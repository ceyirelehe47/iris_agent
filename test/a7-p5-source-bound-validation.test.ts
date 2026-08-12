/**
 * Feature A7 (#117): P5 source-bound semantic tamper detection.
 *
 * Tests that mutating semanticContent while keeping contentHash/sourceHash
 * unchanged is detected and fails closed at the validation/publish boundary.
 *
 * The P5 projection must prove that:
 * unit.header.contentHash === unit.header.source.sourceHash
 * AND this hash matches the ACTUAL content (not just a copied value).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  type ContextGenerationV2,
  type ContextUnitV2,
  type ContextMessageUnitV1,
  type JsonValue,
  CONTEXT_UNIT_V2_SCHEMA_ID,
  CONTEXT_UNIT_HEADER_V1_SCHEMA_ID,
  CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
  CONTEXT_GENERATION_V2_SCHEMA_ID,
  CONTEXT_GENERATION_HEADER_V1_SCHEMA_ID,
  CONTEXT_MESSAGE_UNIT_V1_SCHEMA_ID,
  KIND_TO_SEMANTIC_SCHEMA_ID,
  computeSemanticContentHash,
  computeContextGenerationHash,
  computeContextMessageUnitContentHashV1,
  validateGenerationV2Strict,
} from "../src/contracts/context-v27.js";

function makeP5UnitFromDurable(cmu: ContextMessageUnitV1): ContextUnitV2 {
  return {
    schemaId: CONTEXT_UNIT_V2_SCHEMA_ID,
    header: {
      schemaId: CONTEXT_UNIT_HEADER_V1_SCHEMA_ID,
      contextUnitId: cmu.contextUnitId,
      source: {
        schemaId: CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
        sourceSchemaId: CONTEXT_MESSAGE_UNIT_V1_SCHEMA_ID,
        sourceId: cmu.contextUnitId,
        sourceHash: cmu.contentHash,
      },
      semanticSchemaId: cmu.semanticSchemaId,
      contentHash: cmu.contentHash,
    },
    semanticContent: cmu.semanticContent,
  };
}

function makeValidDurableUnit(id: string, content: string): ContextMessageUnitV1 {
  const semanticContent: JsonValue = { role: "user", content };
  const kind = "user" as const;
  const semanticSchemaId = KIND_TO_SEMANTIC_SCHEMA_ID[kind];
  const contentHash = computeContextMessageUnitContentHashV1({
    semanticSchemaId,
    kind,
    historianDisposition: "include",
    derivationRefs: { schemaId: "iris.semantic_derivation_refs.v1" },
    semanticContent,
  });
  return {
    schemaId: CONTEXT_MESSAGE_UNIT_V1_SCHEMA_ID,
    contextUnitId: id,
    contextLineageId: "test-lineage",
    contextSeq: 0,
    runtimeEventId: "evt-1",
    kind,
    semanticSchemaId,
    semanticContent,
    historianDisposition: "include",
    contentHash,
    lifecycleState: "committed",
    createdAt: "2026-08-13T00:00:00Z",
  };
}

function makeGeneration(units: ContextUnitV2[]): ContextGenerationV2 {
  const layerEnds: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, units.length];
  const hash = computeContextGenerationHash({
    schemaId: CONTEXT_GENERATION_V2_SCHEMA_ID,
    contextLineageId: "test-lineage",
    sourceSnapshotHash: "test-snapshot",
    units,
    layerEnds,
  });
  return {
    schemaId: CONTEXT_GENERATION_V2_SCHEMA_ID,
    header: {
      schemaId: CONTEXT_GENERATION_HEADER_V1_SCHEMA_ID,
      contextGenerationId: "gen-1",
      contextLineageId: "test-lineage",
      sourceSnapshotHash: "test-snapshot",
      layerEnds,
      contextGenerationHash: hash,
      createdAt: "2026-08-13T00:00:00Z",
    },
    units,
  };
}

test("A7: valid P5 unit passes strict validation", () => {
  const cmu = makeValidDurableUnit("u1", "hello world");
  const unit = makeP5UnitFromDurable(cmu);
  const gen = makeGeneration([unit]);
  const result = validateGenerationV2Strict(gen);
  assert.ok(result.valid, `valid P5 unit should pass: ${result.reason}`);
});

test("A7 #117: mutate semanticContent only → validation MUST FAIL (tamper detection)", () => {
  const cmu = makeValidDurableUnit("u1", "original content");
  const unit = makeP5UnitFromDurable(cmu);

  // TAMPER: mutate semanticContent but keep contentHash and sourceHash unchanged
  const tamperedUnit: ContextUnitV2 = {
    ...unit,
    semanticContent: { role: "user", content: "TAMPERED CONTENT" },
    // contentHash and source.sourceHash are COPIED from the original (unchanged)
  };

  const gen = makeGeneration([tamperedUnit]);
  const result = validateGenerationV2Strict(gen);

  // The strict validator checks: for P5 units (sourceSchemaId === ContextMessageUnitV1),
  // contentHash must equal source.sourceHash. Both are the SAME copied value here,
  // so that check passes. BUT the validator should ALSO recompute the hash from
  // the actual semanticContent to detect tampering.
  //
  // Currently the validator only checks contentHash === sourceHash for P5 units.
  // A7 requires: recompute the durable hash from the current semanticContent and
  // verify it matches. This detects semantic tampering even when contentHash
  // and sourceHash are both copied from the original.
  //
  // If this test FAILS (result.valid === true), it means the validator has a
  // blind spot: it trusts the copied hash without recomputing from content.
  assert.ok(
    !result.valid,
    "P5 semantic tamper MUST be detected: mutated semanticContent with " +
      "unchanged contentHash/sourceHash must fail validation. " +
      `Got: ${result.reason ?? "passed"}. ` +
      "The validator must recompute the durable hash from semanticContent, " +
      "not just check contentHash === sourceHash.",
  );
});

test("A7: legacy_committed_unknown lifecycle state is recognized", () => {
  // The legacy fence state should be a valid lifecycle state
  const cmu = makeValidDurableUnit("u1", "legacy");
  const legacyUnit: ContextMessageUnitV1 = {
    ...cmu,
    lifecycleState: "legacy_committed_unknown",
  };
  assert.equal(legacyUnit.lifecycleState, "legacy_committed_unknown");
});
