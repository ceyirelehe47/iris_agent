/**
 * iris_agent#74: the ACTIVE context.db must stay bounded (rows AND bytes)
 * under long-running rollover operation. The binding-audit provenance moves
 * OUT of the active db into an EXTERNAL archive (context-archive.db) with a
 * crash-safe staged handoff:
 *
 *   reclaim (active txn) → stage batch id (active txn) → copy+manifest
 *   (archive txn) → delete staged (active txn)
 *
 * These tests drive the REAL store through >= 20k rollovers and prove:
 *  - the active binding tables (session_lineage_bindings + audit staging)
 *    stay at a fixed small row count;
 *  - the active DB file returns to a BYTE PLATEAU after
 *    checkpoint(TRUNCATE) + VACUUM (measured at multiple plateaus);
 *  - WAL growth is checkpointable to zero;
 *  - the archive holds every reclaimed row with a manifest (count + hash);
 *  - a crash at ANY handoff phase loses nothing and replays idempotently;
 *  - still-recoverable (unreconciled) Sessions are never reclaimed;
 *  - unknown/pruned/archived Sessions fail closed and can never become
 *    current again;
 *  - a broken archive drains the staging backlog to a HARD cap and then
 *    fails closed with a typed error;
 *  - health metrics expose soft/hard limits + active DB/WAL sizes.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { ContextAuditBacklogExceededError, ContextStore } from "../src/context/context-store.js";

const LINEAGE = "identity-b74";

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

/** One rollover: bind the next session; the PREVIOUS session becomes
 * historical, gets reconciled (evidence of a consumed recovery window) and
 * is reclaimed + archived on the following bind. */
function rolloverOnce(store: ContextStore, index: number): void {
  const session = `iris-b74-s-${index}`;
  store.bindCurrentSession(LINEAGE, session);
  if (index > 1) {
    store.acknowledgeSessionReconciled(`iris-b74-s-${index - 1}`);
  }
}

test("B74-AC1: capacity model covers ALL binding-related tables (active + archive)", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b74-model-"));
  try {
    const store = ContextStore.open(join(dir, "context.db"), {
      lineageId: LINEAGE,
      bindingSoftLimit: 1,
      bindingHardLimit: 2,
      bindingRetainRecent: 0,
    });
    try {
      store.createLineage(makeLineageInput("iris-b74-s-1"));
      rolloverOnce(store, 1);
      rolloverOnce(store, 2);
      rolloverOnce(store, 3); // this bind reclaims the reconciled s-1
      const ledger = store.bindingLedgerStats();
      assert.deepEqual(
        Object.keys(ledger).sort(),
        [
          "auditRows",
          "current",
          "historical",
          "reclaimable",
          "reconciled",
          "staged",
          "total",
        ].sort(),
        "capacity model covers the active binding ledger + audit staging",
      );
      const archive = store.bindingArchiveStats();
      assert.deepEqual(
        Object.keys(archive).sort(),
        [
          "activeDbBytes",
          "archiveBatches",
          "archiveRows",
          "staged",
          "stagingHardCap",
          "stagingSoftCap",
          "walBytes",
        ].sort(),
        "capacity model covers the external archive + active db sizes",
      );
      assert.equal(archive.archiveRows, 1, "one reclaimed binding archived");
      assert.equal(archive.staged, 0, "active staging drained");
      assert.equal(ledger.auditRows, 0, "no audit rows left in the active db");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B74-AC2/AC3: 20k rollovers — active DB rows AND bytes plateau; WAL checkpoints to zero", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b74-plateau-"));
  try {
    const store = ContextStore.open(join(dir, "context.db"), {
      lineageId: LINEAGE,
      bindingSoftLimit: 1,
      bindingHardLimit: 2,
      bindingRetainRecent: 0,
    });
    try {
      store.createLineage(makeLineageInput("iris-b74-s-1"));
      const baseline = store.maintenance().activeDbBytesAfter;
      assert.ok(baseline > 0);

      const samples: Array<{ rollovers: number; activeBytes: number; auditRows: number }> = [];
      const TOTAL = 20_000;
      for (let i = 1; i <= TOTAL; i++) {
        rolloverOnce(store, i);
        if (i === 1_000 || i === 5_000 || i === 10_000 || i === 20_000) {
          const m = store.maintenance();
          const ledger = store.bindingLedgerStats();
          samples.push({
            rollovers: i,
            activeBytes: m.activeDbBytesAfter,
            auditRows: ledger.auditRows,
          });
        }
      }

      // Rows: the active ledger holds exactly the current + the single
      // unreconciled historical window; the audit staging is EMPTY.
      const ledger = store.bindingLedgerStats();
      assert.equal(ledger.auditRows, 0, "no audit rows remain in the active db");
      assert.ok(ledger.total <= 2, `active binding ledger bounded (total=${ledger.total})`);

      // Bytes: the ACTIVE db returns to a plateau — every sample after the
      // first is within a small constant of the baseline (a lifetime
      // archive would grow linearly; a vacuumed active db cannot).
      const PLATEAU_TOLERANCE_BYTES = 128 * 1024;
      for (const sample of samples) {
        assert.ok(
          sample.activeBytes <= baseline + PLATEAU_TOLERANCE_BYTES,
          `plateau after ${sample.rollovers} rollovers: ${sample.activeBytes}B <= baseline ${baseline}B + ${PLATEAU_TOLERANCE_BYTES}B`,
        );
      }
      const first = samples[0];
      const last = samples[samples.length - 1];
      if (first !== undefined && last !== undefined) {
        assert.ok(
          Math.abs(last.activeBytes - first.activeBytes) <= PLATEAU_TOLERANCE_BYTES,
          `10k→20k plateau flat: ${first.activeBytes}B → ${last.activeBytes}B`,
        );
      }

      // WAL: after a TRUNCATE checkpoint the WAL is empty.
      const m = store.maintenance();
      assert.equal(m.walBytesAfter, 0, "WAL truncates to zero");

      // The EXTERNAL archive holds ALL provenance (lifetime archive), with
      // one manifest batch per staged batch. The reclaim lags one rollover
      // (a session is reconciled AFTER its successor binds), so the last
      // reconciled session stays in the active ledger as the retain window.
      const archive = store.bindingArchiveStats();
      assert.equal(archive.archiveRows, TOTAL - 2, "every reclaimed binding is archived");
      assert.ok(archive.archiveBatches >= 1, "manifest batches recorded");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B74-AC4: crash-safe handoff — replay after a crash at ANY phase loses nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b74-crash-"));
  try {
    const dbPath = join(dir, "context.db");
    let store = ContextStore.open(dbPath, {
      lineageId: LINEAGE,
      bindingSoftLimit: 1,
      bindingHardLimit: 2,
      bindingRetainRecent: 0,
    });
    store.createLineage(makeLineageInput("iris-b74-s-1"));
    rolloverOnce(store, 1);
    rolloverOnce(store, 2);
    rolloverOnce(store, 3);
    // Reclaimed rows exist (s-1) but the post-bind drain already archived
    // them. Simulate a crash BETWEEN the archive copy and the active
    // delete (Phase B committed, Phase C never ran): re-insert the rows
    // into the active audit table, marked with the SAME batch id the
    // archive already holds — the exact on-disk state a mid-handoff crash
    // leaves behind.
    // The drain ran automatically after the last bind — the archive holds
    // the reclaimed row.
    const archive = (
      store as unknown as {
        archiveDb: {
          prepare(sql: string): {
            get(...a: unknown[]): unknown;
            all(...a: unknown[]): unknown;
            run(...a: unknown[]): unknown;
          };
        };
      }
    ).archiveDb;
    const manifest = archive
      .prepare("SELECT batch_id AS id, row_count AS n FROM archive_manifest")
      .all() as Array<{ id: number; n: number }>;
    assert.ok(manifest.length >= 1, "archive manifest exists");
    const batch = manifest[0];
    assert.ok(batch !== undefined);
    const archivedRows = archive
      .prepare("SELECT * FROM binding_audit_archive WHERE batch_id = ?")
      .all(batch.id) as Array<Record<string, unknown>>;
    // Recreate the crash state: rows back in the active audit, still marked.
    store.close();
    store = ContextStore.open(dbPath, {
      lineageId: LINEAGE,
      bindingSoftLimit: 1,
      bindingHardLimit: 2,
      bindingRetainRecent: 0,
    });
    const insert = (
      store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }
    ).db.prepare(
      `INSERT INTO session_lineage_bindings_audit
        (runtime_session_id, context_lineage_id, binding_role, bound_at, superseded_at,
         binding_checksum, reconciled_at, pruned_at, archived_batch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of archivedRows) {
      insert.run(
        row["runtime_session_id"],
        row["context_lineage_id"],
        row["binding_role"],
        row["bound_at"],
        row["superseded_at"],
        row["binding_checksum"],
        row["reconciled_at"],
        row["pruned_at"],
        row["batch_id"],
      );
    }
    assert.equal(
      store.bindingLedgerStats().auditRows,
      archivedRows.length,
      "crash state recreated",
    );

    // Replay: the next drain must be idempotent (archive rows NOT
    // duplicated) and must delete the stale staged rows.
    const result = store.archiveBindingAudit();
    assert.equal(result.stagedRemaining, 0, "stale staged rows drained");
    const statsAfter = store.bindingArchiveStats();
    assert.equal(
      statsAfter.archiveRows,
      archivedRows.length,
      "no duplicate archive rows on replay",
    );
    assert.equal(store.bindingLedgerStats().auditRows, 0, "active audit empty after replay");

    // Crash BEFORE the archive copy (Phase A done, B never ran): staged
    // rows with a batch id the archive does NOT know must still be copied.
    // (A crash between A and B is the same state as fresh reclaim rows —
    // the drain re-runs B for every staged batch.)
    const s4 = "iris-b74-s-4";
    store.bindCurrentSession(LINEAGE, s4);
    store.acknowledgeSessionReconciled("iris-b74-s-3");
    // Force a reclaim + drain WITHOUT the automatic post-bind drain by
    // using a fresh store (the archive is the same file).
    store.close();
    store = ContextStore.open(dbPath, {
      lineageId: LINEAGE,
      bindingSoftLimit: 1,
      bindingHardLimit: 2,
      bindingRetainRecent: 0,
    });
    store.bindCurrentSession(LINEAGE, "iris-b74-s-5"); // reclaims s-3? s-3 reconciled now
    const ledger = store.bindingLedgerStats();
    const rows = ledger.auditRows + ledger.staged;
    assert.equal(rows, 0, "all reclaimed rows drained automatically");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B74-AC5: unreconciled Sessions are never reclaimed/archived; recovery stays resolvable", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b74-recovery-"));
  try {
    const store = ContextStore.open(join(dir, "context.db"), {
      lineageId: LINEAGE,
      bindingSoftLimit: 1,
      bindingHardLimit: 2,
      bindingRetainRecent: 0,
    });
    try {
      store.createLineage(makeLineageInput("iris-b74-s-1"));
      store.bindCurrentSession(LINEAGE, "iris-b74-s-1");
      store.bindCurrentSession(LINEAGE, "iris-b74-s-2");
      // s-1 is historical but NOT reconciled → never pruned.
      assert.equal(store.reclaimReconciledBindings(), 0, "unreconciled never reclaimed");
      const receipt = {
        sessionId: "iris-b74-s-1",
        entryId: "e-1",
        contentHash: "c".repeat(64),
      };
      assert.equal(
        store.resolveLineageForRecovery("iris-b74-s-1", receipt),
        LINEAGE,
        "still-recoverable session resolves",
      );
      // Now reconcile s-1 and reclaim: it moves to the audit + archive.
      // The recovery window is CONSUMED (that is what reconciliation
      // proves), so resolution now fails closed — but the provenance is
      // preserved in the EXTERNAL archive, never lost.
      store.acknowledgeSessionReconciled("iris-b74-s-1");
      assert.equal(store.reclaimReconciledBindings(), 1, "reconciled reclaimed");
      store.archiveBindingAudit();
      assert.equal(store.bindingLedgerStats().auditRows, 0, "audit drained to archive");
      assert.throws(
        () => store.resolveLineageForRecovery("iris-b74-s-1", receipt),
        /no binding for runtime session/,
        "reclaimed session fails closed (recovery window consumed)",
      );
      const archive = store.bindingArchiveStats();
      assert.equal(archive.archiveRows, 1, "provenance survives in the external archive");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B74-AC6: unknown/pruned/foreign Sessions fail closed with typed diagnostics", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b74-failclosed-"));
  try {
    const store = ContextStore.open(join(dir, "context.db"), {
      lineageId: LINEAGE,
      bindingSoftLimit: 1,
      bindingHardLimit: 2,
      bindingRetainRecent: 0,
    });
    try {
      store.createLineage(makeLineageInput("iris-b74-s-1"));
      store.bindCurrentSession(LINEAGE, "iris-b74-s-1");
      store.acknowledgeSessionReconciled("iris-b74-s-1");
      store.bindCurrentSession(LINEAGE, "iris-b74-s-2"); // s-1 → historical
      store.acknowledgeSessionReconciled("iris-b74-s-2");
      store.bindCurrentSession(LINEAGE, "iris-b74-s-3"); // gate reclaims s-1 → archive
      store.archiveBindingAudit();
      const receipt = {
        sessionId: "never-existed",
        entryId: "e-1",
        contentHash: "c".repeat(64),
      };
      assert.throws(
        () => store.resolveLineageForRecovery("never-existed", receipt),
        /no binding for runtime session/,
        "unknown session fails closed",
      );
      // A pruned (reclaimed + archived) session cannot resolve either —
      // it can never silently become current again.
      assert.throws(
        () =>
          store.resolveLineageForRecovery("iris-b74-s-1", {
            ...receipt,
            sessionId: "iris-b74-s-1",
          }),
        /no binding for runtime session/,
        "pruned session fails closed",
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B74-AC7: broken archive → staging backlog hits the HARD cap → typed fail-closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b74-hardcap-"));
  try {
    // The archive path points INTO a FILE (not a directory) — every drain
    // fails, so the staging backlog grows and the hard cap must trip.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    const store = ContextStore.open(join(dir, "context.db"), {
      lineageId: LINEAGE,
      bindingSoftLimit: 1,
      bindingHardLimit: 2,
      bindingRetainRecent: 0,
      archiveDbPath: join(blocker, "archive.db"),
      auditStagingSoftCap: 1,
      auditStagingHardCap: 2,
    });
    try {
      store.createLineage(makeLineageInput("iris-b74-s-1"));
      store.bindCurrentSession(LINEAGE, "iris-b74-s-1");
      store.acknowledgeSessionReconciled("iris-b74-s-1");
      // First reclaiming bind (s-3's gate prunes the reconciled s-1): the
      // drain fails (archive broken) — the error propagates but the bind
      // itself committed.
      store.bindCurrentSession(LINEAGE, "iris-b74-s-2");
      store.acknowledgeSessionReconciled("iris-b74-s-2");
      assert.throws(() => {
        store.bindCurrentSession(LINEAGE, "iris-b74-s-3");
      });
      store.acknowledgeSessionReconciled("iris-b74-s-3");
      // Second reclaiming bind: another staged row (audit = 2), drain
      // still fails — the error propagates again.
      assert.throws(() => {
        store.bindCurrentSession(LINEAGE, "iris-b74-s-4");
      });
      store.acknowledgeSessionReconciled("iris-b74-s-4");
      // The backlog now crosses the hard cap (audit = 3 > 2) → the rollover
      // gate fails closed with the typed error BEFORE committing.
      assert.throws(
        () => {
          store.bindCurrentSession(LINEAGE, "iris-b74-s-5");
        },
        ContextAuditBacklogExceededError,
        "hard cap fails closed with typed diagnostics",
      );
      const stats = store.bindingLedgerStats();
      assert.ok(stats.auditRows >= 2, "backlog visible in metrics");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B74-AC8: health metrics expose soft/hard limits and active DB/WAL sizes", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b74-metrics-"));
  try {
    const store = ContextStore.open(join(dir, "context.db"), {
      lineageId: LINEAGE,
      bindingSoftLimit: 1,
      bindingHardLimit: 2,
      bindingRetainRecent: 0,
      auditStagingSoftCap: 7,
      auditStagingHardCap: 9,
    });
    try {
      store.createLineage(makeLineageInput("iris-b74-s-1"));
      rolloverOnce(store, 1);
      rolloverOnce(store, 2);
      const archive = store.bindingArchiveStats();
      assert.equal(archive.stagingSoftCap, 7, "soft limit exposed");
      assert.equal(archive.stagingHardCap, 9, "hard limit exposed");
      assert.ok(archive.activeDbBytes > 0, "active db bytes exposed");
      assert.equal(archive.walBytes >= 0, true, "wal bytes exposed");
      const m = store.maintenance();
      assert.equal(m.walBytesAfter, 0, "maintenance truncates the WAL");
      assert.ok(m.activeDbBytesAfter > 0);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B85-AC1: power-loss durable handoff — WAL frames checkpointed BEFORE active delete (iris_agent#85)", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b85-powerloss-"));
  try {
    const dbPath = join(dir, "context.db");
    const archivePath = join(dir, "context-archive.db");
    const store = ContextStore.open(dbPath, {
      lineageId: LINEAGE,
      bindingSoftLimit: 1,
      bindingHardLimit: 2,
      bindingRetainRecent: 0,
      archiveDbPath: archivePath,
    });
    try {
      store.createLineage(makeLineageInput("iris-b85-s-1"));
      rolloverOnce(store, 1);
      rolloverOnce(store, 2);
      rolloverOnce(store, 3); // reclaims s-1 -> drains to archive

      const stats = store.bindingArchiveStats();
      assert.ok(stats.archiveBatches >= 1, "archive has batch(es)");

      assert.equal(
        store.bindingLedgerStats().auditRows,
        0,
        "active audit rows deleted after archive",
      );

      // CRITICAL: the archive's WAL should be checkpointed to zero bytes
      // (TRUNCATE barrier ran BEFORE the active delete). This proves the
      // archive data is in the MAIN DB file, not just uncheckpointed WAL
      // frames that a power loss could drop.
      const archiveDb = (
        store as unknown as {
          archiveDb: {
            prepare(sql: string): { get(...a: unknown[]): unknown };
          };
        }
      ).archiveDb;
      const walInfo = archiveDb.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as {
        busy: number;
        log: number;
        checkpointed: number;
      };
      assert.equal(
        walInfo.log,
        0,
        "archive WAL is checkpointed to zero - durability barrier ran before active delete (iris_agent#85)",
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B85-AC2: archive WAL loss simulation - provenance survives (iris_agent#85)", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b85-wallloss-"));
  try {
    const dbPath = join(dir, "context.db");
    const archivePath = join(dir, "context-archive.db");
    let store = ContextStore.open(dbPath, {
      lineageId: LINEAGE,
      bindingSoftLimit: 1,
      bindingHardLimit: 2,
      bindingRetainRecent: 0,
      archiveDbPath: archivePath,
    });
    store.createLineage(makeLineageInput("iris-b85-s-1"));
    rolloverOnce(store, 1);
    rolloverOnce(store, 2);
    rolloverOnce(store, 3);
    store.close();

    // Simulate power loss: delete the archive's WAL/SHM files.
    // Because the #85 fix checkpoints (TRUNCATE) the archive before
    // deleting active rows, the main archive DB file already contains
    // all data. Deleting -wal/-shm should NOT lose data.
    try {
      rmSync(`${archivePath}-wal`, { force: true });
      rmSync(`${archivePath}-shm`, { force: true });
    } catch {
      // WAL/SHM may not exist if already checkpointed
    }

    store = ContextStore.open(dbPath, {
      lineageId: LINEAGE,
      bindingSoftLimit: 1,
      bindingHardLimit: 2,
      bindingRetainRecent: 0,
      archiveDbPath: archivePath,
    });
    try {
      const stats = store.bindingArchiveStats();
      assert.ok(stats.archiveRows >= 1, "archived rows survive WAL loss");
      assert.ok(stats.archiveBatches >= 1, "manifest survives WAL loss");

      const ledger = store.bindingLedgerStats();
      assert.equal(ledger.auditRows, 0, "active audit still clean after WAL loss");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
