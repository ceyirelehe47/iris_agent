export const IRIS_INPUT_META_CUSTOM_TYPE = "iris_input_meta";
export const IRIS_INPUT_META_CONTENT = "<iris-input-meta/>";
// Legacy m0/m1 empty-baseline constants (SUPERSEDED renderer + carriers only;
// the V2 pipeline has no m0/m1).
export const M0_EMPTY_BODY = "<session-history></session-history>";
export const M1_EMPTY_PLACEHOLDER =
  "<session-history-since>(no new content since last materialization)</session-history-since>";

// v27: the flat invocation DTOs (InvocationSourceBinding /
// PreparedInvocationSources / TransformMessagesInput / MessageProjectionResult)
// were deleted with the m0/m1 materialization path — see context-v27.ts
// (PreparedV2Sources) and context/v2-generation.ts.

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
