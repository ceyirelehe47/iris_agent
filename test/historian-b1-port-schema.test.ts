/**
 * R3-P0 移植说明：本测试从已验证的 `agent/r2-product-parity-fix-r3-historian`
 * 分支（commit 5b94db7）原样移植，覆盖 Feature B1（Schema 移植 + read port +
 * fail-closed）。后续 b3–b8 测试由 R3-P1..P4 各自接管。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import type { SessionTreeEntry } from "@iris/pi-agent-core";

import { SessionHistoryReadPort } from "../src/historian/history-read-port.js";
import { HistorianStore } from "../src/historian/historian-store.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { stableHash } from "../src/contracts/historian.js";
import type { HistorianBoundarySnapshot } from "../src/contracts/historian.js";

/**
 * Feature B1 — shared History Projection Read Port + Historian schema.
 */

const SESSION = "iris-runtime-2026-08-01-1";

function rawEntries(): SessionTreeEntry[] {
  return [
    {
      type: "message",
      id: "u-1",
      parentId: null,
      timestamp: "2026-08-01T00:00:01.000Z",
      message: { role: "user", content: "hello", timestamp: 1 },
    },
    {
      type: "custom_message",
      id: "c-1",
      parentId: "u-1",
      timestamp: "2026-08-01T00:00:02.000Z",
      customType: "iris_input_meta",
      content: "<iris-input-meta/>",
      display: false,
    },
    {
      type: "message",
      id: "a-1",
      parentId: "c-1",
      timestamp: "2026-08-01T00:00:03.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        api: "x",
        provider: "m",
        model: "v",
        timestamp: 3,
      },
    },
    {
      type: "model_change",
      id: "mc-1",
      parentId: "a-1",
      timestamp: "2026-08-01T00:00:04.000Z",
      from: "m1",
      to: "m2",
    },
    {
      type: "compaction",
      id: "cp-1",
      parentId: "mc-1",
      timestamp: "2026-08-01T00:00:05.000Z",
      summary: "compacted",
      firstKeptEntryId: "u-1",
      tokensBefore: 100,
    },
  ] as unknown as SessionTreeEntry[];
}

function storeFixture(): { store: HistorianStore; dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "iris-b1-store-"));
  const path = join(dir, "historian.db");
  const store = HistorianStore.open({ databasePath: path });
  return { store, dir, path };
}

test("B1: read port surfaces ALL raw entry types with raw entrySeq ordinals (never filtered-index)", async () => {
  const port = new SessionHistoryReadPort({ readRawEntries: async () => rawEntries() });
  const page = await port.readEntries({ runtimeSessionId: SESSION, limit: 10 });
  assert.equal(page.entries.length, 5, "all 5 raw entries (incl. non-message types) are surfaced");
  assert.equal(page.entries[0]?.entryId, "u-1");
  assert.equal(page.entries[0]?.entrySeq, 1);
  // Non-message types are preserved with their real ids and raw ordinals.
  const modelChange = page.entries.find((entry) => entry.entryId === "mc-1");
  assert.ok(modelChange, "model_change entry is surfaced");
  assert.equal(modelChange?.entrySeq, 4, "model_change has raw ordinal 4");
  const compaction = page.entries.find((entry) => entry.entryId === "cp-1");
  assert.ok(compaction, "compaction entry is surfaced");
  assert.equal(compaction?.entrySeq, 5);
  // Content hash is deterministic and content-sensitive.
  assert.equal(compaction?.contentHash, stableHash(compaction?.entry));
  const again = await port.readEntries({ runtimeSessionId: SESSION, limit: 10 });
  assert.equal(again.entries[4]?.contentHash, compaction?.contentHash, "stable across reads");
});

test("B1: read port pagination is cursor-based, exclusive, forward-only", async () => {
  const port = new SessionHistoryReadPort({ readRawEntries: async () => rawEntries() });
  const first = await port.readEntries({ runtimeSessionId: SESSION, limit: 2 });
  assert.equal(first.entries.length, 2);
  assert.equal(first.nextCursor, 2, "nextCursor = last returned entrySeq");
  assert.equal(first.endOfSession, false);
  const second = await port.readEntries({
    runtimeSessionId: SESSION,
    afterEntrySeqExclusive: 2,
    limit: 2,
  });
  assert.equal(second.entries[0]?.entrySeq, 3, "exclusive cursor skips seq 2");
  assert.equal(second.entries[1]?.entrySeq, 4);
  const last = await port.readEntries({
    runtimeSessionId: SESSION,
    afterEntrySeqExclusive: 4,
    limit: 2,
  });
  assert.equal(last.entries.length, 1);
  assert.equal(last.entries[0]?.entrySeq, 5);
  assert.equal(last.endOfSession, true);
  assert.equal(last.nextCursor, 0, "end of session → cursor 0");
});

test("B1: readRangeUpTo honors the frozen ceiling (runner never widens)", async () => {
  const port = new SessionHistoryReadPort({ readRawEntries: async () => rawEntries() });
  const range = await port.readRangeUpTo({
    runtimeSessionId: SESSION,
    afterEntrySeqExclusive: 0,
    throughEntrySeqInclusive: 3,
  });
  assert.equal(range.length, 3, "range stops exactly at the frozen ceiling");
  assert.equal(range[2]?.entrySeq, 3);
});

test("B1: gap detection surfaces sequence gaps instead of guessing", () => {
  assert.equal(
    SessionHistoryReadPort.detectGap([{ entrySeq: 1 }, { entrySeq: 2 }, { entrySeq: 4 }])?.kind,
    "sequence_gap",
  );
  assert.equal(SessionHistoryReadPort.detectGap([{ entrySeq: 1 }, { entrySeq: 2 }]), null);
});

test("B1: HistorianStore migrates an empty data root (bootstrap)", () => {
  const { store, dir } = storeFixture();
  try {
    const row = store
      .raw()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='publications'")
      .get() as { name: string } | undefined;
    assert.ok(row, "publications table exists after bootstrap");
    assert.ok(store.getSessionState(SESSION) === undefined, "no session state before any upsert");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B1: migration is idempotent on repeat open; checksum verified", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b1-idempotent-"));
  const path = join(dir, "historian.db");
  const migrationsDir = join("src", "db", "migrations", "historian");
  try {
    const first = migrateDatabase(path, migrationsDir);
    const appliedNow = first.appliedVersions.length;
    assert.ok(appliedNow >= 1, `first run applies the pending migrations (${appliedNow})`);
    const second = migrateDatabase(path, migrationsDir);
    assert.equal(second.appliedVersions.length, 0, "repeat run applies nothing");
    const third = migrateDatabase(path, migrationsDir);
    assert.equal(third.appliedVersions.length, 0, "third run also idempotent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B1: a changed applied migration fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b1-checksum-"));
  const path = join(dir, "historian.db");
  const migrationsDir = join(dir, "migrations");
  mkdirSync(migrationsDir, { recursive: true });
  writeFileSync(
    join(migrationsDir, "0001_bootstrap.sql"),
    "CREATE TABLE t (id INTEGER PRIMARY KEY);\n",
  );
  // Migrate once (applies 0001).
  migrateDatabase(path, migrationsDir);
  // Change the applied file content.
  writeFileSync(
    join(migrationsDir, "0001_bootstrap.sql"),
    "CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT);\n",
  );
  assert.throws(
    () => migrateDatabase(path, migrationsDir),
    /migration 0001_bootstrap changed after being applied/,
    "changed applied file must fail closed",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("B1: a NEWER schema (applied version absent from the migration dir) fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b1-newer-"));
  const path = join(dir, "historian.db");
  const migrationsDir = join(dir, "migrations");
  mkdirSync(migrationsDir, { recursive: true });
  // Apply version 0002 directly (simulating a newer build).
  writeFileSync(
    join(migrationsDir, "0002_future.sql"),
    "CREATE TABLE future (id INTEGER PRIMARY KEY);\n",
  );
  migrateDatabase(path, migrationsDir);
  // Now open with an OLDER build whose migration dir only knows 0001.
  const olderMigrationsDir = join(dir, "migrations-older");
  mkdirSync(olderMigrationsDir, { recursive: true });
  writeFileSync(
    join(olderMigrationsDir, "0001_bootstrap.sql"),
    "CREATE TABLE old (id INTEGER PRIMARY KEY);\n",
  );
  assert.throws(
    () => migrateDatabase(path, olderMigrationsDir),
    /database schema is NEWER than this build/,
    "newer-schema must fail closed",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("B1: session state + boundary snapshot round-trip", () => {
  const { store, dir } = storeFixture();
  try {
    store.upsertSessionState({
      runtimeSessionId: SESSION,
      processedThroughEntrySeq: 7,
      status: "active",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    const state = store.getSessionState(SESSION);
    assert.equal(state?.processedThroughEntrySeq, 7);
    assert.equal(state?.status, "active");

    const snapshot: HistorianBoundarySnapshot = {
      boundarySnapshotId: "bs-1",
      runtimeSessionId: SESSION,
      lineageId: "identity-b1",
      observedHeadEntrySeq: 9,
      observedHeadContextSeq: 9,
      eligibleThroughEntrySeq: 6,
      eligibleThroughContextSeq: 6,
      protectedTailStartEntrySeq: 7,
      trueRawEligibleTokens: 1000,
      narratableEligibleTokens: 800,
      sourceRangeHash: "hash-1",
      modelProviderProfile: "opencode/deepseek-v4-flash",
      frozenAt: "2026-08-01T00:00:00.000Z",
    };
    store.saveBoundarySnapshot(snapshot);
    const list = store.listBoundarySnapshots(SESSION);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.eligibleThroughEntrySeq, 6);
    assert.equal(list[0]?.protectedTailStartEntrySeq, 7);
    assert.equal(list[0]?.sourceRangeHash, "hash-1");
    // Re-freeze at the same head replaces the snapshot (upsert).
    store.saveBoundarySnapshot({ ...snapshot, eligibleThroughEntrySeq: 5 });
    assert.equal(store.listBoundarySnapshots(SESSION)[0]?.eligibleThroughEntrySeq, 5);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B1: store transaction begin/commit/rollback works", () => {
  const { store, dir } = storeFixture();
  try {
    store.begin();
    store.upsertSessionState({
      runtimeSessionId: SESSION,
      processedThroughEntrySeq: 1,
      status: "active",
      updatedAt: "x",
    });
    store.rollback();
    assert.equal(store.getSessionState(SESSION), undefined, "rollback discards the write");
    store.begin();
    store.upsertSessionState({
      runtimeSessionId: SESSION,
      processedThroughEntrySeq: 2,
      status: "active",
      updatedAt: "x",
    });
    store.commit();
    assert.equal(store.getSessionState(SESSION)?.processedThroughEntrySeq, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
