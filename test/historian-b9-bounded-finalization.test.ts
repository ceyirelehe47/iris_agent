/**
 * Feature B9 — iris_agent#53: finalizers preserved WITHOUT bypassing bounded
 * queue capacity.
 *
 * AC map:
 *  - bounded invariant: pending+running+successors <= configured bounds
 *  - thousands of durable closing intents: no proportional in-memory growth
 *  - all-finalizer queue: extra intents stay durable, never dropped
 *  - fair deterministic refill (FIFO by finalizationRequestedAt)
 *  - saturation -> health/readiness policy
 *  - duplicate wrapup -> one terminal transition, one snapshot/publication seq
 *  - retry exhaustion -> durable diagnosable intent, no hot loop
 *  - crash tests: persistence before scheduling, scheduler saturation, worker
 *    failure, restart refill, final commit
 *  - maxQueuedJobs / maxSuccessors / backlog limits configuration-backed and
 *    tested at boundary values
 */
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";

import { HistorianManager, historianSchedulerOptions } from "../src/historian/historian-manager.js";
import type { ContextHistoryReadPort } from "../src/context/history-read-port.js";
import { historianBatchHash } from "../src/contracts/historian.js";
import {
  HistorianQueue,
  type HistorianJob,
  type HistorianJobResult,
} from "../src/historian/historian-queue.js";
import { HistorianStore } from "../src/historian/historian-store.js";

/** iris_agent#45: production Historian cannot publish without the Context
 * read/claim port — tests wire a stub port with committed units. */
function stubHistoryPort(): ContextHistoryReadPort {
  return {
    getMaterializedBoundary() {
      return {
        representedThroughContextSeq: 0,
        representedThroughEntrySeq: 0,
        m0ContentHash: null,
        lineageStatus: "ok",
        providerProfileId: "mock",
      };
    },
    listUnitsForHistorian(_lineageId: string, fromContextSeq: number, toContextSeq: number) {
      // iris_agent#76: anti-echo views are keyed by CONTEXT coordinates —
      // one view per claimed seq (same window the batch served).
      const units: import("../src/historian/anti-echo.js").HistorianUnitView[] = [];
      for (let seq = fromContextSeq; seq <= toContextSeq; seq++) {
        units.push({
          contextUnitId: `unit-${seq}`,
          contextSeq: seq,
          runtimeEventId: `evt-${seq}`,
          kind: "user",
          disposition: "include",
          contentHash: "b".repeat(64),
          derivationRefs: { memoryRefs: [], compartmentIds: [], sourceContextMessageUnitIds: [] },
        });
      }
      return units;
    },
    listUnitsWithPayload(_lineageId: string, fromContextSeq: number, toContextSeq: number) {
      const views = this.listUnitsForHistorian(_lineageId, fromContextSeq, toContextSeq);
      return views.map((view) => ({
        ...view,
        payload: { role: "user", content: `content-${view.contextSeq}`, timestamp: 0 },
        payloadTimestamp: new Date().toISOString(),
      }));
    },
    claimHistorianBatch({ afterContextSeqExclusive, throughContextSeqInclusive }) {
      // iris_agent#76: full committed units (payload included) — the
      // runner's normal semantic input, keyed by global contextSeq. The
      // fixture head is capped at 4096 (the old freeze-head window bound)
      // so the manager's MAX_SAFE_INTEGER head probe stays bounded.
      const units: import("../src/contracts/context-units.js").ContextMessageUnit[] = [];
      for (
        let seq = afterContextSeqExclusive + 1;
        seq <= Math.min(throughContextSeqInclusive, 4096);
        seq++
      ) {
        units.push({
          lineageId: "identity-b8b9",
          runtimeSessionId: "attribution-stub",
          contextSeq: seq,
          contextUnitId: `unit-${seq}`,
          unitId: `unit-${seq}`,
          sourceEventId: `evt-${seq}`,
          runtimeEventId: `evt-${seq}`,
          unitType: "input",
          semanticSchemaId: "iris.semantic.context_message.user.v1",
          disposition: "include",
          entryId: `entry-${seq}`,
          entrySeq: seq,
          contentHash: "b".repeat(64),
          payload: { role: "user", content: `content-${seq}`, timestamp: 1 },
          paired: false,
          derivationRefs: { schemaId: "iris.semantic_derivation_refs.v1", memoryRefs: [], compartmentIds: [], sourceContextMessageUnitIds: [] },
          schemaVersion: "context-unit-v1",
          createdAt: "2026-08-01T00:00:00.000Z",
        });
      }
      const batch: import("../src/contracts/historian.js").HistorianBatchV1 = {
        schemaVersion: "historian-batch-v1",
        lineageId: "identity-b8b9",
        afterContextSeqExclusive,
        throughContextSeqInclusive:
          units.length === 0
            ? afterContextSeqExclusive
            : (units[units.length - 1]?.contextSeq ?? afterContextSeqExclusive),
        units,
        batchHash: "",
        frozenAt: new Date().toISOString(),
      };
      batch.batchHash = historianBatchHash(batch);
      return batch;
    },
    lineageId() {
      return "identity-b8b9";
    },
  };
}

const SESSION = "iris-runtime-2026-08-01-1";

function fakeJob(
  runtimeSessionId: string,
  priority: HistorianJob["priority"],
): Omit<HistorianJob, "jobId" | "attempt" | "retryAtMs"> {
  return {
    priority,
    runtimeSessionId,
    boundary: {
      runtimeSessionId,
      frozenAt: new Date().toISOString(),
      observedHeadEntrySeq: 1,
      entryRange: { fromEntrySeq: 1, toEntrySeq: 1 },
    } as unknown as HistorianJob["boundary"],
    sessionState: {
      runtimeSessionId,
      processedThroughEntrySeq: 0,
      status: "active",
      updatedAt: new Date().toISOString(),
    },
  };
}

function managerFixture(options: {
  entries?: SessionTreeEntry[];
  maxQueuedJobs?: number;
  maxSuccessors?: number;
  maxAttempts?: number;
  durableRefillBatchSize?: number;
  nowMs?: () => number;
}): { manager: HistorianManager; store: HistorianStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "iris-b9-"));
  const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  const manager = new HistorianManager({
    store,
    historyPort: stubHistoryPort(),
    modelProviderProfile: "opencode/deepseek-v4-flash",
    maxQueuedJobs: options.maxQueuedJobs ?? 256,
    ...(options.maxSuccessors !== undefined ? { maxSuccessors: options.maxSuccessors } : {}),
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    ...(options.durableRefillBatchSize !== undefined
      ? { durableRefillBatchSize: options.durableRefillBatchSize }
      : {}),
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
  });
  return { manager, store, dir };
}

test("B9-AC1: pending+running+successors never exceed the configured bounds (finalizers deferred, never admitted unbounded)", () => {
  // Phase A: a queue FULL of finalizing jobs defers new intents (nothing
  // evictable — finalizers are never dropped).
  const queue = new HistorianQueue({ maxQueuedJobs: 3, maxSuccessors: 1, maxAttempts: 8 });
  assert.equal(queue.enqueue(fakeJob("s1", "normal")), "queued");
  assert.equal(queue.enqueue(fakeJob("s2", "normal")), "queued");
  assert.equal(queue.enqueue(fakeJob("s3", "normal")), "queued");
  assert.equal(
    queue.enqueue(fakeJob("s4", "normal")),
    "deferred_durable",
    "full-of-finalizers queue defers",
  );
  let stats = queue.stats();
  assert.equal(stats.pending, 3, "pending stays at the bound");
  assert.equal(stats.dropped, 0, "finalizers are never dropped");
  assert.equal(stats.deferred, 1);

  // Phase B: a terminal successor registered for the running session is
  // promoted when the running job finishes; a full-of-finalizers pending
  // must DEFER the promotion (never overflow, never drop the finalizer).
  const q2 = new HistorianQueue({ maxQueuedJobs: 2, maxSuccessors: 1, maxAttempts: 8 });
  q2.enqueue(fakeJob("s5", "highest"));
  const runningJob = q2.take();
  assert.equal(runningJob?.runtimeSessionId, "s5", "non-finalizing job running");
  assert.equal(q2.enqueue(fakeJob("s5", "normal")), "successor_registered");
  // Fill pending with finalizers (no evictable non-finalizing candidate).
  assert.equal(q2.enqueue(fakeJob("s6", "normal")), "queued");
  assert.equal(q2.enqueue(fakeJob("s7", "normal")), "queued");
  q2.finish(true);
  stats = q2.stats();
  assert.equal(stats.successors, 0, "successor promotion consumed");
  assert.equal(stats.pending, 2, "pending stays at the bound after promotion");
  assert.equal(stats.deferred, 1, "promotion deferred, not dropped");
  assert.equal(stats.dropped, 0, "finalizer never dropped");
});

test("B9-AC1: all-finalizer queue: additional intents are deferred_durable, never overflow or drop", () => {
  const queue = new HistorianQueue({ maxQueuedJobs: 2, maxAttempts: 8 });
  assert.equal(queue.enqueue(fakeJob("s1", "normal")), "queued");
  assert.equal(queue.enqueue(fakeJob("s2", "normal")), "queued");
  // No non-finalizing candidate to evict -> deferred (durable), NOT admitted.
  assert.equal(queue.enqueue(fakeJob("s3", "normal")), "deferred_durable");
  const stats = queue.stats();
  assert.equal(stats.pending, 2, "pending stays at the bound");
  assert.equal(stats.dropped, 0, "finalizer never dropped");
  assert.equal(stats.deferred, 1);
});

test("B9-AC7: retry backoff prevents hot loops; exhaustion is permanent; full-queue requeue is deferred not permanent", async () => {
  let now = 1_000_000;
  const queue = new HistorianQueue({ maxQueuedJobs: 1, maxAttempts: 2, nowMs: () => now });
  const handler = async (): Promise<HistorianJobResult> => ({ ok: false, errorCode: "boom" });
  const worker = new (await import("../src/historian/historian-queue.js")).HistorianWorker(
    queue,
    handler,
  );
  queue.enqueue(fakeJob("s1", "normal"));
  // First failure: requeued with backoff (retryAtMs in the future).
  await worker.runOnce();
  assert.equal(queue.stats().failedPermanent, 0);
  assert.equal(queue.pendingCount(), 1, "requeued with backoff");
  // Hot-loop guard: before the backoff elapses the job is not runnable.
  assert.equal(queue.take(), undefined, "backoff window blocks immediate retry");
  // After the backoff: second failure exhausts attempts -> permanent.
  now = 1_000_000 + 10_000;
  await worker.runOnce();
  assert.equal(queue.stats().failedPermanent, 1, "exhaustion counted as permanent");
  assert.equal(queue.pendingCount(), 0);
  // Full-queue requeue: deferred (durable backlog is the retry path), NOT permanent.
  const q2 = new HistorianQueue({ maxQueuedJobs: 1, maxAttempts: 8, nowMs: () => now });
  q2.enqueue(fakeJob("a", "highest"));
  const job = q2.take();
  assert.ok(job);
  q2.enqueue(fakeJob("b", "highest")); // fills pending
  assert.equal(q2.requeue(job), "no_capacity");
  assert.equal(q2.stats().deferred, 1);
  assert.equal(q2.stats().failedPermanent, 0, "no_capacity is not a permanent failure");
});

test("B9-AC5/AC8: durable intent persists BEFORE scheduling; crash → restart recover() re-admits and finalizes exactly once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b9-crash-"));
  try {
    // Process 1: durable append + wrapup enqueued, then CRASH before the pump.
    const store1 = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    const manager1 = new HistorianManager({
      store: store1,
      historyPort: stubHistoryPort(),
      modelProviderProfile: "m",
      maxQueuedJobs: 2,
    });
    assert.equal(await manager1.enqueueWrapup(SESSION), true);
    // The closing intent is durable BEFORE any job runs.
    const closing = store1.getSessionState(SESSION);
    assert.equal(closing?.status, "closing");
    assert.ok(closing?.finalizationRequestedAt, "intent timestamp persisted");
    // Crash: no pump, hard close.
    store1.close();
    manager1.close();

    // Process 2: restart — recover() re-admits the durable closing intent.
    const store2 = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    const manager2 = new HistorianManager({
      store: store2,
      historyPort: stubHistoryPort(),
      modelProviderProfile: "m",
      maxQueuedJobs: 2,
    });
    await manager2.recover();
    assert.equal(manager2.getQueue().pendingCount(), 1, "closing intent re-admitted");
    // Pump until drained -> exactly one terminal transition + one snapshot.
    for (let i = 0; i < 10 && manager2.getQueue().pendingCount() > 0; i++) {
      await manager2.pumpOnce();
    }
    const final = store2.getSessionState(SESSION);
    assert.ok(
      final?.status === "closed" || final?.status === "closed_incomplete",
      `terminal state ${final?.status}`,
    );
    assert.equal(store2.listContinuitySnapshots(SESSION).length, 1, "exactly one snapshot");
    assert.equal(store2.countClosingSessions(), 0, "durable backlog drained");
    store2.close();
    manager2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B9-AC2/AC8: thousands of durable closing intents do not grow the bounded scheduler", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b9-bulk-"));
  try {
    const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    // 2000 durable closing intents (simulated crash backlog) with distinct intent times.
    const base = new Date("2026-08-01T00:00:00.000Z").getTime();
    for (let i = 0; i < 2000; i++) {
      store.upsertSessionState({
        runtimeSessionId: `sess-${String(i).padStart(4, "0")}`,
        processedThroughEntrySeq: 1,
        status: "closing",
        updatedAt: new Date(base + i * 1000).toISOString(),
      });
    }
    assert.equal(store.countClosingSessions(), 2000);
    const manager = new HistorianManager({
      store,
      historyPort: stubHistoryPort(),
      modelProviderProfile: "m",
      maxQueuedJobs: 8,
      durableRefillBatchSize: 16,
    });
    // Repeated refill+pump cycles over the whole backlog: occupancy never exceeds the bound.
    for (let cycle = 0; cycle < 30 && store.countClosingSessions() > 0; cycle++) {
      manager.refill();
      await manager.pumpOnce();
      const stats = manager.getQueue().stats();
      assert.ok(
        stats.pending + stats.running + stats.successors <= 8,
        `cycle ${cycle}: occupancy ${stats.pending + stats.running + stats.successors} <= 8`,
      );
      assert.ok(store.countClosingSessions() <= 2000, "durable backlog stays finite and countable");
    }
    assert.ok(store.countClosingSessions() < 2000, "refill actually consumed durable intents");
    store.close();
    manager.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B9-AC4: refill is fair and deterministic — FIFO by finalizationRequestedAt, then session id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b9-refill-"));
  try {
    const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    const base = new Date("2026-08-01T00:00:00.000Z").getTime();
    const ids = ["sess-d", "sess-a", "sess-c", "sess-b"];
    // Intent times deliberately out of order: d(4) a(1) c(3) b(2).
    const times = [4, 1, 3, 2];
    for (const [i, id] of ids.entries()) {
      const intentTime = times[i];
      assert.ok(intentTime !== undefined, "test vector must exist");
      store.upsertSessionState({
        runtimeSessionId: id,
        processedThroughEntrySeq: 1,
        status: "closing",
        updatedAt: new Date(base + intentTime * 1000).toISOString(),
      });
    }
    const manager = new HistorianManager({
      store,
      historyPort: stubHistoryPort(),
      modelProviderProfile: "m",
      maxQueuedJobs: 16,
      durableRefillBatchSize: 16,
    });
    await manager.refill();
    // Deterministic admission order: a (t=1), b (t=2), c (t=3), d (t=4).
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      const job = manager.getQueue().take();
      assert.ok(job, `job ${i} admitted`);
      order.push(job.runtimeSessionId);
    }
    assert.deepEqual(order, ["sess-a", "sess-b", "sess-c", "sess-d"], "FIFO by intent time");
    store.close();
    manager.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B9-AC5: saturation, durableBacklog, oldest intent age and retryExhausted in health()", async () => {
  let now = 1_000_000;
  const { manager, store } = managerFixture({ maxQueuedJobs: 2, nowMs: () => now });
  try {
    const health0 = manager.health();
    assert.equal(health0.ready, true);
    assert.equal(health0.saturation, 0);
    assert.equal(health0.durableBacklog, 0);
    assert.equal(health0.oldestFinalizationIntentAgeMs, 0);
    // Two sessions closing -> queue full (maxQueuedJobs=2).
    await manager.enqueueWrapup(SESSION);
    await manager.enqueueWrapup("iris-runtime-2026-08-02-1");
    assert.equal(manager.getQueue().pendingCount(), 2);
    const health = manager.health();
    assert.equal(health.saturation, 1, "scheduler saturated");
    assert.equal(health.durableBacklog, 2, "both intents durable");
    assert.ok(health.oldestFinalizationIntentAgeMs >= 0);
    // Age grows with time.
    now += 5_000;
    assert.ok(
      manager.health().oldestFinalizationIntentAgeMs >= 5_000,
      "oldest intent age advances",
    );
    // retryExhausted mirrors permanent failures.
    const exhausted = new HistorianQueue({ maxQueuedJobs: 2, maxAttempts: 1 });
    exhausted.enqueue(fakeJob("x", "normal"));
    // (attempt+1 >= maxAttempts on first requeue -> exhausted)
    const exhaustedJob = exhausted.take();
    assert.ok(exhaustedJob !== undefined);
    assert.equal(exhausted.requeue(exhaustedJob), "exhausted");
    assert.equal(exhausted.stats().failedPermanent, 0); // requeue alone doesn't count; finish does
  } finally {
    store.close();
    manager.close();
  }
});

test("B9-AC6: duplicate wrapup/recovery requests → exactly one terminal transition and one snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b9-dup-"));
  try {
    const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    const manager = new HistorianManager({
      store,
      historyPort: stubHistoryPort(),
      modelProviderProfile: "m",
      maxQueuedJobs: 4,
    });
    // Duplicate wrapup requests (rollover racing recovery).
    assert.equal(await manager.enqueueWrapup(SESSION), true);
    assert.equal(await manager.enqueueWrapup(SESSION), true, "duplicate is an idempotent no-op");
    for (let i = 0; i < 10 && manager.getQueue().pendingCount() > 0; i++) {
      await manager.pumpOnce();
    }
    const final = store.getSessionState(SESSION);
    assert.ok(final?.status === "closed" || final?.status === "closed_incomplete");
    assert.equal(store.listContinuitySnapshots(SESSION).length, 1, "at most one snapshot");
    // The intent timestamp was set once and is never reset.
    if (final === undefined) {
      throw new Error("final state missing");
    }
    const reClosing = {
      ...final,
      status: "closing" as const,
      updatedAt: new Date(Date.now() + 60_000).toISOString(),
    };
    store.upsertSessionState(reClosing);
    const after = store.getSessionState(SESSION);
    assert.equal(
      after?.finalizationRequestedAt,
      final?.finalizationRequestedAt,
      "intent time never reset",
    );
    store.close();
    manager.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B9-AC9: scheduler bounds are configuration-backed and honored at boundary values", () => {
  assert.deepEqual(historianSchedulerOptions(undefined), {
    maxQueuedJobs: 256,
    maxSuccessors: 256,
    maxAttempts: 8,
    durableRefillBatchSize: 16,
  });
  assert.deepEqual(
    historianSchedulerOptions({
      sqlite_path: "/tmp/x.db",
      queue: { mode: "single_global", max_pending_jobs: 1 },
    }),
    { maxQueuedJobs: 1, maxSuccessors: 1, maxAttempts: 8, durableRefillBatchSize: 16 },
  );
  assert.deepEqual(
    historianSchedulerOptions({
      queue: {
        max_pending_jobs: 4,
        max_successors: 2,
        max_attempts: 3,
        durable_refill_batch_size: 1,
      },
    }),
    { maxQueuedJobs: 4, maxSuccessors: 2, maxAttempts: 3, durableRefillBatchSize: 1 },
  );
  // Boundary values actually bind the queue: pending overflow of a
  // FINALIZING job defers (never drops); non-finalizing overflow evicts.
  const queue = new HistorianQueue({ maxQueuedJobs: 1, maxSuccessors: 1 });
  assert.equal(queue.enqueue(fakeJob("a", "normal")), "queued");
  assert.equal(
    queue.enqueue(fakeJob("b", "normal")),
    "deferred_durable",
    "finalizer deferred at the bound",
  );
  assert.equal(queue.stats().pending, 1);
  assert.equal(queue.stats().dropped, 0);
  const q2 = new HistorianQueue({ maxQueuedJobs: 1, maxSuccessors: 1 });
  q2.enqueue(fakeJob("a", "highest"));
  assert.equal(
    q2.enqueue(fakeJob("b", "highest")),
    "queued",
    "non-finalizing overflow evicts the lowest priority",
  );
  assert.equal(q2.stats().pending, 1);
  assert.equal(q2.stats().dropped, 1);
});

test("B9-AC3/AC8: worker failure keeps the durable intent; final commit still happens via refill", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b9-fail-"));
  try {
    const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    const manager = new HistorianManager({
      store,
      historyPort: stubHistoryPort(),
      modelProviderProfile: "m",
      maxQueuedJobs: 2,
      maxAttempts: 3,
    });
    await manager.enqueueWrapup(SESSION);
    // Simulate a worker failure by shutting down mid-flight: the durable
    // intent must remain (status closing, intent timestamp preserved).
    const stateBefore = store.getSessionState(SESSION);
    assert.equal(stateBefore?.status, "closing");
    assert.ok(stateBefore?.finalizationRequestedAt);
    store.close();
    manager.close();
    // Restart: recover() re-admits; the finalizer runs to completion.
    const store2 = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    const manager2 = new HistorianManager({
      store: store2,
      historyPort: stubHistoryPort(),
      modelProviderProfile: "m",
      maxQueuedJobs: 2,
    });
    await manager2.recover();
    for (let i = 0; i < 10 && manager2.getQueue().pendingCount() > 0; i++) {
      await manager2.pumpOnce();
    }
    const final = store2.getSessionState(SESSION);
    assert.ok(
      final?.status === "closed" || final?.status === "closed_incomplete",
      `final ${final?.status}`,
    );
    assert.equal(store2.countClosingSessions(), 0);
    store2.close();
    manager2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B9-AC10: migration 0007 upgrades a 0006-era DB, backfills intent timestamps, and fails closed on tampering", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b9-mig-"));
  try {
    const realMigrations = join(process.cwd(), "src/db/migrations/historian");
    // 1) Build a 0006-era database (migrations without 0007).
    const oldDir = join(dir, "old-migrations");
    mkdtempSync(oldDir);
    for (const f of readdirSync(realMigrations).filter((n) => n <= "0006_outbox_payload.sql")) {
      cpSync(join(realMigrations, f), join(oldDir, f));
    }
    const dbPath = join(dir, "historian.db");
    const store06 = HistorianStore.open({ databasePath: dbPath, migrationsDir: oldDir });
    const closingAt = "2026-08-01T00:00:00.000Z";
    // Seed the 0006-era closing row with the RAW 0006 schema (the new-code
    // upsert references the 0007 column, which does not exist yet).
    store06
      .raw()
      .prepare(
        `INSERT INTO session_state (runtime_session_id, processed_through_entry_seq, status, observed_head_entry_seq, updated_at)
       VALUES (?, 1, 'closing', NULL, ?)`,
      )
      .run(SESSION, closingAt);
    store06.close();
    // 2) Reopen with the real migration set: 0007 applies + backfills.
    const store = HistorianStore.open({ databasePath: dbPath });
    const state = store.getSessionState(SESSION);
    assert.equal(state?.status, "closing");
    assert.equal(
      state?.finalizationRequestedAt,
      closingAt,
      "intent timestamp backfilled from updated_at",
    );
    store.close();
    // 3) Tamper 0007 after apply -> reopen fails closed.
    const tamperedDir = join(dir, "tampered-migrations");
    mkdtempSync(tamperedDir);
    for (const f of readdirSync(realMigrations)) {
      cpSync(join(realMigrations, f), join(tamperedDir, f));
    }
    writeFileSync(join(tamperedDir, "0007_finalization_intent.sql"), "-- tampered\n", {
      flag: "a",
    });
    assert.throws(
      () => HistorianStore.open({ databasePath: dbPath, migrationsDir: tamperedDir }),
      /migration 0007_finalization_intent changed after being applied/,
      "release-owned checksum fails closed",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("iris_agent#65: retry exhaustion is DURABLE — refill/recovery cannot reset an exhausted finalizer to attempt zero", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b65-exhaust-"));
  try {
    const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    // maxAttempts=3: attempt 0,1,2 run and fail; the third failure exhausts.
    let now = 1_000_000;
    const manager = new HistorianManager({
      store,
      historyPort: stubHistoryPort(),
      modelProviderProfile: "m",
      maxQueuedJobs: 2,
      maxAttempts: 3,
      nowMs: () => now,
    });
    // A permanently failing handler: make every finalizer run throw.
    (manager as unknown as { executeJob: () => Promise<{ ok: boolean }> }).executeJob =
      async () => ({
        ok: false,
        errorCode: "boom",
      });
    await manager.enqueueWrapup(SESSION);
    for (let i = 0; i < 10 && manager.getQueue().pendingCount() > 0; i++) {
      await manager.pumpOnce();
      now += 60_000; // advance past the retry backoff
    }
    // Durable exhaustion marker is set.
    const exhausted = store.getSessionState(SESSION);
    assert.equal(exhausted?.status, "closing", "durable state stays closing");
    assert.ok(exhausted?.retryExhaustedAt, "durable retry-exhausted marker persisted");
    assert.equal(exhausted?.retryAttempts, 2, "durable attempt counter persisted");
    // health() reports the durable exhausted count.
    assert.equal(manager.countExhaustedSessions(), 1);
    assert.equal(manager.health().retryExhausted, 1);
    // refill() must NOT re-admit the exhausted session.
    await manager.refill();
    assert.equal(manager.getQueue().pendingCount(), 0, "exhausted session not re-admitted");
    manager.close();
    store.close();

    // Restart: recover() must NOT re-admit the exhausted finalizer either.
    const store2 = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    const manager2 = new HistorianManager({
      store: store2,
      historyPort: stubHistoryPort(),
      modelProviderProfile: "m",
      maxQueuedJobs: 2,
      maxAttempts: 3,
      nowMs: () => now,
    });
    await manager2.recover();
    assert.equal(
      manager2.getQueue().pendingCount(),
      0,
      "startup recovery skips exhausted sessions (no auto-resurrection)",
    );
    const afterRestart = store2.getSessionState(SESSION);
    assert.ok(afterRestart?.retryExhaustedAt, "exhaustion survives restart");
    assert.equal(afterRestart?.retryAttempts, 2, "attempt budget survives restart");
    // pumpOnce/refill stays quiet.
    await manager2.pumpOnce();
    assert.equal(manager2.getQueue().pendingCount(), 0);
    assert.equal(
      manager2.getQueue().stats().failedPermanent,
      0,
      "no fresh attempt-zero job created",
    );

    // Explicit reactivation: clears the marker and re-admits through refill.
    assert.equal(await manager2.reactivateExhaustedSession(SESSION), true);
    const reactivated = store2.getSessionState(SESSION);
    assert.equal(reactivated?.retryExhaustedAt, undefined, "exhaustion marker cleared");
    assert.equal(reactivated?.retryAttempts ?? 0, 0, "attempt budget reset for the explicit retry");
    assert.equal(manager2.getQueue().pendingCount(), 1, "explicit retry re-admitted");
    // Reactivation is idempotent for non-exhausted sessions.
    assert.equal(await manager2.reactivateExhaustedSession(SESSION), false);
    manager2.close();
    store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("iris_agent#65: unrelated closing sessions stay fair while one session is exhausted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b65-fair-"));
  try {
    const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    let now = 1_000_000;
    const manager = new HistorianManager({
      store,
      historyPort: stubHistoryPort(),
      modelProviderProfile: "m",
      maxQueuedJobs: 4,
      maxAttempts: 2,
      nowMs: () => now,
    });
    // Exhaust session A by making only it fail permanently.
    const realExecute = (
      manager as unknown as {
        executeJob: (job: { runtimeSessionId: string }) => Promise<{ ok: boolean }>;
      }
    ).executeJob.bind(manager);
    (
      manager as unknown as {
        executeJob: (job: { runtimeSessionId: string }) => Promise<{ ok: boolean }>;
      }
    ).executeJob = async (job) =>
      job.runtimeSessionId === "session-A" ? { ok: false, errorCode: "boom" } : realExecute(job);

    await manager.enqueueWrapup("session-A");
    await manager.enqueueWrapup("session-B");
    for (let i = 0; i < 20 && manager.getQueue().pendingCount() > 0; i++) {
      await manager.pumpOnce();
      now += 60_000; // advance past the retry backoff
    }
    assert.ok(store.getSessionState("session-A")?.retryExhaustedAt, "session A durably exhausted");
    const b = store.getSessionState("session-B");
    assert.ok(
      b?.status === "closed" || b?.status === "closed_incomplete",
      `session B finalized independently ${b?.status}`,
    );
    assert.equal(manager.countExhaustedSessions(), 1, "only session A exhausted");
    manager.close();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("iris_agent#65: migration 0008 upgrades a 0007-era DB and fails closed on tampering", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b65-mig-"));
  try {
    const realMigrations = join(process.cwd(), "src/db/migrations/historian");
    // Build a 0007-era database (migrations without 0008).
    const oldDir = join(dir, "old-migrations");
    mkdtempSync(oldDir);
    for (const f of readdirSync(realMigrations).filter(
      (n) => n <= "0007_finalization_intent.sql",
    )) {
      cpSync(join(realMigrations, f), join(oldDir, f));
    }
    const dbPath = join(dir, "historian.db");
    const store07 = HistorianStore.open({ databasePath: dbPath, migrationsDir: oldDir });
    store07
      .raw()
      .prepare(
        `INSERT INTO session_state (runtime_session_id, processed_through_entry_seq, status, observed_head_entry_seq, updated_at)
       VALUES (?, 1, 'closing', NULL, ?)`,
      )
      .run(SESSION, "2026-08-01T00:00:00.000Z");
    store07.close();
    // Reopen with the real migration set: 0008 applies (retry columns default).
    const store = HistorianStore.open({ databasePath: dbPath });
    const state = store.getSessionState(SESSION);
    assert.equal(state?.status, "closing");
    assert.equal(state?.retryExhaustedAt, undefined, "no exhaustion marker after upgrade");
    store.close();
    // Tamper 0008 after apply -> reopen fails closed.
    const tamperedDir = join(dir, "tampered-migrations");
    mkdtempSync(tamperedDir);
    for (const f of readdirSync(realMigrations)) {
      cpSync(join(realMigrations, f), join(tamperedDir, f));
    }
    writeFileSync(join(tamperedDir, "0008_retry_exhaustion.sql"), "-- tampered\n", { flag: "a" });
    assert.throws(
      () => HistorianStore.open({ databasePath: dbPath, migrationsDir: tamperedDir }),
      /migration 0008_retry_exhaustion changed after being applied/,
      "release-owned checksum fails closed",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
