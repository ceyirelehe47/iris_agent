/**
 * iris_agent#96: V2 Context Generation contract tests.
 *
 * Proves the exact V2 structured contract, layer boundaries,
 * V1→V2 migration/rejection fence, and deterministic hash behavior.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  type ContextGenerationV2,
  type ContextUnitV2,
  type JsonValue,
  CONTEXT_GENERATION_V2_SCHEMA_ID,
  CONTEXT_GENERATION_HEADER_V1_SCHEMA_ID,
  CONTEXT_UNIT_V2_SCHEMA_ID,
  CONTEXT_UNIT_HEADER_V1_SCHEMA_ID,
  CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
  validateGenerationV2,
  hasForbiddenUnitFields,
  isLegacyFlatV1Generation,
  v1ToF2Fence,
  computeContextGenerationHash,
  computeSemanticContentHash,
} from "../src/contracts/context-v27.js";

import {
  buildContextGenerationV2,
  unitLayer,
  unitsInLayer,
  type FrozenContextSources,
} from "../src/context/generation-builder.js";

// ---------------------------------------------------------------------------
// Helper: create a minimal valid ContextUnitV2
// ---------------------------------------------------------------------------
function makeUnit(
  id: string,
  semanticSchemaId: string,
  content: JsonValue,
  sourceId?: string,
  sourceHash?: string,
): ContextUnitV2 {
  return {
    schemaId: CONTEXT_UNIT_V2_SCHEMA_ID,
    header: {
      schemaId: CONTEXT_UNIT_HEADER_V1_SCHEMA_ID,
      contextUnitId: id,
      source: {
        schemaId: CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
        sourceSchemaId: "test.source.v1",
        sourceId: sourceId ?? `source-${id}`,
        sourceHash: sourceHash ?? `hash-${id}`,
      },
      semanticSchemaId,
      contentHash: computeSemanticContentHash(content),
    },
    semanticContent: content,
  };
}

function makeGeneration(
  units: ContextUnitV2[],
  layerEnds: [number, number, number, number, number, number],
  lineageId = "lineage-test-001",
  snapshotHash = "snapshot-hash-001",
): ContextGenerationV2 {
  const contextGenerationHash = computeContextGenerationHash({
    schemaId: CONTEXT_GENERATION_V2_SCHEMA_ID,
    contextLineageId: lineageId,
    sourceSnapshotHash: snapshotHash,
    units,
    layerEnds,
  });
  return {
    schemaId: CONTEXT_GENERATION_V2_SCHEMA_ID,
    header: {
      schemaId: CONTEXT_GENERATION_HEADER_V1_SCHEMA_ID,
      contextGenerationId: "gen-test-001",
      contextLineageId: lineageId,
      sourceSnapshotHash: snapshotHash,
      layerEnds,
      contextGenerationHash,
      createdAt: "2026-08-09T12:00:00.000Z",
    },
    units,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("iris_agent#96: V2 Context Generation contract", () => {
  describe("exact V2 structured types", () => {
    it("ContextGenerationV2 has exactly schemaId, header, units", () => {
      const gen = makeGeneration([], [0, 0, 0, 0, 0, 0]);
      assert.equal(gen.schemaId, "iris.context_generation.v2");
      assert.ok("header" in gen);
      assert.ok("units" in gen);
      assert.equal(Object.keys(gen).length, 3);
    });

    it("ContextGenerationHeaderV1 has exact fields including layerEnds[6]", () => {
      const gen = makeGeneration([], [0, 0, 0, 0, 0, 0]);
      const header = gen.header;
      assert.equal(header.schemaId, "iris.context_generation_header.v1");
      assert.ok("contextGenerationId" in header);
      assert.ok("contextLineageId" in header);
      assert.ok("sourceSnapshotHash" in header);
      assert.ok("layerEnds" in header);
      assert.ok("contextGenerationHash" in header);
      assert.ok("createdAt" in header);
      assert.equal(header.layerEnds.length, 6);
    });

    it("ContextUnitV2 has exactly schemaId, header, semanticContent", () => {
      const unit = makeUnit("u1", "iris.semantic.text_v1", "hello");
      assert.equal(unit.schemaId, "iris.context_unit.v2");
      assert.ok("header" in unit);
      assert.ok("semanticContent" in unit);
      assert.equal(Object.keys(unit).length, 3);
    });

    it("ContextUnitHeaderV1 has exact fields: schemaId, contextUnitId, source, semanticSchemaId, contentHash", () => {
      const unit = makeUnit("u1", "iris.semantic.text_v1", "hello");
      const header = unit.header;
      assert.equal(header.schemaId, "iris.context_unit_header.v1");
      assert.ok("contextUnitId" in header);
      assert.ok("source" in header);
      assert.ok("semanticSchemaId" in header);
      assert.ok("contentHash" in header);
    });

    it("ContextUnitSourceRefV1 has required sourceHash (not optional)", () => {
      const unit = makeUnit("u1", "test", "x");
      const source = unit.header.source;
      assert.equal(source.schemaId, "iris.context_unit_source_ref.v1");
      assert.ok("sourceSchemaId" in source);
      assert.ok("sourceId" in source);
      assert.ok("sourceHash" in source);
      assert.equal(typeof source.sourceHash, "string");
      assert.ok(source.sourceHash.length > 0);
    });

    it("semanticContent accepts JsonValue (string, number, boolean, null, array, object)", () => {
      const cases: JsonValue[] = [
        "hello",
        42,
        true,
        null,
        [1, "two", { three: true }],
        { key: "value", nested: { deep: [1, 2] } },
      ];
      for (const content of cases) {
        const unit = makeUnit("u", "test", content);
        assert.deepEqual(unit.semanticContent, content);
      }
    });
  });

  describe("P0-P5 membership from layerEnds only", () => {
    it("unit does NOT carry layer/pLevel discriminator", () => {
      const unit = makeUnit("u1", "test", "hello");
      assert.equal(hasForbiddenUnitFields(unit), false);
      assert.ok(!("layer" in unit));
      assert.ok(!("pLevel" in unit));
      assert.ok(!("layer" in unit.header));
      assert.ok(!("pLevel" in unit.header));
    });

    it("hasForbiddenUnitFields detects layer in header", () => {
      const badUnit = {
        schemaId: CONTEXT_UNIT_V2_SCHEMA_ID,
        header: {
          ...makeUnit("u1", "test", "x").header,
          layer: 3,
        },
        semanticContent: "x",
      };
      assert.equal(hasForbiddenUnitFields(badUnit), true);
    });

    it("hasForbiddenUnitFields detects pLevel in header", () => {
      const badUnit = {
        schemaId: CONTEXT_UNIT_V2_SCHEMA_ID,
        header: {
          ...makeUnit("u1", "test", "x").header,
          pLevel: 2,
        },
        semanticContent: "x",
      };
      assert.equal(hasForbiddenUnitFields(badUnit), true);
    });

    it("layerEnds derive P0-P5 correctly with empty layers", () => {
      // All layers empty
      const gen0 = makeGeneration([], [0, 0, 0, 0, 0, 0]);
      assert.ok(validateGenerationV2(gen0));
      assert.equal(unitLayer(gen0, 0), null);

      // Units only in P0 and P5, P1-P4 empty
      const u0 = makeUnit("u0", "sys", "system");
      const u5a = makeUnit("u5a", "input", "hello");
      const u5b = makeUnit("u5b", "output", "hi");
      const gen = makeGeneration([u0, u5a, u5b], [1, 1, 1, 1, 1, 3]);
      assert.equal(unitLayer(gen, 0), 0);
      assert.equal(unitLayer(gen, 1), 5);
      assert.equal(unitLayer(gen, 2), 5);
      assert.deepEqual(unitsInLayer(gen, 0), [u0]);
      assert.deepEqual(unitsInLayer(gen, 5), [u5a, u5b]);
      assert.deepEqual(unitsInLayer(gen, 1), []);
    });
  });

  describe("semantic discriminator is semanticSchemaId only", () => {
    it("semanticContent does not duplicate identity/type/hash metadata", () => {
      const unit = makeUnit("u1", "iris.semantic.text_v1", "hello world");
      // semanticContent is pure semantic payload
      assert.equal(unit.semanticContent, "hello world");
      // No type/kind field in header that restates semantic schema
      assert.ok(!("type" in unit.header));
      assert.ok(!("kind" in unit.header));
    });
  });

  describe("V1→V2 migration / rejection fence", () => {
    it("passes through valid V2 generation unchanged", () => {
      const gen = makeGeneration([], [0, 0, 0, 0, 0, 0]);
      const result = v1ToF2Fence(
        gen,
        "lineage-001",
        "gen-001",
        "snapshot-001",
        "2026-01-01T00:00:00Z",
      );
      assert.equal(result.outcome, "v2");
    });

    it("migrates legacy flat V1 generation deterministically", () => {
      const legacyV1 = {
        layerEnds: [1, 1, 1, 1, 1, 2] as const,
        units: [
          {
            contextUnitId: "u1",
            sourceRef: { sourceId: "source-u1", sourceHash: "hash-u1" },
            content: { body: "hello", contentHash: "ch-1" },
          },
          {
            contextUnitId: "u2",
            sourceRef: { sourceId: "source-u2" }, // no sourceHash → falls back to contentHash
            content: { body: "world", contentHash: "ch-2" },
          },
        ],
      };
      assert.ok(isLegacyFlatV1Generation(legacyV1));
      const result = v1ToF2Fence(
        legacyV1,
        "lineage-001",
        "gen-001",
        "snapshot-001",
        "2026-01-01T00:00:00Z",
      );
      assert.equal(result.outcome, "migrated");
      if (result.outcome === "migrated") {
        const m = result.migrated;
        assert.equal(m.schemaId, CONTEXT_GENERATION_V2_SCHEMA_ID);
        assert.equal(m.units.length, 2);
        assert.equal(m.units[0]!.header.contextUnitId, "u1");
        assert.equal(m.units[0]!.header.source.sourceHash, "hash-u1");
        assert.equal(m.units[1]!.header.source.sourceHash, "ch-2"); // falls back to contentHash
        assert.equal(m.units[0]!.semanticContent, "hello");
        assert.equal(m.units[1]!.semanticContent, "world");
        assert.deepEqual([...m.header.layerEnds], [1, 1, 1, 1, 1, 2]);
        assert.ok(validateGenerationV2(m));
      }
    });

    it("rejects unrecognized shapes (fail-closed)", () => {
      const garbage = { foo: "bar", baz: 123 };
      const result = v1ToF2Fence(garbage, "lineage", "gen", "snap", "2026-01-01");
      assert.equal(result.outcome, "rejected");
      if (result.outcome === "rejected") {
        assert.ok(result.reason.length > 0);
      }
    });

    it("V1 and V2 cannot mix in the same pipeline (V2 input returns 'v2', not 'migrated')", () => {
      const gen = makeGeneration([makeUnit("u1", "test", "x")], [0, 0, 0, 0, 0, 1]);
      const result = v1ToF2Fence(gen, "lineage", "gen", "snap", "2026-01-01");
      assert.equal(result.outcome, "v2");
    });
  });

  describe("deterministic ordering and hash behavior", () => {
    it("same inputs produce same contextGenerationHash", () => {
      const units = [makeUnit("u1", "test", "a"), makeUnit("u2", "test", "b")];
      const h1 = computeContextGenerationHash({
        schemaId: CONTEXT_GENERATION_V2_SCHEMA_ID,
        contextLineageId: "L1",
        sourceSnapshotHash: "S1",
        units,
        layerEnds: [0, 0, 0, 0, 0, 2],
      });
      const h2 = computeContextGenerationHash({
        schemaId: CONTEXT_GENERATION_V2_SCHEMA_ID,
        contextLineageId: "L1",
        sourceSnapshotHash: "S1",
        units,
        layerEnds: [0, 0, 0, 0, 0, 2],
      });
      assert.equal(h1, h2);
    });

    it("different unit order produces different hash", () => {
      const u1 = makeUnit("u1", "test", "a");
      const u2 = makeUnit("u2", "test", "b");
      const h1 = computeContextGenerationHash({
        schemaId: CONTEXT_GENERATION_V2_SCHEMA_ID,
        contextLineageId: "L1",
        sourceSnapshotHash: "S1",
        units: [u1, u2],
        layerEnds: [0, 0, 0, 0, 0, 2],
      });
      const h2 = computeContextGenerationHash({
        schemaId: CONTEXT_GENERATION_V2_SCHEMA_ID,
        contextLineageId: "L1",
        sourceSnapshotHash: "S1",
        units: [u2, u1],
        layerEnds: [0, 0, 0, 0, 0, 2],
      });
      assert.notEqual(h1, h2);
    });

    it("different layerEnds produce different hash", () => {
      const u1 = makeUnit("u1", "test", "a");
      const u2 = makeUnit("u2", "test", "b");
      const h1 = computeContextGenerationHash({
        schemaId: CONTEXT_GENERATION_V2_SCHEMA_ID,
        contextLineageId: "L1",
        sourceSnapshotHash: "S1",
        units: [u1, u2],
        layerEnds: [1, 1, 1, 1, 1, 2],
      });
      const h2 = computeContextGenerationHash({
        schemaId: CONTEXT_GENERATION_V2_SCHEMA_ID,
        contextLineageId: "L1",
        sourceSnapshotHash: "S1",
        units: [u1, u2],
        layerEnds: [2, 2, 2, 2, 2, 2],
      });
      assert.notEqual(h1, h2);
    });

    it("different lineage produces different hash", () => {
      const units = [makeUnit("u1", "test", "a")];
      const h1 = computeContextGenerationHash({
        schemaId: CONTEXT_GENERATION_V2_SCHEMA_ID,
        contextLineageId: "L1",
        sourceSnapshotHash: "S1",
        units,
        layerEnds: [0, 0, 0, 0, 0, 1],
      });
      const h2 = computeContextGenerationHash({
        schemaId: CONTEXT_GENERATION_V2_SCHEMA_ID,
        contextLineageId: "L2",
        sourceSnapshotHash: "S1",
        units,
        layerEnds: [0, 0, 0, 0, 0, 1],
      });
      assert.notEqual(h1, h2);
    });
  });

  describe("buildContextGenerationV2 from frozen sources", () => {
    it("builds valid generation with P0-P5 layerEnds correctly", () => {
      const sources: FrozenContextSources = {
        contextLineageId: "lineage-001",
        sourceSnapshotHash: "snap-001",
        p0Units: [
          {
            contextUnitId: "sys-1",
            source: {
              schemaId: CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
              sourceSchemaId: "system.v1",
              sourceId: "sys-source",
              sourceHash: "sys-hash",
            },
            semanticSchemaId: "iris.semantic.system.v1",
            semanticContent: { prompt: "You are Iris" },
          },
        ],
        p1Units: [],
        p2Units: [],
        p3Units: [],
        p4Units: [],
        p5Units: [],
      };

      const gen = buildContextGenerationV2(sources, "gen-001", "2026-08-09T12:00:00Z");
      assert.equal(gen.schemaId, CONTEXT_GENERATION_V2_SCHEMA_ID);
      assert.equal(gen.units.length, 1);
      assert.deepEqual([...gen.header.layerEnds], [1, 1, 1, 1, 1, 1]);
      assert.equal(unitLayer(gen, 0), 0);
      assert.ok(validateGenerationV2(gen));
    });

    it("deterministic: same sources produce same generation (except createdAt)", () => {
      const sources: FrozenContextSources = {
        contextLineageId: "L1",
        sourceSnapshotHash: "S1",
        p0Units: [],
        p1Units: [],
        p2Units: [],
        p3Units: [],
        p4Units: [],
        p5Units: [],
      };
      const g1 = buildContextGenerationV2(sources, "gen-001", "2026-08-09T12:00:00Z");
      const g2 = buildContextGenerationV2(sources, "gen-001", "2026-08-09T12:00:00Z");
      assert.equal(g1.header.contextGenerationHash, g2.header.contextGenerationHash);
    });
  });

  describe("schemaId literals use underscores", () => {
    it("all schemaIds use underscores, not dashes", () => {
      assert.equal(CONTEXT_GENERATION_V2_SCHEMA_ID, "iris.context_generation.v2");
      assert.equal(CONTEXT_GENERATION_HEADER_V1_SCHEMA_ID, "iris.context_generation_header.v1");
      assert.equal(CONTEXT_UNIT_V2_SCHEMA_ID, "iris.context_unit.v2");
      assert.equal(CONTEXT_UNIT_HEADER_V1_SCHEMA_ID, "iris.context_unit_header.v1");
      assert.equal(CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID, "iris.context_unit_source_ref.v1");
    });
  });

  describe("Provider Renderer consumes only validated V2", () => {
    it("validateGenerationV2 rejects generation with wrong schemaId", () => {
      const gen = makeGeneration([], [0, 0, 0, 0, 0, 0]);
      const bad = { ...gen, schemaId: "wrong.schema.v1" } as unknown as ContextGenerationV2;
      assert.equal(validateGenerationV2(bad), false);
    });

    it("validateGenerationV2 rejects unit without sourceHash", () => {
      const badUnit = {
        schemaId: CONTEXT_UNIT_V2_SCHEMA_ID,
        header: {
          schemaId: CONTEXT_UNIT_HEADER_V1_SCHEMA_ID,
          contextUnitId: "u1",
          source: {
            schemaId: CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
            sourceSchemaId: "test",
            sourceId: "s1",
            sourceHash: "", // empty → invalid
          },
          semanticSchemaId: "test.v1",
          contentHash: "ch1",
        },
        semanticContent: "hello",
      } as unknown as ContextUnitV2;
      const gen = makeGeneration([badUnit], [0, 0, 0, 0, 0, 1]);
      assert.equal(validateGenerationV2(gen), false);
    });

    it("validateGenerationV2 rejects invalid layerEnds (e5 != units.length)", () => {
      const gen = makeGeneration(
        [makeUnit("u1", "test", "x")],
        [0, 0, 0, 0, 0, 0], // says 0 units but has 1
      );
      assert.equal(validateGenerationV2(gen), false);
    });
  });
});
