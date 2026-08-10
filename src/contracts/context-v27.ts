/**
 * Roadmap v27 Canonical Context Contracts — single source of truth.
 *
 * These definitions are the authoritative types for the v27 Context model.
 * No handwritten duplicate interface may exist in other files — all code
 * that needs these types imports from here.
 *
 * Key v27 invariants (Notion v27 Amendment — Structured Context Headers):
 * - ContextMessageUnitV1 is durable (context.db), has contextSeq + lifecycle.
 * - ContextUnitV2 is the generation-level member: schemaId + header + semanticContent.
 *   It is in-memory only, NOT persisted.
 * - ContextGenerationV2 = { schemaId, header, units } — one ordered array;
 *   P-level membership determined by index + header.layerEnds[6].
 * - ContextUnitHeaderV1 owns contextUnitId, source, semanticSchemaId, contentHash.
 *   semanticSchemaId is the semantic type discriminator.
 * - semanticContent is JsonValue — the only semantic payload plane.
 * - BUST is the only refresh path; fail-closed on failure.
 * - Pi Session is raw archive only, never a Context semantic source.
 * - Flat V1 layouts (ContextUnitV1/ContextGenerationV1 without schemaId/header
 *   structure) are superseded; R0 must provide V1→V2 migration or rejection fence.
 */

// ---------------------------------------------------------------------------
// JsonValue helper type (matches Notion spec exactly)
// ---------------------------------------------------------------------------

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Durable Context Message Unit (context.db)
// ---------------------------------------------------------------------------

/**
 * The lifecycle state of a durable ContextMessageUnit.
 *
 * Authoritative lifecycle (Notion R2):
 * committed → historian_eligible → historian_claimed →
 * compartmentalized_pending_bust → represented_in_p3 → retired
 */
export type ContextMessageUnitLifecycleState =
  | "committed"
  | "historian_eligible"
  | "historian_claimed"
  | "compartmentalized_pending_bust"
  | "represented_in_p3"
  | "retired";

/**
 * RuntimeEventKind — the canonical event type discriminator.
 * Maps from the old unitType: input→user, assistant→assistant, tool_result→tool_result.
 * tool_call, body_event, operational are new kinds for v27.
 */
export type RuntimeEventKind =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "body_event"
  | "operational";

/**
 * Historian disposition — controls whether a unit enters Historian evidence.
 */
export type HistorianDisposition = "include" | "reference_only" | "exclude";

/**
 * Raw archive reference — points to the Pi Session raw entry for audit/recovery.
 * Carries a schemaId per the v27 compatibility rules.
 */
export interface RawArchiveRefV1 {
  readonly schemaId: "iris.raw_archive_ref.v1";
  readonly runtimeSessionId: string;
  readonly startEntrySeq?: number;
  readonly endEntrySeq?: number;
  readonly entryIds?: readonly string[];
  readonly sourceHash?: string;
  readonly blobRefs?: readonly string[];
}

/**
 * A durable, identity-level Context semantic unit stored in context.db.
 * Has a global monotonic contextSeq within its lineage, carries lifecycle
 * state, and is the Historian's normal input. When selected for P5, it
 * projects 1:1 into a generation-level ContextUnitV2.
 *
 * This is the SINGLE authoritative durable Context unit definition.
 * No handwritten duplicate may exist in other files.
 * All persistence, ingestion, history, generation, and tests must use
 * this type.
 */
export interface ContextMessageUnitV1 {
  readonly schemaId: "iris.context_message_unit.v1";
  /** Stable identity within the lineage. */
  readonly contextUnitId: string;
  /** The lineage this unit belongs to. */
  readonly contextLineageId: string;
  /** Global monotonic sequence within the lineage. Primary ordering key. */
  readonly contextSeq: number;
  /** The canonical RuntimeEvent that produced this unit. */
  readonly runtimeEventId: string;
  /** Optional invocation id (for tool calls etc.). */
  readonly invocationId?: string;
  /** Semantic unit type — maps to the v27 RuntimeEventKind. */
  readonly kind: RuntimeEventKind;
  /** The semantic schema discriminator for this unit's content. */
  readonly semanticSchemaId: string;
  /** Semantic payload (JsonValue). The only semantic content plane. */
  readonly semanticContent: JsonValue;
  /** Whether this unit is included in generation, reference-only, or excluded. */
  readonly historianDisposition: HistorianDisposition;
  /** Semantic derivation references for provenance tracking. */
  readonly derivationRefs?: SemanticDerivationRefsV1;
  /** Optional raw archive reference (for recovery/audit only). */
  readonly rawArchiveRef?: RawArchiveRefV1;
  /** Canonical content hash covering semantic content, kind, disposition, derivation refs, and semantic schema ID. */
  readonly contentHash: string;
  /** Lifecycle state. */
  readonly lifecycleState: ContextMessageUnitLifecycleState;
  /** Creation timestamp. */
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// V2 Generation Contract (in-memory, validated, not persisted)
// ---------------------------------------------------------------------------

/**
 * Reference to the authoritative source that produced a generation unit.
 * Every interface in V2 carries its own schemaId.
 */
export interface ContextUnitSourceRefV1 {
  readonly schemaId: "iris.context_unit_source_ref.v1";
  readonly sourceSchemaId: string;
  readonly sourceId: string;
  /** Optional source revision (e.g. migration version, snapshot version). */
  readonly sourceRevision?: string;
  /** REQUIRED — content hash of the source (not optional in V2). */
  readonly sourceHash: string;
}

/**
 * Header for a V2 generation unit. Owns identity, source, semantic type,
 * and content hash. MUST NOT contain semantic body content.
 * MUST NOT contain layer/pLevel/sourceKind (duplicate layer membership).
 */
export interface ContextUnitHeaderV1 {
  readonly schemaId: "iris.context_unit_header.v1";
  readonly contextUnitId: string;
  readonly source: ContextUnitSourceRefV1;
  /**
   * The semantic type discriminator for this unit's content.
   * This is the ONLY place where the semantic type is declared.
   */
  readonly semanticSchemaId: string;
  /** Hash of the semanticContent payload. */
  readonly contentHash: string;
}

/**
 * A generation-level Context unit (V2). In-memory only, NOT persisted.
 *
 * Structured per v27 amendment:
 * - schemaId + header + semanticContent
 * - Does NOT carry layer/pLevel — membership is determined by array index
 *   + header.layerEnds in ContextGenerationV2.
 * - Identity comes from header.contextUnitId (stable across rebuilds).
 * - semanticContent is JsonValue — the only semantic payload plane.
 * - semanticContent MUST NOT duplicate identity/source/type/hash/layer/index
 *   metadata.
 */
export interface ContextUnitV2 {
  readonly schemaId: "iris.context_unit.v2";
  readonly header: ContextUnitHeaderV1;
  readonly semanticContent: JsonValue;
}

/**
 * Header for a V2 Context generation. Owns generation identity, lineage,
 * source snapshot hash, layer boundaries, generation hash, and creation time.
 */
export interface ContextGenerationHeaderV1 {
  readonly schemaId: "iris.context_generation_header.v1";
  readonly contextGenerationId: string;
  readonly contextLineageId: string;
  /** Hash of the frozen source snapshot used to build this generation. */
  readonly sourceSnapshotHash: string;
  /**
   * End-exclusive array-index boundaries for P0–P5:
   * P0 = units[0 : layerEnds[0])
   * P1 = units[layerEnds[0] : layerEnds[1])
   * ...
   * P5 = units[layerEnds[4] : layerEnds[5])
   * Constraint: 0 <= e0 <= e1 <= e2 <= e3 <= e4 <= e5 == units.length.
   * Empty layers legal (consecutive equal values).
   */
  readonly layerEnds: readonly [number, number, number, number, number, number];
  /**
   * Hash covering: generation schema identity + contextLineageId +
   * sourceSnapshotHash + ordered unit identity/content hashes + layerEnds.
   * Excludes itself (contextGenerationHash) and createdAt.
   */
  readonly contextGenerationHash: string;
  readonly createdAt: string;
}

/**
 * A validated, in-memory Context generation (V2). The provider cache that is
 * rebuilt from authoritative sources by the canonical BUST pipeline.
 *
 * Structured per v27 amendment:
 * - schemaId + header + units: ContextUnitV2[]
 * - Provider Renderer consumes ONLY this validated structure.
 * - NOT persisted as a whole snapshot; rebuilt from durable sources.
 */
export interface ContextGenerationV2 {
  readonly schemaId: "iris.context_generation.v2";
  readonly header: ContextGenerationHeaderV1;
  readonly units: readonly ContextUnitV2[];
}

// ---------------------------------------------------------------------------
// Semantic derivation references
// ---------------------------------------------------------------------------

/**
 * Semantic derivation references for provenance tracking.
 * Uses `sourceContextMessageUnitIds` (NOT the deprecated `sourceContextUnitIds`).
 * Per Notion spec: memoryRefs, compartmentIds, workSnapshotVersion are optional.
 */
export interface SemanticDerivationRefsV1 {
  readonly schemaId: "iris.semantic_derivation_refs.v1";
  readonly memoryRefs?: readonly string[];
  readonly compartmentIds?: readonly string[];
  readonly workSnapshotVersion?: number;
  readonly sourceContextMessageUnitIds?: readonly string[];
}

// ---------------------------------------------------------------------------
// Schema ID constants (for migration/fencing checks)
// ---------------------------------------------------------------------------

export const CONTEXT_GENERATION_V2_SCHEMA_ID = "iris.context_generation.v2" as const;
export const CONTEXT_GENERATION_HEADER_V1_SCHEMA_ID = "iris.context_generation_header.v1" as const;
export const CONTEXT_UNIT_V2_SCHEMA_ID = "iris.context_unit.v2" as const;
export const CONTEXT_UNIT_HEADER_V1_SCHEMA_ID = "iris.context_unit_header.v1" as const;
export const CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID = "iris.context_unit_source_ref.v1" as const;

/** Schema ID for the durable Context message unit. */
export const CONTEXT_MESSAGE_UNIT_V1_SCHEMA_ID = "iris.context_message_unit.v1" as const;

/** Schema ID for semantic derivation refs. */
export const SEMANTIC_DERIVATION_REFS_V1_SCHEMA_ID = "iris.semantic_derivation_refs.v1" as const;

/**
 * Maps RuntimeEventKind to the canonical semanticSchemaId for durable units.
 * This is the ONLY place semantic schema identity is derived — the generation
 * builder reuses it 1:1 from the durable unit rather than inventing a second map.
 */
export const KIND_TO_SEMANTIC_SCHEMA_ID: Record<RuntimeEventKind, string> = {
  user: "iris.semantic.context_message.user.v1",
  assistant: "iris.semantic.context_message.assistant.v1",
  tool_call: "iris.semantic.context_message.tool_call.v1",
  tool_result: "iris.semantic.context_message.tool_result.v1",
  body_event: "iris.semantic.context_message.body_event.v1",
  operational: "iris.semantic.context_message.operational.v1",
};

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate that a ContextGenerationV2 satisfies the v27 layerEnds constraint:
 * 0 <= e0 <= e1 <= e2 <= e3 <= e4 <= e5 == units.length
 *
 * This is a shallow structural check. For the full fail-closed boundary
 * (hash verification, required field enforcement, unknown schema rejection),
 * use validateGenerationV2Strict().
 */
export function validateGenerationV2(generation: ContextGenerationV2): boolean {
  const [e0, e1, e2, e3, e4, e5] = generation.header.layerEnds;
  const len = generation.units.length;
  return (
    0 <= e0 &&
    e0 <= e1 &&
    e1 <= e2 &&
    e2 <= e3 &&
    e3 <= e4 &&
    e4 <= e5 &&
    e5 === len &&
    generation.schemaId === CONTEXT_GENERATION_V2_SCHEMA_ID &&
    generation.header.schemaId === CONTEXT_GENERATION_HEADER_V1_SCHEMA_ID &&
    generation.units.every(
      (u) =>
        u.schemaId === CONTEXT_UNIT_V2_SCHEMA_ID &&
        u.header.schemaId === CONTEXT_UNIT_HEADER_V1_SCHEMA_ID &&
        u.header.source.schemaId === CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID &&
        u.header.source.sourceHash.length > 0,
    )
  );
}

/**
 * Known valid schema IDs for V2 generation members.
 * Used by the strict validator to reject unknown schemas.
 */
export const KNOWN_GENERATION_SCHEMA_IDS = new Set<string>([
  CONTEXT_GENERATION_V2_SCHEMA_ID,
]);
export const KNOWN_GENERATION_HEADER_SCHEMA_IDS = new Set<string>([
  CONTEXT_GENERATION_HEADER_V1_SCHEMA_ID,
]);
export const KNOWN_UNIT_SCHEMA_IDS = new Set<string>([
  CONTEXT_UNIT_V2_SCHEMA_ID,
]);
export const KNOWN_UNIT_HEADER_SCHEMA_IDS = new Set<string>([
  CONTEXT_UNIT_HEADER_V1_SCHEMA_ID,
]);
export const KNOWN_SOURCE_REF_SCHEMA_IDS = new Set<string>([
  CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
]);

/**
 * Strict fail-closed validation for ContextGenerationV2.
 *
 * Per #104 acceptance criteria:
 * - A schemaId tag alone does NOT establish validity.
 * - Every required nested field is checked.
 * - contentHash is recomputed and verified.
 * - contextGenerationHash is recomputed and verified.
 * - Unknown schema IDs are rejected.
 * - Header/payload separation is enforced (no identity/type/hash in payload).
 * - Missing required fields are rejected.
 *
 * Returns { valid: true } or { valid: false, reason: string }.
 */
export function validateGenerationV2Strict(generation: unknown): {
  valid: boolean;
  reason?: string;
} {
  if (typeof generation !== "object" || generation === null) {
    return { valid: false, reason: "generation is not an object" };
  }
  const gen = generation as Record<string, unknown>;

  // Top-level schemaId
  if (gen["schemaId"] !== CONTEXT_GENERATION_V2_SCHEMA_ID) {
    return { valid: false, reason: `unknown or missing top-level schemaId: ${String(gen["schemaId"])}` };
  }

  // Required header
  const header = gen["header"];
  if (typeof header !== "object" || header === null) {
    return { valid: false, reason: "missing or invalid header" };
  }
  const hdr = header as Record<string, unknown>;

  // Header schemaId
  if (hdr["schemaId"] !== CONTEXT_GENERATION_HEADER_V1_SCHEMA_ID) {
    return { valid: false, reason: `unknown header schemaId: ${String(hdr["schemaId"])}` };
  }

  // Required header fields
  const requiredHeaderFields = [
    "contextGenerationId",
    "contextLineageId",
    "sourceSnapshotHash",
    "layerEnds",
    "contextGenerationHash",
    "createdAt",
  ];
  for (const field of requiredHeaderFields) {
    if (!(field in hdr)) {
      return { valid: false, reason: `missing required header field: ${field}` };
    }
  }

  // Layer ends validation
  const layerEnds = hdr["layerEnds"];
  if (!Array.isArray(layerEnds) || layerEnds.length !== 6) {
    return { valid: false, reason: "layerEnds must be an array of 6 numbers" };
  }
  const ends = layerEnds as number[];
  for (const e of ends) {
    if (typeof e !== "number" || !Number.isInteger(e) || e < 0) {
      return { valid: false, reason: "layerEnds must contain non-negative integers" };
    }
  }
  // Check non-decreasing (all elements are validated as integers above)
  for (let i = 0; i < 5; i++) {
    const curr = ends[i];
    const next = ends[i + 1];
    if (curr !== undefined && next !== undefined && curr > next) {
      return { valid: false, reason: "layerEnds must be non-decreasing" };
    }
  }

  // Required units
  const units = gen["units"];
  if (!Array.isArray(units)) {
    return { valid: false, reason: "units must be an array" };
  }
  if (ends[5] !== units.length) {
    return { valid: false, reason: `layerEnds[5] (${ends[5]}) must equal units.length (${units.length})` };
  }

  // Validate each unit
  for (let i = 0; i < units.length; i++) {
    const unit: unknown = units[i];
    const unitCheck = validateUnitV2Strict(unit);
    if (!unitCheck.valid) {
      return { valid: false, reason: `unit[${i}]: ${unitCheck.reason}` };
    }

    // Verify contentHash by recompute
    const unitRecord = unit as Record<string, unknown>;
    const unitHeader = unitRecord["header"] as Record<string, unknown>;
    const semanticContent = unitRecord["semanticContent"] as JsonValue;
    const expectedHash = computeSemanticContentHash(semanticContent);
    if (unitHeader["contentHash"] !== expectedHash) {
      return {
        valid: false,
        reason: `unit[${i}]: contentHash mismatch (expected ${expectedHash}, got ${unitHeader["contentHash"]})`,
      };
    }
  }

  // Verify contextGenerationHash by recompute
  const typedGeneration = generation as ContextGenerationV2;
  const expectedGenHash = computeContextGenerationHash({
    schemaId: CONTEXT_GENERATION_V2_SCHEMA_ID,
    contextLineageId: hdr["contextLineageId"] as string,
    sourceSnapshotHash: hdr["sourceSnapshotHash"] as string,
    units: typedGeneration.units,
    layerEnds: ends as [number, number, number, number, number, number],
  });
  if (hdr["contextGenerationHash"] !== expectedGenHash) {
    return {
      valid: false,
      reason: `contextGenerationHash mismatch (expected ${expectedGenHash}, got ${hdr["contextGenerationHash"]})`,
    };
  }

  return { valid: true };
}

/**
 * Strict validation for a single ContextUnitV2.
 * Checks schemaId, required header fields, and header/payload separation.
 */
export function validateUnitV2Strict(unit: unknown): { valid: boolean; reason?: string } {
  if (typeof unit !== "object" || unit === null) {
    return { valid: false, reason: "unit is not an object" };
  }
  const u = unit as Record<string, unknown>;

  // schemaId
  if (u["schemaId"] !== CONTEXT_UNIT_V2_SCHEMA_ID) {
    return { valid: false, reason: `unknown unit schemaId: ${String(u["schemaId"])}` };
  }

  // Required header
  const header = u["header"];
  if (typeof header !== "object" || header === null) {
    return { valid: false, reason: "missing or invalid unit header" };
  }
  const hdr = header as Record<string, unknown>;

  // Header schemaId
  if (hdr["schemaId"] !== CONTEXT_UNIT_HEADER_V1_SCHEMA_ID) {
    return { valid: false, reason: `unknown unit header schemaId: ${String(hdr["schemaId"])}` };
  }

  // Required header fields
  const requiredFields = ["contextUnitId", "source", "semanticSchemaId", "contentHash"];
  for (const field of requiredFields) {
    if (!(field in hdr)) {
      return { valid: false, reason: `missing required header field: ${field}` };
    }
  }

  // Validate source ref
  const source = hdr["source"];
  if (typeof source !== "object" || source === null) {
    return { valid: false, reason: "missing or invalid source ref" };
  }
  const src = source as Record<string, unknown>;
  if (src["schemaId"] !== CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID) {
    return { valid: false, reason: `unknown source ref schemaId: ${String(src["schemaId"])}` };
  }
  const requiredSourceFields = ["sourceSchemaId", "sourceId", "sourceHash"];
  for (const field of requiredSourceFields) {
    if (!(field in src)) {
      return { valid: false, reason: `missing required source field: ${field}` };
    }
  }
  if (typeof src["sourceHash"] !== "string" || src["sourceHash"].length === 0) {
    return { valid: false, reason: "source.sourceHash must be a non-empty string" };
  }

  // Validate string fields
  if (typeof hdr["contextUnitId"] !== "string" || hdr["contextUnitId"].length === 0) {
    return { valid: false, reason: "contextUnitId must be a non-empty string" };
  }
  if (typeof hdr["semanticSchemaId"] !== "string" || hdr["semanticSchemaId"].length === 0) {
    return { valid: false, reason: "semanticSchemaId must be a non-empty string" };
  }
  if (typeof hdr["contentHash"] !== "string" || hdr["contentHash"].length === 0) {
    return { valid: false, reason: "contentHash must be a non-empty string" };
  }

  // Header/payload separation: semanticContent must exist
  if (!("semanticContent" in u)) {
    return { valid: false, reason: "missing semanticContent" };
  }

  // Check for forbidden fields (layer/pLevel/sourceKind in header)
  if ("layer" in hdr || "pLevel" in hdr || "sourceKind" in hdr) {
    return { valid: false, reason: "unit header contains forbidden layer/pLevel/sourceKind field" };
  }

  return { valid: true };
}

/**
 * Check whether a unit carries forbidden layer/pLevel/sourceKind fields
 * (structural violation of the v27 contract).
 */
export function hasForbiddenUnitFields(unit: unknown): boolean {
  if (typeof unit !== "object" || unit === null) return false;
  const record = unit as Record<string, unknown>;
  const header = record["header"];
  if (typeof header === "object" && header !== null) {
    const headerRecord = header as Record<string, unknown>;
    return "layer" in headerRecord || "pLevel" in headerRecord || "sourceKind" in headerRecord;
  }
  return "layer" in record || "pLevel" in record || "sourceKind" in record;
}

// ---------------------------------------------------------------------------
// V1→V2 migration / rejection fence
// ---------------------------------------------------------------------------

/**
 * Legacy flat V1 generation shape (superseded). Used only by the migration
 * fence to detect and reject/convert old data.
 */
export interface LegacyFlatV1Generation {
  readonly layerEnds: readonly [number, number, number, number, number, number];
  readonly units: readonly LegacyFlatV1Unit[];
}

export interface LegacyFlatV1Unit {
  readonly contextUnitId: string;
  readonly sourceRef: {
    readonly sourceId: string;
    readonly sourceHash?: string;
  };
  readonly content: {
    readonly body: string;
    readonly contentHash: string;
  };
}

/**
 * Detect whether an unknown value is a legacy flat V1 generation (no schemaId,
 * no header structure). Returns true if it matches the old shape.
 */
export function isLegacyFlatV1Generation(value: unknown): value is LegacyFlatV1Generation {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if ("schemaId" in record && typeof record["schemaId"] === "string") {
    // Has a schemaId — it's a V2 (or tagged) generation, not flat V1
    return false;
  }
  return (
    "layerEnds" in record &&
    Array.isArray(record["layerEnds"]) &&
    (record["layerEnds"] as unknown[]).length === 6 &&
    "units" in record &&
    Array.isArray(record["units"])
  );
}

/**
 * Result of attempting to handle a V1 input at a V2 boundary.
 */
export type V1FenceResult =
  | { readonly outcome: "v2" }
  | { readonly outcome: "migrated"; readonly migrated: ContextGenerationV2 }
  | { readonly outcome: "rejected"; readonly reason: string };

/**
 * V1→V2 boundary fence. Called at every boundary that can receive
 * persisted/serialized old data.
 *
 * - If the value is already a valid V2 generation → "v2" (pass through).
 * - If the value is a legacy flat V1 generation → deterministic migration
 *   to V2 → "migrated".
 * - If the value is neither V2 nor a recognizable V1 shape → "rejected"
 *   (fail-closed).
 *
 * The migration is deterministic: each V1 unit maps to exactly one V2 unit
 * with the same contextUnitId, sourceHash from the V1 content (or a
 * placeholder if V1 sourceRef.sourceHash was optional), and body string
 * wrapped as semanticContent.
 */
export function v1ToF2Fence(
  value: unknown,
  contextLineageId: string,
  contextGenerationId: string,
  sourceSnapshotHash: string,
  createdAt: string,
): V1FenceResult {
  // Already V2? — validate strictly, not just by schemaId tag (#104)
  if (
    typeof value === "object" &&
    value !== null &&
    "schemaId" in value &&
    (value as Record<string, unknown>)["schemaId"] === CONTEXT_GENERATION_V2_SCHEMA_ID
  ) {
    const check = validateGenerationV2Strict(value);
    if (!check.valid) {
      return { outcome: "rejected", reason: `V2 tag present but validation failed: ${check.reason}` };
    }
    return { outcome: "v2" };
  }

  // Legacy flat V1?
  if (isLegacyFlatV1Generation(value)) {
    // Strict V1 validation: verify each unit has required nested fields
    const v1 = value as LegacyFlatV1Generation;
    for (let i = 0; i < v1.units.length; i++) {
      const v1u = v1.units[i];
      if (v1u?.contextUnitId === undefined || v1u?.sourceRef === undefined || v1u?.content === undefined) {
        return { outcome: "rejected", reason: `V1 unit[${i}] has missing required fields` };
      }
      if (typeof v1u.content.contentHash !== "string" || v1u.content.contentHash.length === 0) {
        return { outcome: "rejected", reason: `V1 unit[${i}] has missing contentHash` };
      }
    }

    const units: ContextUnitV2[] = v1.units.map((v1u) => {
      const sourceHash = v1u.sourceRef.sourceHash ?? v1u.content.contentHash;
      const header: ContextUnitHeaderV1 = {
        schemaId: CONTEXT_UNIT_HEADER_V1_SCHEMA_ID,
        contextUnitId: v1u.contextUnitId,
        source: {
          schemaId: CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
          sourceSchemaId: "iris.legacy_flat_v1.source",
          sourceId: v1u.sourceRef.sourceId,
          sourceHash,
        },
        semanticSchemaId: "iris.semantic.text_v1",
        contentHash: computeSemanticContentHash(v1u.content.body),
      };
      return {
        schemaId: CONTEXT_UNIT_V2_SCHEMA_ID,
        header,
        semanticContent: v1u.content.body,
      };
    });

    const generationHash = computeContextGenerationHash({
      schemaId: CONTEXT_GENERATION_V2_SCHEMA_ID,
      contextLineageId,
      sourceSnapshotHash,
      units,
      layerEnds: v1.layerEnds as [number, number, number, number, number, number],
    });

    const migrated: ContextGenerationV2 = {
      schemaId: CONTEXT_GENERATION_V2_SCHEMA_ID,
      header: {
        schemaId: CONTEXT_GENERATION_HEADER_V1_SCHEMA_ID,
        contextGenerationId,
        contextLineageId,
        sourceSnapshotHash,
        layerEnds: v1.layerEnds as [number, number, number, number, number, number],
        contextGenerationHash: generationHash,
        createdAt,
      },
      units,
    };

    // Migration output must pass the full strict V2 validator (#104)
    const outputCheck = validateGenerationV2Strict(migrated);
    if (!outputCheck.valid) {
      return { outcome: "rejected", reason: `migrated V2 output failed validation: ${outputCheck.reason}` };
    }

    return { outcome: "migrated", migrated };
  }

  return {
    outcome: "rejected",
    reason: "value is neither a valid V2 generation nor a recognizable flat V1 generation",
  };
}

// ---------------------------------------------------------------------------
// Generation hash computation
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

/**
 * Compute contextGenerationHash per the v27 spec:
 * Must cover generation schema identity + contextLineageId + sourceSnapshotHash +
 * ordered unit identity/content hashes + layerEnds.
 * Excludes contextGenerationHash itself and createdAt.
 */
export function computeContextGenerationHash(input: {
  schemaId: string;
  contextLineageId: string;
  sourceSnapshotHash: string;
  units: readonly ContextUnitV2[];
  layerEnds: readonly [number, number, number, number, number, number];
}): string {
  const hash = createHash("sha256");
  hash.update(input.schemaId, "utf8");
  hash.update("\0");
  hash.update(input.contextLineageId, "utf8");
  hash.update("\0");
  hash.update(input.sourceSnapshotHash, "utf8");
  hash.update("\0");

  for (const unit of input.units) {
    hash.update(unit.header.contextUnitId, "utf8");
    hash.update("\0");
    hash.update(unit.header.semanticSchemaId, "utf8");
    hash.update("\0");
    hash.update(unit.header.contentHash, "utf8");
    hash.update("\0");
    hash.update(unit.header.source.sourceId, "utf8");
    hash.update("\0");
    hash.update(unit.header.source.sourceHash, "utf8");
    hash.update("\0");
  }

  hash.update(input.layerEnds.join(","), "utf8");

  return hash.digest("hex");
}

/**
 * Compute a content hash for a semantic payload.
 * Uses canonical JSON serialization: deterministic key ordering for objects.
 * Two semantically equivalent JsonValue objects with different key insertion
 * order must hash identically (Notion: stable canonical JSON serialization).
 */
export function computeSemanticContentHash(content: JsonValue): string {
  const canonical = canonicalJsonStringify(content);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Canonical JSON serialization: recursively sorts object keys.
 * Produces a stable string representation regardless of insertion order.
 */
function canonicalJsonStringify(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonStringify).join(",")}]`;
  }
  const obj = value as Record<string, JsonValue>;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k] ?? null)}`);
  return `{${pairs.join(",")}}`;
}
