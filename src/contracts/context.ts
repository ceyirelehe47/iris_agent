import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const IRIS_INPUT_META_CUSTOM_TYPE = "iris_input_meta";
export const IRIS_INPUT_META_CONTENT = "<iris-input-meta/>";
export const M0_EMPTY_BODY = "<session-history></session-history>";
export const M1_EMPTY_PLACEHOLDER =
  "<session-history-since>(no new content since last materialization)</session-history-since>";

// TODO: R2 — v27 supersedes this; will be replaced by ContextGeneration/ContextMessageUnitView
export interface ContextSourceSnapshot {
  contextSourceSnapshotId: string;
  runtimeSessionId: string;
  epochId: string;
  personaSnapshotId: string;
  declarationVersion: string;
  continuitySeedId?: string;
  runtimeRecoveryNoticeId?: string;
  stableMemoryPoolVersion?: string;
  providerProfileId: string;
  canonicalSystemPrompt: string;
  systemProjectionHash: string;
  preparedAt: string;
}

// TODO: R2 — v27 supersedes this; will be replaced by ContextGeneration/ContextMessageUnitView
export interface PreparedContextSources {
  contextSourceSnapshotId: string;
  runtimeSessionId: string;
  canonicalSystemPrompt: string;
  systemProjectionHash: string;
  materializationIdentity: string;
  preparedAt: string;
}

export interface TransformMessagesInput {
  invocationId: string;
  runtimeSessionId: string;
  messages: AgentMessage[];
  model: { provider: string; modelId: string };
  providerProfileId: string;
}

/**
 * v13：live-fold（transformContextMessages）的结果契约。v12 的
 * representedBoundaryState（mock-m0m1-v1）已随 ContextRuntimePort 一起删除；
 * 真实的 m0/m1 物化边界状态现在由 context_lineages（ContextRenderer +
 * persistRender）持有，这里只保留 provider 可见的折叠后消息数组。
 */
// TODO: R2 — v27 supersedes this; will be replaced by ContextGeneration/ContextMessageUnitView
export interface ContextTransformResult {
  messages: AgentMessage[];
}

export interface IrisContextCarrierDetails {
  irisContext: {
    schemaVersion: number;
    runtimeSessionId: string;
    surface: "m0" | "m1";
    materializationId: string;
    contentHash: string;
    /** Fixed carrier schema version; bump only on an explicit review. */
    carrierSchemaVersion: string;
    /** Provider profile the carrier was materialized under (invalidation). */
    providerProfileId: string;
  };
}
