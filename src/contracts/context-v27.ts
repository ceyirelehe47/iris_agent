/**
 * Roadmap v27 Canonical Context Contracts — thin shim over generated contracts.
 *
 * ALL type/interface definitions and schema ID constants are GENERATED from
 * contracts/source/schemas.json via scripts/codegen.mjs → contracts/generated/.
 * This file re-exports those generated types and adds non-schema-domain logic
 * (hash functions, validation wrappers, migration fence).
 *
 * No handwritten duplicate interface may exist in other files. The generated
 * types in contracts/generated/types.ts are the single machine authority.
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
 *   structure) are superseded; R0 provides V1→V2 migration or rejection fence.
 * - NO semantic escape hatch (iris.semantic.p5.unknown.v1 is FORBIDDEN).
 *   Unknown semantic schemas FAIL CLOSED.
 */

// ---------------------------------------------------------------------------
// Re-export ALL generated types and schema ID constants
// ---------------------------------------------------------------------------

export type {
  JsonPrimitive,
  JsonValue,
  RuntimeEventKind,
  HistorianDisposition,
  ContextMessageUnitLifecycleState,
  RawArchiveRefV1,
  SemanticDerivationRefsV1,
  ContextMessageUnitV1,
  ContextUnitSourceRefV1,
  ContextUnitHeaderV1,
  ContextUnitV2,
  ContextGenerationHeaderV1,
  ContextGenerationV2,
} from "../../contracts/generated/types.js";

export {
  IRIS_RAW_ARCHIVE_REF_V1_SCHEMA_ID,
  IRIS_SEMANTIC_DERIVATION_REFS_V1_SCHEMA_ID,
  IRIS_CONTEXT_MESSAGE_UNIT_V1_SCHEMA_ID,
  IRIS_CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
  IRIS_CONTEXT_UNIT_HEADER_V1_SCHEMA_ID,
  IRIS_CONTEXT_UNIT_V2_SCHEMA_ID,
  IRIS_CONTEXT_GENERATION_HEADER_V1_SCHEMA_ID,
  IRIS_CONTEXT_GENERATION_V2_SCHEMA_ID,
  KIND_TO_SEMANTIC_SCHEMA_ID,
  KNOWN_SEMANTIC_SCHEMA_IDS,
} from "../../contracts/generated/types.js";

// Re-export with legacy names for backward compatibility with existing imports
export {
  IRIS_CONTEXT_GENERATION_V2_SCHEMA_ID as CONTEXT_GENERATION_V2_SCHEMA_ID,
  IRIS_CONTEXT_GENERATION_HEADER_V1_SCHEMA_ID as CONTEXT_GENERATION_HEADER_V1_SCHEMA_ID,
  IRIS_CONTEXT_UNIT_V2_SCHEMA_ID as CONTEXT_UNIT_V2_SCHEMA_ID,
  IRIS_CONTEXT_UNIT_HEADER_V1_SCHEMA_ID as CONTEXT_UNIT_HEADER_V1_SCHEMA_ID,
  IRIS_CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID as CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
  IRIS_CONTEXT_MESSAGE_UNIT_V1_SCHEMA_ID as CONTEXT_MESSAGE_UNIT_V1_SCHEMA_ID,
  IRIS_SEMANTIC_DERIVATION_REFS_V1_SCHEMA_ID as SEMANTIC_DERIVATION_REFS_V1_SCHEMA_ID,
} from "../../contracts/generated/types.js";

// ---------------------------------------------------------------------------
// Import for internal use
// ---------------------------------------------------------------------------

import type {
  JsonValue,
  RuntimeEventKind,
  HistorianDisposition,
  SemanticDerivationRefsV1,
  RawArchiveRefV1,
  ContextMessageUnitV1,
  ContextUnitV2,
  ContextUnitHeaderV1,
  ContextGenerationV2,
  ContextGenerationHeaderV1,
  ContextUnitSourceRefV1,
} from "../../contracts/generated/types.js";

import {
  IRIS_CONTEXT_GENERATION_V2_SCHEMA_ID as CONTEXT_GENERATION_V2_SCHEMA_ID,
  IRIS_CONTEXT_GENERATION_HEADER_V1_SCHEMA_ID as CONTEXT_GENERATION_HEADER_V1_SCHEMA_ID,
  IRIS_CONTEXT_UNIT_V2_SCHEMA_ID as CONTEXT_UNIT_V2_SCHEMA_ID,
  IRIS_CONTEXT_UNIT_HEADER_V1_SCHEMA_ID as CONTEXT_UNIT_HEADER_V1_SCHEMA_ID,
  IRIS_CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID as CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
  IRIS_CONTEXT_MESSAGE_UNIT_V1_SCHEMA_ID as CONTEXT_MESSAGE_UNIT_V1_SCHEMA_ID,
} from "../../contracts/generated/types.js";

// Import generated semantic validator
import { validateSemanticContent as generatedValidateSemanticContent } from "../../contracts/generated/validators.js";

// Re-export isKnownSemanticSchemaId for backward compatibility with tests
export { isKnownSemanticSchemaId } from "../../contracts/generated/validators.js";

// ---------------------------------------------------------------------------
// Generated semantic content validation (replaces handwritten registry)
// ---------------------------------------------------------------------------

/**
 * Validate semanticContent against the schema selected by semanticSchemaId.
 * Dispatches through the GENERATED validator registry.
 * Unknown semanticSchemaId → fail closed (no escape hatch).
 * Returns an error string if invalid, null if valid.
 */
export function validateSemanticContentForSchema(
  semanticSchemaId: string,
  semanticContent: unknown,
): string | null {
  const result = generatedValidateSemanticContent(semanticSchemaId, semanticContent);
  if (!result.valid) {
    return result.errors?.join("; ") ?? "semantic validation failed";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Context Ingest Port (non-schema-domain, kept here)
// ---------------------------------------------------------------------------

export type UnitDispositionFilter = "include" | "all";

export interface ContextIngestPort {
  ensureUnitsUpTo(runtimeSessionId: string, options?: { limit?: number }): ContextMessageUnitV1[];
  listUnits(
    runtimeSessionId: string,
    options?: {
      afterContextSeq?: number;
      limit?: number;
      disposition?: UnitDispositionFilter;
    },
  ): ContextMessageUnitV1[];
  close(): void;
}

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
  const ends = generation.header.layerEnds;
  const [e0, e1, e2, e3, e4, e5] = ends;
  const len = generation.units.length;
  return (
    0 <= (e0 ?? -1) &&
    (e0 ?? -1) <= (e1 ?? -1) &&
    (e1 ?? -1) <= (e2 ?? -1) &&
    (e2 ?? -1) <= (e3 ?? -1) &&
    (e3 ?? -1) <= (e4 ?? -1) &&
    (e4 ?? -1) <= (e5 ?? -1) &&
    (e5 ?? -1) === len &&
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
export const KNOWN_GENERATION_SCHEMA_IDS = new Set<string>([CONTEXT_GENERATION_V2_SCHEMA_ID]);
export const KNOWN_GENERATION_HEADER_SCHEMA_IDS = new Set<string>([
  CONTEXT_GENERATION_HEADER_V1_SCHEMA_ID,
]);
export const KNOWN_UNIT_SCHEMA_IDS = new Set<string>([CONTEXT_UNIT_V2_SCHEMA_ID]);
export const KNOWN_UNIT_HEADER_SCHEMA_IDS = new Set<string>([CONTEXT_UNIT_HEADER_V1_SCHEMA_ID]);
export const KNOWN_SOURCE_REF_SCHEMA_IDS = new Set<string>([CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID]);

/**
 * Strict fail-closed validation for ContextGenerationV2.
 *
 * Per #104 acceptance criteria:
 * - A schemaId tag alone does NOT establish validity.
 * - Every required nested field is checked (type, non-empty, format).
 * - contentHash is recomputed and verified.
 * - contextGenerationHash is recomputed and verified.
 * - Unknown schema IDs are rejected.
 * - Header/payload separation is enforced (no identity/type/hash in payload).
 * - createdAt must be a valid date-time string (FAIL CLOSED on malformed).
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
    return {
      valid: false,
      reason: `unknown or missing top-level schemaId: ${String(gen["schemaId"])}`,
    };
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

  // Required header fields with exact type validation (#104/#116)
  const stringFields: Record<string, string> = {
    contextGenerationId: "contextGenerationId",
    contextLineageId: "contextLineageId",
    sourceSnapshotHash: "sourceSnapshotHash",
    contextGenerationHash: "contextGenerationHash",
  };
  for (const [field, label] of Object.entries(stringFields)) {
    const val = hdr[field];
    if (typeof val !== "string" || val.length === 0) {
      return { valid: false, reason: `${label} must be a non-empty string` };
    }
  }

  // createdAt: must be a valid ISO date-time string (#116: FAIL CLOSED on malformed)
  const createdAt = hdr["createdAt"];
  if (typeof createdAt !== "string" || createdAt.length === 0) {
    return { valid: false, reason: "createdAt must be a non-empty string" };
  }
  const parsedDate = new Date(createdAt);
  if (isNaN(parsedDate.getTime())) {
    return { valid: false, reason: `createdAt is not a valid date-time: ${createdAt}` };
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
  // Check non-decreasing
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
    return {
      valid: false,
      reason: `layerEnds[5] (${ends[5]}) must equal units.length (${units.length})`,
    };
  }

  // Validate each unit
  for (let i = 0; i < units.length; i++) {
    const unit: unknown = units[i];
    const unitCheck = validateUnitV2Strict(unit);
    if (!unitCheck.valid) {
      return { valid: false, reason: `unit[${i}]: ${unitCheck.reason}` };
    }

    // Verify contentHash against the ONE canonical basis (#113):
    // - P5 units are 1:1 projections of durable ContextMessageUnitV1 rows.
    //   The durable contentHash is verified on the store read path; the V2
    //   projection must preserve it exactly through the source ref chain
    //   (contentHash === sourceHash).
    // - Static units (P0–P4) carry no kind/disposition/derivationRefs; their
    //   contentHash is the payload-plane hash recomputed here.
    const unitRecord = unit as Record<string, unknown>;
    const unitHeader = unitRecord["header"] as Record<string, unknown>;
    const source = unitHeader["source"] as Record<string, unknown>;
    const semanticContent = unitRecord["semanticContent"] as JsonValue;
    if (source["sourceSchemaId"] === CONTEXT_MESSAGE_UNIT_V1_SCHEMA_ID) {
      if (unitHeader["contentHash"] !== source["sourceHash"]) {
        return {
          valid: false,
          reason:
            `unit[${i}]: P5 contentHash must equal its durable source sourceHash ` +
            `(projected ${unitHeader["contentHash"]}, source ${source["sourceHash"]})`,
        };
      }
    } else {
      const expectedHash = computeSemanticContentHash(semanticContent);
      if (unitHeader["contentHash"] !== expectedHash) {
        return {
          valid: false,
          reason: `unit[${i}]: contentHash mismatch (expected ${expectedHash}, got ${unitHeader["contentHash"]})`,
        };
      }
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
 * Checks schemaId, required header fields, source ref validation, and
 * header/payload separation. Dispatches semantic validation through the
 * GENERATED validator registry.
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

  // Required header fields with exact type validation (#104/#116)
  if (typeof hdr["contextUnitId"] !== "string" || (hdr["contextUnitId"] as string).length === 0) {
    return { valid: false, reason: "contextUnitId must be a non-empty string" };
  }
  if (typeof hdr["semanticSchemaId"] !== "string" || (hdr["semanticSchemaId"] as string).length === 0) {
    return { valid: false, reason: "semanticSchemaId must be a non-empty string" };
  }
  if (typeof hdr["contentHash"] !== "string" || (hdr["contentHash"] as string).length === 0) {
    return { valid: false, reason: "contentHash must be a non-empty string" };
  }

  // Validate source ref with exact type checks (#116)
  const source = hdr["source"];
  if (typeof source !== "object" || source === null) {
    return { valid: false, reason: "missing or invalid source ref" };
  }
  const src = source as Record<string, unknown>;
  if (src["schemaId"] !== CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID) {
    return { valid: false, reason: `unknown source ref schemaId: ${String(src["schemaId"])}` };
  }
  // sourceSchemaId: non-empty string
  if (typeof src["sourceSchemaId"] !== "string" || (src["sourceSchemaId"] as string).length === 0) {
    return { valid: false, reason: "sourceSchemaId must be a non-empty string" };
  }
  // sourceId: non-empty string
  if (typeof src["sourceId"] !== "string" || (src["sourceId"] as string).length === 0) {
    return { valid: false, reason: "sourceId must be a non-empty string" };
  }
  // sourceHash: non-empty string
  if (typeof src["sourceHash"] !== "string" || (src["sourceHash"] as string).length === 0) {
    return { valid: false, reason: "sourceHash must be a non-empty string" };
  }

  // Header/payload separation: semanticContent must exist
  if (!("semanticContent" in u)) {
    return { valid: false, reason: "missing semanticContent" };
  }

  // Check for forbidden fields (layer/pLevel/sourceKind in header)
  if ("layer" in hdr || "pLevel" in hdr || "sourceKind" in hdr) {
    return { valid: false, reason: "unit header contains forbidden layer/pLevel/sourceKind field" };
  }

  // Generated schema-driven semanticContent validation by semanticSchemaId.
  // Unknown schema → fail closed (no iris.semantic.p5.unknown.v1 escape hatch).
  // Forbidden control metadata in payload → fail closed.
  const semanticSchemaId = hdr["semanticSchemaId"] as string;
  const semanticContent = u["semanticContent"];
  const schemaError = validateSemanticContentForSchema(semanticSchemaId, semanticContent);
  if (schemaError !== null) {
    return { valid: false, reason: `semantic validation failed: ${schemaError}` };
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
 * Note: migrated units use semanticSchemaId "iris.semantic.context_message.user.v1"
 * (a REAL semantic schema, NOT the forbidden iris.semantic.text_v1 or
 * iris.semantic.p5.unknown.v1 escape hatches). The sourceSchemaId is
 * "iris.legacy_flat_v1.source" which is ONLY used in the migration/source-ref
 * fence, NOT in the semantic payload registry.
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
      return {
        outcome: "rejected",
        reason: `V2 tag present but validation failed: ${check.reason}`,
      };
    }
    return { outcome: "v2" };
  }

  // Legacy flat V1?
  if (isLegacyFlatV1Generation(value)) {
    const v1 = value as LegacyFlatV1Generation;
    for (let i = 0; i < v1.units.length; i++) {
      const v1u = v1.units[i];
      if (
        v1u?.contextUnitId === undefined ||
        v1u?.contextUnitId === null ||
        v1u?.sourceRef === undefined ||
        v1u?.sourceRef === null ||
        v1u?.content === undefined ||
        v1u?.content === null
      ) {
        return { outcome: "rejected", reason: `V1 unit[${i}] has missing or null required fields` };
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
        // Use the user semantic schema for migrated text content
        semanticSchemaId: "iris.semantic.context_message.user.v1",
        // contentHash must cover the WRAPPED semanticContent the migration
        // emits ({role:"user", content: body}), so the strict validator's
        // recompute (hash of semanticContent) matches.
        contentHash: computeSemanticContentHash({ role: "user", content: v1u.content.body }),
      };
      return {
        schemaId: CONTEXT_UNIT_V2_SCHEMA_ID,
        header,
        semanticContent: { role: "user", content: v1u.content.body } as unknown as JsonValue,
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

    const outputCheck = validateGenerationV2Strict(migrated);
    if (!outputCheck.valid) {
      return {
        outcome: "rejected",
        reason: `migrated V2 output failed validation: ${outputCheck.reason}`,
      };
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
 */
export function computeSemanticContentHash(content: JsonValue): string {
  const canonical = canonicalJsonStringify(content);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * The one versioned canonical hash basis for the durable
 * ContextMessageUnitV1.contentHash (Feature A5, #113).
 */
export interface ContextMessageUnitContentHashBasisV1 {
  readonly semanticSchemaId: string;
  readonly kind: RuntimeEventKind;
  readonly historianDisposition: HistorianDisposition;
  readonly derivationRefs: SemanticDerivationRefsV1;
  readonly semanticContent: JsonValue;
}

export const CONTEXT_MESSAGE_UNIT_CONTENT_HASH_BASIS_VERSION =
  "iris.context_message_unit.content_hash.v1" as const;

export function computeContextMessageUnitContentHashV1(
  basis: ContextMessageUnitContentHashBasisV1,
): string {
  const canonical = canonicalJsonStringify({
    basis: CONTEXT_MESSAGE_UNIT_CONTENT_HASH_BASIS_VERSION,
    semanticSchemaId: basis.semanticSchemaId,
    kind: basis.kind,
    historianDisposition: basis.historianDisposition,
    derivationRefs: derivationRefsToJsonValue(basis.derivationRefs),
    semanticContent: basis.semanticContent,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function derivationRefsToJsonValue(refs: SemanticDerivationRefsV1): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = { schemaId: refs.schemaId };
  if (refs.memoryRefs !== undefined) {
    out["memoryRefs"] = [...refs.memoryRefs];
  }
  if (refs.compartmentIds !== undefined) {
    out["compartmentIds"] = [...refs.compartmentIds];
  }
  if (refs.workSnapshotVersion !== undefined) {
    out["workSnapshotVersion"] = refs.workSnapshotVersion;
  }
  if (refs.sourceContextMessageUnitIds !== undefined) {
    out["sourceContextMessageUnitIds"] = [...refs.sourceContextMessageUnitIds];
  }
  return out;
}

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
