/**
 * Round 6 — Architecture probe: enforce Notion v27 prohibitions.
 *
 * Current Notion explicitly forbids these symbols in the normal production
 * Context path:
 *   m0, m1, SOFT+, SOFT, HARD (pass taxonomy), LKG,
 *   ContextSourceSnapshot, PreparedContextSources, PreparedInvocationSources,
 *   ContextMaterializationState, transformMessages, ContextTransformResult,
 *   intermediate materialization/fold layer
 *
 * These symbols may ONLY exist in files with a header comment containing
 * "MIGRATION ONLY" or "NOT PRODUCTION" in the first 5 lines.
 *
 * OpenCode is behavior reference only — it does NOT override current Notion.
 *
 * This test also verifies that the generated contract system is the single
 * authority: no handwritten duplicate interface may exist in production code.
 */
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SRC_DIR = path.join(REPO_ROOT, "src");

/** Strip block and line comments so only ACTIVE code is probed. */
function codeOnly(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/^\s*$/gm, "");
}

/** Check if a file is marked as MIGRATION ONLY / NOT PRODUCTION. */
function isMigrationOnly(filePath: string): boolean {
  const content = fs.readFileSync(filePath, "utf8");
  const first5Lines = content.split("\n").slice(0, 5).join("\n");
  return first5Lines.includes("MIGRATION ONLY") || first5Lines.includes("NOT PRODUCTION");
}

function walk(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const tsFiles = walk(SRC_DIR).filter((f) => f.endsWith(".ts"));
const srcContents = new Map(
  tsFiles.map((file) => [file, codeOnly(fs.readFileSync(file, "utf8"))] as const),
);

/**
 * Notion-prohibited symbols that must NOT appear in production code.
 */
const PROHIBITED_SYMBOLS: Array<{ symbol: string; why: string }> = [
  { symbol: "PreparedInvocationSources", why: "Notion: DO NOT IMPLEMENT" },
  { symbol: "PreparedContextSources", why: "Notion: DO NOT IMPLEMENT" },
  { symbol: "ContextSourceSnapshot", why: "Notion: superseded" },
  { symbol: "ContextMaterializationState", why: "Notion: removed" },
  { symbol: "ContextTransformResult", why: "Notion: removed" },
  { symbol: "transformMessages", why: "Notion: DO NOT IMPLEMENT" },
  { symbol: "materializationIdentity", why: "Notion: removed" },
  { symbol: "mock-m0m1-v1", why: "Notion: DO NOT IMPLEMENT" },
  { symbol: "representedBoundaryState", why: "Notion: removed" },
  { symbol: "ContextRuntimePort", why: "Notion: removed" },
];

test("Round 6: no Notion-prohibited symbol in production src/", () => {
  for (const { symbol, why } of PROHIBITED_SYMBOLS) {
    for (const [file, code] of srcContents) {
      if (isMigrationOnly(file)) continue;
      const relPath = path.relative(REPO_ROOT, file);
      assert.ok(
        !code.includes(symbol),
        `prohibited symbol '${symbol}' found in production file ${relPath} (${why})`,
      );
    }
  }
});

test("Round 6: pass-taxonomy is not imported by production runtime", () => {
  for (const [file, code] of srcContents) {
    if (isMigrationOnly(file)) continue;
    const relPath = path.relative(REPO_ROOT, file);
    if (relPath.includes("pass-taxonomy")) continue;
    if (code.includes("pass-taxonomy")) {
      assert.fail(
        `${relPath} imports pass-taxonomy — prohibited per current Notion.`,
      );
    }
  }
});

test("Round 6: LKG modules not imported by production runtime", () => {
  for (const [file, code] of srcContents) {
    if (isMigrationOnly(file)) continue;
    const relPath = path.relative(REPO_ROOT, file);
    if (relPath.includes("lkg")) continue;
    if (code.includes("/lkg") || code.includes('"./lkg')) {
      assert.fail(
        `${relPath} imports LKG — prohibited per current Notion.`,
      );
    }
  }
});

test("Round 6: no handwritten duplicate ContextMessageUnitV1 interface", () => {
  for (const [file, code] of srcContents) {
    const relPath = path.relative(REPO_ROOT, file);
    if (relPath === "src/contracts/context-v27.ts") continue;
    if (relPath.includes("generated/")) continue;
    assert.ok(
      !code.match(/export\s+interface\s+ContextMessageUnitV1\b/),
      `${relPath} defines handwritten ContextMessageUnitV1 — only generated/types.ts may define this.`,
    );
  }
});

test("Round 6: no semantic escape hatch in production", () => {
  for (const [file, code] of srcContents) {
    const relPath = path.relative(REPO_ROOT, file);
    assert.ok(
      !code.includes("iris.semantic.p5.unknown.v1"),
      `${relPath} references forbidden iris.semantic.p5.unknown.v1 escape hatch.`,
    );
  }
});

test("Round 6: generated contract artifacts exist", () => {
  const genDir = path.join(REPO_ROOT, "contracts", "generated");
  assert.ok(fs.existsSync(path.join(genDir, "types.ts")), "generated/types.ts must exist");
  assert.ok(fs.existsSync(path.join(genDir, "validators.ts")), "generated/validators.ts must exist");
  assert.ok(fs.existsSync(path.join(genDir, "registry.json")), "generated/registry.json must exist");
});
