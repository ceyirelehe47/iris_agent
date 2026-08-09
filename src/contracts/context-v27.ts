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

export type ContextUnitType =
  | "input"
  | "output"
  | "tool_call"
  | "tool_result"
  | "system"
  | "operational";

export type ContextMessageUnitDisposition = "include" | "reference_only" | "exclude";

export interface RawArchiveRefV1 {
  readonly runtimeSessionId: string;
  readonly entryId: string;
  readonly sourceRevision?: string;
}

/**
 * A durable, identity-level Context semantic unit stored in context.db.
 * Has a global monotonic contextSeq within its lineage, carries lifecycle
 * state, and is the Historian's normal input. When selected for P5, it
 * projects 1:1 into a generation-level ContextUnitV2.
 */
export interface ContextMessageUnitV1 {
  /** Stable identity within the lineage. */
  readonly contextUnitId: string;
  /** Global monotonic sequence within the lineage. Primary ordering key. */
  readonly contextSeq: number;
  /** The canonical RuntimeEvent that produced this unit. */
  readonly runtimeEventId: string;
  /** Semantic unit type. */
  readonly unitType: ContextUnitType;
  /** Whether this unit is included in generation, reference-only, or excluded. */
  readonly disposition: ContextMessageUnitDisposition;
  /** Content hash for provenance verification. */
  readonly contentHash: string;
  /**
   * Lifecycle state
   * (committed/historian_eligible/historian_claimed/compartmentalized_pending_bust/
   * represented_in_p3/retired).
   */
  readonly lifecycleState: ContextMessageUnitLifecycleState;
  /** Optional raw archive reference (for recovery/audit only). */
  readonly rawArchiveRef?: RawArchiveRefV1;
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
 */
export interface SemanticDerivationRefsV1 {
  readonly memoryRefs: readonly string[];
  readonly compartmentIds: readonly string[];
  readonly sourceContextMessageUnitIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Schema ID constants (for migration/fencing checks)
// ---------------------------------------------------------------------------

export const CONTEXT_GENERATION_V2_SCHEMA_ID = "iris.context_generation.v2" as const;
export const CONTEXT_GENERATION_HEADER_V1_SCHEMA_ID = "iris.context_generation_header.v1" as const;
export const CONTEXT_UNIT_V2_SCHEMA_ID = "iris.context_unit.v2" as const;
export const CONTEXT_UNIT_HEADER_V1_SCHEMA_ID = "iris.context_unit_header.v1" as const;
export const CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID = "iris.context_unit_source_ref.v1" as const;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate that a ContextGenerationV2 satisfies the v27 layerEnds constraint:
 * 0 <= e0 <= e1 <= e2 <= e3 <= e4 <= e5 == units.length
 */
export function validateGenerationV2(generation: ContextGenerationV2): boolean {
  const [e0, e1, e2, e3, e4, e5] = generation.header.layerEnds;
  const len = generation.units.length;
  return (
    0 <= e0 && e0 <= e1 && e1 <= e2 && e2 <= e3 && e3 <= e4 && e4 <= e5 && e5 === len &&
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
 * Check whether a unit carries forbidden layer/pLevel/sourceKind fields
 * (structural violation of the v27 contract).
 */
export function hasForbiddenUnitFields(unit: unknown): boolean {
  if (typeof unit !== "object" || unit === null) return false;
  const record = unit as Record<string, unknown>;
  const header = record["header"];
  if (typeof header === "object" && header !== null) {
    const headerRecord = header as Record<string, unknown>;
    return (
      "layer" in headerRecord ||
      "pLevel" in headerRecord ||
      "sourceKind" in headerRecord
    );
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
  // Already V2?
  if (
    typeof value === "object" &&
    value !== null &&
    "schemaId" in value &&
    (value as Record<string, unknown>)["schemaId"] === CONTEXT_GENERATION_V2_SCHEMA_ID
  ) {
    return { outcome: "v2" };
  }

  // Legacy flat V1?
  if (isLegacyFlatV1Generation(value)) {
    const v1 = value as LegacyFlatV1Generation;
    const units: ContextUnitV2[] = v1.units.map((v1u) => {
      const sourceHash =
        v1u.sourceRef.sourceHash ?? v1u.content.contentHash;
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
        contentHash: v1u.content.contentHash,
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
 * Compute a content hash for a semantic payload (deterministic canonical JSON).
 */
export function computeSemanticContentHash(content: JsonValue): string {
  const canonical = JSON.stringify(content);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
