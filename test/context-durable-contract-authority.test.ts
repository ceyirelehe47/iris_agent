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
  // Check that no other production source file defines a competing interface.
  const srcDir = path.join(REPO_ROOT, "src");
  function walk(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : [full];
    });
  }
  const tsFiles = walk(srcDir).filter((f) => f.endsWith(".ts") && !f.includes("context-v27.ts"));
  for (const f of tsFiles) {
    const content = fs.readFileSync(f, "utf8");
    // Check for a competing interface definition (not just an import or comment)
    const match = /export\s+interface\s+ContextMessageUnitV1\b/.exec(content);
    assert.ok(
      !match,
      `Duplicate ContextMessageUnitV1 interface found in ${f} — only context-v27.ts may define it`,
    );
  }
});
