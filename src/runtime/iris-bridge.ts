/**
 * IrisRuntimeEventBridge —— Pi runtime seam → @iris/context 中性 RuntimeEvent
 * ingest（iris_agent 侧唯一的 Context 事件入口）。
 *
 * 权威来源：Notion 01 Context Assembly｜Native Event-driven Context Runtime
 * Override + 3a5b Module Boundaries｜Runtime Event Ingestor：
 *
 *   Ingress / Provider / Tool Runtime 预分配稳定 runtimeEventId
 *   → Pi Session append + SessionCommitReceipt（message_finalized）
 *   → Runtime Event Ingestor 验证并原子提交 RuntimeEvent ledger +
 *     ContextMessageUnit(contextSeq)
 *
 * 本 bridge 是那层 Ingestor 的 Pi 适配：
 *  - 在 harness 的 message_finalized 事件处，把 Pi 消息解码为 @iris/context
 *    的 `RuntimeEventInput`（eventId=预分配 runtimeEventId、kind 映射、中性
 *    payload、origin、derivationRefs、rawArchiveRef、companion 关联）；
 *  - Pi UserMessage + iris_input_meta CustomMessage → 双事件模型：主 user
 *    事件（先 commit）+ companion 事件（companionOf 指向主事件）；
 *  - 所有语义 payload 是符合 @iris/context 语义 schema 的中性 JsonValue
 *    （不解析/不透传 Pi 消息形状）；
 *  - 单位建单元提交（user/assistant/tool_result）后提交 canonical BUST
 *    请求（coalesce；下一安全 provider 边界 full rebuild）。
 *
 * Pi Session 只作 raw archive（rawArchiveRef attribution / recovery
 * reconciliation）；绝不把 Session.buildContext() 作为 Context 正常输入。
 * Context 语义完全经 @iris/context 的 ContextService。
 */
import { createHash } from "node:crypto";

import type { AgentHarness } from "@iris/pi-agent-core";
import type { ContextService } from "@iris/context";
import type {
  JsonValue,
  OriginEnvelope as NeutralOrigin,
  RuntimeEventInput,
} from "@iris/context/contracts/runtime-events";
import { computeContentTextHash } from "@iris/context/contracts/runtime-events";
import type { OriginEnvelope as AgentOrigin, AgentInput } from "../contracts/origin.js";
import {
  IRIS_INPUT_META_CONTENT,
  IRIS_INPUT_META_CUSTOM_TYPE,
  decodeUserContentParts,
  decodeUserText,
  type IrisInputMetaDetails,
} from "./companion.js";

/** 预分配稳定 runtimeEventId（deterministic：runtimeSessionId + entryId）。 */
export function deriveRuntimeEventId(runtimeSessionId: string, entryId: string): string {
  return `re-${createHash("sha256").update(`${runtimeSessionId}:${entryId}`).digest("hex").slice(0, 24)}`;
}

/** iris_agent OriginEnvelope → @iris/context OriginEnvelope（中性 provenance）。 */
export function toNeutralOrigin(origin: AgentOrigin | undefined): NeutralOrigin {
  if (origin === undefined) {
    return {
      schemaId: "iris.origin_envelope.v1",
      channel: "unknown",
      principalKind: "environment",
      authority: "data_only",
      trust: "untrusted",
    };
  }
  return {
    schemaId: "iris.origin_envelope.v1",
    channel: origin.channel,
    principalKind: origin.principalKind,
    ...(origin.principalRef !== undefined ? { principalRef: origin.principalRef } : {}),
    authority: origin.authority,
    trust: origin.trust,
    ...(origin.provenanceRef !== undefined ? { provenanceRef: origin.provenanceRef } : {}),
  };
}

export interface IrisContextBridgeOptions {
  /** identity-level runtime session id（Context 的 attribution 键）。 */
  runtimeSessionId: string;
  /** Host instance epoch（companion 配对 identity 的一部分）。 */
  instanceEpoch: number;
  /** @iris/context ContextService（已 createLineage 绑定）。 */
  contextService: ContextService;
  /** 当前 invocation 的输入（origin 与 companion 配对来源）。 */
  getInput: () => AgentInput;
  /** 时间注入（默认 new Date().toISOString()）。 */
  now?: () => string;
}

/** 语义 content part 转换（Pi → neutral；thinking 字段名转换）。 */
function toSemanticParts(
  content: readonly {
    type: string;
    text?: string;
    thinking?: string;
    thinkingSignature?: string;
    signature?: string;
    redacted?: boolean;
    data?: string;
    mimeType?: string;
    id?: string;
    name?: string;
    arguments?: Record<string, unknown>;
    thoughtSignature?: string;
  }[],
): JsonValue[] {
  const parts: JsonValue[] = [];
  for (const part of content) {
    switch (part.type) {
      case "text":
        parts.push({ type: "text", text: part.text ?? "" });
        break;
      case "image":
        parts.push({ type: "image", data: part.data ?? "", mimeType: part.mimeType ?? "" });
        break;
      case "toolCall":
        parts.push({
          type: "toolCall",
          id: part.id ?? "",
          name: part.name ?? "",
          arguments: (part.arguments ?? {}) as JsonValue,
          ...(typeof part.thoughtSignature === "string"
            ? { thoughtSignature: part.thoughtSignature }
            : {}),
        });
        break;
      case "thinking":
        parts.push({
          type: "thinking",
          text: part.thinking ?? part.text ?? "",
          ...(typeof part.thinkingSignature === "string"
            ? { signature: part.thinkingSignature }
            : {}),
          ...(part.redacted === true ? { redacted: true } : {}),
        });
        break;
      default:
        // Unknown Pi content part → fail closed（不猜测）。
        throw new Error(
          `iris bridge: unsupported Pi content part type ${JSON.stringify(part.type)} (fail closed)`,
        );
    }
  }
  return parts;
}

interface PendingUserPair {
  eventId: string;
  text: string;
}

/**
 * 把 Pi harness 生命周期事件桥接为 @iris/context RuntimeEventInput 并原子
 * ingest。通过 harness.subscribe 挂载（涵盖 replay 路径 —— 重放按相同顺序
 * 投递 message_finalized，配对逻辑保持一致）。
 */
export class IrisContextBridge {
  private readonly options: IrisContextBridgeOptions;
  /** 最近一次已提交的 user 事件（companion 紧随其后，raw_adjacent 配对）。 */
  private pendingUser: PendingUserPair | null = null;
  private closed = false;

  constructor(options: IrisContextBridgeOptions) {
    this.options = options;
  }

  attach(harness: AgentHarness): void {
    harness.subscribe(async (event) => {
      if (this.closed) {
        return;
      }
      switch (event.type) {
        case "message_finalized": {
          this.onMessageFinalized(event);
          return;
        }
        case "tool_execution_committed": {
          this.onToolExecutionCommitted(event);
          return;
        }
        default:
          return;
      }
    });
  }

  close(): void {
    this.closed = true;
    this.pendingUser = null;
  }

  private now(): string {
    return (this.options.now ?? (() => new Date().toISOString()))();
  }

  private timestampOf(message: { timestamp?: number }): string {
    if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
      return new Date(message.timestamp).toISOString();
    }
    return this.now();
  }

  private rawArchiveRef(entryId: string, entrySeq: number | undefined, contentHash: string) {
    return {
      schemaId: "iris.raw_archive_ref.v1" as const,
      runtimeSessionId: this.options.runtimeSessionId,
      entryIds: [entryId],
      ...(entrySeq !== undefined ? { startEntrySeq: entrySeq, endEntrySeq: entrySeq } : {}),
      sourceHash: contentHash,
    };
  }

  private ingest(input: RuntimeEventInput): void {
    this.options.contextService.ingestRuntimeEvent(input);
  }

  private requestBustAfterUnit(kind: string, eventId: string): void {
    this.options.contextService.requestBust("source_invalidation", {
      schemaId: "iris.bust_evidence.v1",
      detail: `committed ${kind} event ${eventId}`,
      sourceRefs: [eventId],
    });
  }

  private onMessageFinalized(event: {
    entryId: string;
    role: string;
    contentHash: string;
    receipt: { entrySeq?: number };
    message: unknown;
  }): void {
    const message = event.message as {
      role: string;
      content: string | unknown[];
      timestamp?: number;
      customType?: string;
      details?: unknown;
      toolCallId?: string;
      toolName?: string;
      isError?: boolean;
      api?: string;
      provider?: string;
      model?: string;
      usage?: unknown;
      stopReason?: unknown;
      errorMessage?: string;
    };
    const runtimeSessionId = this.options.runtimeSessionId;
    const eventId = deriveRuntimeEventId(runtimeSessionId, event.entryId);
    const occurredAt = this.timestampOf(message);
    const idempotencyKey = `msg:${runtimeSessionId}:${event.entryId}`;
    const base = {
      eventId,
      runtimeSessionId,
      occurredAt,
      idempotencyKey,
      rawArchiveRef: this.rawArchiveRef(event.entryId, event.receipt.entrySeq, event.contentHash),
    };

    switch (event.role) {
      case "user": {
        // 主 user 事件：中性语义内容 = 解码后的文本 parts；companion 配对
        // 由紧随其后的 iris_input_meta CustomMessage 双事件合并。
        const text = decodeUserText(
          message as { content: string | { type: string; text?: string }[] },
        );
        const payload: JsonValue = {
          role: "user",
          content: decodeUserContentParts(
            message as { content: string | { type: string; text?: string }[] },
          ),
        };
        this.ingest({
          ...base,
          kind: "user",
          role: "user",
          payload,
          origin: toNeutralOrigin(this.options.getInput().triggerOrigin),
        });
        this.pendingUser = { eventId, text };
        this.requestBustAfterUnit("user", eventId);
        return;
      }
      case "custom": {
        // iris_input_meta companion：双事件模型的 companion 事件（companionOf
        // 指向主 user 事件；payload 必须是 CompanionPayloadV1）。
        if (
          message.customType === IRIS_INPUT_META_CUSTOM_TYPE &&
          message.content === IRIS_INPUT_META_CONTENT
        ) {
          const details = message.details as IrisInputMetaDetails | undefined;
          const iris = details?.iris;
          const pairKey = typeof iris?.pairKey === "string" ? iris.pairKey : "";
          const layoutHash =
            typeof iris?.contentLayoutHash === "string" ? iris.contentLayoutHash : undefined;
          const contentHash =
            this.pendingUser !== null ? computeContentTextHash(this.pendingUser.text) : undefined;
          const origin =
            iris?.triggerOrigin !== undefined
              ? toNeutralOrigin(iris.triggerOrigin)
              : toNeutralOrigin(this.options.getInput().triggerOrigin);
          this.ingest({
            ...base,
            kind: "operational",
            role: "custom",
            payload: {
              type: "iris_input_meta",
              pairKey,
              ...(contentHash !== undefined ? { contentHash } : {}),
              ...(layoutHash !== undefined ? { layoutHash } : {}),
              origin,
            } as unknown as JsonValue,
            ...(this.pendingUser !== null ? { companionOf: this.pendingUser.eventId } : {}),
          });
          this.pendingUser = null;
          return;
        }
        // 其他 custom 消息：不做 Context 语义（Pi raw archive 已有）。
        return;
      }
      case "assistant": {
        const msg = message as {
          content: unknown[];
          api?: string;
          provider?: string;
          model?: string;
          usage?: unknown;
          stopReason?: unknown;
          errorMessage?: string;
        };
        const payload = {
          role: "assistant",
          content: toSemanticParts(
            msg.content as {
              type: string;
              text?: string;
              thinking?: string;
              thinkingSignature?: string;
              redacted?: boolean;
              data?: string;
              mimeType?: string;
              id?: string;
              name?: string;
              arguments?: Record<string, unknown>;
              thoughtSignature?: string;
            }[],
          ),
          ...(typeof msg.api === "string" ? { api: msg.api } : {}),
          ...(typeof msg.provider === "string" ? { provider: msg.provider } : {}),
          ...(typeof msg.model === "string" ? { model: msg.model } : {}),
          ...(msg.usage !== undefined ? { usage: msg.usage as JsonValue } : {}),
          ...(msg.stopReason !== undefined ? { stopReason: msg.stopReason as JsonValue } : {}),
          ...(typeof msg.errorMessage === "string" ? { errorMessage: msg.errorMessage } : {}),
          timestamp: message.timestamp ?? Date.now(),
        } as JsonValue;
        this.ingest({
          ...base,
          kind: "assistant",
          role: "assistant",
          payload,
          origin: toNeutralOrigin({
            schemaVersion: 1,
            channel: "model",
            principalKind: "model",
            authority: "internal_control",
            trust: "limited",
          }),
        });
        this.requestBustAfterUnit("assistant", eventId);
        return;
      }
      case "toolResult": {
        const msg = message as {
          content: unknown[];
          toolCallId?: string;
          toolName?: string;
          isError?: boolean;
          usage?: unknown;
          addedToolNames?: string[];
        };
        const payload = {
          role: "toolResult",
          toolCallId: msg.toolCallId ?? "",
          toolName: msg.toolName ?? "",
          content: toSemanticParts(
            msg.content as {
              type: string;
              text?: string;
              thinking?: string;
              data?: string;
              mimeType?: string;
            }[],
          ),
          ...(msg.usage !== undefined ? { usage: msg.usage as JsonValue } : {}),
          ...(msg.addedToolNames !== undefined
            ? { addedToolNames: msg.addedToolNames as JsonValue }
            : {}),
          isError: msg.isError === true,
          timestamp: message.timestamp ?? Date.now(),
        } as JsonValue;
        this.ingest({
          ...base,
          kind: "tool_result",
          role: "toolResult",
          payload,
          ...(msg.toolCallId !== undefined ? { toolCallId: msg.toolCallId } : {}),
          ...(msg.toolName !== undefined ? { toolName: msg.toolName } : {}),
          isError: msg.isError === true,
          origin: toNeutralOrigin({
            schemaVersion: 1,
            channel: "tool",
            principalKind: "tool",
            authority: "data_only",
            trust: "limited",
          }),
        });
        this.requestBustAfterUnit("tool_result", eventId);
        return;
      }
      default:
        // branchSummary / compactionSummary / 未知 role：Pi raw archive 已有；
        // 不进 canonical Context（避免第二套语义猜测）。
        return;
    }
  }

  private onToolExecutionCommitted(event: {
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
    isError: boolean;
  }): void {
    // tool_call 是 ledger-only 事件（不建 ContextMessageUnit；工具弧身份
    // attribution 由 tool_result 单元携带 toolCallId/toolName）。
    const runtimeSessionId = this.options.runtimeSessionId;
    const eventId = deriveRuntimeEventId(runtimeSessionId, `tool:${event.toolCallId}`);
    this.ingest({
      eventId,
      runtimeSessionId,
      kind: "tool_call",
      role: "assistant",
      payload: {
        role: "assistant",
        content: [],
        toolCalls: [
          {
            type: "toolCall",
            id: event.toolCallId,
            name: event.toolName,
            arguments: (event.input ?? {}) as JsonValue,
          },
        ],
      } as unknown as JsonValue,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError,
      origin: toNeutralOrigin({
        schemaVersion: 1,
        channel: "tool",
        principalKind: "tool",
        authority: "internal_control",
        trust: "limited",
      }),
      occurredAt: this.now(),
      idempotencyKey: `tool:${runtimeSessionId}:${event.toolCallId}`,
    });
  }
}
