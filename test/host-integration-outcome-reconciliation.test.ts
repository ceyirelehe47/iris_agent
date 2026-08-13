/**
 * iris_agent#111 Feature D5: GENUINE IrisHost outcome_unknown reconciliation
 * integration tests.
 *
 * Instantiates REAL IrisHost.open() (src/host/host.ts) with a temp dataRoot
 * and drives the REAL production dispatch path end-to-end:
 *
 *   Host pump → RecoverySupervisor (durable recovery-state.db)
 *     → RuntimeCoordinator.promptWithModel → PiRuntimeAdapter → AgentHarness
 *     → real Pi Session (SQLite), real companion pairing, real context
 *     controller, real startup ingress recovery.
 *
 * Mock boundaries (explicitly marked, per AGENTS.md):
 *   1. The PROVIDER CALL itself — AgentHarness.prototype.prompt is stubbed to
 *      throw an error whose message carries `outcome_unknown` (the exact
 *      string classifyNativeFailure maps to the outcome_unknown
 *      classification), mirroring how a real provider surfaces an ambiguous
 *      dispatch. The REAL PiRuntimeAdapter converts the throw into
 *      failed(code=harness_error) + rethrow, and the REAL supervisor
 *      classifies the message → outcome_unknown. This is the same provider
 *      boundary the Feature C integration test treats as the "realistic fake
 *      harness boundary". When a test does NOT stub prompt, the real mock
 *      provider (createMockProvider) runs untouched.
 *   2. The outcomeReconciler option — the seam IrisHost itself exposes.
 *   3. Seeded durable pending records — written via the REAL
 *      RecoveryStateStore to reproduce the iris_agent#102 crash window
 *      (pending_outcome_unknown persisted BEFORE any reconciliation runs, so
 *      a restart restores the exact pending ambiguity). This is precisely the
 *      state the supervisor reconciles before any provider dispatch.
 *
 * Scenario coverage (Feature D5 AC):
 *   1. same-run outcome_unknown: provider ambiguity → supervisor persists
 *      pendingOutcomeUnknown with dispatchId → reconciler called with the
 *      SAME dispatchId → ambiguous → durable fail-closed.
 *   2. restart reconciliation: pending written to disk → IrisHost restarted
 *      → reconciler called with the SAME dispatchId (from the persisted
 *      record, never re-inferred from the current input).
 *   3. confirmed_applied: settle WITHOUT replay (zero provider dispatch).
 *      The durable pending fence is deliberately NOT cleared while the
 *      input is still `accepted` — the fence is the guard that makes
 *      repeated restarts re-consult the reconciler and never replay.
 *   4. replay_safe: replay with the same logical execution/idempotency
 *      identity, then settle normally (the fence IS cleared on replay).
 *   5. dispatchId stability: same-run pending.dispatchId === restart
 *      pending.dispatchId (=== the durable record on disk).
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentHarness } from "@iris/pi-agent-core";
import type { ImageContent } from "@iris/pi-ai";

import { defaultAgentConfig } from "../src/config/load.js";
import type { AgentConfigV3 } from "../src/config/schema.js";
import type { AgentInput } from "../src/contracts/origin.js";
import { directUserRequest } from "../src/contracts/origin.js";
import { initializeDataRoot, resolveDataRootPaths } from "../src/host/data-root.js";
import { InputAcceptanceLedger } from "../src/host/ingress.js";
import { IrisHost } from "../src/host/host.js";
import {
  DurableOutcomeResolutionStore,
  freshRecoveryState,
  RecoveryStateStore,
} from "../src/runtime/recovery-state.js";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

function makeInput(inputId: string, text = "hello iris"): AgentInput {
  return {
    inputId,
    triggerOrigin: directUserRequest(),
    blocks: [
      {
        blockId: `block-${inputId}`,
        sourceOrigin: directUserRequest(),
        content: { mode: "inline_text", text },
        contentHash: "",
      },
    ],
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface ReconcilerCall {
  logicalExecutionId: string;
  inputId: string;
  dispatchId: string;
}

/** outcomeReconciler option: records every reconciliation signal. */
function makeReconciler(
  calls: ReconcilerCall[],
  disposition: "confirmed_applied" | "replay_safe" | "ambiguous",
): (signal: {
  logicalExecutionId: string;
  inputId: string;
  dispatchId: string;
}) => Promise<"confirmed_applied" | "replay_safe" | "ambiguous"> {
  return async (signal) => {
    calls.push({ ...signal });
    return disposition;
  };
}

/**
 * Reproduce the #102 crash window WITHOUT a host: an input durably accepted
 * (no Pi pair — the crash happened before the first UserMessage append) plus
 * a pendingOutcomeUnknown record durably persisted in recovery-state.db
 * (the crash happened right after the possibly-accepted dispatch).
 */
function seedCrashWindowState(
  dataRoot: string,
  config: AgentConfigV3,
  input: AgentInput,
  pending: { dispatchId: string; logicalExecutionId: string; inputId: string },
): void {
  initializeDataRoot(dataRoot, config);
  const paths = resolveDataRootPaths(dataRoot, config);
  const ledger = new InputAcceptanceLedger(paths.ingressDb, paths.blobsIngress, 20, 1);
  try {
    ledger.accept(input, input.inputId);
  } finally {
    ledger.close();
  }
  const store = new RecoveryStateStore(join(paths.dataRoot, "recovery-state.db"));
  try {
    store.save({
      ...freshRecoveryState(pending.logicalExecutionId, new Date().toISOString()),
      pendingOutcomeUnknown: {
        dispatchId: pending.dispatchId,
        logicalExecutionId: pending.logicalExecutionId,
        inputId: pending.inputId,
        model: null,
        occurredAt: new Date().toISOString(),
        detail: "seeded crash-window pending (Feature D5)",
      },
    });
  } finally {
    store.close();
  }
}

/** Read the durable recovery snapshot for a logical execution. */
function loadSnapshot(dataRoot: string, logicalExecutionId: string) {
  const store = new RecoveryStateStore(join(dataRoot, "recovery-state.db"));
  try {
    return store.load(logicalExecutionId);
  } finally {
    store.close();
  }
}

/**
 * Round 7 (#124/#118): provider dispatch failures must flow through the REAL
 * harness failure path — the faux provider throws, the real AgentHarness
 * catches it (emitRunFailure → failure message → agent_end → native settled).
 * Mocking AgentHarness.prototype.prompt to throw directly bypassed the harness
 * and could never emit native settled, which made the C6 adapter fail closed
 * ("prompt ended without native settled") on every D5 scenario.
 */
function providerFailure(): Error {
  return new Error("provider dispatch outcome_unknown: ambiguous status");
}

/** Wrap the provider call with a call counter (real implementation runs). */
function installPromptCounter(counter: { promptCalls: number }): void {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const realPrompt = AgentHarness.prototype.prompt;
  mock.method(
    AgentHarness.prototype,
    "prompt",
    async function (this: AgentHarness, text: string, options?: { images?: ImageContent[] }) {
      counter.promptCalls += 1;
      return realPrompt.call(this, text, options);
    },
  );
}

// ---------------------------------------------------------------------------
// Scenario 1: same-run outcome_unknown → fail-closed
// ---------------------------------------------------------------------------

test("D5: same-run outcome_unknown — supervisor persists dispatchId, reconciler gets the same id, ambiguous fails closed", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-d5-same-run-"));
  const config = defaultAgentConfig();
  const calls: ReconcilerCall[] = [];
  const events: string[] = [];

  // MOCK boundary #1: the provider call surfaces an ambiguous dispatch.
  let host: IrisHost | undefined;
  try {
    host = await IrisHost.open({
      dataRoot,
      config,
      provider: "mock",
      mockProviderError: providerFailure(),
      outcomeReconciler: makeReconciler(calls, "ambiguous"),
    });
    const unsubscribe = host.onEvent((event) => events.push(event.type));
    const pumpPromise = host.run();
    host.acceptInput(makeInput("d5-same-0001"), "d5-same-0001");

    // The supervisor stores pendingOutcomeUnknown durably, then calls the
    // reconciler with the EXACT dispatchId it just persisted.
    await waitFor(() => calls.length >= 1);
    assert.equal(calls.length, 1, "reconciler must be called exactly once");
    assert.equal(
      calls[0]?.dispatchId,
      "invocation-d5-same-0001",
      "reconciler dispatchId must be the persisted pending dispatchId (the invocation id), not re-inferred",
    );
    assert.equal(
      calls[0]?.logicalExecutionId,
      "logical-exec-1:d5-same-0001",
      "reconciler must receive the stable logical execution identity",
    );
    assert.equal(calls[0]?.inputId, "d5-same-0001");

    // ambiguous → fail closed: host not-ready, input stays durably accepted.
    await waitFor(() => events.includes("failed"));
    assert.equal(host.health().ready, false, "ambiguous must fail closed (not-ready)");
    assert.equal(
      host.getIngress().getRecord("d5-same-0001", 1)?.state,
      "accepted",
      "input must never be committed while ambiguous",
    );

    await host.shutdown();
    await pumpPromise;
    unsubscribe();
    host = undefined;
  } finally {
    mock.restoreAll();
    await host?.shutdown().catch(() => undefined);
  }

  // The durable pending record survives with the SAME dispatchId.
  const snapshot = loadSnapshot(dataRoot, "logical-exec-1:d5-same-0001");
  assert.ok(snapshot !== undefined, "recovery state must be durable");
  assert.equal(
    snapshot.pendingOutcomeUnknown?.dispatchId,
    "invocation-d5-same-0001",
    "same-run pending.dispatchId must be persisted durably",
  );
  assert.equal(snapshot.exhausted, true, "ambiguous must persist the exhausted fence");
  assert.equal(snapshot.outcomeUnknown, 1);
});

// ---------------------------------------------------------------------------
// Scenario 2: restart reconciliation — persisted dispatchId, never re-inferred
// ---------------------------------------------------------------------------

test("D5: restart reconciliation — pending written to disk is reconciled with the SAME persisted dispatchId", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-d5-restart-"));
  const config = defaultAgentConfig();
  const input = makeInput("d5-restart-0002");
  const SEEDED_DISPATCH = "dispatch-d5-restart-77"; // arbitrary — NOT derivable from input
  const logicalExecutionId = "logical-exec-1:d5-restart-0002";

  // Write pendingOutcomeUnknown to disk (the #102 crash window).
  seedCrashWindowState(dataRoot, config, input, {
    dispatchId: SEEDED_DISPATCH,
    logicalExecutionId,
    inputId: input.inputId,
  });

  // A first Host lifecycle over the same dataRoot must NOT consume or
  // rewrite the pending record (no pump, no dispatch).
  const calls1: ReconcilerCall[] = [];
  const first = await IrisHost.open({
    dataRoot,
    config,
    provider: "mock",
    outcomeReconciler: makeReconciler(calls1, "ambiguous"),
  });
  await first.shutdown();
  assert.equal(calls1.length, 0, "no dispatch → no reconciliation on host open alone");
  assert.equal(
    loadSnapshot(dataRoot, logicalExecutionId)?.pendingOutcomeUnknown?.dispatchId,
    SEEDED_DISPATCH,
    "pending must survive a host lifecycle untouched",
  );

  // Restart: the pump re-invokes the still-accepted input; the supervisor
  // reconciles the RESTORED pending BEFORE any provider dispatch.
  const calls2: ReconcilerCall[] = [];
  const events2: string[] = [];
  const restarted = await IrisHost.open({
    dataRoot,
    config,
    provider: "mock",
    outcomeReconciler: makeReconciler(calls2, "ambiguous"),
  });
  const unsub2 = restarted.onEvent((event) => events2.push(event.type));
  try {
    const pumpPromise = restarted.run();
    await waitFor(() => calls2.length >= 1);
    assert.equal(calls2.length, 1, "restart reconciliation must run exactly once");
    assert.equal(
      calls2[0]?.dispatchId,
      SEEDED_DISPATCH,
      "restart reconciler must receive the dispatchId FROM THE PERSISTED RECORD, never re-inferred",
    );
    assert.equal(calls2[0]?.logicalExecutionId, logicalExecutionId);
    assert.equal(calls2[0]?.inputId, input.inputId);

    // ambiguous → durable fail-closed again.
    await waitFor(() => events2.includes("failed"));
    assert.equal(
      restarted.getIngress().getRecord(input.inputId, 1)?.state,
      "accepted",
      "ambiguous restart must not commit the input",
    );
    await restarted.shutdown();
    await pumpPromise;
    unsub2();
  } finally {
    await restarted.shutdown().catch(() => undefined);
  }

  const after = loadSnapshot(dataRoot, logicalExecutionId);
  assert.equal(
    after?.pendingOutcomeUnknown?.dispatchId,
    SEEDED_DISPATCH,
    "pending must stay durable with the same dispatchId after fail-closed",
  );
  assert.equal(after?.exhausted, true, "fail-closed fence must be durable");

  // A SECOND restart must NOT reconcile again (zero replay across restarts —
  // the exhausted fence guards the pending record).
  const calls3: ReconcilerCall[] = [];
  const third = await IrisHost.open({
    dataRoot,
    config,
    provider: "mock",
    outcomeReconciler: makeReconciler(calls3, "ambiguous"),
  });
  try {
    const pump3 = third.run();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(calls3.length, 0, "zero replay: exhausted pending must never reconcile again");
    assert.equal(
      third.getIngress().getRecord(input.inputId, 1)?.state,
      "accepted",
      "input must remain accepted (never re-prompted)",
    );
    await third.shutdown();
    await pump3;
  } finally {
    await third.shutdown().catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Scenario 3: confirmed_applied → settle WITHOUT replay
// ---------------------------------------------------------------------------

test("D5: confirmed_applied — settle without replay (zero provider dispatch)", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-d5-applied-"));
  const config = defaultAgentConfig();
  const input = makeInput("d5-applied-0003");
  const logicalExecutionId = "logical-exec-1:d5-applied-0003";
  const counter = { promptCalls: 0 };
  const calls: ReconcilerCall[] = [];
  const events: string[] = [];

  seedCrashWindowState(dataRoot, config, input, {
    dispatchId: "dispatch-d5-applied-88",
    logicalExecutionId,
    inputId: input.inputId,
  });
  // MOCK boundary #1 (counting only): the real provider runs untouched.
  installPromptCounter(counter);

  let host: IrisHost | undefined;
  try {
    host = await IrisHost.open({
      dataRoot,
      config,
      provider: "mock",
      outcomeReconciler: makeReconciler(calls, "confirmed_applied"),
    });
    const unsubscribe = host.onEvent((event) => events.push(event.type));
    const pumpPromise = host.run();

    await waitFor(() => calls.length >= 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.dispatchId, "dispatch-d5-applied-88");
    assert.equal(calls[0]?.logicalExecutionId, logicalExecutionId);
    assert.equal(calls[0]?.inputId, input.inputId);

    // Settle WITHOUT replay: no dispatch happened, no turn started, no fail.
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(
      counter.promptCalls,
      0,
      "confirmed_applied must settle with ZERO provider dispatch (no duplicate side effects)",
    );
    assert.equal(events.includes("turn_start"), false, "confirmed_applied must never start a turn");
    assert.equal(events.includes("failed"), false, "confirmed_applied is not a failure");
    assert.equal(host.health().ready, true);
    assert.equal(
      host.getIngress().getRecord(input.inputId, 1)?.state,
      "accepted",
      "supervisor-level settle without replay: input is never re-prompted",
    );

    await host.shutdown();
    await pumpPromise;
    unsubscribe();
    host = undefined;
  } finally {
    mock.restoreAll();
    await host?.shutdown().catch(() => undefined);
  }

  // Round 7 (#118/#125): confirmed_applied is a DURABLE terminal resolution —
  // the pending fence is replaced by the resolution record. Restart reads the
  // resolution and performs ZERO re-query and ZERO replay.
  const snapshot = loadSnapshot(dataRoot, logicalExecutionId);
  assert.ok(snapshot !== undefined);
  assert.equal(
    snapshot.pendingOutcomeUnknown,
    null,
    "confirmed_applied must clear the pending fence (replaced by durable resolution)",
  );
  assert.equal(snapshot.exhausted, false, "confirmed_applied is not a failure state");
  const resolutionStore = new DurableOutcomeResolutionStore(
    join(dataRoot, "recovery-state.db"),
  );
  const resolution = resolutionStore.load(logicalExecutionId);
  assert.ok(resolution !== null, "confirmed_applied must persist a durable resolution");
  assert.equal(resolution?.resolution, "confirmed_applied");
  assert.equal(resolution?.dispatchId, "dispatch-d5-applied-88");
  assert.equal(resolution?.inputId, input.inputId);
  resolutionStore.close();

  // A SECOND restart reads the durable resolution: ZERO external re-query
  // (reconciler not called) and ZERO replay — the #118 durable-resolution
  // requirement, replacing the old re-consult-forever design.
  const calls2: ReconcilerCall[] = [];
  const counter2 = { promptCalls: 0 };
  installPromptCounter(counter2);
  let host2: IrisHost | undefined;
  try {
    host2 = await IrisHost.open({
      dataRoot,
      config,
      provider: "mock",
      outcomeReconciler: makeReconciler(calls2, "confirmed_applied"),
    });
    const pump2 = host2.run();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(
      calls2.length,
      0,
      "restart after confirmed_applied must read the durable resolution — zero re-query",
    );
    assert.equal(
      counter2.promptCalls,
      0,
      "repeated restarts must NEVER replay after confirmed_applied",
    );
    assert.equal(
      host2.getIngress().getRecord(input.inputId, 1)?.state,
      "accepted",
      "input stays accepted — never re-prompted, never duplicated",
    );
    await host2.shutdown();
    await pump2;
    host2 = undefined;
  } finally {
    mock.restoreAll();
    await host2?.shutdown().catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Scenario 4: replay_safe → replay with the same logical execution identity
// ---------------------------------------------------------------------------

test("D5: replay_safe — replay with the same logicalExecutionId/idempotency identity, then settle", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-d5-replay-"));
  const config = defaultAgentConfig();
  const input = makeInput("d5-replay-0004");
  const logicalExecutionId = "logical-exec-1:d5-replay-0004";
  const counter = { promptCalls: 0 };
  const calls: ReconcilerCall[] = [];
  const events: string[] = [];

  seedCrashWindowState(dataRoot, config, input, {
    dispatchId: "dispatch-d5-replay-99",
    logicalExecutionId,
    inputId: input.inputId,
  });
  installPromptCounter(counter);

  let host: IrisHost | undefined;
  try {
    host = await IrisHost.open({
      dataRoot,
      config,
      provider: "mock",
      outcomeReconciler: makeReconciler(calls, "replay_safe"),
    });
    const unsubscribe = host.onEvent((event) => events.push(event.type));
    const pumpPromise = host.run();

    await waitFor(() => calls.length >= 1);
    assert.equal(calls.length, 1, "reconciliation runs once before the replay");
    assert.equal(calls[0]?.dispatchId, "dispatch-d5-replay-99");
    assert.equal(calls[0]?.logicalExecutionId, logicalExecutionId);
    assert.equal(calls[0]?.inputId, input.inputId);

    // replay_safe → replay with the same logical execution identity → settle.
    await waitFor(() => events.includes("settled"));
    assert.equal(
      counter.promptCalls,
      1,
      "replay_safe must replay EXACTLY once (same idempotency identity)",
    );
    assert.equal(
      host.getIngress().getRecord(input.inputId, 1)?.state,
      "session_committed",
      "the replay must settle and commit the input",
    );
    assert.equal(host.health().ready, true);

    await host.shutdown();
    await pumpPromise;
    unsubscribe();
    host = undefined;
  } finally {
    mock.restoreAll();
    await host?.shutdown().catch(() => undefined);
  }

  // The replay ran under the SAME durable logical execution row (the
  // supervisor never re-keyed the identity) and cleared the pending fence.
  const snapshot = loadSnapshot(dataRoot, logicalExecutionId);
  assert.ok(snapshot !== undefined, "recovery row must exist under the same logical execution id");
  assert.equal(snapshot.logicalExecutionId, logicalExecutionId);
  assert.equal(
    snapshot.pendingOutcomeUnknown,
    null,
    "replay_safe must clear the durable pending fence",
  );
});

// ---------------------------------------------------------------------------
// Scenario 5: dispatchId stability — same-run === restart
// ---------------------------------------------------------------------------

test("D5: dispatchId stability — same-run pending.dispatchId === restart pending.dispatchId", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-d5-stable-"));
  const config = defaultAgentConfig();
  const input = makeInput("d5-stable-0005");
  const logicalExecutionId = "logical-exec-1:d5-stable-0005";

  // Same-run: provider ambiguity → supervisor persists pending → reconciler
  // gets the same dispatchId → ambiguous → fail-closed.
  const calls1: ReconcilerCall[] = [];
  let host1: IrisHost | undefined;
  try {
    host1 = await IrisHost.open({
      dataRoot,
      config,
      provider: "mock",
      mockProviderError: providerFailure(),
      outcomeReconciler: makeReconciler(calls1, "ambiguous"),
    });
    const pump1 = host1.run();
    host1.acceptInput(input, input.inputId);
    await waitFor(() => calls1.length >= 1);
    const sameRunDispatchId = calls1[0]?.dispatchId;
    assert.ok(sameRunDispatchId !== undefined);
    await host1.shutdown();
    await pump1;
    host1 = undefined;
  } finally {
    mock.restoreAll();
    await host1?.shutdown().catch(() => undefined);
  }

  // The same-run pending is durable.
  const pendingOnDisk = loadSnapshot(dataRoot, logicalExecutionId)?.pendingOutcomeUnknown;
  assert.ok(pendingOnDisk !== undefined, "same-run pending must be on disk");
  assert.ok(pendingOnDisk !== null, "same-run pending must be a real record");
  assert.equal(pendingOnDisk.dispatchId, calls1[0]?.dispatchId);

  // #102 crash window: the process died after the pending was persisted but
  // before the disposition — restore the pending WITHOUT the exhausted fence
  // so restart reconciliation legitimately runs again.
  const store = new RecoveryStateStore(join(dataRoot, "recovery-state.db"));
  try {
    const snapshot = store.load(logicalExecutionId);
    assert.ok(snapshot !== undefined);
    store.save({ ...snapshot, exhausted: false });
  } finally {
    store.close();
  }

  // Restart: reconciler must receive the SAME dispatchId as the same-run
  // pending — from the persisted record, not re-inferred.
  const calls2: ReconcilerCall[] = [];
  const host2 = await IrisHost.open({
    dataRoot,
    config,
    provider: "mock",
    outcomeReconciler: makeReconciler(calls2, "ambiguous"),
  });
  try {
    const pump2 = host2.run();
    await waitFor(() => calls2.length >= 1);
    assert.equal(
      calls2[0]?.dispatchId,
      calls1[0]?.dispatchId,
      "restart reconciliation must use the SAME dispatchId as the same-run pending",
    );
    assert.equal(calls2[0]?.logicalExecutionId, logicalExecutionId);
    assert.equal(calls2[0]?.inputId, input.inputId);
    await host2.shutdown();
    await pump2;
  } finally {
    await host2.shutdown().catch(() => undefined);
  }

  assert.equal(
    loadSnapshot(dataRoot, logicalExecutionId)?.pendingOutcomeUnknown?.dispatchId,
    calls1[0]?.dispatchId,
    "durable pending.dispatchId === same-run dispatchId === restart dispatchId",
  );
});
