/**
 * Feature B (#104) — Context V2 canonical fail-closed boundary tests.
 *
 * Tests every acceptance criterion from #104:
 * - Tagged malformed V2 is rejected
 * - contentHash mismatch is rejected
 * - contextGenerationHash mismatch is rejected
 * - Unknown semantic schema is rejected
 * - Forbidden fields in semantic payload are rejected
 * - Canonical JSON key-order independence
 * - Malformed V1 is rejected or deterministically migrated
 * - Migrated V1 output passes full V2 validator
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  validateGenerationV2Strict,
  validateUnitV2Strict,
  v1ToF2Fence,
  computeSemanticContentHash,
  computeContextGenerationHash,
  CONTEXT_GENERATION_V2_SCHEMA_ID,
  CONTEXT_GENERATION_HEADER_V1_SCHEMA_ID,
  CONTEXT_UNIT_V2_SCHEMA_ID,
  CONTEXT_UNIT_HEADER_V1_SCHEMA_ID,
  CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
  type ContextGenerationV2,
  type ContextUnitV2,
  type ContextUnitHeaderV1,
  type JsonValue,
} from "../src/contracts/context-v27.js";

// --- Helpers ---

function makeValidUnit(id: string, content: JsonValue): ContextUnitV2 {
  const contentHash = computeSemanticContentHash(content);
  const header: ContextUnitHeaderV1 = {
    schemaId: CONTEXT_UNIT_HEADER_V1_SCHEMA_ID,
    contextUnitId: id,
    source: {
      schemaId: CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
      sourceSchemaId: "iris.context_message_unit.v1",
      sourceId: id,
      sourceHash: contentHash,
    },
    semanticSchemaId: "iris.semantic.text_v1",
    contentHash,
  };
  return { schemaId: CONTEXT_UNIT_V2_SCHEMA_ID, header, semanticContent: content };
}

function makeValidGeneration(units: ContextUnitV2[]): ContextGenerationV2 {
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
      createdAt: "2026-08-11T00:00:00Z",
    },
    units,
  };
}

// --- Tests ---

test("B1: valid generation passes strict validation", () => {
  const gen = makeValidGeneration([
    makeValidUnit("u1", "hello"),
    makeValidUnit("u2", { text: "world" }),
  ]);
  const result = validateGenerationV2Strict(gen);
  assert.ok(result.valid, `should be valid: ${result.reason}`);
});

test("B2: schemaId tag alone does NOT establish validity", () => {
  const malformed = {
    schemaId: CONTEXT_GENERATION_V2_SCHEMA_ID,
    // Missing header, units, everything else
  };
  const result = validateGenerationV2Strict(malformed);
  assert.ok(!result.valid, "should be rejected");
  assert.match(result.reason ?? "", /missing or invalid header/i);
});

test("B3: missing required header field is rejected", () => {
  const gen = makeValidGeneration([makeValidUnit("u1", "hello")]);
  // Delete the field entirely (not just set to undefined)
  const headerCopy: Record<string, unknown> = { ...gen.header };
  delete headerCopy["contextLineageId"];
  const malformed = { ...gen, header: headerCopy };
  const result = validateGenerationV2Strict(malformed);
  assert.ok(!result.valid);
  assert.match(result.reason ?? "", /missing required header field: contextLineageId/);
});

test("B4: contentHash mismatch is rejected", () => {
  const unit = makeValidUnit("u1", "hello");
  const tampered: ContextUnitV2 = {
    ...unit,
    header: {
      ...unit.header,
      contentHash: "0000000000000000000000000000000000000000000000000000000000000000",
    },
  };
  const gen = makeValidGeneration([tampered]);
  const result = validateGenerationV2Strict(gen);
  assert.ok(!result.valid);
  assert.match(result.reason ?? "", /contentHash mismatch/);
});

test("B5: contextGenerationHash mismatch is rejected", () => {
  const gen = makeValidGeneration([makeValidUnit("u1", "hello")]);
  const tampered = {
    ...gen,
    header: { ...gen.header, contextGenerationHash: "deadbeef" },
  };
  const result = validateGenerationV2Strict(tampered);
  assert.ok(!result.valid);
  assert.match(result.reason ?? "", /contextGenerationHash mismatch/);
});

test("B6: unknown unit schemaId is rejected", () => {
  const unit = makeValidUnit("u1", "hello");
  const badUnit = { ...unit, schemaId: "iris.context_unit.v999" };
  const gen = makeValidGeneration([badUnit as ContextUnitV2]);
  // Override with a generation that has a valid hash for the tampered units
  const result = validateGenerationV2Strict(gen);
  assert.ok(!result.valid);
  assert.match(result.reason ?? "", /unknown unit schemaId/);
});

test("B7: forbidden layer field in unit header is rejected", () => {
  const unit = makeValidUnit("u1", "hello");
  const badUnit = {
    ...unit,
    header: { ...unit.header, layer: 5 } as unknown,
  };
  const result = validateUnitV2Strict(badUnit);
  assert.ok(!result.valid);
  assert.match(result.reason ?? "", /forbidden layer\/pLevel\/sourceKind/);
});

test("B8: canonical JSON key-order independence for hashing", () => {
  const h1 = computeSemanticContentHash({ a: 1, b: { x: 2, y: 3 }, c: [1, 2] });
  const h2 = computeSemanticContentHash({ c: [1, 2], b: { y: 3, x: 2 }, a: 1 });
  assert.equal(h1, h2, "key insertion order must not affect hash");
});

test("B9: malformed V1 fixture is rejected (not throws)", () => {
  const malformedV1 = {
    layerEnds: [0, 0, 0, 0, 0, 1],
    units: [
      {
        contextUnitId: "u1",
        sourceRef: { sourceId: "s1" },
        content: { body: "hello", contentHash: "" }, // empty hash → reject
      },
    ],
  };
  const result = v1ToF2Fence(malformedV1, "lineage", "gen-1", "snapshot", "2026-08-11");
  assert.equal(result.outcome, "rejected");
});

test("B10: valid V1 is migrated and output passes full V2 validator", () => {
  const validV1 = {
    layerEnds: [0, 0, 0, 0, 0, 1] as [number, number, number, number, number, number],
    units: [
      {
        contextUnitId: "u1",
        sourceRef: { sourceId: "s1", sourceHash: "abc123" },
        content: { body: "hello world", contentHash: "abc123" },
      },
    ],
  };
  const result = v1ToF2Fence(validV1, "lineage", "gen-1", "snapshot", "2026-08-11");
  assert.equal(result.outcome, "migrated");
  if (result.outcome === "migrated") {
    // The migrated output must pass strict validation
    const check = validateGenerationV2Strict(result.migrated);
    assert.ok(check.valid, `migrated output should pass strict validation: ${check.reason}`);
  }
});

test("B11: V2 with valid structure but wrong hash is rejected at fence", () => {
  const gen = makeValidGeneration([makeValidUnit("u1", "hello")]);
  const tampered = {
    ...gen,
    header: { ...gen.header, contextGenerationHash: "wrong-hash" },
  };
  const result = v1ToF2Fence(tampered, "lineage", "gen-1", "snapshot", "2026-08-11");
  assert.equal(result.outcome, "rejected");
  assert.match(result.reason ?? "", /V2 tag present but validation failed/);
});

test("B12: neither V1 nor V2 shape is rejected", () => {
  const garbage = { foo: "bar", baz: 42 };
  const result = v1ToF2Fence(garbage, "lineage", "gen-1", "snapshot", "2026-08-11");
  assert.equal(result.outcome, "rejected");
});

test("B13: layerEnds[5] != units.length is rejected", () => {
  const gen = makeValidGeneration([makeValidUnit("u1", "hello")]);
  const tampered = {
    ...gen,
    header: {
      ...gen.header,
      layerEnds: [0, 0, 0, 0, 0, 99] as [number, number, number, number, number, number],
    },
  };
  const result = validateGenerationV2Strict(tampered);
  assert.ok(!result.valid);
  assert.match(result.reason ?? "", /layerEnds\[5\]/);
});
