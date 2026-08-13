#!/usr/bin/env node
/**
 * Sensitivity probes (#123): prove that breaking a generated artifact, the
 * deprecated-symbol rule, a critical behavioral test, or a production-path
 * prohibition makes aggregate CI fail.
 *
 * Each probe runs on a TEMPORARY git worktree of the current HEAD so the
 * working tree is never touched:
 *   1. tamper generated artifact → check:codegen-freshness FAILS
 *   2. prohibited symbol in production-reachable file → architecture probe FAILS
 *   3. deprecated name in src → check:deprecated-names FAILS
 *   4. delete a critical behavioral test from the test list → aggregate test FAILS
 *
 * Exit 0 = every probe observed its gate failing (gates have teeth).
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..");

function run(cmd, cwd, opts = {}) {
  try {
    const out = execSync(cmd, { cwd, stdio: "pipe", encoding: "utf8", timeout: 120000, ...opts });
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
  }

  // --- Probe 2: prohibited symbol in a production-reachable file → architecture probe FAILS ---
  const hostPath = join(worktree, "src", "host", "host.ts");
  const originalHost = fs.readFileSync(hostPath, "utf8");
  fs.writeFileSync(hostPath, originalHost + "\nconst PreparedInvocationSources = 1;\n");
  const arch = run("npx tsx --test test/architecture-normal-path-probe.test.ts", worktree);
  expectFailure(
    "prohibited symbol in production-reachable file → architecture probe",
    arch,
    "PreparedInvocationSources",
  );
  fs.writeFileSync(hostPath, originalHost);

  // --- Probe 3: deprecated name in src → check:deprecated-names FAILS ---
  const contextPath = join(worktree, "src", "context", "context-store.ts");
  const originalContext = fs.readFileSync(contextPath, "utf8");
  fs.writeFileSync(
    contextPath,
    originalContext + "\n// probe\nconst ContextMaterializationState = 1;\n",
  );
  const deprecated = run("node scripts/check-deprecated-names.mjs", worktree);
  expectFailure(
    "deprecated name in src → check:deprecated-names",
    deprecated,
    "ContextMaterializationState",
  );
  fs.writeFileSync(contextPath, originalContext);

  // --- Probe 4: critical behavioral test removed from the test script → aggregate test FAILS ---
  const pkgPath = join(worktree, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const originalTest = pkg.scripts.test;
  pkg.scripts.test = originalTest.replace(
    "test/a7-p5-source-bound-validation.test.ts",
    "test/__missing__a7.test.ts",
  );
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  const tests = run("npm test 2>&1 | tail -8", worktree);
  // npm test runs every listed file; a missing file makes the runner fail.
  expectFailure("removing a critical behavioral test from npm test", tests);
  pkg.scripts.test = originalTest;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

  // --- Probe 5: disable projectP5Unit's authoritative hash validation → A7 tamper tests FAIL ---
  const builderPath = join(worktree, "src", "context", "generation-builder.ts");
  const originalBuilder = fs.readFileSync(builderPath, "utf8");
  fs.writeFileSync(
    builderPath,
    originalBuilder.replace(
      "if (recomputedHash !== cmu.contentHash) {",
      "if (false && recomputedHash !== cmu.contentHash) {",
    ),
  );
  const a7Tamper = run("npx tsx --test test/a7-p5-source-bound-validation.test.ts", worktree);
  expectFailure("disabling projectP5Unit hash validation → A7 tamper tests", a7Tamper);
  fs.writeFileSync(builderPath, originalBuilder);

  // --- Probe 6: restore the Round-6 `receipt === null → return` abort success
  // path → C7 native-settled authority tests FAIL ---
  const adapterPath = join(worktree, "src", "runtime", "pi-runtime-adapter.ts");
  const originalAdapter = fs.readFileSync(adapterPath, "utf8");
  fs.writeFileSync(
    adapterPath,
    originalAdapter.replace(
      "if (receipt === null) {\n      throw new Error(",
      "if (receipt === null) {\n      // SENSITIVITY PROBE: broken abort-success path\n      return;\n      throw new Error(",
    ),
  );
  const c7 = run("npx tsx --test test/c7-native-settled-authority.test.ts", worktree);
  // The broken path (receipt null → return) means case 1's abort no longer
  // fails closed → the test must fail.
  expectFailure("restoring receipt-null abort success → C7 authority tests", c7);
  fs.writeFileSync(adapterPath, originalAdapter);

  // --- Probe 7: disable the durable resolution read at restart → D7 zero-re-query tests FAIL ---
  const supervisorPath = join(worktree, "src", "runtime", "recovery-supervisor.ts");
  const originalSupervisor = fs.readFileSync(supervisorPath, "utf8");
  fs.writeFileSync(
    supervisorPath,
    originalSupervisor.replace(
      "const durableResolution = this.resolutionStore?.load(logicalExecutionId);",
      "const durableResolution = undefined; // SENSITIVITY PROBE: resolution read disabled",
    ),
  );
  const d7 = run("npx tsx --test test/d7-crash-injection.test.ts", worktree);
  expectFailure("disabling durable resolution read → D7 restart tests", d7);
  fs.writeFileSync(supervisorPath, originalSupervisor);

  console.log(
    process.exitCode === 1
      ? "SENSITIVITY PROBES: FAILED"
      : "SENSITIVITY PROBES: ALL GATES HAVE TEETH",
  );
} finally {
  run(`git worktree remove --force ${worktree}`, REPO_ROOT);
}
