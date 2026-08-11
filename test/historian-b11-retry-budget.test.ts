/**
 * Feature B11 — iris_agent#75: the durable retry budget counts EVERY failed
 * execution, including failures that found no in-memory retry slot.
 *
 * Core invariant: a real handler execution failure must consume one durable
 * attempt BEFORE the decision to enqueue / defer to the durable backlog /
 * mark exhausted. `no_capacity` and crashes between accounting and requeue
 * must never let the same durable attempt number execute repeatedly.
 *
 * AC map (issue iris_agent#75):
 *  - failed attempt advances durable accounting even under scheduler
 *    capacity pressure (no_capacity);
 *  - no_capacity cannot cause the same durable attempt to execute repeatedly;
 *  - typed {ok:false} failures and thrown handler errors share the invariant;
 *  - crash after durable accounting but before in-memory requeue cannot
 *    reset the budget;
 *  - crash before/after exhaustion persistence;
 *  - refill respects durable next-attempt/exhaustion state and stays fair;
 *  - backoff stays deterministic; capacity pressure does not hot-loop;
 *  - explicit operator reactivation is the only reset path and cannot
 *    duplicate Publication/snapshot/outbox/cursor commits.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import type { ContextHistoryReadPort } from "../src/context/history-read-port.js";
import { historianBatchHash } from "../src/contracts/historian.js";
import {
  HistorianQueue,
  HistorianWorker,
  type HistorianJob,
  type HistorianJobResult,
} from "../src/historian/historian-queue.js";
import { HistorianManager } from "../src/historian/historian-manager.js";
import { HistorianStore } from "../src/historian/historian-store.js";

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

/** Refill-style re-admission: the durable backlog hands the session back
 * with the PERSISTED retryAttempts value (never a fresh zero budget). */
function jobAtAttempt(
  runtimeSessionId: string,
  attempts: number,
): Parameters<HistorianQueue["enqueue"]>[0] {
  const base = fakeJob(runtimeSessionId, "highest");
  return {
    ...base,
    sessionState: {
      ...base.sessionState,
      status: "closing",
      retryAttempts: attempts,
    },
  };
}

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
          historianDisposition: "include",
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
      // Real committed units in the claimed window — the freeze and the
      // runner need a non-empty claim to make progress. The fixture head is
      // capped at 4096 (the old freeze-head window bound) so the manager's
      // MAX_SAFE_INTEGER head probe stays bounded.
      const units: import("../src/contracts/context-units.js").ContextMessageUnit[] = [];
      for (
        let seq = afterContextSeqExclusive + 1;
        seq <= Math.min(throughContextSeqInclusive, 4096);
        seq++
      ) {
        units.push({
          contextLineageId: "identity-b11",
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
        lineageId: "identity-b11",
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
      return "identity-b11";
    },
  };
}

/** A history port whose RUNNER claim path fails the first `failures`
 * executions, then behaves like the stub. The freeze path (first claim of
 * each admission) must keep working — the failure is injected into the
 * handler execution, not into scheduling. */
function flakyHistoryPort(
  failures: number,
): ContextHistoryReadPort & { remainingFailures: number } {
  const port = stubHistoryPort() as ContextHistoryReadPort & { remainingFailures: number };
  port.remainingFailures = failures;
  let claimCalls = 0;
  const original = port.claimHistorianBatch.bind(port);
  port.claimHistorianBatch = (input: {
    afterContextSeqExclusive: number;
    throughContextSeqInclusive: number;
  }) => {
    claimCalls += 1;
    // The freeze path is the first claim of each admission; the runner's
    // execution claim is every later one.
    if (claimCalls > 1 && port.remainingFailures > 0) {
      port.remainingFailures -= 1;
      throw new Error("claim unavailable (injected failure)");
    }
    return original(input);
  };
  return port;
}

test("B11-AC1: a failed attempt advances the durable counter even when requeue() cannot admit a pending retry (no_capacity)", async () => {
  const persisted: Array<[string, number]> = [];
  const queue = new HistorianQueue({
    maxQueuedJobs: 1,
    maxAttempts: 8,
    onAttemptPersist: (id, attempts) => persisted.push([id, attempts]),
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => (started = resolve));
  const handler = async (): Promise<HistorianJobResult> => {
    started();
    await gate;
    return { ok: false, errorCode: "typed_boom" };
  };
  const worker = new HistorianWorker(queue, handler);

  queue.enqueue(fakeJob("s1", "highest"));
  const runPromise = worker.runOnce();
  await startedPromise;
  // While the job executes, the scheduler reaches capacity.
  queue.enqueue(fakeJob("s2", "highest"));
  release();
  await runPromise;

  assert.deepEqual(
    persisted,
    [["s1", 1]],
    "the durable attempt must advance BEFORE the no_capacity decision",
  );
  assert.equal(queue.stats().deferred, 1, "no_capacity defers");
  assert.equal(queue.stats().failedPermanent, 0, "no_capacity is not a permanent failure");
  assert.equal(queue.stats().pending, 1, "the filler job remains pending");
});

test("B11-AC2: repeated no_capacity never re-executes the same durable attempt; exhaustion wins over a full queue", () => {
  const persisted: string[] = [];
  const exhausted: string[] = [];
  const queue = new HistorianQueue({
    maxQueuedJobs: 1,
    maxAttempts: 3,
    onAttemptPersist: (id, attempts) => persisted.push(`${id}:${attempts}`),
    onExhausted: (job) => exhausted.push(job.runtimeSessionId),
  });

  // Initial admission (fresh durable state: attempt 0).
  queue.enqueue(jobAtAttempt("s1", 0));
  for (let cycle = 1; cycle <= 3; cycle++) {
    const job = queue.take();
    assert.ok(job, `cycle ${cycle} must have a runnable job`);
    assert.equal(
      job.attempt,
      cycle - 1,
      `cycle ${cycle} executes attempt ${cycle - 1} exactly once`,
    );
    // Fill the scheduler to capacity while the job is "running".
    queue.enqueue(fakeJob(`filler-${cycle}`, "highest"));
    const outcome = queue.requeue(job);
    // The worker clears the running slot after every requeue outcome.
    queue.finish(undefined);
    if (cycle < 3) {
      assert.equal(outcome, "no_capacity", `cycle ${cycle}: full queue defers`);
      // Refill re-admission: the durable backlog hands the session back
      // with the PERSISTED attempt — the next cycle can only run N+1.
      queue.enqueue(jobAtAttempt("s1", cycle));
    } else {
      assert.equal(outcome, "exhausted", "exhaustion wins over a full queue");
    }
  }
  assert.deepEqual(persisted, ["s1:1", "s1:2"], "durable attempts 1..2 consumed exactly once each");
  assert.deepEqual(exhausted, ["s1"], "exhaustion persisted exactly once");
  assert.equal(queue.stats().deferred, 2, "both non-terminal failures were deferred");
  assert.equal(queue.stats().failedPermanent, 0, "exhaustion is counted at the manager level");
});

test("B11-AC3: thrown handler errors satisfy the same invariant (attempt consumed before no_capacity)", async () => {
  const persisted: Array<[string, number]> = [];
  const queue = new HistorianQueue({
    maxQueuedJobs: 1,
    maxAttempts: 8,
    onAttemptPersist: (id, attempts) => persisted.push([id, attempts]),
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => (started = resolve));
  const handler = async (): Promise<HistorianJobResult> => {
    started();
    await gate;
    throw new Error("handler crashed");
  };
  const worker = new HistorianWorker(queue, handler);

  queue.enqueue(fakeJob("s3", "highest"));
  const runPromise = worker.runOnce();
  await startedPromise;
  queue.enqueue(fakeJob("s4", "highest")); // saturate
  release();
  const result = await runPromise;
  assert.equal(result?.ok, false);
  assert.deepEqual(persisted, [["s3", 1]], "a thrown failure consumes the durable attempt too");
  assert.equal(queue.stats().deferred, 1);
  assert.equal(queue.stats().failedPermanent, 0);
});

test("B11-AC4: crash after durable attempt accounting but before in-memory requeue cannot reset the budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b11-crash-"));
  try {
    // Process 1: one failing execution, then a crash right after the durable
    // attempt accounting (no further pump — the in-memory requeue never ran).
    const store1 = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    const manager1 = new HistorianManager({
      store: store1,
      historyPort: flakyHistoryPort(99),
      modelProviderProfile: "m",
      maxQueuedJobs: 2,
      maxAttempts: 3,
    });
    assert.equal(await manager1.enqueueWrapup(SESSION), true);
    await manager1.pumpOnce(); // one real failed execution -> durable attempt 1
    const state1 = store1.getSessionState(SESSION);
    assert.equal(state1?.status, "closing");
    assert.equal(state1?.retryAttempts, 1, "durable attempt advanced before the crash");
    // Crash: hard close without draining.
    store1.close();
    manager1.close();

    // Process 2: restart. The refill must re-admit at attempt 1, never 0.
    const store2 = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    const manager2 = new HistorianManager({
      store: store2,
      historyPort: flakyHistoryPort(99),
      modelProviderProfile: "m",
      maxQueuedJobs: 2,
      maxAttempts: 3,
    });
    await manager2.recover();
    await manager2.refill();
    const job = manager2.getQueue().take();
    assert.ok(job, "recover() re-admits the closing intent");
    assert.equal(job.attempt, 1, "restart resumes the durable budget (never attempt 0)");
    assert.equal(job.runtimeSessionId, SESSION);
    store2.close();
    manager2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B11-AC5: crash before and after exhaustion persistence; exhausted sessions stay out of refill until reactivation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b11-exhaust-"));
  try {
    // Process 1: exhaust the budget (attempt 1 persisted, then attempt 2
    // fails -> exhaustion marker persisted), then crash before any pump.
    let now = 1_000_000;
    const store1 = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    const manager1 = new HistorianManager({
      store: store1,
      historyPort: flakyHistoryPort(99),
      modelProviderProfile: "m",
      maxQueuedJobs: 2,
      maxAttempts: 2,
      nowMs: () => now,
    });
    assert.equal(await manager1.enqueueWrapup(SESSION), true);
    await manager1.pumpOnce(); // fail 1 -> durable attempt 1 (requeued)
    now += 60_000; // elapse the retry backoff window
    await manager1.pumpOnce(); // fail 2 -> exhaustion persisted durably
    assert.equal(store1.countExhaustedSessions(), 1, "exhaustion marker persisted");
    store1.close();
    manager1.close();

    // Process 2: restart — exhausted sessions are NOT re-admitted by refill.
    const store2 = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    const manager2 = new HistorianManager({
      store: store2,
      historyPort: flakyHistoryPort(99),
      modelProviderProfile: "m",
      maxQueuedJobs: 2,
      maxAttempts: 2,
      nowMs: () => now,
    });
    await manager2.recover();
    await manager2.refill();
    assert.equal(
      manager2.getQueue().pendingCount(),
      0,
      "exhausted finalizer stays out of the scheduler",
    );
    assert.equal(store2.countExhaustedSessions(), 1);

    // Explicit operator reactivation is the ONLY reset path: it clears the
    // marker AND the attempt counter, then re-admits through the refill.
    assert.equal(await manager2.reactivateExhaustedSession(SESSION), true);
    assert.equal(manager2.getQueue().pendingCount(), 1, "reactivation re-admits the intent");
    const reactivatedJob = manager2.getQueue().take();
    assert.equal(reactivatedJob?.attempt, 0, "reactivation resets the retry budget to zero");
    store2.close();
    manager2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B11-AC6: reactivation cannot duplicate terminal commits — one terminal transition, one snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b11-react-"));
  try {
    const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    let now = 1_000_000;
    // Fails the first 3 executions, then succeeds: the wrapup commits.
    const manager = new HistorianManager({
      store,
      historyPort: flakyHistoryPort(3),
      modelProviderProfile: "m",
      maxQueuedJobs: 2,
      maxAttempts: 3,
      nowMs: () => now,
    });
    assert.equal(await manager.enqueueWrapup(SESSION), true);
    for (let i = 0; i < 3; i++) {
      await manager.pumpOnce();
      now += 60_000; // elapse the retry backoff window between attempts
    }
    assert.equal(store.countExhaustedSessions(), 1, "three failed executions exhaust the budget");
    assert.equal(
      store.listContinuitySnapshots(SESSION).length,
      0,
      "no terminal transition while failing",
    );

    // Reactivate: the wrapup runs once more and commits the terminal
    // transition — exactly one snapshot, no duplicate publication.
    assert.equal(await manager.reactivateExhaustedSession(SESSION), true);
    for (let i = 0; i < 5 && manager.getQueue().pendingCount() > 0; i++) {
      await manager.pumpOnce();
      now += 60_000; // elapse the retry backoff window
    }
    const final = store.getSessionState(SESSION);
    assert.ok(
      final?.status === "closed" || final?.status === "closed_incomplete",
      `terminal state ${final?.status}`,
    );
    assert.equal(
      store.listContinuitySnapshots(SESSION).length,
      1,
      "reactivation cannot duplicate the terminal transition",
    );
    assert.equal(store.countExhaustedSessions(), 0);
    assert.equal(store.countClosingSessions(), 0);
    store.close();
    manager.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B11-AC7: refill stays fair to unrelated closing sessions while a retrying session is deferred", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b11-fair-"));
  try {
    const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    const base = new Date("2026-08-01T00:00:00.000Z").getTime();
    // Two closing sessions: s1 (retrying, attempt 1 already consumed) and an
    // unrelated s2 with a later intent time.
    store.upsertSessionState({
      runtimeSessionId: "s1",
      processedThroughEntrySeq: 1,
      status: "closing",
      updatedAt: new Date(base + 1000).toISOString(),
      retryAttempts: 1,
    });
    store.upsertSessionState({
      runtimeSessionId: "s2",
      processedThroughEntrySeq: 1,
      status: "closing",
      updatedAt: new Date(base + 2000).toISOString(),
    });
    const manager = new HistorianManager({
      store,
      historyPort: stubHistoryPort(),
      modelProviderProfile: "m",
      maxQueuedJobs: 2,
      durableRefillBatchSize: 16,
    });
    await manager.refill();
    const jobs: HistorianJob[] = [];
    for (let i = 0; i < 2; i++) {
      const job = manager.getQueue().take();
      if (job === undefined) break;
      jobs.push(job);
    }
    assert.deepEqual(
      jobs.map((job) => job.runtimeSessionId),
      ["s1", "s2"],
      "FIFO by intent time, retry budget respected",
    );
    assert.equal(jobs[0]?.attempt, 1, "refill respects the durable next-attempt value");
    assert.equal(jobs[1]?.attempt, 0, "fresh sessions still start at attempt 0");
    store.close();
    manager.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
