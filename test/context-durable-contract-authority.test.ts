/**
 * Feature A (#103) architecture gate: no second P5 semantic schema map,
 * and the durable ContextMessageUnitV1 is the single authority for semantic
 * schema identity in P5 projection.
 *
 * The generation builder MUST reuse the durable unit's semanticSchemaId
 * 1:1 — it must NOT contain a local P5_SEMANTIC_SCHEMA_MAP or equivalent
 * second discriminator.
 */
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";

import {
  CONTEXT_MESSAGE_UNIT_V1_SCHEMA_ID,
  KIND_TO_SEMANTIC_SCHEMA_ID,
  computeSemanticContentHash,
  isKnownSemanticSchemaId,
  validateSemanticContentForSchema,
  validateUnitV2Strict,
  CONTEXT_UNIT_V2_SCHEMA_ID,
  CONTEXT_UNIT_HEADER_V1_SCHEMA_ID,
  CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
} from "../src/contracts/context-v27.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

test("Feature A: generation-builder.ts contains no active P5_SEMANTIC_SCHEMA_MAP", () => {
  const builderPath = path.join(REPO_ROOT, "src", "context", "generation-builder.ts");
  const content = fs.readFileSync(builderPath, "utf8");
  // Strip comments to check only active code
  const codeOnly = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(
    !codeOnly.includes("P5_SEMANTIC_SCHEMA_MAP"),
    "P5_SEMANTIC_SCHEMA_MAP must not exist as active code in generation-builder.ts — the durable unit's semanticSchemaId is reused 1:1",
  );
});

test("Feature A: ContextMessageUnitV1 schemaId constant exists", () => {
  assert.equal(CONTEXT_MESSAGE_UNIT_V1_SCHEMA_ID, "iris.context_message_unit.v1");
});

test("Feature A: KIND_TO_SEMANTIC_SCHEMA_ID maps all RuntimeEventKind values", () => {
  const map = KIND_TO_SEMANTIC_SCHEMA_ID as Record<string, string>;
  const expectedKinds = [
    "user",
    "assistant",
    "tool_call",
    "tool_result",
    "body_event",
    "operational",
  ];
  for (const kind of expectedKinds) {
    assert.ok(map[kind], `KIND_TO_SEMANTIC_SCHEMA_ID must map kind "${kind}"`);
    assert.ok(
      map[kind].startsWith("iris.semantic."),
      `Semantic schema ID for "${kind}" must follow the iris.semantic.* convention`,
    );
  }
});

test("Feature A: computeSemanticContentHash is canonical (key-order independent)", () => {
  // Two objects with same content but different key insertion order must hash identically
  const hash1 = computeSemanticContentHash({ a: 1, b: 2, c: 3 });
  const hash2 = computeSemanticContentHash({ c: 3, b: 2, a: 1 });
  assert.equal(
    hash1,
    hash2,
    "Objects with same content but different key order must hash identically",
  );
});

test("Feature A: no handwritten duplicate durable Context unit interface in production src/", () => {
  // The canonical ContextMessageUnitV1 lives in context-v27.ts.
  // Check that no other production source file defines a competing durable
  // Context unit interface — STRUCTURAL check, not name-based (#106).
  // A competing interface is one that defines durable semantic identity fields
  // (contextUnitId + contentHash + semanticSchemaId) under ANY name.
  const srcDir = path.join(REPO_ROOT, "src");
  function walk(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : [full];
    });
  }
  const tsFiles = walk(srcDir).filter(
    (f) => f.endsWith(".ts") && !f.includes("context-v27.ts") && !f.includes("context-units.ts"),
  );
  for (const f of tsFiles) {
    const content = fs.readFileSync(f, "utf8");
    // Strip comments to check only active code
    const codeOnly = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    // Detect a competing durable unit interface: any interface that has
    // BOTH contextUnitId AND contentHash AND semanticSchemaId (the durable
    // identity signature) — regardless of the interface name.
    // This catches renamed duplicates like "ContextUnit", "DurableUnit", etc.
    const interfaceBlocks = codeOnly.match(/export\s+interface\s+\w+\s*\{[^}]+\}/g);
    if (interfaceBlocks !== null) {
      for (const block of interfaceBlocks) {
        const hasContextUnitId = block.includes("contextUnitId");
        const hasContentHash = block.includes("contentHash");
        const hasSemanticSchemaId = block.includes("semanticSchemaId");
        if (hasContextUnitId && hasContentHash && hasSemanticSchemaId) {
          assert.fail(
            `Structural violation: ${f} defines a competing durable Context unit interface ` +
              `(has contextUnitId + contentHash + semanticSchemaId). ` +
              `The canonical contract lives ONLY in context-v27.ts / context-units.ts.`,
          );
        }
      }
    }
  }
});

test("Feature A #106: semantic schema registry rejects unknown schemas", () => {
  // Known schemas pass
  assert.ok(isKnownSemanticSchemaId("iris.semantic.context_message.user.v1"));
  assert.ok(isKnownSemanticSchemaId("iris.semantic.context_message.assistant.v1"));

  // Unknown schema fails closed
  assert.ok(!isKnownSemanticSchemaId("iris.semantic.context_message.unknown.v1"));
  assert.ok(!isKnownSemanticSchemaId("bogus.schema"));

  // Validation rejects unknown schema
  const err = validateSemanticContentForSchema("iris.semantic.unknown.v1", { role: "user" });
  assert.ok(err?.includes("unknown semanticSchemaId"));
});

test("Feature A #106: semanticContent with forbidden control metadata fails closed", () => {
  // Content with contextUnitId in payload → fail
  const err1 = validateSemanticContentForSchema("iris.semantic.context_message.user.v1", {
    role: "user",
    contextUnitId: "u-1",
  });
  assert.ok(err1?.includes("forbidden"));

  // Content with layer in payload → fail
  const err2 = validateSemanticContentForSchema("iris.semantic.context_message.user.v1", {
    role: "user",
    layer: 5,
  });
  assert.ok(err2?.includes("forbidden"));

  // Clean content → pass
  const err3 = validateSemanticContentForSchema("iris.semantic.context_message.user.v1", {
    role: "user",
    content: "hello",
  });
  assert.equal(err3, null);
});

test("Feature A #106: validateUnitV2Strict dispatches schema validation", () => {
  // A unit with unknown semanticSchemaId must fail
  const content = { role: "user", content: "hello" };
  const contentHash = computeSemanticContentHash(content);
  const unitWithUnknownSchema = {
    schemaId: CONTEXT_UNIT_V2_SCHEMA_ID,
    header: {
      schemaId: CONTEXT_UNIT_HEADER_V1_SCHEMA_ID,
      contextUnitId: "u-1",
      source: {
        schemaId: CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
        sourceSchemaId: "test",
        sourceId: "s-1",
        sourceHash: "abc",
      },
      semanticSchemaId: "iris.semantic.totally_unknown.v999",
      contentHash,
    },
    semanticContent: content,
  };
  const result = validateUnitV2Strict(unitWithUnknownSchema);
  assert.ok(!result.valid, "unknown semanticSchemaId must fail");
  assert.ok(result.reason?.includes("unknown semanticSchemaId"));
});
