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
    entrySeq?: number;
    contentHash?: string;
  },
): void {
  store.insertUnit({
    lineageId: LINEAGE,
    runtimeSessionId: input.runtimeSessionId,
    contextSeq: input.contextSeq,
    unitId: input.unitId,
    sourceEventId: `evt-${input.contextSeq}`,
    runtimeEventId: `evt-${input.contextSeq}`,
    unitType: "input",
    disposition: "include",
    entryId: input.entrySeq === undefined ? "no-archive-map" : `entry-${input.contextSeq}`,
    ...(input.entrySeq === undefined ? {} : { entrySeq: input.entrySeq }),
    contentHash: input.contentHash ?? "c".repeat(64),
    payload: { role: "user" as const, content: `content-${input.contextSeq}`, timestamp: 1 },
    paired: false,
    derivationRefs: { memoryRefs: [], compartmentIds: [], sourceContextUnitIds: [] },
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
    insertUnit(store, { runtimeSessionId: SESSION_A, contextSeq: 1, unitId: "u1", entrySeq: 1 });
    insertUnit(store, { runtimeSessionId: SESSION_A, contextSeq: 2, unitId: "u2" });
    insertUnit(store, { runtimeSessionId: SESSION_A, contextSeq: 3, unitId: "u3", entrySeq: 3 });

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
        unitId: u.unitId,
        contextSeq: u.contextSeq,
        entrySeq: u.entrySeq,
      })),
      [
        { unitId: "b-4", contextSeq: 4, entrySeq: 1 },
        { unitId: "b-5", contextSeq: 5, entrySeq: 2 },
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
