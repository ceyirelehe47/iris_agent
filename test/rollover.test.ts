import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { createNodeSqliteFactory, SqliteSessionRepository } from "@iris/pi-storage-sqlite-node";

import { defaultAgentConfig } from "../src/config/load.js";
import { initializeDataRoot, resolveDataRootPaths } from "../src/host/data-root.js";
import { RuntimeEpochStore } from "../src/runtime/epoch-manager.js";
import { nodeSqliteRepoEnv } from "../src/runtime/pi-env.js";
import {
  reopenActiveSession,
  rolloverActiveSession,
  
  sampleAgentInput,
} from "../src/runtime/vertical-slice.js";
import { runMinimalSlice } from "../src/runtime/vertical-slice-demo.js";

test("settled rollover closes the old epoch and activates a fresh linked epoch", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-rollover-test-"));
  const config = defaultAgentConfig();
  const now = "2026-08-01T12:00:00.000Z";

  const first = await runMinimalSlice({ dataRoot, config, input: sampleAgentInput(), now });
  assert.equal(first.epochId, "iris-runtime-2026-08-01-1");

  const rolled = await rolloverActiveSession({
    dataRoot,
    config,
    now,
    settledEpochId: first.epochId,
  });
  assert.notEqual(rolled.newEpochId, rolled.previousEpochId);
  assert.notEqual(rolled.newSessionId, rolled.previousSessionId);
  // previousStatus reflects the state at rollover time (active, before the
  // two-phase switch closed it); "closed" is asserted on the store row.
  assert.equal(rolled.previousStatus, "active");

  // The new session is a fresh empty Pi Session (no copied history), and it
  // is a REAL session row — not a missing one that masquerades as empty.
  assert.equal(rolled.entries.length, 0);
  const paths = resolveDataRootPaths(dataRoot, config);
  const repo = new SqliteSessionRepository({
    env: nodeSqliteRepoEnv(dataRoot),
    sqlite: createNodeSqliteFactory(),
    databasePath: paths.sessionDb,
  });
  const list = await repo.list({ cwd: dataRoot });
  assert.ok(
    list.some((candidate) => candidate.id === rolled.newSessionId),
    "rollover must actually create the new Pi Session row",
  );

  // The new epoch links back through previous_epoch_id.
  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const active = store.getActive();
  assert.equal(active?.epochId, rolled.newEpochId);
  assert.equal(active?.previousEpochId, rolled.previousEpochId);
  const previous = store.getByEpochId(rolled.previousEpochId);
  assert.equal(previous.status, "closed");
  store.close();
});

test("rollover requires an explicit request first", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-rollover-guard-"));
  const config = defaultAgentConfig();
  const now = "2026-08-01T12:00:00.000Z";
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);

  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  store.ensureActive(now);
  assert.throws(() => store.rolloverAfterSettled(now), /without requestRollover/);
  store.close();
});

test("rollover keeps a single active epoch invariant", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-rollover-invariant-"));
  const config = defaultAgentConfig();
  const now = "2026-08-01T12:00:00.000Z";
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);

  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  store.ensureActive(now);
  store.requestRollover("invariant-check");
  store.rolloverAfterSettled(now);

  const all = store.getActive();
  assert.ok(all !== null);
  store.close();

  // After rollover the old session is closed and a fresh session exists.
  const reopened = await reopenActiveSession({ dataRoot, config, input: sampleAgentInput(), now });
  assert.equal(reopened.runtimeSessionId, all.runtimeSessionId);
  assert.equal(reopened.entries.length, 0);
});

test("rollover does not create synthetic repair artifacts", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-rollover-artifacts-"));
  const config = defaultAgentConfig();
  const now = "2026-08-01T12:00:00.000Z";

  const first = await runMinimalSlice({ dataRoot, config, input: sampleAgentInput(), now });
  await rolloverActiveSession({ dataRoot, config, now, settledEpochId: first.epochId });

  assert.ok(!existsSync(join(dataRoot, "invocation.db")));
  assert.ok(!existsSync(join(dataRoot, "result.db")));
});

test("rollover refuses without settled authorization", async () => {
  // Review blocker #3: an arbitrary caller cannot roll over — the settled
  // epoch must match the currently active one.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-rollover-refuse-"));
  const config = defaultAgentConfig();
  const now = "2026-08-01T12:00:00.000Z";

  const first = await runMinimalSlice({ dataRoot, config, input: sampleAgentInput(), now });
  await assert.rejects(
    rolloverActiveSession({ dataRoot, config, now, settledEpochId: "some-other-epoch" }),
    /not the settled epoch/,
  );
  void first;
});

test("startup recovers a stale creating epoch after a mid-rollover crash", async () => {
  // Crash window between beginRollover and activateRollover: the new epoch is
  // 'creating' and the old epoch is still 'active'. Startup recovery discards
  // the stale 'creating' row so the single-active invariant holds again.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-rollover-recover-"));
  const config = defaultAgentConfig();
  const now = "2026-08-01T12:00:00.000Z";
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);

  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  store.ensureActive(now);
  const pending = store.beginRollover(now);
  assert.equal(pending.status, "creating");
  assert.equal(store.getActive()?.epochId, "iris-runtime-2026-08-01-1");
  store.close();

  // A fresh store (restart) runs recovery: read stale creating rows, mark
  // their orphan Pi Sessions as cleaned, then remove the Epoch rows — the
  // original epoch remains active.
  const restarted = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const stale = restarted.listCreating();
  assert.deepEqual(
    stale.map((row) => row.runtimeSessionId),
    [pending.runtimeSessionId],
  );
  const recovered = restarted.recoverCreating(stale.map((row) => row.runtimeSessionId));
  assert.equal(recovered, 1);
  assert.equal(restarted.countAll(), 1);
  assert.equal(restarted.getActive()?.epochId, "iris-runtime-2026-08-01-1");
  restarted.close();
});

test("beginRollover rejects a second pending creating epoch", async () => {
  // Review blocker #3: only one pending rollover at a time — a second
  // beginRollover while one is outstanding must be rejected, not orphaned.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-rollover-double-"));
  const config = defaultAgentConfig();
  const now = "2026-08-01T12:00:00.000Z";
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);

  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  store.ensureActive(now);
  store.beginRollover(now);
  assert.throws(() => store.beginRollover(now), /already in progress/);
  store.close();
});

test("two-phase rollover never exposes a zero-active window", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-rollover-nogap-"));
  const config = defaultAgentConfig();
  const now = "2026-08-01T12:00:00.000Z";
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);

  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  store.ensureActive(now);
  store.beginRollover(now);
  // Between phases the old epoch is still active — never zero active.
  assert.ok(store.getActive() !== null);
  store.activateRollover(now);
  assert.ok(store.getActive() !== null);
  assert.equal(store.countAll(), 2);
  store.close();
});
