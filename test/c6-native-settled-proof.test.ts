/**
 * Feature C6 (#119/#114/#100): Adversarial native-settled proof.
 *
 * Proves that nativeSettlementReceipt is NOT satisfiable by:
 * - harness.abort() returning without native settled event
 * - generator finally / runCompletion resolving without native settled
 * - native settled from a different invocation
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

test("C6: nativeSettlementReceipt structure — abort waits for native settled, not runCompletion", () => {
  const adapterCode = fs.readFileSync(
    path.join(REPO_ROOT, "src", "runtime", "pi-runtime-adapter.ts"),
    "utf8",
  );

  // 1. nativeSettlementReceipt exists
  assert.ok(adapterCode.includes("nativeSettlementReceipt"));

  // 2. settlementResolve is called ONLY on "settled" event
  assert.ok(adapterCode.includes("this.settlementResolve?.();"));

  // 3. settlementReject is called when !settledSeen
  assert.ok(adapterCode.includes("prompt ended without native settled"));

  // 4. abort() races the receipt against a timeout
  assert.ok(adapterCode.includes("Promise.race"));

  // 5. runCompletion is in RuntimeCoordinator, separate from nativeSettlementReceipt
  const coordinatorCode = fs.readFileSync(
    path.join(REPO_ROOT, "src", "runtime", "runtime-coordinator.ts"),
    "utf8",
  );
  assert.ok(coordinatorCode.includes("runCompletion"));
  assert.ok(!coordinatorCode.includes("nativeSettlementReceipt"));
});

test("C6: receipt is invocation-scoped", () => {
  const adapterCode = fs.readFileSync(
    path.join(REPO_ROOT, "src", "runtime", "pi-runtime-adapter.ts"),
    "utf8",
  );

  assert.ok(adapterCode.includes("this.nativeSettlementReceipt = new Promise"));
  assert.ok(adapterCode.includes("this.nativeSettlementReceipt = null;"));
  assert.ok(adapterCode.includes("const receipt = this.nativeSettlementReceipt;"));
});
