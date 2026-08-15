import { createHash } from "node:crypto";

import type { OriginEnvelope } from "./origin.js";

export interface ToolDescriptor {
  name: string;
  version: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  source: "builtin" | "mcp" | "body";
  risk: "low" | "medium" | "high";
  idempotency: "read_only" | "idempotent_write" | "non_idempotent_write";
  hostMutationScope:
    "none" | "workspace_write" | "iris_data_root" | "iris_runtime_control" | "arbitrary_host_write";
  timeoutMs: number;
}

export interface IrisBlockLayoutV1 {
  blockId: string;
  blockIndex: number;
  contentKind: "inline_text" | "external_ref" | "image_ref";
  location:
    | { mode: "text_frame"; frameIndex: number; utf8ByteLength: number }
    | { mode: "content_part"; partIndex: number };
  sourceOrigin: OriginEnvelope;
  sourceContentHash: string;
  wireContentHash: string;
  originalPayloadRef?: {
    schemaVersion: number;
    kind: string;
    hash: string;
    byteLength: number;
    uri: string;
  };
}

export interface ToolResultDetailsIris {
  schemaVersion: number;
  toolExecutionKey: string;
  assistantEntryId: string;
  assistantEntrySeq?: number;
  entryOrigin: OriginEnvelope;
  layoutVersion: "iris_content_layout_v1";
  blocks: IrisBlockLayoutV1[];
  contentLayoutHash: string;
}

export interface ToolExecutionContext {
  instanceEpoch: number;
  epochId: string;
  runtimeSessionId: string;
  invocationId: string;
  assistantEntryId: string;
  assistantEntrySeq?: number;
  toolCallOrdinal: number;
  toolCallId: string;
  toolExecutionKey: string;
  workspaceRoot: string;
  abortSignal: AbortSignal;
}

export interface ToolExecutionRecord {
  toolExecutionKey: string;
  instanceEpoch: number;
  epochId: string;
  runtimeSessionId: string;
  assistantEntryId: string;
  assistantEntrySeq?: number;
  toolCallOrdinal: number;
  toolCallId: string;
  toolName: string;
  toolVersion: string;
  adapterKey: string;
  canonicalArgsHash: string;
  externalIdempotencyKey?: string;
  state:
    | "prepared"
    | "running"
    | "succeeded_unpublished"
    | "session_committed"
    | "failed"
    | "outcome_unknown";
  resultHash?: string;
  resultRecoveryRef?: string;
  startedAt: string;
  finishedAt?: string;
  sessionCommittedAt?: string;
}

export function computeToolExecutionKey(input: {
  instanceEpoch: number;
  runtimeSessionId: string;
  assistantEntryId: string;
  toolCallOrdinal: number;
  toolCallId: string;
  toolName: string;
  toolVersion: string;
  canonicalArgsHash: string;
}): string {
  const canonical = JSON.stringify({
    instanceEpoch: input.instanceEpoch,
    runtimeSessionId: input.runtimeSessionId,
    assistantEntryId: input.assistantEntryId,
    toolCallOrdinal: input.toolCallOrdinal,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    toolVersion: input.toolVersion,
    canonicalArgsHash: input.canonicalArgsHash,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Canonical stable JSON serialization for tool arguments: recursively sorts
 * object keys so two calls with the same arguments in different key orders
 * produce the same canonicalArgsHash (review blocker: key order must not
 * change a tool execution's identity).
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value);
}
