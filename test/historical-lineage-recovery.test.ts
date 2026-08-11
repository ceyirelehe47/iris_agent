import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { computeMessageContentHash } from "@earendil-works/pi-agent-core";

import { defaultAgentConfig } from "../src/config/load.js";
import { initializeDataRoot, resolveDataRootPaths } from "../src/host/data-root.js";
import { RuntimeEpochStore } from "../src/runtime/epoch-manager.js";
import { ContextBindingLedgerExceededError, ContextStore } from "../src/context/context-store.js";
import {
  closeSessionStorage,
  deriveLineageId,
  openOrCreateSession,
  reconcileHistoricalSession,
  rolloverActiveSession,
} from "../src/runtime/vertical-slice.js";

/**
 * iris_agent#52: rollover must not delete the Session->lineage resolution
 * path needed by late recovery. The historical binding ledger keeps every
 * binding (append-only); normal ingest still accepts ONLY the current
 * session; the Recovery Reconciler resolves a verified historical session
 * to its durable identity lineage and the recovered events continue the
 * same global contextSeq, while Session B proceeds without a reset.
 */

async function setupSlice(
  dataRoot: string,
  config = defaultAgentConfig(),
  now = "2026-08-05T00:00:00.000Z",
) {
  initializeDataRoot(dataRoot, config);
  const paths = resolveDataRootPaths(dataRoot, config);
  const epochStore = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const epoch = epochStore.ensureActive(now);
  const { repo, session } = await openOrCreateSession(dataRoot, config, epoch.runtimeSessionId);
  // Production path: the identity lineage is created when the slice starts.
  // (runSlice -> ensureLineage). Mirror it here so rollover has a lineage to
  // rebind and the recovery reconciler has a binding to resolve.
  const contextStore = ContextStore.open(paths.contextDb, {
    lineageId: deriveLineageId(paths.dataRoot),
  });
  try {
    if (contextStore.getLineageByLineageId(contextStore.lineageId) === undefined) {
      contextStore.createLineage({
        lineageId: contextStore.lineageId,
        runtimeSessionId: epoch.runtimeSessionId,
        contextSourceSnapshotId: "snap-c1",
        epochId: epoch.epochId,
        personaSnapshotId: "persona-default-v1",
        declarationVersion: "decl-v1",
        providerProfileId: "profile-c1",
        canonicalSystemPrompt: "sys",
        systemProjectionHash: "hash",
        preparedAt: now,
        materializationId: "mat",
        contextSerializerVersion: "v1",
        carrierSchemaVersion: "v1",
      });
    }
  } finally {
    contextStore.close();
  }
  return { config, now, epochStore, epoch, repo, session, paths };
}

function userMessage(text: string) {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp: Date.now(),
  };
}

test("c1: crash -> rollover -> restart recovers Session A into the SAME lineage with the next global contextSeq, then B continues", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-c1-"));
  const s = await setupSlice(dataRoot);
  try {
    // Session A commits a message + pending receipt, then the process crashes
    // before Iris commit (no recover, no ack).
    const metadata = await s.session.getMetadata();
    const aMessage = userMessage("session A crash window");
    const aHash = await computeMessageContentHash(aMessage);
    await s.session.appendMessageWithCommitReceipt(aMessage, (entryId) => ({
      sessionId: metadata.id,
      entryId,
      contentHash: aHash,
      committedAt: new Date().toISOString(),
    }));
    assert.equal((await s.session.readPendingCommitReceipts()).length, 1);
    await closeSessionStorage(s.repo);
    s.epochStore.close();

    // Restart: Session B becomes current via settled rollover (A stays closed).
    const rolled = await rolloverActiveSession({
      dataRoot,
      config: s.config,
      now: s.now,
      settledEpochId: s.epoch.epochId,
    });
    assert.notEqual(rolled.newSessionId, s.epoch.runtimeSessionId);

    // Recovery reconciler resolves A (historical binding) and replays exactly
    // once into the durable identity lineage.
    const reconciled = await reconcileHistoricalSession({
      dataRoot,
      config: s.config,
      runtimeSessionId: s.epoch.runtimeSessionId,
      now: s.now,
    });
    assert.equal(reconciled.replayed, 1);
    assert.ok(reconciled.lineageId.length > 0, "recovery must resolve the durable lineage");
    assert.equal(reconciled.units.length, 1, "one Context unit for the recovered message");
    // Raw-archive attribution: the unit keeps A's Pi Session id in its
    // rawArchiveRef (the unit row's runtimeSessionId field is the lineage id
    // by existing rowToUnit semantics; attribution lives in the archive ref
    // and in the RuntimeEvent ledger row, which stays on A).
    assert.match(
      (reconciled.units[0]?.rawArchiveRef as string | undefined) ?? "",
      new RegExp(s.epoch.runtimeSessionId),
    );
    assert.equal(reconciled.units[0]?.contextLineageId, reconciled.lineageId);

    // A second reconciliation is a no-op (receipt acked; unit idempotent).
    const again = await reconcileHistoricalSession({
      dataRoot,
      config: s.config,
      runtimeSessionId: s.epoch.runtimeSessionId,
      now: s.now,
    });
    assert.equal(again.replayed, 0, "duplicate recovery replays zero");
    // The lineage still carries exactly ONE unit (no duplication).
    const verifyStore = ContextStore.open(s.paths.contextDb, { lineageId: reconciled.lineageId });
    try {
      assert.equal(verifyStore.maxContextSeqByLineage(reconciled.lineageId), 1);
    } finally {
      verifyStore.close();
    }

    // Session B continues on the same lineage with the NEXT global contextSeq
    // (no reset): open B's session, ingest a new event, its contextSeq must be
    // reconciled.units[0].contextSeq + 1.
    const { repo: repoB, session: sessionB } = await openOrCreateSession(
      dataRoot,
      s.config,
      rolled.newSessionId,
    );
    try {
      const bMessage = userMessage("session B after rollover");
      const bHash = await computeMessageContentHash(bMessage);
      await sessionB.appendMessageWithCommitReceipt(bMessage, (entryId) => ({
        sessionId: rolled.newSessionId,
        entryId,
        contentHash: bHash,
        committedAt: new Date().toISOString(),
      }));
      const storeB = ContextStore.open(s.paths.contextDb, { lineageId: reconciled.lineageId });
      try {
        const seqA = reconciled.units[0]?.contextSeq ?? 0;
        const maxSeq = storeB.maxContextSeqByLineage(reconciled.lineageId);
        assert.equal(maxSeq, seqA, "recovered unit carries the lineage watermark");
        // B's own recovery must resolve through the CURRENT binding.
        const lineageB = storeB.resolveLineageForRecovery(rolled.newSessionId, {
          sessionId: rolled.newSessionId,
          entryId: "placeholder",
          contentHash: bHash,
        });
        assert.equal(lineageB, reconciled.lineageId, "B binds the same identity lineage");
      } finally {
        storeB.close();
      }
    } finally {
      await closeSessionStorage(repoB);
    }
  } finally {
    // OS tmpdir 管理。
  }
});

test("c2: normal ingest from the old Session after rollover still fails closed; only the reconciler can resolve it", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-c2-"));
  const config = defaultAgentConfig();
  initializeDataRoot(dataRoot, config);
  const paths = resolveDataRootPaths(dataRoot, config);
  const epochStore = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const epochA = epochStore.ensureActive("2026-08-05T00:00:00.000Z");
  const store = ContextStore.open(paths.contextDb, { lineageId: "lineage-c2" });
  try {
    const lineage = "lineage-c2";
    store.createLineage({
      lineageId: lineage,
      runtimeSessionId: epochA.runtimeSessionId,
      contextSourceSnapshotId: "snap",
      epochId: epochA.epochId,
      personaSnapshotId: "persona-default-v1",
      declarationVersion: "decl-v1",
      providerProfileId: "profile",
      canonicalSystemPrompt: "sys",
      systemProjectionHash: "hash",
      preparedAt: "2026-08-05T00:00:00.000Z",
      materializationId: "mat",
      contextSerializerVersion: "v1",
      carrierSchemaVersion: "v1",
    });
    // Rollover: B becomes current; A's binding is historical.
    store.bindCurrentSession(lineage, "session-B");
    // Normal production resolution of A must fail closed.
    assert.throws(
      () => store.maxContextSeq(epochA.runtimeSessionId),
      /ContextLineageResolutionError|refusing to resolve/,
    );
    // The reconciler (verified receipt) resolves A to the same lineage.
    const resolved = store.resolveLineageForRecovery(epochA.runtimeSessionId, {
      sessionId: epochA.runtimeSessionId,
      entryId: "e-a",
      contentHash: "a".repeat(64),
    });
    assert.equal(resolved, lineage);
    // And it is still read-only: A is NOT current again.
    assert.throws(() => store.maxContextSeq(epochA.runtimeSessionId), /refusing to resolve/);
  } finally {
    store.close();
    epochStore.close();
  }
});

test("c3: binding ledger keeps the full append-only history with integrity checksums", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-c3-"));
  const config = defaultAgentConfig();
  initializeDataRoot(dataRoot, config);
  const paths = resolveDataRootPaths(dataRoot, config);
  const epochStore = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const epoch = epochStore.ensureActive("2026-08-05T00:00:00.000Z");
  const store = ContextStore.open(paths.contextDb, { lineageId: "lineage-c3" });
  try {
    store.createLineage({
      lineageId: "lineage-c3",
      runtimeSessionId: epoch.runtimeSessionId,
      contextSourceSnapshotId: "snap",
      epochId: epoch.epochId,
      personaSnapshotId: "persona-default-v1",
      declarationVersion: "decl-v1",
      providerProfileId: "profile",
      canonicalSystemPrompt: "sys",
      systemProjectionHash: "hash",
      preparedAt: "2026-08-05T00:00:00.000Z",
      materializationId: "mat",
      contextSerializerVersion: "v1",
      carrierSchemaVersion: "v1",
    });
    store.bindCurrentSession("lineage-c3", "session-B");
    store.bindCurrentSession("lineage-c3", "session-C");

    // Both old sessions resolve as historical; the ledger rows are immutable
    // (never deleted) and checksum-verified.
    const a = store.resolveLineageForRecovery(epoch.runtimeSessionId, {
      sessionId: epoch.runtimeSessionId,
      entryId: "e-a",
      contentHash: "a".repeat(64),
    });
    const b = store.resolveLineageForRecovery("session-B", {
      sessionId: "session-B",
      entryId: "e-b",
      contentHash: "b".repeat(64),
    });
    assert.equal(a, "lineage-c3");
    assert.equal(b, "lineage-c3");
  } finally {
    store.close();
    epochStore.close();
  }
});

test("c5: single-current-binding guard, ambiguity fail-closed and unmasked hard-cap error (review findings)", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-c5-"));
  const config = defaultAgentConfig();
  initializeDataRoot(dataRoot, config);
  const paths = resolveDataRootPaths(dataRoot, config);
  const epochStore = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const epoch = epochStore.ensureActive("2026-08-05T00:00:00.000Z");
  const store = ContextStore.open(paths.contextDb, {
    lineageId: "lineage-c5",
    maxUnitsPerSession: 10,
  });
  try {
    store.createLineage({
      lineageId: "lineage-c5",
      runtimeSessionId: epoch.runtimeSessionId,
      contextSourceSnapshotId: "snap",
      epochId: epoch.epochId,
      personaSnapshotId: "persona-default-v1",
      declarationVersion: "decl-v1",
      providerProfileId: "profile",
      canonicalSystemPrompt: "sys",
      systemProjectionHash: "hash",
      preparedAt: "2026-08-05T00:00:00.000Z",
      materializationId: "mat",
      contextSerializerVersion: "v1",
      carrierSchemaVersion: "v1",
    });

    // Review finding (probe-ambiguity): a session that is the CURRENT binding
    // of one lineage must not be bindable as current of a second lineage.
    store.createLineage({
      lineageId: "lineage-c5-other",
      runtimeSessionId: "some-other-session",
      contextSourceSnapshotId: "snap",
      epochId: epoch.epochId,
      personaSnapshotId: "persona-default-v1",
      declarationVersion: "decl-v1",
      providerProfileId: "profile",
      canonicalSystemPrompt: "sys",
      systemProjectionHash: "hash",
      preparedAt: "2026-08-05T00:00:00.000Z",
      materializationId: "mat",
      contextSerializerVersion: "v1",
      carrierSchemaVersion: "v1",
    });
    assert.throws(() => {
      store.bindCurrentSession("lineage-c5-other", epoch.runtimeSessionId);
    }, /already the current binding of lineage lineage-c5/);

    // Ambiguity fail-closed: two binding rows for one session (external
    // tampering) must throw instead of resolving arbitrarily.
    store
      .raw()
      .prepare(
        `INSERT INTO session_lineage_bindings
        (runtime_session_id, context_lineage_id, binding_role, bound_at, superseded_at, binding_checksum)
       VALUES (?, ?, 'historical', ?, NULL, ?)`,
      )
      .run("some-other-session", "lineage-c5", "2026-08-05T00:00:00.000Z", "0".repeat(64));
    assert.throws(
      () => {
        store.resolveLineageForRecovery("some-other-session", {
          sessionId: "some-other-session",
          entryId: "e",
          contentHash: "f".repeat(64),
        });
      },
      /has 2 bindings|checksum/,
      "ambiguous or corrupt bindings must fail closed",
    );

    // Review finding (P7): recovery-mode hard-cap insert must surface
    // ContextBoundsExceededError, NOT mask it with a session-resolution
    // failure when recording the emergency state. (hard cap = 2x soft cap.)
    const hard = ContextStore.open(paths.contextDb, {
      lineageId: "lineage-c5",
      maxUnitsPerSession: 1,
    });
    try {
      for (let i = 1; i <= 2; i += 1) {
        hard.insertUnit(
          {
            schemaId: "iris.context_message_unit.v1",
            contextLineageId: "lineage-c5",
            contextSeq: i,
            contextUnitId: `u${i}`,
            runtimeEventId: `evt-${i}`,
            kind: "assistant",
            semanticSchemaId: "iris.semantic.context_message.assistant.v1",
            historianDisposition: "include",
            contentHash: "c".repeat(64),
            semanticContent: { role: "assistant", content: [{ type: "text", text: "x" }] } as never,
            derivationRefs: {
              schemaId: "iris.semantic_derivation_refs.v1",
              memoryRefs: [],
              compartmentIds: [],
              sourceContextMessageUnitIds: [],
            },
            lifecycleState: "committed",
            createdAt: "2026-08-05T00:00:00.000Z",
          },
          { verifySessionBinding: false },
        );
      }
      assert.throws(
        () => {
          hard.insertUnit(
            {
              schemaId: "iris.context_message_unit.v1",
              contextLineageId: "lineage-c5",
              contextSeq: 3,
              contextUnitId: "u3",
              runtimeEventId: "evt-3",
              kind: "assistant",
              semanticSchemaId: "iris.semantic.context_message.assistant.v1",
              historianDisposition: "include",
              contentHash: "c".repeat(64),
              semanticContent: {
                role: "assistant",
                content: [{ type: "text", text: "x" }],
              } as never,
              derivationRefs: {
                schemaId: "iris.semantic_derivation_refs.v1",
                memoryRefs: [],
                compartmentIds: [],
                sourceContextMessageUnitIds: [],
              },
              lifecycleState: "committed",
              createdAt: "2026-08-05T00:00:00.000Z",
            },
            { verifySessionBinding: false },
          );
        },
        /hard cap exceeded/,
        "recovery-mode hard-cap failure must surface ContextBoundsExceededError",
      );
    } finally {
      hard.close();
    }
  } finally {
    store.close();
    epochStore.close();
  }
});

test("c4: foreign, fabricated, deleted and checksum-corrupt bindings fail closed", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-c4-"));
  const config = defaultAgentConfig();
  initializeDataRoot(dataRoot, config);
  const paths = resolveDataRootPaths(dataRoot, config);
  const epochStore = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const epoch = epochStore.ensureActive("2026-08-05T00:00:00.000Z");
  const store = ContextStore.open(paths.contextDb, { lineageId: "lineage-c4" });
  try {
    // 1) Unknown session (foreign data root / never bound): fail closed.
    assert.throws(
      () =>
        store.resolveLineageForRecovery("foreign-session", {
          sessionId: "foreign-session",
          entryId: "e",
          contentHash: "c".repeat(64),
        }),
      /no binding/,
    );

    // 2) Fabricated binding (direct row insert with a wrong checksum): fail
    //    closed on the integrity gate.
    store
      .raw()
      .prepare(
        `INSERT INTO session_lineage_bindings
        (runtime_session_id, context_lineage_id, binding_role, bound_at, superseded_at, binding_checksum)
       VALUES (?, ?, 'current', ?, NULL, ?)`,
      )
      .run("fabricated", "lineage-c4", "2026-08-05T00:00:00.000Z", "0".repeat(64));
    assert.throws(
      () =>
        store.resolveLineageForRecovery("fabricated", {
          sessionId: "fabricated",
          entryId: "e",
          contentHash: "d".repeat(64),
        }),
      /checksum/,
    );

    // 3) Legit binding then deleted (tampering): fail closed, never fall back.
    store.createLineage({
      lineageId: "lineage-c4",
      runtimeSessionId: epoch.runtimeSessionId,
      contextSourceSnapshotId: "snap",
      epochId: epoch.epochId,
      personaSnapshotId: "persona-default-v1",
      declarationVersion: "decl-v1",
      providerProfileId: "profile",
      canonicalSystemPrompt: "sys",
      systemProjectionHash: "hash",
      preparedAt: "2026-08-05T00:00:00.000Z",
      materializationId: "mat",
      contextSerializerVersion: "v1",
      carrierSchemaVersion: "v1",
    });
    store
      .raw()
      .prepare("DELETE FROM session_lineage_bindings WHERE runtime_session_id = ?")
      .run(epoch.runtimeSessionId);
    assert.throws(
      () =>
        store.resolveLineageForRecovery(epoch.runtimeSessionId, {
          sessionId: epoch.runtimeSessionId,
          entryId: "e",
          contentHash: "e".repeat(64),
        }),
      /no binding/,
    );

    // 4) Receipt identity mismatch: receipt for a DIFFERENT session.
    store.createLineage({
      lineageId: "lineage-c4b",
      runtimeSessionId: "session-other",
      contextSourceSnapshotId: "snap",
      epochId: epoch.epochId,
      personaSnapshotId: "persona-default-v1",
      declarationVersion: "decl-v1",
      providerProfileId: "profile",
      canonicalSystemPrompt: "sys",
      systemProjectionHash: "hash",
      preparedAt: "2026-08-05T00:00:00.000Z",
      materializationId: "mat",
      contextSerializerVersion: "v1",
      carrierSchemaVersion: "v1",
    });
    assert.throws(
      () =>
        store.resolveLineageForRecovery("session-other", {
          sessionId: "not-session-other",
          entryId: "e",
          contentHash: "f".repeat(64),
        }),
      /belongs to session/,
    );

    // 5) Malformed content hash fails closed.
    assert.throws(
      () =>
        store.resolveLineageForRecovery("session-other", {
          sessionId: "session-other",
          entryId: "e",
          contentHash: "not-a-hash",
        }),
      /malformed content hash/,
    );
  } finally {
    store.close();
    epochStore.close();
  }
});

test("c5 (iris_agent#63): reconciled historical bindings are reclaimed with audit provenance; unreconciled ones never pruned", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-c5-"));
  const config = defaultAgentConfig();
  initializeDataRoot(dataRoot, config);
  const paths = resolveDataRootPaths(dataRoot, config);
  const epochStore = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const epoch = epochStore.ensureActive("2026-08-05T00:00:00.000Z");
  const store = ContextStore.open(paths.contextDb, { lineageId: "lineage-c5" });
  try {
    store.createLineage({
      lineageId: "lineage-c5",
      runtimeSessionId: epoch.runtimeSessionId,
      contextSourceSnapshotId: "snap",
      epochId: epoch.epochId,
      personaSnapshotId: "persona-default-v1",
      declarationVersion: "decl-v1",
      providerProfileId: "profile",
      canonicalSystemPrompt: "sys",
      systemProjectionHash: "hash",
      preparedAt: "2026-08-05T00:00:00.000Z",
      materializationId: "mat",
      contextSerializerVersion: "v1",
      carrierSchemaVersion: "v1",
    });
    // Simulate 100 rollovers: 99 historical bindings + the current one.
    for (let i = 0; i < 99; i++) {
      store.bindCurrentSession("lineage-c5", `session-roll-${i}`);
    }
    const before = store.bindingLedgerStats();
    assert.equal(before.current, 1);
    assert.equal(before.historical, 99);

    // Without acknowledgment NO binding is reclaimable (evidence gate).
    assert.equal(store.reclaimReconciledBindings(), 0, "unreconciled bindings never pruned");
    assert.equal(store.bindingLedgerStats().historical, 99);

    // Acknowledge the OLDEST 80 sessions (their pending receipt windows are
    // fully consumed), keep the 19 newest unreconciled (late-recovery margin).
    for (let i = 0; i < 80; i++) {
      store.acknowledgeSessionReconciled(`session-roll-${i}`);
    }
    const stats = store.bindingLedgerStats();
    assert.equal(stats.reconciled, 80);

    // Reclaim keeps the RETAIN_RECENT newest + everything unreconciled.
    const pruned = store.reclaimReconciledBindings();
    assert.ok(pruned >= 1, `reconciled out-of-window bindings pruned (${pruned})`);
    const after = store.bindingLedgerStats();
    // The 19 newest sessions (unreconciled) survive, plus the 64 retained
    // recent window minus overlap; current stays 1.
    assert.equal(after.current, 1);
    assert.ok(
      after.historical < before.historical,
      `historical ledger shrank (${before.historical} -> ${after.historical})`,
    );
    // Audit provenance was preserved for every pruned row.
    assert.equal(after.auditRows, pruned, "audit table holds exactly the pruned rows");
    // The audit rows carry the original checksum + lineage identity.
    const auditRow = store
      .raw()
      .prepare(
        "SELECT runtime_session_id, context_lineage_id, binding_checksum, pruned_at FROM session_lineage_bindings_audit LIMIT 1",
      )
      .get() as {
      runtime_session_id: string;
      context_lineage_id: string;
      binding_checksum: string;
      pruned_at: string;
    };
    assert.ok(auditRow);
    assert.equal(auditRow.context_lineage_id, "lineage-c5");
    assert.match(auditRow.binding_checksum, /^[0-9a-f]{64}$/);
    assert.ok(auditRow.pruned_at);

    // A PRUNED session resolves fail-closed (no old Session becomes current).
    const prunedSession = auditRow.runtime_session_id;
    assert.throws(
      () =>
        store.resolveLineageForRecovery(prunedSession, {
          sessionId: prunedSession,
          entryId: "e",
          contentHash: "f".repeat(64),
        }),
      /no binding/,
      "pruned sessions fail closed like unknown/foreign ones",
    );
    // The CURRENT session still resolves normally.
    const resolved = store.resolveLineageForRecovery(epoch.runtimeSessionId, {
      sessionId: epoch.runtimeSessionId,
      entryId: "e",
      contentHash: "e".repeat(64),
    });
    assert.equal(resolved, "lineage-c5");
  } finally {
    store.close();
    epochStore.close();
  }
});

test("c6 (iris_agent#63): binding ledger hard limit fails closed even with reconciled rows (bounded growth)", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-c6-"));
  const config = defaultAgentConfig();
  initializeDataRoot(dataRoot, config);
  const paths = resolveDataRootPaths(dataRoot, config);
  const epochStore = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const epoch = epochStore.ensureActive("2026-08-05T00:00:00.000Z");
  // Test-injected tiny bounds: soft=4, hard=8, retain=2 — the gate logic is
  // identical to production; only the scale differs.
  const store = ContextStore.open(paths.contextDb, {
    lineageId: "lineage-c6",
    bindingSoftLimit: 4,
    bindingHardLimit: 8,
    bindingRetainRecent: 2,
  });
  try {
    store.createLineage({
      lineageId: "lineage-c6",
      runtimeSessionId: epoch.runtimeSessionId,
      contextSourceSnapshotId: "snap",
      epochId: epoch.epochId,
      personaSnapshotId: "persona-default-v1",
      declarationVersion: "decl-v1",
      providerProfileId: "profile",
      canonicalSystemPrompt: "sys",
      systemProjectionHash: "hash",
      preparedAt: "2026-08-05T00:00:00.000Z",
      materializationId: "mat",
      contextSerializerVersion: "v1",
      carrierSchemaVersion: "v1",
    });
    // Fill UNRECONCILED historical bindings past the hard limit — automatic
    // reclaim cannot prune any of them (evidence gate), so the gate must
    // fail closed on the next bind. Bound = HARD + RETAIN + 1 ≈ 11 binds.
    let threw = false;
    for (let i = 0; i < 30; i++) {
      try {
        store.bindCurrentSession("lineage-c6", `session-c6-${i}`);
      } catch (error) {
        if (
          error instanceof ContextBindingLedgerExceededError ||
          String(error).includes("binding ledger exceeded the hard limit")
        ) {
          threw = true;
          break;
        }
        throw error;
      }
    }
    assert.equal(threw, true, "hard-limit breach fails closed with a typed error");
    const stats = store.bindingLedgerStats();
    // The ledger never grew unbounded: it stopped at the hard ceiling
    // (unreconciled rows are all retained since none are prunable).
    assert.ok(stats.historical <= 8 + 2, `ledger bounded at hard+retain: ${stats.historical}`);
    assert.equal(stats.current, 1, "failed bind did not create a current binding");
    // The soft-limit auto-reclaim path (reconciled rows get pruned) is
    // covered by c5; here every row is unreconciled so nothing is pruned.
    assert.equal(stats.reclaimable, 0);

    // Acknowledging the OLDEST rows makes them prunable again, so the same
    // store can recover from the ceiling: reclaim frees space and a new bind
    // succeeds (no permanent wedge).
    store.acknowledgeSessionReconciled("session-c6-0");
    store.acknowledgeSessionReconciled("session-c6-1");
    const pruned = store.reclaimReconciledBindings();
    assert.ok(pruned >= 1, `reclaim frees reconciled rows (${pruned})`);
    assert.doesNotThrow(() => {
      store.bindCurrentSession("lineage-c6", "session-c6-recovered");
    }, "bind succeeds after reclaim frees space");
    assert.equal(store.bindingLedgerStats().current, 1);
  } finally {
    store.close();
    epochStore.close();
  }
});
