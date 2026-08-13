import { createHash } from "node:crypto";

import type { CustomMessage } from "@iris/pi-agent-core";

import { IRIS_INPUT_META_CONTENT, IRIS_INPUT_META_CUSTOM_TYPE } from "../contracts/context.js";
import type { AgentInput, OriginEnvelope, ProvenancedContentBlock } from "../contracts/origin.js";
import { originHash } from "../contracts/origin.js";
import type { IrisBlockLayoutV1 } from "../contracts/tool.js";

export const INPUT_FRAME_HEADER = "IRIS_INPUT_V1";
const FRAME_HEADER_PATTERN = /^(inline_text|external_ref):(\d+)$/;

export interface InputFrame {
  kind: "inline_text" | "external_ref";
  utf8ByteLength: number;
  payload: string;
}

export interface IrisInputMetaDetails {
  iris?: {
    schemaVersion?: number;
    inputId?: string;
    pairKey?: string;
    /** review-pass-7 #2: the Host instanceEpoch the pair was created under —
     *  part of the durable pair identity so a pair from another instance
     *  epoch can never be mistaken for this epoch's input. */
    instanceEpoch?: number;
    triggerOrigin?: OriginEnvelope;
    entryOrigin?: OriginEnvelope;
    layoutVersion?: string;
    contentLayoutHash?: string;
    blocks?: IrisBlockLayoutV1[];
  };
}

function blockToFrame(block: ProvenancedContentBlock): InputFrame {
  if (block.content.mode === "inline_text") {
    return {
      kind: "inline_text",
      utf8ByteLength: Buffer.byteLength(block.content.text, "utf8"),
      payload: block.content.text,
    };
  }
  if (block.content.mode === "external_ref") {
    const preview = block.content.ref.uri;
    return {
      kind: "external_ref",
      utf8ByteLength: Buffer.byteLength(preview, "utf8"),
      payload: preview,
    };
  }
  if (block.content.mode === "image_ref") {
    // Image references are externalized payloads: the frame carries the
    // content-addressable fingerprint (hash) rather than image bytes, so the
    // input bridge round-trips the provenance without embedding binary data.
    const fingerprint = `${block.content.ref.kind}:${block.content.ref.hash}`;
    return {
      kind: "external_ref",
      utf8ByteLength: Buffer.byteLength(fingerprint, "utf8"),
      payload: fingerprint,
    };
  }
  // All ProvenancedContent modes are handled above; a new mode must be added
  // to both the type and this function.
  const mode = (block.content as { mode: string }).mode;
  throw new Error(`unsupported content mode: ${mode}`);
}

export function encodeInputFramesFromFrames(frames: InputFrame[]): string {
  const chunks: Buffer[] = [Buffer.from(`${INPUT_FRAME_HEADER}\n`, "utf8")];
  for (const frame of frames) {
    chunks.push(Buffer.from(`${frame.kind}:${frame.utf8ByteLength}\n`, "utf8"));
    chunks.push(Buffer.from(frame.payload, "utf8"));
    chunks.push(Buffer.from("\n", "utf8"));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function encodeInputFrames(blocks: ProvenancedContentBlock[]): string {
  return encodeInputFramesFromFrames(blocks.map(blockToFrame));
}

export function decodeInputFrames(wire: string): InputFrame[] {
  const bytes = Buffer.from(wire, "utf8");
  const header = Buffer.from(`${INPUT_FRAME_HEADER}\n`, "utf8");
  if (bytes.length < header.length || !bytes.subarray(0, header.length).equals(header)) {
    throw new Error("invalid input frame header");
  }
  const frames: InputFrame[] = [];
  let offset = header.length;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset);
    if (newline < 0) {
      throw new Error("invalid frame header");
    }
    const headerLine = bytes.subarray(offset, newline).toString("utf8");
    const match = FRAME_HEADER_PATTERN.exec(headerLine);
    if (match === null) {
      throw new Error(`invalid frame header: ${headerLine}`);
    }
    const byteLength = Number(match[2]);
    const payloadStart = newline + 1;
    const payloadEnd = payloadStart + byteLength;
    if (payloadEnd > bytes.length) {
      throw new Error("frame byte length mismatch");
    }
    const payload = bytes.subarray(payloadStart, payloadEnd).toString("utf8");
    frames.push({ kind: match[1] as InputFrame["kind"], utf8ByteLength: byteLength, payload });
    if (payloadEnd === bytes.length) {
      offset = bytes.length;
    } else {
      if (bytes[payloadEnd] !== 0x0a) {
        throw new Error("frame terminator missing");
      }
      offset = payloadEnd + 1;
    }
  }
  return frames;
}

interface LayoutEntry {
  blockId: string;
  blockIndex: number;
  contentKind: string;
  sourceOriginHash: string;
  sourceContentHash: string;
  wireContentHash: string;
}

function layoutHash(entries: LayoutEntry[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ layoutVersion: "iris_content_layout_v1", layout: entries }))
    .digest("hex");
}

export function computeContentLayoutHash(input: AgentInput, wire: string): string {
  const frames = decodeInputFrames(wire);
  const entries: LayoutEntry[] = input.blocks.map((block, index) => {
    const frame = frames[index];
    if (frame === undefined) {
      throw new Error("frame count does not match blocks");
    }
    return {
      blockId: block.blockId,
      blockIndex: index,
      contentKind: block.content.mode,
      sourceOriginHash: originHash(block.sourceOrigin),
      sourceContentHash: block.contentHash,
      wireContentHash: createHash("sha256").update(frame.payload, "utf8").digest("hex"),
    };
  });
  return layoutHash(entries);
}

export function verifyCompanionLayoutHash(details: IrisInputMetaDetails): boolean {
  const iris = details.iris;
  const blocks = iris?.blocks;
  const expected = iris?.contentLayoutHash;
  if (!Array.isArray(blocks) || typeof expected !== "string") {
    return false;
  }
  const entries: LayoutEntry[] = blocks.map((block) => ({
    blockId: block.blockId,
    blockIndex: block.blockIndex,
    contentKind: block.contentKind,
    sourceOriginHash: originHash(block.sourceOrigin),
    sourceContentHash: block.sourceContentHash,
    wireContentHash: block.wireContentHash,
  }));
  return layoutHash(entries) === expected;
}

export function derivePairKey(
  inputId: string,
  frames: InputFrame[],
  instanceEpoch?: number,
): string {
  const wire = encodeInputFramesFromFrames(frames);
  // review-pass-7 #2: the Host instanceEpoch is part of the pair identity so
  // the same inputId+wire under a DIFFERENT instanceEpoch yields a different
  // pairKey — a pair from another instance epoch can never promote this
  // epoch's accepted record.
  const identity = instanceEpoch === undefined ? inputId : `${instanceEpoch}:${inputId}`;
  return createHash("sha256")
    .update(`${identity}:${createHash("sha256").update(wire).digest("hex")}`)
    .digest("hex");
}

export function inputPairKey(input: AgentInput): string {
  return derivePairKey(input.inputId, decodeInputFrames(encodeInputFrames(input.blocks)));
}

export function computeUserContentHash(input: AgentInput): string {
  const wire = encodeInputFrames(input.blocks);
  return createHash("sha256").update(wire).digest("hex");
}

export function createInputMetaCompanion(
  input: AgentInput,
  layoutHash: string,
  timestamp: string,
  instanceEpoch?: number,
): CustomMessage<unknown> {
  const wire = encodeInputFrames(input.blocks);
  const frames = decodeInputFrames(wire);
  const blocks: IrisBlockLayoutV1[] = [];
  for (const [index, block] of input.blocks.entries()) {
    const frame = frames[index];
    if (frame === undefined) {
      throw new Error("frame count does not match blocks");
    }
    // Every block is encoded into exactly one wire frame (blockToFrame is
    // 1:1), so the location is a real text_frame with the block's own frame
    // index — not a phantom content_part for non-inline blocks (review
    // blocker #4, third pass).
    blocks.push({
      blockId: block.blockId,
      blockIndex: index,
      contentKind: block.content.mode,
      location: {
        mode: "text_frame",
        frameIndex: index,
        utf8ByteLength: frame.utf8ByteLength,
      },
      sourceOrigin: block.sourceOrigin,
      // sourceContentHash is the content-addressed source hash: for ref
      // blocks that is the externalized payload ref.hash, for inline text it
      // is the content hash of the text bytes (review blocker #4).
      sourceContentHash:
        block.content.mode === "inline_text" ? block.contentHash : block.content.ref.hash,
      wireContentHash: createHash("sha256").update(frame.payload, "utf8").digest("hex"),
      ...(block.content.mode === "external_ref" || block.content.mode === "image_ref"
        ? {
            originalPayloadRef: {
              schemaVersion: block.content.ref.schemaVersion,
              kind: block.content.ref.kind,
              hash: block.content.ref.hash,
              byteLength: block.content.ref.byteLength,
              uri: block.content.ref.uri,
            },
          }
        : {}),
    });
  }

  return {
    role: "custom",
    customType: IRIS_INPUT_META_CUSTOM_TYPE,
    content: IRIS_INPUT_META_CONTENT,
    display: false,
    details: {
      iris: {
        schemaVersion: 1,
        inputId: input.inputId,
        // review-pass-7 #2: pairKey binds (instanceEpoch, inputId, wire);
        // instanceEpoch is durably recorded in the companion.
        pairKey: derivePairKey(input.inputId, frames, instanceEpoch),
        ...(instanceEpoch === undefined ? {} : { instanceEpoch }),
        triggerOrigin: input.triggerOrigin,
        entryOrigin: input.triggerOrigin,
        layoutVersion: "iris_content_layout_v1",
        blocks,
        contentLayoutHash: layoutHash,
      },
    },
    timestamp: new Date(timestamp).getTime(),
  };
}
