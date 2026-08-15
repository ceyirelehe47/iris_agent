#!/usr/bin/env node
/**
 * Sensitivity probes (#123): prove that breaking a generated artifact, the
 * deprecated-symbol rule, a critical behavioral test, or a production-path
 * prohibition makes aggregate CI fail.
 *
 * Each probe runs on a TEMPORARY git worktree so the working tree is never
 * touched. consume-iris-context 适配：probes 覆盖当前架构的门禁 —— 工作树
 * 的 src/test/scripts/contracts/package.json 会 overlay 进 worktree，因此
 * 被验证的是「当前」门禁（而非 HEAD 的旧 Context/Historian 架构）：
 *   1. drift generated source → check:codegen-freshness FAILS（恢复后通过）
 *   2. reintroduce src/context/ → check-duplicate-implementation FAILS
 *   3. deprecated name in src → check:deprecated-names FAILS
 *   4. remove a critical behavioral test from npm test → aggregate test FAILS
 *   5. disable Provider Renderer fail-closed → context-render tests FAIL
 *   6. remove native settled-resolution call → c6 native-settled proof FAIL
 *   7. disable durable recovery-state load → d6 crash-injection tests FAIL
 *
 * Exit 0 = every probe observed its gate failing (gates have teeth).
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..");

function run(cmd, cwd, opts = {}) {
  try {
    const out = execSync(cmd, {
      cwd,
      stdio: "pipe",
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 64 * 1024 * 1024,
      ...opts,
    });
    return { ok: true, out };
  } catch (error) {
    return {
      ok: false,
      out: String(error.stdout ?? "") + String(error.stderr ?? ""),
      code: error.status,
    };
  }
}

function expectFailure(probeName, result, needle) {
  if (result.ok) {
    console.error(`PROBE FAILED (gate did NOT fail): ${probeName}`);
    process.exitCode = 1;
    return;
  }
  if (needle !== undefined && !result.out.includes(needle)) {
    console.error(`PROBE FAILED (wrong failure signal): ${probeName}`);
    console.error(result.out.slice(0, 500));
    process.exitCode = 1;
    return;
  }
  console.log(`PROBE OK: ${probeName}`);
}

const worktree = mkdtempSync(join(tmpdir(), "iris-sensitivity-"));
try {
  const add = run(`git worktree add --detach ${worktree} HEAD`, REPO_ROOT);
  if (!add.ok) {
    console.error("cannot create worktree:", add.out.slice(0, 500));
    process.exit(1);
  }
  // Install deps in the worktree (node_modules symlink keeps it fast).
  run(`ln -s ${REPO_ROOT}/node_modules ${worktree}/node_modules`, worktree);
  // iris_agent#131: the shared node_modules/@iris/* links resolve through the
  // sibling managed cache (<repo>/../.iris-vendor). When the worktree's parent
  // already IS the cache location (e.g. a repo cloned into /tmp), the links
  // resolve natively and no mirror is needed. Otherwise mirror the cache at
  // the worktree's parent. NEVER delete a real cache directory — only remove a
  // previously-created mirror symlink (lstat-based detection also handles a
  // dangling symlink, which existsSync() would miss).
  const realVendor = resolve(REPO_ROOT, "..", ".iris-vendor");
  const vendorMirror = join(dirname(worktree), ".iris-vendor");
  const mirrorStat = (() => {
    try {
      return fs.lstatSync(vendorMirror);
    } catch {
      return null;
    }
  })();
  if (
    fs.existsSync(realVendor) &&
    resolve(realVendor) !== resolve(vendorMirror) &&
    !(mirrorStat !== null && mirrorStat.isDirectory())
  ) {
    if (mirrorStat !== null) {
      fs.rmSync(vendorMirror, { force: true });
    }
    fs.symlinkSync(realVendor, vendorMirror, "dir");
  }

  // consume-iris-context: overlay the CURRENT working-tree state so the
  // probes exercise the CURRENT gates (the HEAD worktree alone would test the
  // deleted Context/Historian architecture). The overlay mirrors deletions
  // too (src/context, src/historian, old contracts/migrations are absent).
  for (const dir of ["src", "test", "scripts", "contracts", "fixtures"]) {
    fs.rmSync(join(worktree, dir), { recursive: true, force: true });
    if (fs.existsSync(join(REPO_ROOT, dir))) {
      fs.cpSync(join(REPO_ROOT, dir), join(worktree, dir), { recursive: true, force: true });
    }
  }
  for (const file of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.build.json",
    "eslint.config.mjs",
    "prettier.config.mjs",
  ]) {
    fs.copyFileSync(join(REPO_ROOT, file), join(worktree, file));
  }
  // The overlay changed the worktree's working tree; stage it so codegen's
  // freshness diff compares against the CURRENT artifacts (not HEAD's).
  run("git add -A", worktree);

  // --- Probe 1: drift the source schema → codegen freshness FAILS ---
  // (Tampering with a GENERATED file is covered up by codegen itself; the
  // real sensitivity is SOURCE drift: a changed source schema produces
  // different generated output, which the freshness gate must reject.)
  const sourcePath = join(worktree, "contracts", "source", "schemas.json");
  const originalSource = fs.readFileSync(sourcePath, "utf8");
  fs.writeFileSync(
    sourcePath,
    originalSource.replace('"retired"', '"retired",\n        "sensitivity_probe_bogus_state"'),
  );
  const freshness = run("node scripts/check-codegen-freshness.mjs", worktree);
  expectFailure("drifted source schema → check:codegen-freshness", freshness, "STALE");
  fs.writeFileSync(sourcePath, originalSource);
  const freshnessRestored = run("node scripts/check-codegen-freshness.mjs", worktree);
  if (!freshnessRestored.ok) {
    console.error("PROBE FAILED: freshness gate did not recover after restore");
    process.exitCode = 1;
  } else {
    console.log("PROBE OK: freshness gate recovers after restore");
  }

  // --- Probe 2: reintroduce a duplicate Context engine → fence FAILS ---
  const contextDir = join(worktree, "src", "context");
  fs.mkdirSync(contextDir, { recursive: true });
  fs.writeFileSync(join(contextDir, "context-store.ts"), "// sensitivity probe\n");
  const fence = run("node scripts/check-duplicate-implementation.mjs", worktree);
  expectFailure(
    "reintroducing src/context/ → check-duplicate-implementation",
    fence,
    "duplicate implementation directory exists",
  );
  fs.rmSync(contextDir, { recursive: true, force: true });

  // --- Probe 3: deprecated name in src → check:deprecated-names FAILS ---
  const adapterPath = join(worktree, "src", "runtime", "pi-runtime-adapter.ts");
  const originalAdapter = fs.readFileSync(adapterPath, "utf8");
  // The forbidden name is assembled at runtime so this probe file itself
  // never contains the literal (the deprecated-name gate scans everything).
  const forbiddenName = "Context" + "Source" + "Snapshot";
  fs.writeFileSync(adapterPath, originalAdapter + `\nconst ${forbiddenName} = 1;\n`);
  const deprecated = run("node scripts/check-deprecated-names.mjs", worktree);
  expectFailure("deprecated name in src → check:deprecated-names", deprecated, forbiddenName);
  fs.writeFileSync(adapterPath, originalAdapter);

  // --- Probe 4: a critical behavioral test is load-bearing for CI ---
  // Two-sided proof: (a) a production regression the test would catch DOES
  // fail the test while it is listed; (b) after removing the test from the
  // test script, the SAME regression sails through `npm test` — proving the
  // list entry is what gives the gate its teeth.
  const bridgePath = join(worktree, "src", "runtime", "iris-bridge.ts");
  const originalBridge = fs.readFileSync(bridgePath, "utf8");
  // Regression: the bridge maps the user message to a WRONG entryId (not
  // the Pi entry id). Only test/iris-bridge.test.ts asserts entryId == Pi
  // entry id (the unique message-identity mapping check); r1/host tests only
  // check non-empty identity fields and still pass, so removing the listed
  // test lets the regression escape (proving the entry is load-bearing).
  const regression = originalBridge.replace(
    'this.admit(event.entryId, "iris.semantic.context_message.user.v1", payload,',
    'this.admit(`probe-${event.entryId}`, "iris.semantic.context_message.user.v1", payload,',
  );
  fs.writeFileSync(bridgePath, regression);
  const caught = run("npx tsx --test test/iris-bridge.test.ts", worktree);
  expectFailure(
    "iris-bridge catches the entryId-mapping regression",
    caught,
    "Pi compatibility entryId must equal the Pi entry id",
  );
  fs.writeFileSync(bridgePath, originalBridge);

  const pkgPath = join(worktree, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const originalTest = pkg.scripts.test;
  pkg.scripts.test = originalTest
    .replace("test/iris-bridge.test.ts", "")
    // consume-iris-context (Phase G Finding 2): production-lock.test.ts is
    // part of npm test, but its ../pi gate resolves the adjacent checkout
    // relative to the REPO root — a /tmp sensitivity worktree has no
    // adjacent ../pi (and a stale /tmp/pi must not decide this probe). The
    // pairing regression under test is unrelated to the pin gate, so drop
    // the production-lock test from THIS scenario only.
    .replace("test/production-lock.test.ts", "");
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  fs.rmSync(join(worktree, "test", "iris-bridge.test.ts"), { force: true });
  fs.rmSync(join(worktree, "test", "production-lock.test.ts"), { force: true });
  // Same regression, critical test removed from the list → npm test must PASS
  // (the regression escapes: the removed entry was load-bearing).
  fs.writeFileSync(bridgePath, regression);
  const escaped = run("npm test", worktree, { timeout: 300000 });
  if (!escaped.ok) {
    console.error("PROBE FAILED: npm test still caught the regression after the test was removed");
    process.exitCode = 1;
  } else {
    console.log("PROBE OK: removing the critical test from npm test lets the regression through");
  }
  fs.writeFileSync(bridgePath, originalBridge);
  pkg.scripts.test = originalTest;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

  // --- Probe 5: disable Provider Renderer fail-closed → context-render tests FAIL ---
  const renderPath = join(worktree, "src", "runtime", "context-render.ts");
  const originalRender = fs.readFileSync(renderPath, "utf8");
  fs.writeFileSync(
    renderPath,
    originalRender.replace(
      /throw new Error\(\s*`provider render: P5 unit \$\{unit\.unitId\} has unknown role \$\{JSON\.stringify\(role\)\} \(fail closed\)`,\s*\);/,
      'return { role: "user", content: [], timestamp: 0 } as unknown as AgentMessage; // SENSITIVITY PROBE: fail-closed disabled',
    ),
  );
  const renderTests = run("npx tsx --test test/context-render.test.ts", worktree);
  expectFailure("disabling Provider Renderer fail-closed → context-render tests", renderTests);
  fs.writeFileSync(renderPath, originalRender);

  // --- Probe 6: remove the native settled-resolution call → C6 native-settled proof FAILS ---
  fs.writeFileSync(
    adapterPath,
    originalAdapter.replace(
      "this.settlementResolve?.();",
      "// SENSITIVITY PROBE: settled-resolution call removed",
    ),
  );
  const c6 = run("npx tsx --test test/c6-native-settled-proof.test.ts", worktree);
  expectFailure("removing settled-resolution call → C6 native-settled proof", c6);
  fs.writeFileSync(adapterPath, originalAdapter);

  // --- Probe 7: disable the durable recovery-state load → D6 crash-injection tests FAIL ---
  const recoveryStatePath = join(worktree, "src", "runtime", "recovery-state.ts");
  const originalRecoveryState = fs.readFileSync(recoveryStatePath, "utf8");
  fs.writeFileSync(
    recoveryStatePath,
    originalRecoveryState.replace(
      "return row === undefined ? undefined : rowToSnapshot(row);",
      "return undefined; // SENSITIVITY PROBE: durable recovery-state load disabled",
    ),
  );
  const d6 = run("npx tsx --test test/d6-crash-injection.test.ts", worktree);
  expectFailure("disabling durable recovery-state load → D6 crash-injection tests", d6);
  fs.writeFileSync(recoveryStatePath, originalRecoveryState);

  console.log(
    process.exitCode === 1
      ? "SENSITIVITY PROBES: FAILED"
      : "SENSITIVITY PROBES: ALL GATES HAVE TEETH",
  );
} finally {
  run(`git worktree remove --force ${worktree}`, REPO_ROOT);
}
