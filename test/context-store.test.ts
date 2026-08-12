import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import assert from "node:assert/strict";

import { ContextStore } from "../src/context/context-store.js";

function makeStore(): { store: ContextStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "iris-context-store-"));
  const path = join(dir, "context.db");
  return { store: ContextStore.open(path), path };
}

function makeLineageInput(
  runtimeSessionId = "iris-runtime-2026-08-01-1",
  lineageId = "identity-test",
) {
  return {
    lineageId,
    runtimeSessionId,
    contextSourceSnapshotId: `src-${runtimeSessionId}`,
    epochId: "iris-runtime-2026-08-01-1",
    personaSnapshotId: "persona-1",
    declarationVersion: "v1",
    providerProfileId: "mock",
    canonicalSystemPrompt: "system prompt bytes",
    systemProjectionHash: "sys-hash-1",
    preparedAt: "2026-08-01T12:00:00.000Z",
    materializationId: "mat-1",
    contextSerializerVersion: "iris-context-golden-v1",
    carrierSchemaVersion: "1",
  };
}

test("context-store: empty DB initializes cleanly and lineage can be created", () => {
  const { store, path } = makeStore();
  try {
    const lineage = store.createLineage(makeLineageInput());
    assert.equal(lineage.currentRuntimeSessionId, "iris-runtime-2026-08-01-1");
    assert.equal(lineage.emergencyState, "ok");
    assert.equal(lineage.representedThroughContextSeq, 0);
    // Re-open proves durability.
    store.close();
    const reopened = ContextStore.open(path);
    try {
      const loaded = reopened.getLineage("identity-test");
      assert.equal(loaded?.materializationId, "mat-1");
      assert.equal(loaded?.m0Body, null, "never materialized");
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
  }
});

test("context-store: repeated open is idempotent (no double migration)", () => {
  const { store, path } = makeStore();
  try {
    store.createLineage(makeLineageInput());
    store.close();
    // Second open must not fail and must not re-apply migrations.
    const again = ContextStore.open(path);
    try {
      const lineage = again.getLineage("identity-test");
      assert.ok(lineage);
      const db = new DatabaseSync(path);
      try {
        const count = (
          db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as { c: number }
        ).c;
        assert.equal(
          count,
          9,
          "0001..0008 applied once, never re-applied (two 0005 files = 9 total)",
        );
      } finally {
        db.close();
      }
    } finally {
      again.close();
    }
  } finally {
    store.close();
  }
});

test("context-store: HARD materializeM0 commits m0+m1 atomically and persists", () => {
  const { store, path } = makeStore();
  try {
    store.createLineage(makeLineageInput());
    store.materializeM0({
      runtimeSessionId: "iris-runtime-2026-08-01-1",
      m0Body: "<session-history></session-history>",
      m1Body:
        "<session-history-since>(no new content since last materialization)</session-history-since>",
      m0ContentHash: "h0",
      m1ContentHash: "h1",
      cachedM0SystemHash: "sys-v1",
      cachedM0ModelKey: "mock/model-v1",
      cachedM0ProviderProfileId: "mock",
      representedThroughEntrySeq: 42,
      protectedTailStartEntrySeq: 30,
      lastSafeUserAnchorEntrySeq: 28,
      atMs: 1_785_000_000_000,
    });
    store.close();
    const reopened = ContextStore.open(path);
    try {
      const lineage = reopened.getLineage("identity-test");
      assert.equal(lineage?.m0Body, "<session-history></session-history>");
      assert.equal(lineage?.m0MaterializedAt, 1_785_000_000_000);
      assert.equal(lineage?.representedThroughEntrySeq, 42);
      assert.equal(lineage?.protectedTailStartEntrySeq, 30);
      assert.equal(lineage?.cachedM0SystemHash, "sys-v1");
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
  }
});

test("context-store: SOFT materializeM1 updates m1 only, m0 untouched", () => {
  const { store } = makeStore();
  try {
    store.createLineage(makeLineageInput());
    store.materializeM0({
      runtimeSessionId: "iris-runtime-2026-08-01-1",
      m0Body: "m0-baseline",
      m1Body: "m1-v1",
      m0ContentHash: "h0",
      m1ContentHash: "h1",
      cachedM0SystemHash: "sys-v1",
      cachedM0ModelKey: "mock/model-v1",
      cachedM0ProviderProfileId: "mock",
      representedThroughEntrySeq: 42,
      protectedTailStartEntrySeq: 30,
      lastSafeUserAnchorEntrySeq: 28,
      atMs: 1_000,
    });
    store.materializeM1({
      runtimeSessionId: "iris-runtime-2026-08-01-1",
      m1Body: "m1-v2",
      m1ContentHash: "h2",
      representedThroughEntrySeq: 50,
      atMs: 2_000,
    });
    const lineage = store.getLineage("identity-test");
    assert.equal(lineage?.m0Body, "m0-baseline", "m0 must be byte-identical");
    assert.equal(lineage?.m0ContentHash, "h0");
    assert.equal(lineage?.m1Body, "m1-v2");
    assert.equal(lineage?.m1ContentHash, "h2");
    assert.equal(lineage?.representedThroughEntrySeq, 50);
  } finally {
    store.close();
  }
});

test("context-store: materialization on a missing lineage fails closed (no partial state)", () => {
  const { store } = makeStore();
  try {
    assert.throws(() => {
      store.materializeM0({
        runtimeSessionId: "no-such-session",
        m0Body: "x",
        m1Body: "y",
        m0ContentHash: "h0",
        m1ContentHash: "h1",
        cachedM0SystemHash: "sys",
        cachedM0ModelKey: "model",
        cachedM0ProviderProfileId: "mock",
        representedThroughEntrySeq: 1,
        protectedTailStartEntrySeq: 1,
        lastSafeUserAnchorEntrySeq: 1,
        atMs: 1,
      });
    }, /fail-closed|fail closed/);
    assert.equal(store.getLineage("no-such-lineage"), undefined);
  } finally {
    store.close();
  }
});

test("context-store: deferred operations preserve ordering via monotonic cursor", () => {
  const { store } = makeStore();
  try {
    store.createLineage(makeLineageInput());
    store.enqueueDeferredOperation("iris-runtime-2026-08-01-1", "drop", '{"id":"d1"}');
    store.enqueueDeferredOperation("iris-runtime-2026-08-01-1", "publish", '{"id":"p1"}');
    const ops = store.listDeferredOperations("iris-runtime-2026-08-01-1");
    assert.equal(ops.length, 2);
    assert.equal(ops[0]?.opKind, "drop");
    assert.equal(ops[1]?.opKind, "publish");
    assert.ok((ops[1]?.seq ?? 0) > (ops[0]?.seq ?? 0));
    // Cursor advances independently.
    store.setDeferredSignalCursor("iris-runtime-2026-08-01-1", 5);
    assert.equal(store.getLineage("identity-test")?.deferredSignalCursor, 5);
  } finally {
    store.close();
  }
});

test("context-store: LKG slots upsert and reload", () => {
  const { store, path } = makeStore();
  try {
    store.createLineage(makeLineageInput());
    store.captureLkgSlot({
      lineageId: "identity-test",
      slotKey: "prefix",
      lkgJson: '{"jsonPrefix":"[]"}',
      capturedAt: "2026-08-01T12:00:00.000Z",
    });
    store.captureLkgSlot({
      lineageId: "identity-test",
      slotKey: "prefix",
      lkgJson: '{"jsonPrefix":"[1]"}',
      capturedAt: "2026-08-01T12:00:01.000Z",
    });
    store.close();
    const reopened = ContextStore.open(path);
    try {
      const slot = reopened.getLkgSlot("identity-test", "prefix");
      assert.equal(slot?.lkgJson, '{"jsonPrefix":"[1]"}', "upsert overwrites");
      assert.equal(reopened.getLkgSlot("identity-test", "other"), undefined);
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
  }
});

test("context-store: corrupt DB fails closed on open", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-context-corrupt-"));
  const path = join(dir, "context.db");
  writeFileSync(path, "this is not a sqlite database at all", "utf8");
  assert.throws(() => ContextStore.open(path), /error|Error|file|not a database/i);
});

test("context-store: newer schema version fails closed (fence)", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-context-newer-"));
  const path = join(dir, "context.db");
  // First open applies the current schema.
  const store = ContextStore.open(path);
  store.close();
  // Simulate a NEWER binary having written a newer migration version.
  const db = new DatabaseSync(path);
  try {
    db.prepare(
      "INSERT INTO schema_migrations (version, applied_at, checksum) VALUES ('9999_newer', ?, 'abc')",
    ).run(new Date().toISOString());
  } finally {
    db.close();
  }
  assert.throws(
    () => ContextStore.open(path),
    /newer than supported|fail closed/i,
    "a DB written by a newer binary must refuse to open",
  );
});

test("context-store: emergency state persists and fails closed on read", () => {
  const { store, path } = makeStore();
  try {
    store.createLineage(makeLineageInput());
    store.setEmergencyState(
      "iris-runtime-2026-08-01-1",
      "emergency_fail_closed",
      "transform exploded",
    );
    store.close();
    const reopened = ContextStore.open(path);
    try {
      const lineage = reopened.getLineage("identity-test");
      assert.equal(lineage?.emergencyState, "emergency_fail_closed");
      assert.equal(lineage?.lastTransformError, "transform exploded");
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
  }
});

test("context-store: rollover binds the SAME lineage to the new session and preserves state", () => {
  const { store } = makeStore();
  try {
    const sessionA = "iris-runtime-2026-08-01-1";
    const sessionB = "iris-runtime-2026-08-02-1";
    // v13: one identity/data root → one lineage → many Runtime Sessions.
    store.createLineage(makeLineageInput(sessionA, "identity-main"));
    store.materializeM0ByContextSeq({
      runtimeSessionId: sessionA,
      m0Body: "A-m0",
      m1Body: "A-m1",
      m0ContentHash: "a0",
      m1ContentHash: "a1",
      cachedM0SystemHash: "sys-A",
      cachedM0ModelKey: "model-A",
      cachedM0ProviderProfileId: "mock",
      representedThroughContextSeq: 7,
      atMs: 1_000,
    });
    // Rollover: bind the same lineage to the new session — state must survive.
    store.bindCurrentSession("identity-main", sessionB);
    const lineage = store.getLineageByLineageId("identity-main");
    assert.equal(lineage?.currentRuntimeSessionId, sessionB);
    assert.equal(lineage?.m0Body, "A-m0", "rollover must preserve m0");
    assert.equal(lineage?.representedThroughContextSeq, 7, "rollover must preserve watermark");
    // New session resolves to the same lineage (identity-level), not a fresh one.
    assert.equal(store.getLineage(sessionB)?.lineageId, "identity-main");
  } finally {
    store.close();
  }
});

test("context-store: a different identity/data root gets a separate lineage", () => {
  const { store } = makeStore();
  try {
    store.createLineage(makeLineageInput("iris-runtime-2026-08-01-1", "identity-main"));
    // A different data root has its own runtime session id; its lineage is
    // independent and never inherits the other identity's state.
    store.createLineage(makeLineageInput("iris-runtime-2026-08-02-1", "identity-other"));
    store.materializeM0ByContextSeq({
      runtimeSessionId: "iris-runtime-2026-08-01-1",
      m0Body: "main-m0",
      m1Body: "main-m1",
      m0ContentHash: "m0",
      m1ContentHash: "m1",
      cachedM0SystemHash: "s",
      cachedM0ModelKey: "k",
      cachedM0ProviderProfileId: "mock",
      representedThroughContextSeq: 3,
      atMs: 1_000,
    });
    const other = store.getLineageByLineageId("identity-other");
    assert.equal(other?.m0Body, null, "other identity must NOT inherit m0");
  } finally {
    store.close();
  }
});

test("context-store: SIGKILL crash leaves a reopenable, consistent DB", async () => {
  // Spawn a child that creates a lineage + materializes m0, signals via a
  // marker file, then parks. Parent SIGKILLs it mid-flight; reopening must
  // succeed with a consistent state (never a partially advanced m0).
  const dir = mkdtempSync(join(tmpdir(), "iris-context-sigkill-"));
  const path = join(dir, "context.db");
  const marker = join(dir, "ready.marker");
  const scriptPath = join(dir, "crash-child.mjs");
  // Resolve the ContextStore module to an absolute file:// URL the child can
  // import regardless of its own working directory.
  const storeModuleUrl = new URL("../src/context/context-store.ts", import.meta.url).href;
  const script = `
    import { writeFileSync } from "node:fs";
    import { ContextStore } from ${JSON.stringify(storeModuleUrl)};
    const store = ContextStore.open(process.argv[2]);
    store.createLineage({
      lineageId: "identity-test",
      runtimeSessionId: "iris-runtime-2026-08-01-1",
      contextSourceSnapshotId: "src-1",
      epochId: "e1",
      personaSnapshotId: "p1",
      declarationVersion: "v1",
      providerProfileId: "mock",
      canonicalSystemPrompt: "sys",
      systemProjectionHash: "sh",
      preparedAt: "2026-08-01T12:00:00.000Z",
      materializationId: "mat-1",
      contextSerializerVersion: "iris-context-golden-v1",
      carrierSchemaVersion: "1",
    });
    store.materializeM0({
      runtimeSessionId: "iris-runtime-2026-08-01-1",
      m0Body: "m0-after-crash",
      m1Body: "m1-after-crash",
      m0ContentHash: "h0",
      m1ContentHash: "h1",
      cachedM0SystemHash: "sys",
      cachedM0ModelKey: "model",
      cachedM0ProviderProfileId: "mock",
      representedThroughEntrySeq: 7,
      protectedTailStartEntrySeq: 4,
      lastSafeUserAnchorEntrySeq: 2,
      atMs: Date.now(),
    });
    writeFileSync(process.argv[3], "ready");
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  `;
  writeFileSync(scriptPath, script, "utf8");

  const { spawn } = await import("node:child_process");
  // The child is TS source (imports end in .js but resolve via tsx).
  const child = spawn(
    process.execPath,
    [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), scriptPath, path, marker],
    { stdio: "ignore" },
  );
  try {
    // Wait for the marker: the child has fully committed its writes.
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      const { existsSync } = await import("node:fs");
      if (existsSync(marker)) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, "child must reach the ready marker before the kill");
    // SIGKILL — no graceful shutdown, no checkpoint.
    child.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Reopen: consistent (m0 either fully present or fully absent, never
    // partial), and the ledger is readable.
    const reopened = ContextStore.open(path);
    try {
      const lineage = reopened.getLineage("identity-test");
      assert.ok(lineage, "lineage must be readable after SIGKILL");
      assert.ok(
        lineage.m0Body === null || lineage.m0Body === "m0-after-crash",
        "m0 must be either fully committed or fully absent, never partial",
      );
      if (lineage.m0Body !== null) {
        assert.equal(lineage.m1Body, "m1-after-crash");
        assert.equal(lineage.representedThroughEntrySeq, 7);
      }
    } finally {
      reopened.close();
    }
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // already dead
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
