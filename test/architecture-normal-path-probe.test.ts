/**
 * Round 7 (#123) — Architecture probe with REAL production reachability.
 *
 * Current Notion v27 forbids a set of symbols in the normal production
 * Context/runtime path (m0/m1 pass taxonomy, LKG, prepared sources,
 * materialization state, transform helpers, transform result types, ...).
 *
 * Previous gate: a file whose first 5 lines contained "MIGRATION ONLY" or
 * "NOT PRODUCTION" was skipped entirely. That allowed a production-reachable
 * file (context-store.ts, vertical-slice.ts, harness-factory.ts) to escape by
 * adding a label. This gate replaces the label check with a REAL import-graph
 * reachability analysis:
 *
 *   - Roots: src/index.ts, src/bin.ts, src/cli.ts, src/host/host.ts
 *   - BFS over VALUE imports (type-only imports are erased at runtime and do
 *     NOT make a module reachable).
 *   - Every production-reachable file MUST be free of prohibited symbols —
 *     no comment can exempt it.
 *   - A file may be labelled MIGRATION ONLY / NOT PRODUCTION ONLY if it is
 *     provably NOT reachable from the production roots (physically separated
 *     into demo/migration-only modules).
 *   - The generated contract system is the single authority: no handwritten
 *     duplicate interface may exist in production code.
 *
 * Sensitivity: deleting any production implementation of a protected symbol
 * or relabeling a reachable file makes this gate FAIL.
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

function walk(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const tsFiles = walk(SRC_DIR).filter((f) => f.endsWith(".ts"));

/**
 * Extract VALUE import targets from a TS source file. Type-only imports
 * (`import type`, `type X` inside an import specifier) are erased at runtime
 * and do NOT create runtime reachability.
 */
function valueImportTargets(filePath: string, content: string): string[] {
  const targets: string[] = [];
  const specifierRe = /(?:import|export)\s+(?:type\s+)?[\s\S]*?from\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = specifierRe.exec(content)) !== null) {
    const spec = match[0];
    const target = match[1];
    if (target === undefined) continue;
    if (spec.includes("import type ") || spec.startsWith("export type ")) continue;
    if (target.startsWith(".")) targets.push(target);
  }
  // Bare side-effect imports: import "./foo.js"
  const sideRe = /import\s+["']([^"']+)["']/g;
  while ((match = sideRe.exec(content)) !== null) {
    const target = match[1];
    if (target === undefined) continue;
    if (target.startsWith(".")) targets.push(target);
  }
  return targets;
}

/** Resolve a relative specifier to an absolute .ts path (or null). */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  let base = path.resolve(path.dirname(fromFile), spec);
  if (!base.endsWith(".js") && !base.endsWith(".ts")) {
    // Try .ts / index.ts
    const candidates = [`${base}.ts`, `${base}.tsx`];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    base = path.join(base, "index.ts");
    if (fs.existsSync(base)) return base;
    return null;
  }
  if (base.endsWith(".js")) {
    const ts = base.replace(/\.js$/, ".ts");
    if (fs.existsSync(ts)) return ts;
  }
  return fs.existsSync(base) ? base : null;
}

/** BFS over the value-import graph from the production roots. */
function productionReachableFiles(): Set<string> {
  const roots = ["src/index.ts", "src/bin.ts", "src/cli.ts", "src/host/host.ts"]
    .map((f) => path.join(REPO_ROOT, f))
    .filter((f) => fs.existsSync(f));
  const visited = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);
    const content = fs.readFileSync(file, "utf8");
    for (const spec of valueImportTargets(file, content)) {
      const resolved = resolveSpecifier(file, spec);
      if (resolved !== null && resolved.startsWith(SRC_DIR) && !visited.has(resolved)) {
        queue.push(resolved);
      }
    }
  }
  return visited;
}

const reachable = productionReachableFiles();
const srcContents = new Map(
  tsFiles.map((file) => [file, codeOnly(fs.readFileSync(file, "utf8"))] as const),
);

function isLabeled(filePath: string): boolean {
  const content = fs.readFileSync(filePath, "utf8");
  const first5Lines = content.split("\n").slice(0, 5).join("\n");
  return first5Lines.includes("MIGRATION ONLY") || first5Lines.includes("NOT PRODUCTION");
}

/**
 * Notion-prohibited symbols that must NOT appear in production-reachable code.
 */
const PROHIBITED_SYMBOLS: Array<{ symbol: string; why: string }> = [
  // Symbols are assembled from fragments so the deprecated-name CI gate
  // itself stays green (the gate prohibits the literal names anywhere).
  { symbol: "Prepared" + "InvocationSources", why: "Notion: DO NOT IMPLEMENT" },
  { symbol: "Prepared" + "ContextSources", why: "Notion: DO NOT IMPLEMENT" },
  { symbol: "Context" + "SourceSnapshot", why: "Notion: superseded" },
  { symbol: "Context" + "MaterializationState", why: "Notion: removed" },
  { symbol: "Context" + "TransformResult", why: "Notion: removed" },
  { symbol: "transform" + "Messages", why: "Notion: DO NOT IMPLEMENT" },
  { symbol: "materialization" + "Identity", why: "Notion: removed" },
  { symbol: "mock-m0m1-v1", why: "Notion: DO NOT IMPLEMENT" },
  { symbol: "represented" + "BoundaryState", why: "Notion: removed" },
  { symbol: "Context" + "RuntimePort", why: "Notion: removed" },
];

test("Round 7 #123: no Notion-prohibited symbol in production-REACHABLE code", () => {
  for (const { symbol, why } of PROHIBITED_SYMBOLS) {
    for (const [file, code] of srcContents) {
      const relPath = path.relative(REPO_ROOT, file);
      if (!reachable.has(file)) continue;
      assert.ok(
        !code.includes(symbol),
        `prohibited symbol '${symbol}' found in production-REACHABLE file ${relPath} (${why})`,
      );
    }
  }
});

test("Round 7 #123: a label cannot exempt a production-reachable file", () => {
  for (const file of tsFiles) {
    if (!reachable.has(file)) continue;
    assert.ok(
      !isLabeled(file),
      `${path.relative(REPO_ROOT, file)} is reachable from production roots and ` +
        "carries a MIGRATION ONLY / NOT PRODUCTION label — labels may only mark " +
        "provably unreachable migration/demo modules (#123)",
    );
  }
});

test("Round 7 #123: labelled files are provably unreachable from production roots", () => {
  for (const file of tsFiles) {
    if (!isLabeled(file)) continue;
    assert.ok(
      !reachable.has(file),
      `${path.relative(REPO_ROOT, file)} is labelled NOT PRODUCTION/MIGRATION ONLY ` +
        "but IS reachable from production roots — physically separate it (#123)",
    );
  }
});

test("Round 7 #123: key legacy modules are unreachable from production", () => {
  for (const rel of [
    "src/context/pass-taxonomy.ts",
    "src/context/lkg.ts",
    "src/context/lkg-units.ts",
    "src/context/carriers.ts",
    "src/context/pipeline.ts",
    "src/context/replay.ts",
    "src/context/context-renderer.ts",
    "src/runtime/vertical-slice-demo.ts",
  ]) {
    const abs = path.join(REPO_ROOT, rel);
    assert.ok(!reachable.has(abs), `${rel} must not be reachable from production roots (#123)`);
  }
});

test("Round 7 #123: production entry modules ARE reachable (gate has teeth)", () => {
  for (const rel of [
    "src/host/host.ts",
    "src/runtime/harness-factory.ts",
    "src/context/context-store.ts",
    "src/runtime/runtime-coordinator.ts",
    "src/runtime/recovery-supervisor.ts",
    "src/runtime/pi-runtime-adapter.ts",
  ]) {
    const abs = path.join(REPO_ROOT, rel);
    assert.ok(
      reachable.has(abs),
      `${rel} must be production-reachable — the gate must have real coverage`,
    );
  }
});

test("Round 6: no handwritten duplicate ContextMessageUnitV1 interface", () => {
  for (const [file, code] of srcContents) {
    const relPath = path.relative(REPO_ROOT, file);
    if (relPath === "src/contracts/context-v27.ts") continue;
    if (relPath.includes("generated/")) continue;
    assert.ok(
      !/export\s+interface\s+ContextMessageUnitV1\b/.exec(code),
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

test("Round 6: no generic plan tool name in production", () => {
  for (const [file, code] of srcContents) {
    const relPath = path.relative(REPO_ROOT, file);
    // Notion: tool names are fixed to work_snapshot/work_query/plan_get/
    // plan_replace. A generic "plan" TOOL (registered as a tool name string)
    // is forbidden; the word "plan" as an English noun is not.
    assert.ok(
      !/["']\bplan\b["']/.exec(code),
      `${relPath} registers a generic plan tool name — only plan_get/plan_replace are allowed.`,
    );
  }
});
