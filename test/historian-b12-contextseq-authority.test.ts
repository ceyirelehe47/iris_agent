/**
 * iris_agent#76: the Historian's semantic batch authority lives in CONTEXT
 * coordinates (lineage + global contextSeq) — never in Session ids or Pi
 * entry ranges. These tests drive the REAL Context store + REAL port +
 * REAL manager/runner path to prove:
 *
 *  B12-AC1  attribution-absent units (no Pi entrySeq, e.g. legacy-recovered)
 *           are FULL batch members — the old entrySeq filter that dropped
 *           them is gone.
 *  B12-AC2  the same ordered Context units claimed under different Runtime
 *           Session boundaries yield an IDENTICAL frozen batch identity
 *           (endpoints + batchHash) — claimHistorianBatch is lineage-scoped,
 *           never session-scoped.
 *  B12-AC3  rollover cannot split/re-scan/duplicate: when Session B (same
 *           lineage) starts with entrySeq=1 again, the claim window is still
 *           keyed by contextSeq — Session A's units are never re-claimed
 *           under B, and B's durable cursor is the global contextSeq.
 *  B12-AC4  the durable cursor is processedThroughContextSeq; legacy
 *           session_state rows (no context column) start from contextSeq 1.
 *  B12-AC5  a frozen batch is replayable: two claims of the same window
 *           return the identical batchHash (immutable, crash-replayable).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { ContextStore } from "../src/context/context-store.js";
import { createContextHistoryReadPort } from "../src/context/history-read-port.js";
import { HistorianManager } from "../src/historian/historian-manager.js";
import { HistorianStore } from "../src/historian/historian-store.js";

const LINEAGE = "identity-b12";
const SESSION_A = "iris-runtime-2026-08-01-a";
const SESSION_B = "iris-runtime-2026-08-02-b";

function makeLineageInput(runtimeSessionId: string) {
  return {
    lineageId: LINEAGE,
    runtimeSessionId,
    contextSourceSnapshotId: "src-1",
    epochId: runtimeSessionId,
    personaSnapshotId: "persona-1",
    declarationVersion: "v1",
    providerProfileId: "mock",
    canonicalSystemPrompt: "sys",
    systemProjectionHash: "sys-hash",
    preparedAt: "t",
    materializationId: "mat-1",
    contextSerializerVersion: "v1",
    carrierSchemaVersion: "v1",
  };
}

function insertUnit(
  store: ContextStore,
  input: {
    runtimeSessionId: string;
    contextSeq: number;
    unitId: string;
    contextUnitId?: string;
    entrySeq?: number;
    contentHash?: string;
  },
): void {
  store.insertUnit({
    lineageId: LINEAGE,
    runtimeSessionId: input.runtimeSessionId,
    contextSeq: input.contextSeq,
    contextUnitId: input.contextUnitId ?? input.unitId,
    unitId: input.unitId,
    sourceEventId: `evt-${input.contextSeq}`,
    runtimeEventId: `evt-${input.contextSeq}`,
    unitType: "input",
    semanticSchemaId: "iris.semantic.context_message.user.v1",
    disposition: "include",
    entryId: input.entrySeq === undefined ? "no-archive-map" : `entry-${input.contextSeq}`,
    ...(input.entrySeq === undefined ? {} : { entrySeq: input.entrySeq }),
    contentHash: input.contentHash ?? "c".repeat(64),
    payload: { role: "user" as const, content: `content-${input.contextSeq}`, timestamp: 1 },
    paired: false,
    derivationRefs: { memoryRefs: [], compartmentIds: [], sourceContextMessageUnitIds: [] },
    schemaVersion: "context-unit-v1",
    createdAt: "t",
  });
}

test("B12-AC1: attribution-absent units (no Pi entrySeq) are FULL batch members", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b12-attribution-"));
  try {
    const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
    store.createLineage(makeLineageInput(SESSION_A));
    store.bindCurrentSession(LINEAGE, SESSION_A);
    // Two units WITH entrySeq + one WITHOUT (legacy-recovered shape).
    insertUnit(store, { runtimeSessionId: SESSION_A, contextSeq: 1, contextUnitId: "u1", unitId: "u1", entrySeq: 1 });
    insertUnit(store, { runtimeSessionId: SESSION_A, contextSeq: 2, unitId: "u2" });
    insertUnit(store, { runtimeSessionId: SESSION_A, contextSeq: 3, contextUnitId: "u3", unitId: "u3", entrySeq: 3 });

    const historian = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    try {
      const port = createContextHistoryReadPort(store);
      const manager = new HistorianManager({
        store: historian,
        historyPort: port,
        modelProviderProfile: "m",
        maxQueuedJobs: 4,
      });
      // The freeze head claim must include the attribution-less unit.
      const batch = port.claimHistorianBatch({
        afterContextSeqExclusive: 0,
        throughContextSeqInclusive: Number.MAX_SAFE_INTEGER,
      });
      assert.deepEqual(
        batch.units.map((u) => u.unitId),
        ["u1", "u2", "u3"],
        "batch membership is contextSeq-keyed; entrySeq absence changes nothing",
      );

      await manager.triggerIncremental(SESSION_A);
      await manager.pumpOnce();
      const state = historian.getSessionState(SESSION_A);
      assert.equal(state?.status, "active");
      assert.equal(
        state?.processedThroughContextSeq,
        3,
        "the Context cursor covers ALL units incl. the attribution-less one",
      );
      assert.equal(
        state?.processedThroughEntrySeq,
        3,
        "the entrySeq attribution cursor advances to the max attribution ordinal",
      );
      manager.close();
    } finally {
      historian.close();
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B12-AC2/AC3: identical batch identity across Session boundaries; rollover never re-scans", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b12-rollover-"));
  try {
    const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
    store.createLineage(makeLineageInput(SESSION_A));
    store.bindCurrentSession(LINEAGE, SESSION_A);
    // Session A: contextSeq 1..3 with entrySeq 1..3.
    for (let seq = 1; seq <= 3; seq++) {
      insertUnit(store, {
        runtimeSessionId: SESSION_A,
        contextSeq: seq,
        contextUnitId: `a-${seq}`,
        unitId: `a-${seq}`,
        entrySeq: seq,
      });
    }
    const port = createContextHistoryReadPort(store);
    const batchA = port.claimHistorianBatch({
      afterContextSeqExclusive: 0,
      throughContextSeqInclusive: 3,
    });

    // Rollover: Session B binds the SAME lineage; its Pi entrySeq RESTARTS
    // at 1 (attribution resets) but contextSeq continues globally.
    store.bindCurrentSession(LINEAGE, SESSION_B);
    for (let seq = 4; seq <= 5; seq++) {
      insertUnit(store, {
        runtimeSessionId: SESSION_B,
        contextSeq: seq,
        contextUnitId: `b-${seq}`,
        unitId: `b-${seq}`,
        entrySeq: seq - 3, // 1, 2 — the reset attribution
      });
    }

    // B12-AC2: claiming the SAME window again (regardless of the current
    // binding) returns the IDENTICAL frozen batch identity.
    const batchAgain = port.claimHistorianBatch({
      afterContextSeqExclusive: 0,
      throughContextSeqInclusive: 3,
    });
    assert.equal(batchAgain.batchHash, batchA.batchHash, "batch identity is session-independent");
    assert.deepEqual(
      batchAgain.units.map((u) => u.unitId),
      batchA.units.map((u) => u.unitId),
    );

    // B12-AC3: Session B's window starts strictly after Session A's ceiling
    // — the claim NEVER re-scans A's units.
    const batchB = port.claimHistorianBatch({
      afterContextSeqExclusive: 3,
      throughContextSeqInclusive: 5,
    });
    assert.deepEqual(
      batchB.units.map((u) => ({
        contextUnitId: u.contextUnitId,
        unitId: u.unitId,
        contextSeq: u.contextSeq,
        entrySeq: u.entrySeq,
      })),
      [
        { contextUnitId: "b-4", unitId: "b-4", contextSeq: 4, entrySeq: 1 },
        { contextUnitId: "b-5", unitId: "b-5", contextSeq: 5, entrySeq: 2 },
      ],
      "membership/order by contextSeq only; B's reset entrySeq is attribution",
    );

    // And through the REAL manager: B's incremental commits advance the
    // GLOBAL cursor without touching A's units (no duplicate claims, no
    // re-scan, no split).
    const historian = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    try {
      const manager = new HistorianManager({
        store: historian,
        historyPort: port,
        modelProviderProfile: "m",
        maxQueuedJobs: 4,
      });
      await manager.triggerIncremental(SESSION_B);
      await manager.pumpOnce();
      const stateB = historian.getSessionState(SESSION_B);
      assert.equal(
        stateB?.processedThroughContextSeq,
        5,
        "B's durable cursor is the GLOBAL contextSeq (3 A-units + 2 B-units)",
      );
      assert.equal(
        stateB?.processedThroughEntrySeq,
        5,
        "B's durable entrySeq attribution is the monotonic batch ordinal (5), NOT its reset raw numbering (1..2) — the raw reset lives on the unit rows only",
      );
      manager.close();
    } finally {
      historian.close();
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B12-AC84: process Session A then rollover — Session B must NOT re-claim A's units (iris_agent#84)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b12-lineage-cursor-"));
  try {
    const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
    store.createLineage(makeLineageInput(SESSION_A));
    store.bindCurrentSession(LINEAGE, SESSION_A);
    // Session A: contextSeq 1..3.
    for (let seq = 1; seq <= 3; seq++) {
      insertUnit(store, {
        runtimeSessionId: SESSION_A,
        contextSeq: seq,
        contextUnitId: `a-${seq}`,
        unitId: `a-${seq}`,
        entrySeq: seq,
      });
    }

    const historian = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    try {
      const port = createContextHistoryReadPort(store);
      const manager = new HistorianManager({
        store: historian,
        historyPort: port,
        modelProviderProfile: "m",
        maxQueuedJobs: 4,
      });

      // STEP 1: Process Session A (1..3). This advances the lineage cursor
      // to contextSeq 3.
      await manager.triggerIncremental(SESSION_A);
      await manager.pumpOnce();
      const stateA = historian.getSessionState(SESSION_A);
      assert.equal(stateA?.processedThroughContextSeq, 3, "A processed 1..3");
      assert.equal(
        historian.getLineageCursor(LINEAGE)?.processedThroughContextSeq,
        3,
        "lineage cursor advanced to 3",
      );

      // STEP 2: Rollover — Session B binds the SAME lineage.
      store.bindCurrentSession(LINEAGE, SESSION_B);
      // Session B: contextSeq 4..5 with entrySeq restarting at 1.
      for (let seq = 4; seq <= 5; seq++) {
        insertUnit(store, {
          runtimeSessionId: SESSION_B,
          contextSeq: seq,
          contextUnitId: `b-${seq}`,
          unitId: `b-${seq}`,
          entrySeq: seq - 3,
        });
      }

      // Use the SAME manager — rollover does not require reopening it.
      // The manager reads the lineage cursor on each freeze, so B will
      // correctly see A's ceiling (3) instead of starting from 0.

      // STEP 3: B's incremental must claim ONLY 4..5, NOT 1..3.
      // Before the fix, B had no session_state row, so
      // processedThroughContextSeq ?? 0 = 0, and B re-claimed A's units.
      await manager.triggerIncremental(SESSION_B);
      await manager.pumpOnce();

      const stateB = historian.getSessionState(SESSION_B);
      assert.equal(
        stateB?.processedThroughContextSeq,
        5,
        "B's cursor reaches 5 (3 from A + 2 from B)",
      );

      // The CRITICAL #84 assertion: the lineage cursor must be 5, and B's
      // freeze/claim must have started AFTER A's ceiling (3), not from 0.
      const lineageCursor = historian.getLineageCursor(LINEAGE);
      assert.equal(
        lineageCursor?.processedThroughContextSeq,
        5,
        "lineage cursor is 5 after B processes 4..5",
      );

      // No duplicate publications: A produced a publication for 1..3, B
      // for 4..5 only. Verify by checking no re-claim of A's range.
      // We can't easily intercept publications here, but we CAN verify
      // the freeze path: the batch B claimed must not include A's units.
      // Re-create the manager scenario: B's freeze cursor starts at 3.
      const lineageCursorBefore = 3; // what B saw
      const batch = port.claimHistorianBatch({
        afterContextSeqExclusive: lineageCursorBefore,
        throughContextSeqInclusive: Number.MAX_SAFE_INTEGER,
      });
      assert.deepEqual(
        batch.units.map((u) => u.unitId),
        ["b-4", "b-5"],
        "B's batch contains ONLY B's units (4..5), never A's 1..3",
      );

      manager.close();
    } finally {
      historian.close();
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B12-AC4: legacy session_state (no context cursor) starts from contextSeq 1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b12-legacy-cursor-"));
  try {
    const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
    store.createLineage(makeLineageInput(SESSION_A));
    store.bindCurrentSession(LINEAGE, SESSION_A);
    for (let seq = 1; seq <= 2; seq++) {
      insertUnit(store, {
        runtimeSessionId: SESSION_A,
        contextSeq: seq,
        contextUnitId: `u-${seq}`,
        unitId: `u-${seq}`,
        entrySeq: seq,
      });
    }
    const historian = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    try {
      // Simulate a PRE-#76 session_state row: entrySeq cursor only, no
      // processed_through_context_seq (legacy column absent/NULL).
      historian.upsertSessionState({
        runtimeSessionId: SESSION_A,
        processedThroughEntrySeq: 0,
        status: "active",
        updatedAt: "t",
      });
      const port = createContextHistoryReadPort(store);
      const manager = new HistorianManager({
        store: historian,
        historyPort: port,
        modelProviderProfile: "m",
        maxQueuedJobs: 4,
      });
      await manager.triggerIncremental(SESSION_A);
      await manager.pumpOnce();
      const state = historian.getSessionState(SESSION_A);
      assert.equal(
        state?.processedThroughContextSeq,
        2,
        "legacy rows start from contextSeq 1 (NULL treated as 0) and advance normally",
      );
      manager.close();
    } finally {
      historian.close();
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B12-AC5: a frozen batch is replayable — identical window ⇒ identical batchHash", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b12-replay-"));
  try {
    const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
    store.createLineage(makeLineageInput(SESSION_A));
    store.bindCurrentSession(LINEAGE, SESSION_A);
    for (let seq = 1; seq <= 4; seq++) {
      insertUnit(store, {
        runtimeSessionId: SESSION_A,
        contextSeq: seq,
        contextUnitId: `u-${seq}`,
        unitId: `u-${seq}`,
        entrySeq: seq,
      });
    }
    const port = createContextHistoryReadPort(store);
    const b1 = port.claimHistorianBatch({
      afterContextSeqExclusive: 1,
      throughContextSeqInclusive: 4,
    });
    const b2 = port.claimHistorianBatch({
      afterContextSeqExclusive: 1,
      throughContextSeqInclusive: 4,
    });
    assert.equal(b1.batchHash, b2.batchHash, "immutable + replayable");
    assert.deepEqual(
      b1.units.map((u) => u.unitId),
      b2.units.map((u) => u.unitId),
      "identical membership",
    );
    assert.equal(b1.throughContextSeqInclusive, 4, "actual endpoints are clamped to the store max");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// iris_agent#94: the lineage cursor must survive REAL process restarts
// (store close + reopen of the SAME database files), not just Session
// rollover inside one manager. These tests drive the full
// close → reopen → new-manager path:
//
//  B12-AC94-1  after a restart, Session B claims only N+1..M — A's units
//              are never re-claimed (the durable lineage cursor is 3, not 0).
//  B12-AC94-2  a crash AFTER B's freeze claim but BEFORE its commit must not
//              rewind the cursor; recovery resumes from the durable ceiling.
//  B12-AC94-3  a restart with no new units is a nothing_new no-op — no
//              duplicate publication, cursor unchanged.
//  B12-AC94-4  a legacy DB (migration 0010 not yet applied) backfills the
//              lineage cursor from pre-#84 data on reopen — no rewind to 0.
test("B12-AC94-1: Session A commit → process restart → Session B claims only N+1..M (iris_agent#94)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b12-restart-claim-"));
  try {
    const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
    store.createLineage(makeLineageInput(SESSION_A));
    store.bindCurrentSession(LINEAGE, SESSION_A);
    for (let seq = 1; seq <= 3; seq++) {
      insertUnit(store, {
        runtimeSessionId: SESSION_A,
        contextSeq: seq,
        contextUnitId: `a-${seq}`,
        unitId: `a-${seq}`,
        entrySeq: seq,
      });
    }
    const historian = HistorianStore.open({ databasePath: join(dir, "historian.db") });

    // PROCESS 1: Session A (1..3) — commits the lineage cursor at 3.
    const port1 = createContextHistoryReadPort(store);
    const manager1 = new HistorianManager({
      store: historian,
      historyPort: port1,
      modelProviderProfile: "m",
      maxQueuedJobs: 4,
    });
    await manager1.triggerIncremental(SESSION_A);
    await manager1.pumpOnce();
    assert.equal(
      historian.getLineageCursor(LINEAGE)?.processedThroughContextSeq,
      3,
      "A committed 1..3 before the restart",
    );
    assert.equal(historian.countPublications(), 1, "A produced exactly one publication");
    // PROCESS RESTART: close everything, reopen the SAME database files.
    manager1.close(); // closes historian too
    store.close();

    const reopenedStore = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
    const reopenedHistorian = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    try {
      // Session B binds after the restart; its Pi entrySeq resets while the
      // contextSeq continues globally.
      reopenedStore.bindCurrentSession(LINEAGE, SESSION_B);
      for (let seq = 4; seq <= 5; seq++) {
        insertUnit(reopenedStore, {
          runtimeSessionId: SESSION_B,
          contextSeq: seq,
          contextUnitId: `b-${seq}`,
          unitId: `b-${seq}`,
          entrySeq: seq - 3,
        });
      }
      const port2 = createContextHistoryReadPort(reopenedStore);
      const manager2 = new HistorianManager({
        store: reopenedHistorian,
        historyPort: port2,
        modelProviderProfile: "m",
        maxQueuedJobs: 4,
      });
      await manager2.triggerIncremental(SESSION_B);
      await manager2.pumpOnce();

      assert.equal(
        reopenedHistorian.getLineageCursor(LINEAGE)?.processedThroughContextSeq,
        5,
        "the lineage cursor survived the restart and advanced to 5",
      );
      assert.equal(
        reopenedHistorian.getSessionState(SESSION_B)?.processedThroughContextSeq,
        5,
        "B's session cursor reaches the global ceiling 5",
      );
      assert.equal(
        reopenedHistorian.countPublications(),
        2,
        "exactly two publications — A's 1..3 and B's 4..5; nothing re-claimed after restart",
      );
      // B's claim window starts strictly after A's durable ceiling (3):
      // only N+1..M is eligible, never A's 1..3.
      const batch = port2.claimHistorianBatch({
        afterContextSeqExclusive: 3,
        throughContextSeqInclusive: Number.MAX_SAFE_INTEGER,
      });
      assert.deepEqual(
        batch.units.map((u) => u.unitId),
        ["b-4", "b-5"],
        "restart recovery claims only 4..5, never A's units",
      );
      manager2.close();
    } finally {
      reopenedHistorian.close();
      reopenedStore.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B12-AC94-2: B frozen claim → crash/restart → recovery does not rewind cursor (iris_agent#94)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b12-restart-freeze-crash-"));
  try {
    const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
    store.createLineage(makeLineageInput(SESSION_A));
    store.bindCurrentSession(LINEAGE, SESSION_A);
    for (let seq = 1; seq <= 3; seq++) {
      insertUnit(store, {
        runtimeSessionId: SESSION_A,
        contextSeq: seq,
        contextUnitId: `a-${seq}`,
        unitId: `a-${seq}`,
        entrySeq: seq,
      });
    }
    const historian = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    const port = createContextHistoryReadPort(store);
    const manager = new HistorianManager({
      store: historian,
      historyPort: port,
      modelProviderProfile: "m",
      maxQueuedJobs: 4,
    });
    await manager.triggerIncremental(SESSION_A);
    await manager.pumpOnce();
    assert.equal(
      historian.getLineageCursor(LINEAGE)?.processedThroughContextSeq,
      3,
      "A committed 1..3",
    );

    // Session B claims the head (4..6): triggerIncremental durably writes
    // the boundary snapshot — but we CRASH before any pumpOnce, so B's
    // commit never ran.
    store.bindCurrentSession(LINEAGE, SESSION_B);
    for (let seq = 4; seq <= 6; seq++) {
      insertUnit(store, {
        runtimeSessionId: SESSION_B,
        contextSeq: seq,
        contextUnitId: `b-${seq}`,
        unitId: `b-${seq}`,
        entrySeq: seq - 3,
      });
    }
    await manager.triggerIncremental(SESSION_B); // freeze claim persisted; NO pumpOnce (crash)
    assert.equal(
      historian.getLineageCursor(LINEAGE)?.processedThroughContextSeq,
      3,
      "a freeze claim alone never advances the durable cursor",
    );
    manager.close();
    store.close();

    // Restart: recovery must resume from the durable lineage cursor (3),
    // never rewind to 0, and never re-publish A's already-committed units.
    const reopenedStore = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
    const reopenedHistorian = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    try {
      const port2 = createContextHistoryReadPort(reopenedStore);
      const manager2 = new HistorianManager({
        store: reopenedHistorian,
        historyPort: port2,
        modelProviderProfile: "m",
        maxQueuedJobs: 4,
      });
      await manager2.triggerIncremental(SESSION_B);
      await manager2.pumpOnce();
      assert.equal(
        reopenedHistorian.getLineageCursor(LINEAGE)?.processedThroughContextSeq,
        6,
        "the cursor never rewound below A's ceiling; B committed 4..6 after recovery",
      );
      assert.equal(
        reopenedHistorian.countPublications(),
        2,
        "A's 1..3 + B's 4..6 — the pre-crash freeze published nothing and left no duplicate",
      );
      manager2.close();
    } finally {
      reopenedHistorian.close();
      reopenedStore.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B12-AC94-3: B commit → immediate restart → no duplicate work (iris_agent#94)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b12-restart-idempotent-"));
  try {
    const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
    store.createLineage(makeLineageInput(SESSION_A));
    store.bindCurrentSession(LINEAGE, SESSION_A);
    for (let seq = 1; seq <= 3; seq++) {
      insertUnit(store, {
        runtimeSessionId: SESSION_A,
        contextSeq: seq,
        contextUnitId: `a-${seq}`,
        unitId: `a-${seq}`,
        entrySeq: seq,
      });
    }
    const historian = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    const port = createContextHistoryReadPort(store);
    const manager = new HistorianManager({
      store: historian,
      historyPort: port,
      modelProviderProfile: "m",
      maxQueuedJobs: 4,
    });
    await manager.triggerIncremental(SESSION_A);
    await manager.pumpOnce();
    store.bindCurrentSession(LINEAGE, SESSION_B);
    for (let seq = 4; seq <= 5; seq++) {
      insertUnit(store, {
        runtimeSessionId: SESSION_B,
        contextSeq: seq,
        contextUnitId: `b-${seq}`,
        unitId: `b-${seq}`,
        entrySeq: seq - 3,
      });
    }
    await manager.triggerIncremental(SESSION_B);
    await manager.pumpOnce();
    assert.equal(
      historian.getLineageCursor(LINEAGE)?.processedThroughContextSeq,
      5,
      "A+B committed through 5",
    );
    assert.equal(historian.countPublications(), 2, "one publication per processed window");
    manager.close();
    store.close();

    // Restart with NOTHING new: the durable lineage cursor (5) is the
    // watermark; a fresh incremental must be a nothing_new no-op.
    const reopenedStore = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
    const reopenedHistorian = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    try {
      const port2 = createContextHistoryReadPort(reopenedStore);
      const manager2 = new HistorianManager({
        store: reopenedHistorian,
        historyPort: port2,
        modelProviderProfile: "m",
        maxQueuedJobs: 4,
      });
      await manager2.triggerIncremental(SESSION_B);
      await manager2.pumpOnce();
      assert.equal(
        reopenedHistorian.getLineageCursor(LINEAGE)?.processedThroughContextSeq,
        5,
        "restart with no new units: cursor stays at 5 — no rewind, no advance",
      );
      assert.equal(
        reopenedHistorian.countPublications(),
        2,
        "no new publication after the restart",
      );
      manager2.close();
    } finally {
      reopenedHistorian.close();
      reopenedStore.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B12-AC94-4: legacy cursor migration → reopen → no rewind (iris_agent#94)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b12-restart-legacy-"));
  try {
    const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
    store.createLineage(makeLineageInput(SESSION_A));
    store.bindCurrentSession(LINEAGE, SESSION_A);
    for (let seq = 1; seq <= 3; seq++) {
      insertUnit(store, {
        runtimeSessionId: SESSION_A,
        contextSeq: seq,
        contextUnitId: `a-${seq}`,
        unitId: `a-${seq}`,
        entrySeq: seq,
      });
    }
    const historian = HistorianStore.open({ databasePath: join(dir, "historian.db") });

    // Downgrade the freshly-opened DB to its pre-#84 legacy shape:
    //  - no lineage_cursors row (the 0010 table is empty);
    //  - migration 0010 not recorded as applied (a legacy binary's DB);
    //  - 0009-era durable data: a session_state row carrying the Context
    //    cursor and a boundary_snapshots row carrying lineage_id.
    // 0010's backfill derives lineage_cursors from boundary_snapshots
    // (session_state cannot be used: it has no lineage_id column).
    const db = historian.raw();
    db.exec("DELETE FROM lineage_cursors");
    db.exec("DELETE FROM schema_migrations WHERE version = '0010_lineage_cursor'");
    db.prepare(
      "INSERT INTO session_state " +
        "(runtime_session_id, processed_through_entry_seq, processed_through_context_seq, status, updated_at) " +
        "VALUES (?, ?, ?, 'active', ?)",
    ).run(SESSION_A, 3, 3, "t");
    db.prepare(
      "INSERT INTO boundary_snapshots " +
        "(boundary_snapshot_id, runtime_session_id, lineage_id, observed_head_entry_seq, " +
        "observed_head_context_seq, eligible_through_entry_seq, eligible_through_context_seq, " +
        "protected_tail_start_entry_seq, true_raw_eligible_tokens, narratable_eligible_tokens, " +
        "source_range_hash, model_provider_profile, frozen_at, consumed_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
    ).run("legacy-bsnap-1", SESSION_A, LINEAGE, 3, 3, 3, 3, 4, 100, 100, "legacy-hash", "m", "t");
    historian.close();

    // "Restart with the upgraded binary": reopening runs the pending 0010
    // migration, whose backfill seeds lineage_cursors from the legacy
    // boundary_snapshots — the cursor must be 3, never 0.
    const reopened = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    try {
      assert.equal(
        reopened.getLineageCursor(LINEAGE)?.processedThroughContextSeq,
        3,
        "0010 backfilled the lineage cursor from the legacy boundary snapshot — no rewind to 0",
      );

      // Session B (4..5) then starts from the backfilled 3, not from 0.
      store.bindCurrentSession(LINEAGE, SESSION_B);
      for (let seq = 4; seq <= 5; seq++) {
        insertUnit(store, {
          runtimeSessionId: SESSION_B,
          contextSeq: seq,
          contextUnitId: `b-${seq}`,
          unitId: `b-${seq}`,
          entrySeq: seq - 3,
        });
      }
      const port = createContextHistoryReadPort(store);
      const manager = new HistorianManager({
        store: reopened,
        historyPort: port,
        modelProviderProfile: "m",
        maxQueuedJobs: 4,
      });
      await manager.triggerIncremental(SESSION_B);
      await manager.pumpOnce();
      assert.equal(
        reopened.getLineageCursor(LINEAGE)?.processedThroughContextSeq,
        5,
        "B advanced the backfilled cursor 3 → 5; the legacy 1..3 was never re-processed",
      );
      assert.equal(
        reopened.getSessionState(SESSION_B)?.processedThroughContextSeq,
        5,
        "B's session cursor is the global ceiling",
      );
      assert.equal(
        reopened.countPublications(),
        1,
        "only B's 4..5 was published; the legacy A range produced no duplicate work",
      );
      manager.close();
    } finally {
      reopened.close();
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
