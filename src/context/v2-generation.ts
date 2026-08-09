import { createHash } from "node:crypto";

import type { ContextMessageUnit } from "../contracts/context-units.js";
import {
  type ContextGenerationV2,
  type ContextMessageUnitV1,
  type ContextUnitV2,
  type JsonValue,
  computeLayerEnds,
  isV1ContextUnit,
  validateGenerationV2,
} from "../contracts/context-v27.js";
import { canonicalJson } from "../contracts/tool.js";

/**
 * Roadmap v27 V2 Context generation builder (01 Context Assembly).
 *
 * Builds a validated, in-memory ContextGenerationV2 from the P0–P5
 * authoritative sources:
 *
 *   P0  system prompt            → one unit (iris.system.v1)
 *   P1  persona snapshot         → one unit (iris.persona.v1)
 *   P2  stable declarations      → one unit (iris.declarations.v1)
 *   P3  compartments             → zero..n units (iris.compartment.v1)
 *   P4  memory items             → zero..n units (iris.memory.v1)
 *   P5  committed ContextMessageUnitV1 → 1:1 deterministic projection
 *                                    (iris.message.*.v1)
 *
 * Invariants (v27):
 * - Units are in-memory only; nothing here persists.
 * - Identity = contextUnitId (stable across rebuilds, never array index).
 * - Order = P0→P5; within P5, ascending contextSeq (the durable ordering key).
 * - Every unit's contentHash = sha256(canonicalJson(semanticContent));
 *   contextGenerationHash covers generation schema identity + contextLineageId
 *   + sourceSnapshotHash + ordered unit identity/content hash + layerEnds
 *   (excludes itself and createdAt).
 * - V1 flat DTOs are rejected (no V1/V2 mixing).
 */

// ---- Semantic schema ids (the ONLY semantic discriminator per unit) ----

export const SEMANTIC_SCHEMA_SYSTEM = "iris.system.v1";
export const SEMANTIC_SCHEMA_PERSONA = "iris.persona.v1";
export const SEMANTIC_SCHEMA_DECLARATIONS = "iris.declarations.v1";
export const SEMANTIC_SCHEMA_COMPARTMENT = "iris.compartment.v1";
export const SEMANTIC_SCHEMA_MEMORY = "iris.memory.v1";
export const SEMANTIC_SCHEMA_MESSAGE_INPUT = "iris.message.input.v1";
export const SEMANTIC_SCHEMA_MESSAGE_OUTPUT = "iris.message.output.v1";
export const SEMANTIC_SCHEMA_MESSAGE_TOOL_CALL = "iris.message.tool_call.v1";
export const SEMANTIC_SCHEMA_MESSAGE_TOOL_RESULT = "iris.message.tool_result.v1";

// ---- Source schema ids (schema identity of each authoritative source) ----

export const SOURCE_SCHEMA_SYSTEM_PROMPT = "iris.system_prompt.v1";
export const SOURCE_SCHEMA_PERSONA_SNAPSHOT = "iris.persona_snapshot.v1";
export const SOURCE_SCHEMA_DECLARATIONS_SNAPSHOT = "iris.declarations_snapshot.v1";
export const SOURCE_SCHEMA_COMPARTMENT = "iris.compartment.v1";
export const SOURCE_SCHEMA_MEMORY = "iris.memory.v1";
export const SOURCE_SCHEMA_CONTEXT_MESSAGE_UNIT = "iris.context_message_unit.v1";

/** v27 unitType → semanticSchemaId (P5). Unknown types fail closed. */
export function semanticSchemaIdForUnitType(unitType: ContextMessageUnitV1["unitType"]): string {
  switch (unitType) {
    case "input":
      return SEMANTIC_SCHEMA_MESSAGE_INPUT;
    case "output":
      return SEMANTIC_SCHEMA_MESSAGE_OUTPUT;
    case "tool_call":
      return SEMANTIC_SCHEMA_MESSAGE_TOOL_CALL;
    case "tool_result":
      return SEMANTIC_SCHEMA_MESSAGE_TOOL_RESULT;
    case "system":
      return SEMANTIC_SCHEMA_SYSTEM;
    case "operational":
      return SEMANTIC_SCHEMA_MESSAGE_OUTPUT;
  }
}

// ---- Source inputs (authoritative, immutable) ----

export interface V2P0Source {
  systemPromptId: string;
  text: string;
  sourceHash: string;
}

export interface V2P1Source {
  personaSnapshotId: string;
  text: string;
  sourceHash: string;
}

export interface V2P2Source {
  declarationVersion: string;
  text: string;
  sourceHash: string;
}

export interface V2P3Source {
  compartmentId: string;
  text: string;
  sourceHash?: string;
}

export interface V2P4Source {
  memoryRef: string;
  text: string;
  sourceHash?: string;
}

/** One committed durable unit + its canonical provider-visible content. */
export interface V2P5Source {
  unit: ContextMessageUnitV1;
  semanticContent: JsonValue;
}

export interface V2GenerationInput {
  lineageId: string;
  runtimeSessionId: string;
  /** contextSourceSnapshotId — identity of the prepared P0-P2 snapshot. */
  generationSourceId: string;
  /** sha256 over the frozen P0-P2 source contents (PreparedV2Sources.sourceSnapshotHash). */
  sourceSnapshotHash: string;
  /** Optional build timestamp (defaults to now). Excluded from all hashes. */
  createdAt?: string;
  p0: V2P0Source;
  p1: V2P1Source;
  p2: V2P2Source;
  p3: readonly V2P3Source[];
  p4: readonly V2P4Source[];
  p5: readonly V2P5Source[];
}

// ---- Helpers ----

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Narrow a provider payload to JsonValue. Payloads are JSON wire DTOs by
 * construction (see ContextMessageUnit.payload), so this cast is lossless.
 */
export function payloadAsJsonValue(payload: unknown): JsonValue {
  return payload as unknown as JsonValue;
}

/**
 * v27 contextGenerationHash basis: generation schema identity + contextLineageId
 * + sourceSnapshotHash + ordered unit identity/content hash + layerEnds.
 * Excludes itself and createdAt.
 */
function contextGenerationHashOf(
  scope: {
    contextLineageId: string;
    sourceSnapshotHash: string;
    layerEnds: readonly [number, number, number, number, number, number];
  },
  units: readonly ContextUnitV2[],
): string {
  return sha256(
    canonicalJson({
      schemaId: "iris.context_generation.v2",
      contextLineageId: scope.contextLineageId,
      sourceSnapshotHash: scope.sourceSnapshotHash,
      units: units.map((unit) => [unit.header.contextUnitId, unit.header.contentHash]),
      layerEnds: [...scope.layerEnds],
    }),
  );
}

/**
 * Narrow projection: R2 store ContextMessageUnit → durable
 * ContextMessageUnitV1. Identity/ordering/hash are preserved 1:1; lifecycle
 * state is "committed" (the store only holds committed units).
 */
export function projectStoreUnitToV1(unit: ContextMessageUnit): ContextMessageUnitV1 {
  const unitType = v1UnitTypeOf(unit.unitType);
  const disposition = v1DispositionOf(unit.disposition);
  return {
    contextUnitId: unit.unitId,
    contextSeq: unit.contextSeq,
    runtimeEventId: unit.runtimeEventId ?? unit.sourceEventId,
    unitType,
    disposition,
    contentHash: unit.contentHash,
    lifecycleState: "committed",
  };
}

function v1UnitTypeOf(unitType: ContextMessageUnit["unitType"]): ContextMessageUnitV1["unitType"] {
  switch (unitType) {
    case "input":
      return "input";
    case "assistant":
      return "output";
    case "tool_result":
      return "tool_result";
  }
}

function v1DispositionOf(
  disposition: ContextMessageUnit["disposition"],
): ContextMessageUnitV1["disposition"] {
  switch (disposition) {
    case "include":
      return "include";
    case "reference_only":
      return "reference_only";
    case "exclude":
    case "retired":
      return "exclude";
  }
}

/**
 * V1→V2 rejection fence: legacy flat units (sourceRef + content, no
 * schemaId/header structure) must not be smuggled into the P5 input — even
 * under a renamed DTO. Throws on the first offender (fail closed).
 */
export function assertNoLegacyFlatUnitShape(p5: readonly V2P5Source[], context: string): void {
  for (const item of p5) {
    if (isV1ContextUnit(item.unit)) {
      throw new Error(
        `v2-generation: ${context} carries a legacy flat unit (sourceRef+content, ` +
          "no structured header) — V1/V2 mixing is forbidden",
      );
    }
  }
}

// ---- Builder ----

function headerFor(
  contextUnitId: string,
  sourceSchemaId: string,
  sourceId: string,
  sourceHash: string,
  semanticSchemaId: string,
  semanticContent: JsonValue,
): ContextUnitV2["header"] {
  return {
    schemaId: "iris.context_unit_header.v1",
    contextUnitId,
    source: {
      schemaId: "iris.context_unit_source_ref.v1",
      sourceSchemaId,
      sourceId,
      sourceHash,
    },
    semanticSchemaId,
    contentHash: sha256(canonicalJson(semanticContent)),
  };
}

/**
 * Build a validated ContextGenerationV2 from the P0–P5 authoritative sources.
 * Deterministic: same input → same generation (ids, hashes, order). Throws on
 * any invariant violation (fail closed) — the generation is validated before
 * return.
 */
export function buildGenerationV2(input: V2GenerationInput): ContextGenerationV2 {
  assertNoLegacyFlatUnitShape(input.p5, `lineage ${input.lineageId}`);

  const units: ContextUnitV2[] = [];
  const p0: ContextUnitV2 = {
    schemaId: "iris.context_unit.v2",
    header: headerFor(
      `system-${input.p0.systemPromptId}`,
      SOURCE_SCHEMA_SYSTEM_PROMPT,
      input.p0.systemPromptId,
      input.p0.sourceHash,
      SEMANTIC_SCHEMA_SYSTEM,
      input.p0.text,
    ),
    semanticContent: input.p0.text,
  };
  units.push(p0);

  const p1: ContextUnitV2 = {
    schemaId: "iris.context_unit.v2",
    header: headerFor(
      `persona-${input.p1.personaSnapshotId}`,
      SOURCE_SCHEMA_PERSONA_SNAPSHOT,
      input.p1.personaSnapshotId,
      input.p1.sourceHash,
      SEMANTIC_SCHEMA_PERSONA,
      input.p1.text,
    ),
    semanticContent: input.p1.text,
  };
  units.push(p1);

  const p2: ContextUnitV2 = {
    schemaId: "iris.context_unit.v2",
    header: headerFor(
      `declarations-${input.p2.declarationVersion}`,
      SOURCE_SCHEMA_DECLARATIONS_SNAPSHOT,
      input.p2.declarationVersion,
      input.p2.sourceHash,
      SEMANTIC_SCHEMA_DECLARATIONS,
      input.p2.text,
    ),
    semanticContent: input.p2.text,
  };
  units.push(p2);

  for (const source of input.p3) {
    units.push({
      schemaId: "iris.context_unit.v2",
      header: headerFor(
        `compartment-${source.compartmentId}`,
        SOURCE_SCHEMA_COMPARTMENT,
        source.compartmentId,
        source.sourceHash ?? sha256(source.text),
        SEMANTIC_SCHEMA_COMPARTMENT,
        source.text,
      ),
      semanticContent: source.text,
    });
  }

  for (const source of input.p4) {
    units.push({
      schemaId: "iris.context_unit.v2",
      header: headerFor(
        `memory-${source.memoryRef}`,
        SOURCE_SCHEMA_MEMORY,
        source.memoryRef,
        source.sourceHash ?? sha256(source.text),
        SEMANTIC_SCHEMA_MEMORY,
        source.text,
      ),
      semanticContent: source.text,
    });
  }

  // P5: 1:1 deterministic projection, ordered by the durable contextSeq.
  // Identity (contextUnitId) is preserved from the durable unit — never
  // re-derived from the array position (iris_agent#6).
  const p5Ordered = [...input.p5].sort((a, b) => a.unit.contextSeq - b.unit.contextSeq);
  const seenIds = new Set<string>();
  for (const item of p5Ordered) {
    if (seenIds.has(item.unit.contextUnitId)) {
      throw new Error(
        `v2-generation: duplicate P5 contextUnitId ${item.unit.contextUnitId} — ` +
          "unit identity must be unique within a generation",
      );
    }
    seenIds.add(item.unit.contextUnitId);
    units.push({
      schemaId: "iris.context_unit.v2",
      header: headerFor(
        item.unit.contextUnitId,
        SOURCE_SCHEMA_CONTEXT_MESSAGE_UNIT,
        item.unit.contextUnitId,
        item.unit.contentHash,
        semanticSchemaIdForUnitType(item.unit.unitType),
        item.semanticContent,
      ),
      semanticContent: item.semanticContent,
    });
  }

  const layerEnds = computeLayerEnds([1, 1, 1, input.p3.length, input.p4.length, p5Ordered.length]);
  const header: ContextGenerationV2["header"] = {
    schemaId: "iris.context_generation_header.v1",
    contextGenerationId: `gen-${sha256(
      `${input.lineageId}\0${input.runtimeSessionId}\0${input.generationSourceId}\0${input.sourceSnapshotHash}`,
    )}`,
    contextLineageId: input.lineageId,
    sourceSnapshotHash: input.sourceSnapshotHash,
    layerEnds,
    contextGenerationHash: contextGenerationHashOf(
      {
        contextLineageId: input.lineageId,
        sourceSnapshotHash: input.sourceSnapshotHash,
        layerEnds,
      },
      units,
    ),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  const generation: ContextGenerationV2 = {
    schemaId: "iris.context_generation.v2",
    header,
    units,
  };

  if (!validateGenerationV2(generation)) {
    throw new Error("v2-generation: built generation failed layerEnds/schema validation");
  }
  return generation;
}

/**
 * Verify generation integrity: every unit's contentHash must be
 * sha256(canonicalJson(semanticContent)) and contextGenerationHash must be the
 * v27 basis hash. Also re-runs the structural layerEnds validation.
 */
export function verifyGenerationHashesV2(generation: ContextGenerationV2): boolean {
  if (!validateGenerationV2(generation)) {
    return false;
  }
  for (const unit of generation.units) {
    if (unit.header.contentHash !== sha256(canonicalJson(unit.semanticContent))) {
      return false;
    }
  }
  return (
    generation.header.contextGenerationHash ===
    contextGenerationHashOf(generation.header, generation.units)
  );
}
