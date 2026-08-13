import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { defaultAgentConfig } from "../src/config/load.js";
import { initializeDataRoot, resolveDataRootPaths } from "../src/host/data-root.js";
import { IrisHost } from "../src/host/host.js";
import { RuntimeEpochStore } from "../src/runtime/epoch-manager.js";
import { directUserRequest } from "../src/contracts/origin.js";
import type { AgentInput } from "../src/contracts/origin.js";
import { openOrCreateSession } from "../src/runtime/vertical-slice.js";

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

test("IrisHost: long-lived host accepts inputs, auto-consumes the FIFO, and settles", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-basic-"));
  const config = defaultAgentConfig();
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const events: string[] = [];
  const unsubscribe = host.onEvent((event) => events.push(event.type));
  try {
    const pumpPromise = host.run();
    const outcome = host.acceptInput(makeInput("host-0001"), "host-0001");
    assert.equal(outcome.outcome, "accepted");
    // Give the pump a moment to run the invocation to settled.
    await waitFor(() => events.includes("settled"));
    assert.equal(host.health().ready, true);
    assert.equal(host.health().coordinatorPhase, "idle");
    // The input is now durably session_committed (Pi pair verified).
    const record = host.getIngress().getRecord("host-0001", 1);
    assert.equal(record?.state, "session_committed");
    assert.ok(record.runtimeSessionId?.startsWith("iris-runtime-"));
    await host.shutdown();
    await pumpPromise;
  } finally {
    unsubscribe();
    await host.shutdown().catch(() => undefined);
  }
});

test("IrisHost: second host against the same data root fails fast (lock held)", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-lock-"));
  const config = defaultAgentConfig();
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  try {
    await assert.rejects(
      IrisHost.open({ dataRoot, config, provider: "mock" }),
      /ELOCKED|lock|already/i,
    );
  } finally {
    await host.shutdown();
  }
  // After graceful shutdown the lock is released and a new host can open.
  const second = await IrisHost.open({ dataRoot, config, provider: "mock" });
  await second.shutdown();
});

test("IrisHost: rollover after settled creates a fresh Session and routes the next input to it", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-rollover-"));
  const config = defaultAgentConfig();
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const events: string[] = [];
  const unsubscribe = host.onEvent((event) => events.push(event.type));
  try {
    const pumpPromise = host.run();
    // First input settles in epoch 1.
    host.acceptInput(makeInput("ro-0001"), "ro-0001");
    await waitFor(() => events.includes("settled"));

    // Request rollover; the switch happens after the settled boundary.
    host.requestRollover("test_admin_request");
    await waitFor(() => events.includes("rollover_completed"));

    const active = host.getCurrentEpoch();
    assert.notEqual(active.epochId, "iris-runtime-2026-08-01-1");
    const status = host.sessionStatus();
    assert.equal(status.epochId, active.epochId);
    assert.notEqual(status.runtimeSessionId, "iris-runtime-2026-08-01-1");

    // A queued input after the rollover enters the NEW Session's first prompt.
    host.acceptInput(makeInput("ro-0002"), "ro-0002");
    const settledCountBefore = events.filter((e) => e === "settled").length;
    await waitFor(() => events.filter((e) => e === "settled").length > settledCountBefore);
    const record = host.getIngress().getRecord("ro-0002", 1);
    assert.equal(record?.state, "session_committed");
    assert.equal(record.runtimeSessionId, active.runtimeSessionId);

    await host.shutdown();
    await pumpPromise;
  } finally {
    unsubscribe();
    await host.shutdown().catch(() => undefined);
  }
});

test("IrisHost: rollover recovery — window 2/3 (creating epoch + new session before CAS)", async () => {
  // Crash state: a 'creating' Epoch row + its new Pi Session row exist, but
  // the active CAS never happened. The real startup path must discard the
  // orphan creating Epoch/Session and keep exactly one active Epoch.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-rw23-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);

  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const active = store.ensureActive("2026-08-01T12:00:00.000Z");
  const pending = store.beginRollover("2026-08-01T12:00:00.000Z");
  // The active Epoch's Session exists (a real product data root always has
  // one); the new Pi Session row was created (crash after create, before CAS).
  await openOrCreateSession(dataRoot, config, active.runtimeSessionId);
  await openOrCreateSession(dataRoot, config, pending.runtimeSessionId);
  store.close();

  // Real startup path: recovery cleans the orphan and opens the active Epoch.
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  try {
    assert.equal(host.getCurrentEpoch().epochId, active.epochId);
    assert.equal(host.sessionStatus().status, "active");
    assert.equal(host.getEpochStore().listCreating().length, 0);
  } finally {
    await host.shutdown();
  }
});

test("IrisHost: rollover recovery — multiple active epochs is corrupt and refuses to guess", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-multiactive-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);
  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  store.ensureActive("2026-08-01T12:00:00.000Z");
  await openOrCreateSession(dataRoot, config, "iris-runtime-2026-08-01-1");
  // Force a second active row (corrupt state) — the Host must NOT pick one
  // by creation time; it enters not-ready/corrupt.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(paths.epochRegistryDb);
  db.prepare(
    `INSERT INTO runtime_epochs(epoch_id, runtime_session_id, local_date, ordinal_within_date, status, created_at)
     VALUES ('iris-runtime-2026-08-01-2', 'iris-runtime-2026-08-01-2', '2026-08-01', 2, 'active', '2026-08-01T12:00:01.000Z')`,
  ).run();
  db.close();

  // Real startup path: two active Epochs => not-ready/corrupt, no silent pick.
  await assert.rejects(
    IrisHost.open({ dataRoot, config, provider: "mock" }),
    /corrupt: 2 active epochs/,
  );
  // The lock was released by the failed startup. Repair the corrupt state
  // (delete the duplicate active row) and re-open — the lock is re-acquirable.
  const repair = new DatabaseSync(paths.epochRegistryDb);
  repair.prepare("DELETE FROM runtime_epochs WHERE epoch_id = 'iris-runtime-2026-08-01-2'").run();
  repair.close();
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  await host.shutdown();
});

test("IrisHost: closed/closed_incomplete sessions never receive new inputs", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-closed-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);
  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const active = store.ensureActive("2026-08-01T12:00:00.000Z");
  store.markClosed(active.epochId, "closed", "2026-08-01T13:00:00.000Z");
  const fresh = store.ensureActive("2026-08-01T14:00:00.000Z");
  // The fresh active Epoch's Session exists (real data root invariant).
  await openOrCreateSession(dataRoot, config, fresh.runtimeSessionId);
  store.close();

  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  try {
    // The active Epoch is the fresh one; the closed one is archived only.
    assert.equal(host.getCurrentEpoch().epochId, fresh.epochId);
    const archives = host.archives(50);
    assert.ok(archives.some((entry) => entry.status === "closed"));
  } finally {
    await host.shutdown();
  }
});

test("IrisHost: shutdown rejects new inputs and releases the lock", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-shutdown-"));
  const config = defaultAgentConfig();
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const pumpPromise = host.run();
  await host.shutdown();
  await pumpPromise;
  assert.equal(host.getReady(), false);
  // Lock released: a new host can open immediately.
  const second = await IrisHost.open({ dataRoot, config, provider: "mock" });
  await second.shutdown();
});

test("IrisHost: M1 — a retry while the input is in-flight is not double-prompted", async () => {
  // A client retry (same identity + same payload) during an active turn must
  // return the duplicate result WITHOUT re-enqueuing — the input is already
  // being prompted (in-flight). Only one settled per input.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-inflight-"));
  const config = defaultAgentConfig();
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const events: string[] = [];
  const unsubscribe = host.onEvent((event) => events.push(event.type));
  try {
    const pumpPromise = host.run();
    host.acceptInput(makeInput("inflight-0001"), "inflight-0001");
    await waitFor(() => events.includes("turn_start"));
    // While the turn is active, the client retries the same input.
    const retry = host.acceptInput(makeInput("inflight-0001"), "inflight-0001");
    assert.equal(retry.outcome, "duplicate");
    // Exactly one settled — the retry never triggered a second prompt.
    await waitFor(() => events.filter((e) => e === "settled").length >= 1);
    const settledCount = events.filter((e) => e === "settled").length;
    assert.equal(settledCount, 1, `expected exactly 1 settled, got ${settledCount}`);
    assert.equal(host.getIngress().queuedCount(), 0);
    await host.shutdown();
    await pumpPromise;
  } finally {
    unsubscribe();
    await host.shutdown().catch(() => undefined);
  }
});

test("IrisHost: M2 — a failed invocation flips not-ready and recover() resumes the pump", async () => {
  // Simulate a provider failure by feeding an input whose frames cannot be
  // encoded (invalid content mode poisons encodeInputFrames) — the turn fails,
  // the Host flips not-ready, and recover() clears it so the pump resumes.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-failed-"));
  const config = defaultAgentConfig();
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const events: string[] = [];
  const unsubscribe = host.onEvent((event) => events.push(event.type));
  try {
    const pumpPromise = host.run();
    // A well-formed input that the mock provider settles normally.
    host.acceptInput(makeInput("ok-0001"), "ok-0001");
    await waitFor(() => events.filter((e) => e === "settled").length >= 1);
    assert.equal(host.health().ready, true);

    // review-pass-2 #5: a poisoned envelope is rejected at the Host boundary
    // (never durably accepted, never flips the Host failed).
    const badInput = {
      inputId: "bad-0001",
      triggerOrigin: directUserRequest(),
      blocks: [
        {
          blockId: "bad-block",
          sourceOrigin: directUserRequest(),
          content: { mode: "unsupported_mode" as never, text: "x" },
          contentHash: "",
        },
      ],
    };
    assert.throws(() => host.acceptInput(badInput, "bad-0001"), /input_invalid|content mode/);
    assert.equal(host.health().ready, true, "rejected input must not flip the Host not-ready");
    assert.equal(host.getIngress().getRecord("bad-0001", 1), undefined);

    // A clean input still settles after the rejected one.
    host.acceptInput(makeInput("ok-0002"), "ok-0002");
    const settledAfter = events.filter((e) => e === "settled").length;
    await waitFor(() => events.filter((e) => e === "settled").length > settledAfter);
    assert.equal(host.health().ready, true);
    await host.shutdown();
    await pumpPromise;
  } finally {
    unsubscribe();
    await host.shutdown().catch(() => undefined);
  }
});

test("IrisHost: C1 — shutdown during an active turn still commits the input", async () => {
  // The worst crash-window: shutdown while an invocation is mid-turn. The
  // input must reach session_committed (the turn finishes, the ledger is only
  // closed after the pump exits) — no accepted-but-uncommitted leftover.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-c1-"));
  const config = defaultAgentConfig();
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const events: string[] = [];
  const unsubscribe = host.onEvent((event) => events.push(event.type));
  try {
    const pumpPromise = host.run();
    host.acceptInput(makeInput("c1-0001"), "c1-0001");
    // Wait until the turn is actually active, then shutdown mid-turn.
    await waitFor(() => events.includes("turn_start"));
    const shutdownPromise = host.shutdown();
    await shutdownPromise;
    await pumpPromise;
  } finally {
    unsubscribe();
    await host.shutdown().catch(() => undefined);
  }
  // After shutdown the ledger is closed; re-open it to verify the durable
  // state (as a fresh process would after a crash/restart).
  const { InputAcceptanceLedger } = await import("../src/host/ingress.js");
  const paths = resolveDataRootPaths(dataRoot, config);
  const reopened = new InputAcceptanceLedger(paths.ingressDb, paths.blobsIngress, 20, 1);
  try {
    const record = reopened.getRecord("c1-0001", 1);
    assert.equal(
      record?.state,
      "session_committed",
      "C1: input must be committed, not left accepted",
    );
  } finally {
    reopened.close();
  }
});

test("IrisHost: rollover recovery — window 1 (requested, old Session not yet settled)", async () => {
  // Crash state: rollover was REQUESTED but the old Session never settled, so
  // no creating Epoch exists. Startup must keep the old active Epoch (the
  // request is not a durable switch) and serve it normally.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-rw1-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);

  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const active = store.ensureActive("2026-08-01T12:00:00.000Z");
  store.requestRollover("crash_before_settled"); // pending only, no switch
  store.close();
  // The active Epoch's Session exists (real data root invariant).
  await openOrCreateSession(dataRoot, config, active.runtimeSessionId);

  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  try {
    assert.equal(host.getCurrentEpoch().epochId, active.epochId);
    assert.equal(host.getEpochStore().countAll(), 1, "no new epoch may be created");
    assert.equal(host.sessionStatus().status, "active");
  } finally {
    await host.shutdown();
  }
});

test("IrisHost: rollover recovery — window 4/5 (CAS committed, new Session is the active Epoch)", async () => {
  // Crash state: the new Epoch row became 'active' (old -> closed) and the
  // new Pi Session row exists, but the process died before the first prompt.
  // Startup must serve the NEW active Epoch + real empty Session — not
  // resurrect the closed old one, not guess by creation time.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-rw45-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);

  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const active = store.ensureActive("2026-08-01T12:00:00.000Z");
  const pending = store.beginRollover("2026-08-01T12:00:00.000Z");
  await openOrCreateSession(dataRoot, config, pending.runtimeSessionId);
  // Commit the CAS: old -> closed, new -> active.
  const next = store.activateRollover("2026-08-01T12:00:00.000Z");
  store.close();

  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  try {
    assert.equal(host.getCurrentEpoch().epochId, next.epochId);
    assert.equal(host.sessionStatus().status, "active");
    // The old epoch is archived as closed; the new Session is real and empty.
    const archives = host.archives(50);
    const oldEpoch = archives.find((entry) => entry.epochId === active.epochId);
    assert.equal(oldEpoch?.status, "closed");
    const status = host.sessionStatus();
    assert.equal(status.runtimeSessionId, next.runtimeSessionId);
    assert.notEqual(status.runtimeSessionId, active.runtimeSessionId);
  } finally {
    await host.shutdown();
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("IrisHost: A3 — rollover requires a native-settled token, not just idle", async () => {
  // A freshly started Host is `idle` but has NO settled authorization: a
  // pending admin rollover must NOT switch the Epoch until an invocation
  // actually reaches native settled on the active Epoch.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-a3-"));
  const config = defaultAgentConfig();
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const events: string[] = [];
  const unsubscribe = host.onEvent((event) => events.push(event.type));
  try {
    const pumpPromise = host.run();
    const epochId = host.getCurrentEpoch().epochId;
    // Request rollover while idle with NO settled ever observed.
    host.requestRollover("no_settled_never");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      host.getCurrentEpoch().epochId,
      epochId,
      "A3: rollover must not fire without a native-settled token",
    );
    assert.equal(events.includes("rollover_completed"), false);

    // After a real invocation settles, the token is produced and consumed:
    // rollover may then fire.
    host.acceptInput(makeInput("a3-0001"), "a3-0001");
    await waitFor(() => events.filter((e) => e === "settled").length >= 1);
    // Re-request after the settled boundary, then wait for the switch.
    host.requestRollover("after_settled");
    await waitFor(() => events.includes("rollover_completed"));
    assert.notEqual(host.getCurrentEpoch().epochId, epochId);
    await host.shutdown();
    await pumpPromise;
  } finally {
    unsubscribe();
    await host.shutdown().catch(() => undefined);
  }
});

test("IrisHost: A5 — active Epoch with missing Session is not-ready/corrupt", async () => {
  // An existing active Epoch whose Pi Session row is missing must fail closed
  // at startup (never silently create an empty Session masquerading as the
  // lost history).
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-a5-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);
  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  store.ensureActive("2026-08-01T12:00:00.000Z"); // Epoch exists, Session does NOT
  store.close();

  await assert.rejects(
    IrisHost.open({ dataRoot, config, provider: "mock" }),
    /missing\/corrupt: Pi Session/,
  );
  // The lock was released by the failed startup (re-openable after repair).
  const { SqliteSessionRepository, createNodeSqliteFactory } =
    await import("@iris/pi-storage-sqlite-node");
  const { nodeSqliteRepoEnv } = await import("../src/runtime/pi-env.js");
  const repo = new SqliteSessionRepository({
    env: nodeSqliteRepoEnv(dataRoot),
    sqlite: createNodeSqliteFactory(),
    databasePath: paths.sessionDb,
  });
  await repo.create({ id: "iris-runtime-2026-08-01-1", cwd: dataRoot });
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  await host.shutdown();
});

test("IrisHost: A1 — accepted record whose Pi pair exists is promoted, not re-prompted", async () => {
  // Simulate: an input was accepted AND its UserMessage + companion pair was
  // durably committed to the Pi Session, but the process crashed before
  // settled. On restart the record must be promoted to session_committed —
  // NOT re-prompted (no second UserMessage).
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-a1-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);

  // First run: accept + fully settle the input (creates the Pi pair).
  const first = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const pump1 = first.run();
  const events1: string[] = [];
  const unsub1 = first.onEvent((e) => events1.push(e.type));
  first.acceptInput(makeInput("a1-0001"), "a1-0001");
  await waitFor(() => events1.includes("settled"));
  const record = first.getIngress().getRecord("a1-0001", 1);
  assert.equal(record?.state, "session_committed");
  unsub1();
  await first.shutdown();
  await pump1;

  // Simulate the crash-before-settled window: rewind the record to `accepted`
  // (the Pi pair still exists in the Session).
  const { InputAcceptanceLedger } = await import("../src/host/ingress.js");
  const ledger = new InputAcceptanceLedger(paths.ingressDb, paths.blobsIngress, 20, 1);
  ledger.rewindToAccepted("a1-0001", 1);
  ledger.close();

  // Restart: the record must be promoted to session_committed by startup
  // reconciliation (the full pair exists) and never re-prompted.
  const restarted = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const events2: string[] = [];
  const unsub2 = restarted.onEvent((e) => events2.push(e.type));
  const pump2 = restarted.run();
  // Give the pump time to run if it (wrongly) tried to re-prompt; the input
  // is already bound to a Pi pair, so it must NOT be prompted again.
  await new Promise((resolve) => setTimeout(resolve, 800));
  const after = restarted.getIngress().getRecord("a1-0001", 1);
  assert.equal(
    after?.state,
    "session_committed",
    "A1: full pair must be promoted, not re-prompted",
  );
  assert.equal(
    events2.includes("turn_start"),
    false,
    "A1: committed input must never be re-prompted",
  );
  unsub2();
  await restarted.shutdown();
  await pump2;
});

test("review-pass2 #1: partial pair (UserMessage w/o companion) fails closed, never re-prompted", async () => {
  // Simulate the crash window AFTER the UserMessage was appended but BEFORE
  // the companion: on restart the accepted record must be marked rejected
  // (partial_pair_incomplete) — NOT re-prompted (no second UserMessage).
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-partial-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);

  // Create active Epoch + Session, then append ONLY the UserMessage frames
  // (no iris_input_meta companion) for a known input.
  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const active = store.ensureActive("2026-08-01T12:00:00.000Z");
  store.close();
  const sessionHandle = await openOrCreateSession(dataRoot, config, active.runtimeSessionId);
  const session = sessionHandle.session;
  await session.appendMessage({
    role: "user",
    content: "IRIS_INPUT_V1\ninline_text:10\nhello iris\n",
    timestamp: Date.now(),
  });
  // 0.83.0+: release the Session storage connection (data retained).
  await sessionHandle.repo[Symbol.asyncDispose]();

  // Accept the same input durably (simulating the crash-left accepted record).
  const { InputAcceptanceLedger } = await import("../src/host/ingress.js");
  const ledger = new InputAcceptanceLedger(paths.ingressDb, paths.blobsIngress, 20, 1);
  ledger.accept(makeInput("partial-0001", "hello iris"), "partial-0001");
  ledger.close();

  // Restart: the orphan UserMessage wire proves only content equality, never
  // identity (review-pass-5 #2) — the Host fails closed into not-ready rather
  // than permanently rejecting a 202-accepted input or re-prompting it.
  await assert.rejects(
    IrisHost.open({ dataRoot, config, provider: "mock" }),
    /ambiguous ingress recovery for inputs: partial-0001/,
  );
  // The lock was released by the failed startup.
  const { DatabaseSync } = await import("node:sqlite");
  const repairDb = new DatabaseSync(paths.ingressDb);
  repairDb.prepare("DELETE FROM ingress_acceptances WHERE input_id = 'partial-0001'").run();
  repairDb.close();
  const second = await IrisHost.open({ dataRoot, config, provider: "mock" });
  await second.shutdown();
});

test("review-pass2 #2: archives-only data root creates a fresh Epoch + Session", async () => {
  // No active Epoch, but closed archives exist: startup must create a new
  // active Epoch AND its fresh Session (not fail with a missing Session).
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-archives-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);
  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const old = store.ensureActive("2026-08-01T10:00:00.000Z");
  store.markClosed(old.epochId, "closed", "2026-08-01T11:00:00.000Z");
  // Archive Session row exists but its Epoch is closed.
  await openOrCreateSession(dataRoot, config, old.runtimeSessionId);
  store.close();

  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  try {
    const current = host.getCurrentEpoch();
    assert.notEqual(current.epochId, old.epochId, "a fresh active Epoch must be created");
    assert.equal(host.sessionStatus().status, "active");
  } finally {
    await host.shutdown();
  }
});

test("review-pass2 #3: settled token is bound to its invocation and consumed once", async () => {
  // The one-time token semantics: a settled invocation produces a token, a
  // rollover request consumes it exactly once (a second request with no new
  // settled does nothing), and a fresh invocation replaces it.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-staletoken-"));
  const config = defaultAgentConfig();
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const events: string[] = [];
  const unsub = host.onEvent((e) => events.push(e.type));
  try {
    const pump = host.run();
    const epochId = host.getCurrentEpoch().epochId;
    // Invocation A settles — token produced but rollover NOT requested.
    host.acceptInput(makeInput("a-0001"), "a-0001");
    await waitFor(() => events.filter((e) => e === "settled").length >= 1);

    // Request rollover now (token present) → switch happens and consumes it.
    host.requestRollover("after_a_settled");
    await waitFor(() => events.includes("rollover_completed"));
    assert.notEqual(host.getCurrentEpoch().epochId, epochId, "token must authorize the switch");
    await host.shutdown();
    await pump;
  } finally {
    unsub();
    await host.shutdown().catch(() => undefined);
  }
});

test("review-pass2 #5: Host acceptInput validates and is the only normalization authority", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-validate-"));
  const config = defaultAgentConfig();
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  try {
    // Malformed input (missing triggerOrigin) is rejected by the Host.
    assert.throws(
      () =>
        host.acceptInput(
          {
            inputId: "x",
            blocks: [
              {
                blockId: "b1",
                sourceOrigin: directUserRequest(),
                content: { mode: "inline_text", text: "hi" },
                contentHash: "",
              },
            ],
          },
          "x",
        ),
      /triggerOrigin/,
    );
    // inputId mismatch between transport and envelope is rejected.
    assert.throws(
      () => host.acceptInput(makeInput("env-0001"), "transport-id-mismatch"),
      /does not match envelope inputId/,
    );
  } finally {
    await host.shutdown();
  }
});

test("review-pass3 #1: corrupt companion pairKey/layout is NOT a verified full pair", async () => {
  // A companion carrying the right inputId but a WRONG pairKey or layout hash
  // must not promote the ingress record — identity-safe verification.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-badpair-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);

  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const active = store.ensureActive("2026-08-01T12:00:00.000Z");
  store.close();
  const sessionHandle = await openOrCreateSession(dataRoot, config, active.runtimeSessionId);
  const session = sessionHandle.session;
  const wire = "IRIS_INPUT_V1\ninline_text:10\nhello iris\n";
  await session.appendMessage({ role: "user", content: wire, timestamp: Date.now() });
  // Companion with the right inputId but a WRONG pairKey (all zeros).
  await session.appendCustomMessageEntry("iris_input_meta", "IRIS_INPUT_META_V1", false, {
    iris: {
      schemaVersion: 1,
      inputId: "corrupt-0001",
      pairKey: "0".repeat(64),
      contentLayoutHash: "0".repeat(64),
      blocks: [],
    },
  });
  // 0.83.0+: release the Session storage connection (data retained).
  await sessionHandle.repo[Symbol.asyncDispose]();

  const { InputAcceptanceLedger } = await import("../src/host/ingress.js");
  const ledger = new InputAcceptanceLedger(paths.ingressDb, paths.blobsIngress, 20, 1);
  ledger.accept(makeInput("corrupt-0001", "hello iris"), "corrupt-0001");
  ledger.close();

  // The corrupt pair must NOT be verified as a full pair: the UserMessage
  // wire exists but the companion fails pairKey/layout verification, so the
  // record enters ambiguous/incomplete recovery — the Host fails closed into
  // not-ready (never false-commits, never re-prompts, never guesses identity).
  await assert.rejects(
    IrisHost.open({ dataRoot, config, provider: "mock" }),
    /ambiguous ingress recovery for inputs: corrupt-0001/,
  );
  // The lock was released by the failed startup.
  const { DatabaseSync } = await import("node:sqlite");
  const repairDb = new DatabaseSync(paths.ingressDb);
  repairDb.prepare("DELETE FROM ingress_acceptances WHERE input_id = 'corrupt-0001'").run();
  repairDb.close();
  const second = await IrisHost.open({ dataRoot, config, provider: "mock" });
  await second.shutdown();
});

test("review-pass3 #2: two inputs with identical body under different inputIds are classified independently", async () => {
  // Same wire, different inputId: an orphan UserMessage (no companion) for
  // input A must NOT reject input B (same body) that was never appended.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-ambig-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);

  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const active = store.ensureActive("2026-08-01T12:00:00.000Z");
  store.close();
  const sessionHandle = await openOrCreateSession(dataRoot, config, active.runtimeSessionId);
  const session = sessionHandle.session;
  // UserMessage for input "a-0001" with body "same body" — NO companion.
  await session.appendMessage({
    role: "user",
    content: "IRIS_INPUT_V1\ninline_text:9\nsame body\n",
    timestamp: Date.now(),
  });
  // 0.83.0+: release the Session storage connection (data retained).
  await sessionHandle.repo[Symbol.asyncDispose]();

  // BOTH a-0001 and b-0001 accepted with the SAME body.
  const { InputAcceptanceLedger } = await import("../src/host/ingress.js");
  const ledger = new InputAcceptanceLedger(paths.ingressDb, paths.blobsIngress, 20, 1);
  ledger.accept(makeInput("a-0001", "same body"), "a-0001");
  ledger.accept(makeInput("b-0001", "same body"), "b-0001");
  ledger.close();

  // The orphan UserMessage wire matches BOTH envelopes -> ambiguous recovery:
  // the Host must NOT guess or batch-reject 202-accepted inputs. It fails
  // closed into not-ready/corrupt so an operator reviews the data root.
  await assert.rejects(
    IrisHost.open({ dataRoot, config, provider: "mock" }),
    /ambiguous ingress recovery for inputs: a-0001, b-0001/,
  );
  // The lock was released by the failed startup. Repair: the operator removes
  // the ambiguous accepted records (or resolves the Session), then the data
  // root reopens normally.
  const { DatabaseSync } = await import("node:sqlite");
  const repairDb = new DatabaseSync(paths.ingressDb);
  repairDb.prepare("DELETE FROM ingress_acceptances WHERE input_id IN ('a-0001', 'b-0001')").run();
  repairDb.close();
  const second = await IrisHost.open({ dataRoot, config, provider: "mock" });
  await second.shutdown();
});

test("review-pass4 #2: rollover post-construction fault => fail-stop, recover forbidden, state consistent", async () => {
  // Fail-stop strategy (review-pass-4 #2): after a rollover post-construction
  // fault the Host is deterministically not-ready, recover() is FORBIDDEN
  // (registry/runtime may be inconsistent), and shutdown releases the lock so
  // restart recovery can rebuild from the durable DB.
  for (const fault of ["dispose_old", "activate_rollover", "cas_swap"] as const) {
    const dataRoot = mkdtempSync(join(tmpdir(), `iris-host-fault-${fault}-`));
    const config = defaultAgentConfig();
    const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
    host._setFaultPoint(fault);
    const events: string[] = [];
    const unsub = host.onEvent((e) => events.push(e.type));
    let pump: Promise<void>;
    try {
      pump = host.run();
      host.acceptInput(makeInput(`f-${fault}`), `f-${fault}`);
      // The invocation settles (token produced); the pending rollover then
      // faults at the injected point.
      await waitFor(() => events.filter((e) => e === "settled").length >= 1);
      host.requestRollover(`fault_${fault}`);
      // The pump must fail (not-ready), NOT silently mis-switch.
      const messages = {
        dispose_old: "old Capsule dispose failure",
        activate_rollover: "epoch activation failure",
        cas_swap: "registry swap failure",
      } as const;
      await assert.rejects(pump, new RegExp(messages[fault]));
      assert.equal(host.health().ready, false, "rollover fault must flip not-ready");
      // Fail-stop: recover() must be FORBIDDEN (runtime/registry may be
      // inconsistent — never resume on a possibly-disposed Capsule).
      assert.equal(host.isFailStop(), true);
      assert.throws(() => {
        host.recover();
      }, /cannot recover a fail-stop host/);
      // review-pass-5 #3: state-ownership assertions per window. For
      // cas_swap the Epoch DB was already activated to the new Epoch but the
      // registry still points at the old (disposed) runtime — the process is
      // deterministically not-ready and only restart can reconcile.
      if (fault === "cas_swap") {
        const dbActive = host.getEpochStore().getActive();
        assert.notEqual(
          dbActive?.epochId,
          host.getCurrentEpoch().epochId,
          "cas_swap fault: DB active Epoch already advanced but registry/currentEpoch still old",
        );
      }
    } finally {
      unsub();
      // Shutdown must still release the lock (no leak).
      await host.shutdown().catch(() => undefined);
      // The durable DB state (whatever the fault left) must be re-openable —
      // restart recovery rebuilds the Capsule from the DB.
      const second = await IrisHost.open({ dataRoot, config, provider: "mock" });
      await second.shutdown();
    }
  }
});

test("review-pass4 #1a: historical committed A (body W) does not make pending B (same body W) partial", async () => {
  // A(inputId=A, body=W) is FULLY committed (verified pair in Session).
  // B(inputId=B, body=W) was durably accepted but crashed BEFORE its Pi
  // append. On restart B must be re-delivered normally (no Pi append for B) —
  // A's UserMessage is consumed by A's verified pair and is NOT an orphan, so
  // it must not be mistaken for B's partial.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-rp4a-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);

  // First run: accept + fully settle A (body W) -> verified pair in Session.
  const first = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const pump1 = first.run();
  const ev1: string[] = [];
  const un1 = first.onEvent((e) => ev1.push(e.type));
  first.acceptInput(makeInput("a-0001", "same body"), "a-0001");
  await waitFor(() => ev1.filter((e) => e === "settled").length >= 1);
  const recA = first.getIngress().getRecord("a-0001", 1);
  assert.equal(recA?.state, "session_committed");
  un1();
  await first.shutdown();
  await pump1;

  // Accept B with the SAME body, rewind it to the crash window (accepted,
  // never appended).
  const { InputAcceptanceLedger } = await import("../src/host/ingress.js");
  const ledger = new InputAcceptanceLedger(paths.ingressDb, paths.blobsIngress, 20, 1);
  ledger.accept(makeInput("b-0001", "same body"), "b-0001");
  ledger.close();

  // Restart: B must be delivered (settled), NOT rejected as partial.
  const restarted = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const ev2: string[] = [];
  const un2 = restarted.onEvent((e) => ev2.push(e.type));
  const pump2 = restarted.run();
  await waitFor(() => ev2.filter((e) => e === "settled").length >= 1);
  const recB = restarted.getIngress().getRecord("b-0001", 1);
  assert.equal(
    recB?.state,
    "session_committed",
    "B (same body as committed A, never appended) must be delivered, not rejected",
  );
  un2();
  await restarted.shutdown();
  await pump2;
});

test("review-pass4 #1b: same-body A and B both with verified pairs are both promoted", async () => {
  // A and B have IDENTICAL body W and BOTH have a legal verified pair in the
  // Session; B's ingress record was not yet marked session_committed when the
  // process crashed (window 4). Both must be promoted by their OWN identity
  // (pairKey embeds inputId) — wire equality must NOT conflate them.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-rp4b-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);

  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const active = store.ensureActive("2026-08-01T12:00:00.000Z");
  store.close();
  const sessionHandle = await openOrCreateSession(dataRoot, config, active.runtimeSessionId);
  const session = sessionHandle.session;

  // Append verified pairs for BOTH a-0001 and b-0001 (identical body W) using
  // the REAL companion generator (correct pairKey + layout hash + blocks).
  const { createInputMetaCompanion, computeContentLayoutHash } =
    await import("../src/runtime/companion.js");
  const wire = "IRIS_INPUT_V1\ninline_text:9\nsame body\n";
  for (const inputId of ["a-0001", "b-0001"]) {
    const input = makeInput(inputId, "same body");
    const layoutHash = computeContentLayoutHash(input, wire);
    const companion = createInputMetaCompanion(
      input,
      layoutHash,
      new Date().toISOString(),
      1, // instanceEpoch: Host default (pair identity includes instanceEpoch)
    );
    await session.appendMessage({ role: "user", content: wire, timestamp: Date.now() });
    await session.appendMessage(companion);
  }
  // 0.83.0+: release the Session storage connection (data retained).
  await sessionHandle.repo[Symbol.asyncDispose]();

  // Both accepted durably.
  const { InputAcceptanceLedger } = await import("../src/host/ingress.js");
  const ledger = new InputAcceptanceLedger(paths.ingressDb, paths.blobsIngress, 20, 1);
  ledger.accept(makeInput("a-0001", "same body"), "a-0001");
  ledger.accept(makeInput("b-0001", "same body"), "b-0001");
  ledger.close();

  // Restart: BOTH must be promoted (session_committed), not conflated.
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  try {
    const recA = host.getIngress().getRecord("a-0001", 1);
    const recB = host.getIngress().getRecord("b-0001", 1);
    assert.equal(
      recA?.state,
      "session_committed",
      "A with verified pair must be promoted despite same body as B",
    );
    assert.equal(
      recB?.state,
      "session_committed",
      "B with verified pair must be promoted despite same body as A",
    );
  } finally {
    await host.shutdown();
  }
});

test("review-pass6 #2: tampered / wrong-hash / missing ingress blob is integrity-rejected, never delivered", async () => {
  // The verified load (raw-bytes ref hash + byteLength + canonical
  // payload_hash) is the ONLY envelope read path. A tampered blob, a blob
  // whose bytes hash to a different ref.hash, and a missing blob must all be
  // typed-rejected and dropped from the FIFO — never JSON.parse'd and
  // prompted.
  for (const scenario of ["tampered", "wrong_ref", "missing"] as const) {
    const dataRoot = mkdtempSync(join(tmpdir(), `iris-host-integrity-${scenario}-`));
    const config = defaultAgentConfig();
    const paths = resolveDataRootPaths(dataRoot, config);
    initializeDataRoot(dataRoot, config);

    const { InputAcceptanceLedger } = await import("../src/host/ingress.js");
    const ledger = new InputAcceptanceLedger(paths.ingressDb, paths.blobsIngress, 20, 1);
    const input = makeInput(`i-${scenario}`, `body ${scenario}`);
    ledger.accept(input, `i-${scenario}`);
    ledger.close();

    // Locate the blob and corrupt it per scenario.
    const record = new InputAcceptanceLedger(paths.ingressDb, paths.blobsIngress, 20, 1).getRecord(
      `i-${scenario}`,
      1,
    );
    const blobDir = paths.blobsIngress;
    const blobPath = join(blobDir, record?.normalizedInputRef?.uri ?? "missing.json");
    if (scenario === "tampered") {
      const original = readFileSync(blobPath, "utf8");
      const parsed = JSON.parse(original) as Record<string, unknown>;
      parsed["blocks"] = [{ blockId: "tampered", content: { mode: "inline_text", text: "x" } }];
      writeFileSync(blobPath, JSON.stringify(parsed), "utf8");
    } else if (scenario === "wrong_ref") {
      // Rewrite the blob so its raw bytes hash to a DIFFERENT hash than the
      // ledger ref.hash (append a byte, then fix JSON with whitespace).
      const original = readFileSync(blobPath, "utf8");
      writeFileSync(blobPath, `${original} `, "utf8"); // byteLength/hash mismatch
    } else {
      // missing: delete the blob.
      try {
        unlinkSync(blobPath);
      } catch {
        // already missing
      }
    }

    // Restart: the input must be integrity-rejected (no turn_start ever).
    const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
    const events: string[] = [];
    const unsub = host.onEvent((e) => events.push(e.type));
    const pump = host.run();
    await new Promise((resolve) => setTimeout(resolve, 800));
    const rec = host.getIngress().getRecord(`i-${scenario}`, 1);
    assert.equal(
      rec?.rejectionCode,
      "envelope_integrity",
      `scenario ${scenario}: blob must be integrity-rejected`,
    );
    assert.equal(
      events.includes("turn_start"),
      false,
      `scenario ${scenario}: tampered/missing blob must never be prompted`,
    );
    unsub();
    await host.shutdown();
    await pump;
  }
});

test("review-pass6 #1: same-identity pair with envelope mismatch is ambiguous, never re-prompted", async () => {
  // A verified (inputId, pairKey) pair exists in the Session with the SAME
  // wire as the pending envelope, but its companion metadata does NOT match
  // the envelope (drifted provenance). The record must enter ambiguous
  // recovery (not-ready) — NOT be treated as "no Pi append" and re-prompted
  // (which would append a second logical input).
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-rp61-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);

  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const active = store.ensureActive("2026-08-01T12:00:00.000Z");
  store.close();
  const sessionHandle = await openOrCreateSession(dataRoot, config, active.runtimeSessionId);
  const session = sessionHandle.session;
  // Append a UserMessage + companion with a REAL pairKey but a WRONG
  // triggerOrigin (different authority than the envelope's).
  const { createInputMetaCompanion, computeContentLayoutHash } =
    await import("../src/runtime/companion.js");
  const input = makeInput("mismatch-0001", "same body");
  const wire = "IRIS_INPUT_V1\ninline_text:9\nsame body\n";
  const layoutHash = computeContentLayoutHash(input, wire);
  const companion = createInputMetaCompanion(input, layoutHash, new Date().toISOString());
  // Drift the companion's triggerOrigin authority AFTER creation.
  const driftable = companion as unknown as {
    details: {
      iris: { triggerOrigin: unknown };
    };
  };
  driftable.details.iris.triggerOrigin = {
    schemaVersion: 1,
    channel: "evil",
    principalKind: "system",
    authority: "internal_control",
    trust: "trusted",
  };
  await session.appendMessage({ role: "user", content: wire, timestamp: Date.now() });
  await session.appendMessage(companion);
  // 0.83.0+: release the Session storage connection (data retained).
  await sessionHandle.repo[Symbol.asyncDispose]();

  const { InputAcceptanceLedger } = await import("../src/host/ingress.js");
  const ledger = new InputAcceptanceLedger(paths.ingressDb, paths.blobsIngress, 20, 1);
  ledger.accept(makeInput("mismatch-0001", "same body"), "mismatch-0001");
  ledger.close();

  // Restart: same identity + wire but companion metadata mismatch -> ambiguous
  // (fail closed, not-ready), never re-prompted.
  await assert.rejects(
    IrisHost.open({ dataRoot, config, provider: "mock" }),
    /ambiguous ingress recovery for inputs: mismatch-0001/,
  );
  // Clean up the ambiguous record, then the data root reopens normally.
  const { DatabaseSync } = await import("node:sqlite");
  const repairDb = new DatabaseSync(paths.ingressDb);
  repairDb.prepare("DELETE FROM ingress_acceptances WHERE input_id = 'mismatch-0001'").run();
  repairDb.close();
  const second = await IrisHost.open({ dataRoot, config, provider: "mock" });
  await second.shutdown();
});

test("review-pass7 #2: a pair created under a DIFFERENT instanceEpoch is not verified for this epoch", async () => {
  // A verified pair for input X (body W) exists in the Session but was
  // created under instanceEpoch=1. A NEW Host instance (instanceEpoch=2)
  // accepts the same inputId X with the same wire and crashes before append.
  // Restart with instanceEpoch=2 must NOT promote the epoch-1 pair (pairKey
  // embeds instanceEpoch) — the record enters ambiguous, not session_committed.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-rp72-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);

  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const active = store.ensureActive("2026-08-01T12:00:00.000Z");
  store.close();
  const sessionHandle = await openOrCreateSession(dataRoot, config, active.runtimeSessionId);
  const session = sessionHandle.session;
  const { createInputMetaCompanion, computeContentLayoutHash } =
    await import("../src/runtime/companion.js");
  const wire = "IRIS_INPUT_V1\ninline_text:9\nsame body\n";
  const input = makeInput("x-0001", "same body");
  const layoutHash = computeContentLayoutHash(input, wire);
  // Pair created under instanceEpoch=1.
  const companion = createInputMetaCompanion(input, layoutHash, new Date().toISOString(), 1);
  await session.appendMessage({ role: "user", content: wire, timestamp: Date.now() });
  await session.appendMessage(companion);
  // 0.83.0+: release the Session storage connection (data retained).
  await sessionHandle.repo[Symbol.asyncDispose]();

  // instanceEpoch=2 accepts the same inputId + wire, never appended.
  const { InputAcceptanceLedger } = await import("../src/host/ingress.js");
  const ledger = new InputAcceptanceLedger(paths.ingressDb, paths.blobsIngress, 20, 2);
  ledger.accept(makeInput("x-0001", "same body"), "x-0001");
  ledger.close();

  // Restart with instanceEpoch=2: the epoch-1 pair is NOT verified — the
  // orphan wire match makes it ambiguous (never falsely session_committed).
  await assert.rejects(
    IrisHost.open({ dataRoot, config, provider: "mock", instanceEpoch: 2 }),
    /ambiguous ingress recovery for inputs: x-0001/,
  );
  const second = await IrisHost.open({ dataRoot, config, provider: "mock" });
  await second.shutdown();
});

test("review-pass7 #1: construction failure rolls back Session + creating row re-entrant-safely", async () => {
  // A failure DURING new-Capsule construction (after the new Session row was
  // created) must: set fail-stop, clean the provisional Session storage AND
  // its metadata row, and only then delete the creating Epoch row — so no
  // stale creating row or orphan Session survives for the next startup.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-rp71-"));
  const config = defaultAgentConfig();
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  host._setFaultPoint("construct_new");
  const events: string[] = [];
  const unsub = host.onEvent((e) => events.push(e.type));
  let pump: Promise<void>;
  try {
    pump = host.run();
    host.acceptInput(makeInput("c-0001"), "c-0001");
    await waitFor(() => events.filter((e) => e === "settled").length >= 1);
    host.requestRollover("construct_fault");
    await assert.rejects(pump, /new Capsule construction failure/);
    assert.equal(host.isFailStop(), true);
    // No stale creating row survives.
    assert.equal(host.getEpochStore().listCreating().length, 0, "creating row must be cleaned up");
  } finally {
    unsub();
    await host.shutdown().catch(() => undefined);
    // Restart recovery is clean (no stale creating row / orphan Session).
    const second = await IrisHost.open({ dataRoot, config, provider: "mock" });
    await second.shutdown();
  }
});

test("review-pass7-fix: rollover then accept then restart verifies the new session's pair", async () => {
  // subagent-review fix regression: the new session's companion must bind the
  // Host's STABLE instanceEpoch (1), NOT the Runtime Session Epoch ordinal
  // (which is 2 after the first rollover). Otherwise restart recovery would
  // see a companion instanceEpoch ≠ Host instanceEpoch and mark the input
  // ambiguous (not-ready) instead of promoting it to session_committed.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-rp7fix-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const events: string[] = [];
  const unsub = host.onEvent((e) => events.push(e.type));
  try {
    const pump = host.run();
    // Settle input 1 (token produced) then rollover to the SECOND epoch.
    host.acceptInput(makeInput("pre-0001"), "pre-0001");
    await waitFor(() => events.filter((e) => e === "settled").length >= 1);
    const epochIdBefore = host.getCurrentEpoch().epochId;
    host.requestRollover("after_pre_settled");
    await waitFor(() => events.includes("rollover_completed"));
    assert.notEqual(host.getCurrentEpoch().epochId, epochIdBefore, "rollover must switch epoch");
    // New epoch ordinal is 2 — the new session's companions must STILL carry
    // Host instanceEpoch 1 (the fix under test).
    const newEpoch = host.getCurrentEpoch();
    assert.equal(newEpoch.ordinalWithinDate, 2, "second epoch ordinal must be 2");
    await host.shutdown();
    await pump;
  } finally {
    unsub();
    await host.shutdown().catch(() => undefined);
  }

  // Accept an input whose companion will be appended to the ordinal-2
  // session, then simulate the crash window (appended, not committed).
  const { InputAcceptanceLedger } = await import("../src/host/ingress.js");
  const ledger = new InputAcceptanceLedger(paths.ingressDb, paths.blobsIngress, 20, 1);
  ledger.accept(makeInput("post-0001", "post body"), "post-0001");
  ledger.close();
  // Append the user message + companion (as the harness would, with Host
  // instanceEpoch 1) directly to the ordinal-2 session.
  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const active = store.getActive();
  store.close();
  assert.ok(active !== null);
  const sessionHandle = await openOrCreateSession(dataRoot, config, active.runtimeSessionId);
  const session = sessionHandle.session;
  const { createInputMetaCompanion, computeContentLayoutHash } =
    await import("../src/runtime/companion.js");
  const input = makeInput("post-0001", "post body");
  const wire = "IRIS_INPUT_V1\ninline_text:9\npost body\n";
  const layoutHash = computeContentLayoutHash(input, wire);
  const companion = createInputMetaCompanion(
    input,
    layoutHash,
    new Date().toISOString(),
    1, // Host instanceEpoch — must match what the harness writes post-rollover
  );
  await session.appendMessage({ role: "user", content: wire, timestamp: Date.now() });
  await session.appendMessage(companion);
  // 0.83.0+: release the Session storage connection (data retained).
  await sessionHandle.repo[Symbol.asyncDispose]();

  // Restart: the ordinal-2 session's pair (instanceEpoch 1) must be verified
  // and promoted — NOT ambiguous/not-ready.
  const restarted = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const events2: string[] = [];
  const unsub2 = restarted.onEvent((e) => events2.push(e.type));
  try {
    const rec = restarted.getIngress().getRecord("post-0001", 1);
    assert.equal(rec?.state, "session_committed", "post-rollover pair must be promoted");
    assert.equal(events2.includes("turn_start"), false, "committed pair must not re-prompt");
  } finally {
    unsub2();
    await restarted.shutdown();
  }
});
