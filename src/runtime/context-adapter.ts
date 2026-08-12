import type { AgentMessage, CustomMessage } from "@iris/pi-agent-core";

import {
  IRIS_INPUT_META_CONTENT,
  IRIS_INPUT_META_CUSTOM_TYPE,
  type MessageProjectionResult,
  type TransformMessagesInput,
} from "../contracts/context.js";
import {
  type InputFrame,
  type IrisInputMetaDetails,
  decodeInputFrames,
  derivePairKey,
  verifyCompanionLayoutHash,
} from "./companion.js";
import type { OriginEnvelope } from "../contracts/origin.js";
import type { IrisBlockLayoutV1 } from "../contracts/tool.js";
import type { ProjectedSessionMessage } from "./session-projection.js";

export interface DetectedInputPair {
  userMessage: AgentMessage & { role: "user" };
  companion: CustomMessage<unknown>;
  pairKey: string;
}

interface VerifiedPair {
  userMessage: AgentMessage & { role: "user" };
  frames: InputFrame[] | undefined;
  blocks: IrisBlockLayoutV1[] | undefined;
  verified: boolean;
}

/**
 * Identity-preserving pair over the raw-entry projection (iris_agent#6). The
 * companion's RAW parent chain and RAW adjacency against the UserMessage are
 * what make the pair authoritative — never a filtered-array position.
 */
export interface ProjectedInputPair {
  user: ProjectedSessionMessage & { message: AgentMessage & { role: "user" } };
  companion: ProjectedSessionMessage & { message: CustomMessage<unknown> };
  pairKey: string;
  /** How the pair linkage was verified against the raw entries. */
  linkage: "raw_adjacent" | "parent_chain";
}

/**
 * True when a projected custom message is an iris_input_meta companion. This
 * applies to both Pi `message` entries whose message.role === "custom" and Pi
 * `custom_message` entries lifted by the projection.
 */
function isInputMetaCompanion(message: AgentMessage): message is CustomMessage<unknown> {
  return (
    message.role === "custom" &&
    message.customType === IRIS_INPUT_META_CUSTOM_TYPE &&
    message.content === IRIS_INPUT_META_CONTENT &&
    message.display === false
  );
}

/**
 * Pair UserMessage + iris_input_meta companion directly on the identity-
 * preserving projection. A pair is only accepted when EITHER:
 *
 *  1. raw_adjacent — the companion is the very next raw entry
 *     (rawIndex === user.rawIndex + 1); or
 *  2. parent_chain  — the companion's raw parentId is exactly the UserMessage
 *     entry id (authoritative Pi parent linkage, e.g. a non-message entry
 *     such as a label sits between them but the companion still hangs off the
 *     UserMessage).
 *
 * Anything else (interleaved message, broken/absent parent linkage, an
 * isolated companion) is NOT a valid pair and is excluded — the caller fails
 * closed on the ambiguity instead of guessing (iris_agent#6).
 */
export function findInputPairsByProjection(
  projected: ProjectedSessionMessage[],
): ProjectedInputPair[] {
  const pairs: ProjectedInputPair[] = [];
  for (let index = 0; index < projected.length - 1; index += 1) {
    const user = projected[index];
    const companion = projected[index + 1];
    if (user === undefined || companion === undefined) {
      continue;
    }
    if (user.message.role !== "user" || !isInputMetaCompanion(companion.message)) {
      continue;
    }
    const details = companion.message.details as IrisInputMetaDetails | undefined;
    const pairKey = details?.iris?.pairKey;
    if (typeof pairKey !== "string") {
      continue;
    }
    if (companion.rawIndex === user.rawIndex + 1) {
      pairs.push({
        user: user as ProjectedSessionMessage & { message: AgentMessage & { role: "user" } },
        companion: companion as ProjectedSessionMessage & { message: CustomMessage<unknown> },
        pairKey,
        linkage: "raw_adjacent",
      });
      continue;
    }
    if (companion.parentId !== null && companion.parentId === user.entryId) {
      pairs.push({
        user: user as ProjectedSessionMessage & { message: AgentMessage & { role: "user" } },
        companion: companion as ProjectedSessionMessage & { message: CustomMessage<unknown> },
        pairKey,
        linkage: "parent_chain",
      });
    }
  }
  return pairs;
}

export function findInputPairs(messages: AgentMessage[]): DetectedInputPair[] {
  const pairs: DetectedInputPair[] = [];
  for (let index = 0; index < messages.length - 1; index += 1) {
    const user = messages[index];
    const companion = messages[index + 1];
    const details = (companion?.role === "custom" ? companion.details : undefined) as
      IrisInputMetaDetails | undefined;
    if (
      user?.role === "user" &&
      companion?.role === "custom" &&
      companion.customType === IRIS_INPUT_META_CUSTOM_TYPE &&
      companion.content === IRIS_INPUT_META_CONTENT &&
      companion.display === false &&
      typeof details?.iris?.pairKey === "string"
    ) {
      pairs.push({
        userMessage: user as AgentMessage & { role: "user" },
        companion,
        pairKey: details.iris.pairKey,
      });
    }
  }
  return pairs;
}

function decodeUserFrames(userMessage: AgentMessage & { role: "user" }): InputFrame[] | undefined {
  const raw = Array.isArray(userMessage.content)
    ? userMessage.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
    : userMessage.content;
  try {
    return decodeInputFrames(raw);
  } catch {
    return undefined;
  }
}

function authorityLabel(authority: OriginEnvelope["authority"]): string {
  switch (authority) {
    case "user_request":
      return "USER REQUEST";
    case "notice_only":
      return "NOTICE ONLY";
    case "data_only":
      return "DATA ONLY";
    case "internal_control":
      return "INTERNAL CONTROL";
  }
}

/**
 * Model-visible provenance label. Spec requires the source summary to carry
 * principalKind + channel in addition to authority/trust (review blocker #4,
 * third pass).
 */
function sourceLabel(origin: OriginEnvelope): string {
  const kind = origin.principalKind.toUpperCase();
  const channel = origin.channel;
  return `[${kind} | ${channel} | ${authorityLabel(origin.authority)} | ${origin.trust.toUpperCase()}]`;
}

function frameOrigins(
  blocks: IrisBlockLayoutV1[] | undefined,
  frameCount: number,
): Array<OriginEnvelope | undefined> {
  if (!Array.isArray(blocks)) {
    return Array.from({ length: frameCount }, () => undefined);
  }
  // Every block contributes exactly one origin, INCLUDING image_ref: the
  // input bridge encodes an image_ref as a textual fingerprint frame, so
  // block<->frame correspondence must be 1:1 — skipping image blocks would
  // mislabel their frames with the NEXT block's origin (review blocker #5).
  const origins: Array<OriginEnvelope | undefined> = [];
  for (const block of blocks) {
    origins.push(block.sourceOrigin);
  }
  return origins;
}

function projectedUserText(
  frames: InputFrame[] | undefined,
  blocks: IrisBlockLayoutV1[] | undefined,
  verified: boolean,
): string {
  if (frames === undefined || !verified) {
    return "[USER REQUEST | UNVERIFIED]";
  }
  const origins = frameOrigins(blocks, frames.length);
  return frames
    .map((frame, index) => {
      const origin = origins[index];
      if (origin === undefined) {
        return `[DATA ONLY | UNTRUSTED]\n${frame.payload}`;
      }
      return `${sourceLabel(origin)}\n${frame.payload}`;
    })
    .join("\n\n");
}

export function transformContextMessages(input: TransformMessagesInput): MessageProjectionResult {
  const candidates = findInputPairs(input.messages);
  const verifiedPairs = new Map<AgentMessage, VerifiedPair>();
  for (const pair of candidates) {
    const details = pair.companion.details as IrisInputMetaDetails | undefined;
    const frames = decodeUserFrames(pair.userMessage);
    const blocks = details?.iris?.blocks;
    // review-pass-7 #2 (subagent-review fix): companions are created with an
    // epoch-bound pairKey (Host instanceEpoch). Recompute with the companion's
    // recorded instanceEpoch (undefined for legacy companions → legacy path).
    const expectedPairKey =
      frames === undefined || typeof details?.iris?.inputId !== "string"
        ? undefined
        : derivePairKey(details.iris.inputId, frames, details.iris.instanceEpoch);
    const verified =
      frames !== undefined &&
      expectedPairKey !== undefined &&
      expectedPairKey === pair.pairKey &&
      verifyCompanionLayoutHash(details ?? {});
    verifiedPairs.set(pair.userMessage, {
      userMessage: pair.userMessage,
      frames,
      blocks,
      verified,
    });
  }

  const projected: AgentMessage[] = [];
  for (const message of input.messages) {
    if (message === undefined) {
      continue;
    }
    if (message.role === "custom" && message.customType === IRIS_INPUT_META_CUSTOM_TYPE) {
      continue;
    }
    const pair = verifiedPairs.get(message);
    if (pair !== undefined) {
      projected.push({
        ...pair.userMessage,
        content: [
          { type: "text", text: projectedUserText(pair.frames, pair.blocks, pair.verified) },
        ],
      });
      continue;
    }
    if (
      message.role === "user" &&
      decodeUserFrames(message as AgentMessage & { role: "user" }) !== undefined
    ) {
      projected.push({
        ...message,
        content: [{ type: "text", text: projectedUserText(undefined, undefined, false) }],
      });
      continue;
    }
    projected.push(message);
  }

  // v13：live-fold 只产出 provider 可见的折叠后消息数组。m0/m1 物化边界
  // 状态（原 v12 representedBoundaryState / "mock-m0m1-v1"）已删除——真实
  // 物化状态现在由 context_lineages + ContextRenderer.persistRender 持有。
  return { messages: projected };
}
