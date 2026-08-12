import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const IRIS_INPUT_META_CUSTOM_TYPE = "iris_input_meta";
export const IRIS_INPUT_META_CONTENT = "<iris-input-meta/>";
export const M0_EMPTY_BODY = "<session-history></session-history>";
export const M1_EMPTY_PLACEHOLDER =
  "<session-history-since>(no new content since last materialization)</session-history-since>";

/**
 * The per-invocation binding for the Pi runtime capsule — what
 * `prepareInvocation` returns to the runtime coordinator and the harness
 * reads on every turn.
 *
 * Feature B (goal.txt §5): this is a MINIMAL Pi-runtime binding and is NOT
 * Context assembly. It carries only:
 *   - session binding (runtimeSessionId, epochId),
 *   - source identity (contextSourceSnapshotId, personaSnapshotId,
 *     declarationVersion, providerProfileId),
 *   - the canonical system prompt + its projection hash (the authoritative
 *     source the provider cache identity is derived from).
 *
 * It NEVER carries Context assembly state. m0/m1 materialization is owned by
 * ContextRenderer + persistRender (context_lineages); the v12-era
 * `materializationIdentity: "mock-m0m1-v1"` marker (PreparedInvocationSources)
 * was removed with this feature. Continuity/recovery identifiers
 * (continuitySeedId, runtimeRecoveryNoticeId, stableMemoryPoolVersion) are
 * recorded on the lineage row when a producer supplies them — they are not
 * part of the runtime binding.
 */
export interface InvocationSourceBinding {
  /** Snapshot identity of the canonical source (derived from the system prompt). */
  contextSourceSnapshotId: string;
  runtimeSessionId: string;
  epochId: string;
  personaSnapshotId: string;
  declarationVersion: string;
  providerProfileId: string;
  canonicalSystemPrompt: string;
  systemProjectionHash: string;
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
// v27 naming: MessageProjectionResult — the provider-visible folded message
// array produced by the live-fold transform.
export interface MessageProjectionResult {
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
