/**
 * Feature B (goal.txt §5) — architecture probe: legacy Context assembly is
 * OUT of the normal runtime path.
 *
 * The production Context path is:
 *   freeze P0-P5 → deterministic projections → ContextUnitV2[] → validation
 *   → atomic publish → Renderer (ContextRenderer.renderForProviderCall).
 *
 * This probe scans production src/ (comments stripped) and fails when any of
 * the v12/v13-era Context-assembly symbols reappear in active code:
 *   - PreparedInvocationSources            (v13 prepared-sources view)
 *   - mock-m0m1-v1 / materializationIdentity (v12 mock materialization tag)
 *   - ContextRuntimePort                   (v12 prepare-time port)
 *   - representedBoundaryState             (v12 mock boundary state)
 *
 * It also positively asserts the minimal Pi-runtime binding
 * (InvocationSourceBinding — session binding + epoch info + canonical system
 * prompt identity, NOT Context assembly) is what the normal path carries.
 *
 * WHAT REMAINS AND WHY (documented, not flagged):
 *   - pass-taxonomy (SOFT+/SOFT/HARD decidePass) — the reviewed R2-P1
 *     ContextRenderer materialization decision layer, aligned with OpenCode
 *     v0.33.0 mustMaterialize (authority). It is wired into the normal path
 *     through harness-factory's contextController (renderForProviderCall) and
 *     is NOT the v12-era assembly path.
 *   - m0/m1 bodies — real materialized prefix/suffix state owned by
 *     context_lineages + ContextRenderer.persistRender (R2-P1), not
 *     binding-side assembly.
 *   - src/context/pipeline.ts (runContextPass, Feature 9) — reviewed
 *     capability layer; per round-4 evidence (final-A/final-B/final-D F1) it
 *     is intentionally NOT wired to the product hook yet (documented gap).
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
const srcContents = new Map(
  tsFiles.map((file) => [file, codeOnly(fs.readFileSync(file, "utf8"))] as const),
);

/** Legacy Context-assembly symbols that must not exist in production code. */
const LEGACY_SYMBOLS: Array<{ symbol: string; why: string }> = [
  {
    symbol: "PreparedInvocationSources",
    why: "v13 prepared-sources view — replaced by the minimal InvocationSourceBinding",
  },
  {
    symbol: "materializationIdentity",
    why: "binding-side materialization identity (v12 mock-m0m1-v1 era) — materialization is owned by ContextRenderer.persistRender",
  },
  {
    symbol: "mock-m0m1-v1",
    why: "v12 explicit mock materialization tag",
  },
  {
    symbol: "ContextRuntimePort",
    why: "v12 prepare-time Context port — removed with the m0/m1 boundary state",
  },
  {
    symbol: "representedBoundaryState",
    why: "v12 mock boundary state — real boundary state lives in context_lineages",
  },
];

test("Feature B: no legacy Context-assembly symbol in production src/", () => {
  for (const { symbol, why } of LEGACY_SYMBOLS) {
    const hits = [...srcContents.entries()].filter(([, code]) => code.includes(symbol));
    assert.deepEqual(
      hits.map(([file]) => path.relative(REPO_ROOT, file)),
      [],
      `legacy symbol '${symbol}' must not appear in production code (${why})`,
    );
  }
});

test("Feature B: the normal path carries the minimal Pi-runtime binding (InvocationSourceBinding)", () => {
  // contracts/context.ts defines it...
  const contractsFile = path.join(SRC_DIR, "contracts", "context.ts");
  const contractsCode = srcContents.get(contractsFile);
  assert.ok(contractsCode !== undefined, "src/contracts/context.ts exists");
  assert.ok(
    contractsCode.includes("export interface InvocationSourceBinding"),
    "InvocationSourceBinding must be the single binding interface in contracts/context.ts",
  );
  // ...and every normal-path consumer imports it (not a legacy view).
  for (const file of [
    path.join(SRC_DIR, "runtime", "runtime-coordinator.ts"),
    path.join(SRC_DIR, "runtime", "vertical-slice.ts"),
    path.join(SRC_DIR, "runtime", "harness-factory.ts"),
  ]) {
    const code = srcContents.get(file);
    assert.ok(code !== undefined, `${path.relative(REPO_ROOT, file)} exists`);
    assert.ok(
      code.includes("InvocationSourceBinding"),
      `${path.relative(REPO_ROOT, file)} must reference the minimal Pi-runtime binding`,
    );
  }
});

test("Feature B: normal provider path renders through ContextRenderer (V2 projection, not Session assembly)", () => {
  const harnessFile = path.join(SRC_DIR, "runtime", "harness-factory.ts");
  const harnessCode = srcContents.get(harnessFile);
  assert.ok(harnessCode !== undefined);
  assert.ok(
    harnessCode.includes("renderForProviderCall"),
    "harness contextController must render through ContextRenderer.renderForProviderCall (V2 projection)",
  );
  assert.ok(
    !harnessCode.includes("runContextPass"),
    "the product hook must NOT call the Feature-9 pipeline (runContextPass) — documented round-4 gap, not wired",
  );
});

test("Feature B: reviewed R2-P1 layers remain intentionally (pass taxonomy + renderer)", () => {
  // These are NOT legacy: the SOFT+/SOFT/HARD decision layer is the reviewed
  // R2-P1 ContextRenderer materialization authority (aligned with OpenCode
  // v0.33.0 mustMaterialize) and remains wired into the normal path.
  for (const file of [
    path.join(SRC_DIR, "context", "pass-taxonomy.ts"),
    path.join(SRC_DIR, "context", "context-renderer.ts"),
  ]) {
    assert.ok(
      fs.existsSync(file),
      `${path.relative(REPO_ROOT, file)} remains (documented R2-P1 layer)`,
    );
  }
  const taxonomy = srcContents.get(path.join(SRC_DIR, "context", "pass-taxonomy.ts")) ?? "";
  assert.ok(
    taxonomy.includes("decidePass"),
    "decidePass remains the renderer's decision authority",
  );
  const renderer = srcContents.get(path.join(SRC_DIR, "context", "context-renderer.ts")) ?? "";
  assert.ok(
    renderer.includes("persistRender"),
    "persistRender remains the materialization commit point",
  );
});
