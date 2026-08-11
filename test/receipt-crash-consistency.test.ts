import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import {
  computeMessageContentHash,
  JsonlSessionRepository,
  loadJsonlSessionMetadata,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

import { defaultAgentConfig } from "../src/config/load.js";
import { ContextIngest } from "../src/context/context-ingest.js";
import { ContextStore } from "../src/context/context-store.js";
import { initializeDataRoot, resolveDataRootPaths } from "../src/host/data-root.js";
import { RuntimeEpochStore } from "../src/runtime/epoch-manager.js";
import { createIrisHarness } from "../src/runtime/harness-factory.js";
import {
  closeSessionStorage,
  composeProvider,
  deriveLineageId,
  makeReadOnlyTestTool,
  openOrCreateSession,
  prepareContextSources,
  rolloverActiveSession,
  sampleAgentInput,
} from "../src/runtime/vertical-slice.js";
import { RuntimeEventLedger } from "../src/runtime/runtime-event-ledger.js";
import { attachRuntimeEventSeam } from "../src/runtime/runtime-event-seam.js";

/**
 * Feature 2 cross-repository integration (iris_agent#40): the durable Pi
 * commit receipt journal must be consumed exactly once by the RuntimeEvent
 * ledger across crash/restart, duplicate recovery, out-of-order recovery and
 * session rollover. These tests drive the REAL Pi fork (SqliteSessionRepository
 * + AgentHarness.recoverPendingCommitReceipts) against the REAL iris_agent
 * ledger; they never infer normal semantic events from the Session transcript.
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
  const { models, model, providerProfileId } = await composeProvider("mock");
  const prepared = prepareContextSources(
    sampleAgentInput(),
    epoch.runtimeSessionId,
    epoch.epochId,
    config,
    now,
  );
  return {
    config,
    now,
    epochStore,
    epoch,
    repo,
    session,
    models,
    model,
    providerProfileId,
    prepared,
    paths,
  };
}

function attachLedger(
  harness: ReturnType<typeof createIrisHarness>["harness"],
  paths: ReturnType<typeof resolveDataRootPaths>,
  runtimeSessionId: string,
  piSessionId: string,
) {
  const ledger = RuntimeEventLedger.open(paths.runtimeLedgerDb);
  attachRuntimeEventSeam(harness, {
    ledger,
    runtimeSessionId,
    piSessionId,
  });
  return ledger;
}

function userMessage(text: string) {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp: Date.now(),
  };
}

/**
 * Production Context wiring for the cross-repo recovery path (mirrors
 * vertical-slice ensureLineage → ContextIngest): opens the real context.db,
 * binds (or rebinds after restart) the runtime session to the data-root
 * lineage, and returns the real ingestion transaction.
 */
function openContextWithLineage(
  ledger: RuntimeEventLedger,
  dataRoot: string,
  runtimeSessionId: string,
  providerProfileId: string,
  now: string,
): { store: ContextStore; ingest: ContextIngest } {
  const store = ContextStore.open(join(dataRoot, "context.db"), {
    lineageId: deriveLineageId(dataRoot),
  });
  const lineageId = store.lineageId;
  if (store.getLineageByLineageId(lineageId) === undefined) {
    store.createLineage({
      lineageId,
      runtimeSessionId,
      contextSourceSnapshotId: `src-${runtimeSessionId}`,
      epochId: `epoch-${runtimeSessionId}`,
      personaSnapshotId: "persona-xrepo",
      declarationVersion: "v1",
      providerProfileId,
      canonicalSystemPrompt: "system",
      systemProjectionHash: "sys-hash",
      preparedAt: now,
      materializationId: "mat-xrepo",
      contextSerializerVersion: "iris-context-golden-v1",
      carrierSchemaVersion: "1",
    });
  } else {
    store.bindCurrentSession(lineageId, runtimeSessionId);
  }
  return { store, ingest: new ContextIngest(ledger, store, lineageId) };
}

test("f2-xrepo: crash between durable append and publication is recovered exactly once", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-f2-crash-"));
  try {
    const s = await setupSlice(dataRoot);

    // "Crash" simulation: record the durable entry + pending receipt at the Pi
    // storage level, but never publish (no recover, no ack) — the process died
    // between append and message_finalized.
    const metadata = await s.session.getMetadata();
    const message = userMessage("crash window message");
    const contentHash = await computeMessageContentHash(message);
    await s.session.appendMessageWithCommitReceipt(message, (entryId) => ({
      sessionId: metadata.id,
      entryId,
      contentHash,
      committedAt: new Date().toISOString(),
    }));
    await expectPending(s, 1);
    await closeSessionStorage(s.repo);
    s.epochStore.close();

    // Restart: reopen the same data root, attach a fresh ledger, recover.
    const s2 = await setupSlice(dataRoot, s.config);
    const { harness: harness2 } = createIrisHarness({
      session: s2.session,
      instanceEpoch: s2.epoch.ordinalWithinDate,
      models: s2.models,
      model: s2.model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation: {
        input: sampleAgentInput(),
        prepared: s2.prepared,
        invocationId: "invocation-f2-crash-restart",
      },
      now: s2.now,
      providerProfileId: s2.providerProfileId,
    });
    const ledger = attachLedger(
      harness2,
      s2.paths,
      s2.epoch.runtimeSessionId,
      s2.epoch.runtimeSessionId,
    );

    const replayed = await harness2.recoverPendingCommitReceipts();
    assert.equal(replayed, 1, "exactly one missed receipt must replay after crash");

    const events = ledger.listBySession(s2.epoch.runtimeSessionId);
    const finalized = events.filter((event) => event.type === "message_finalized");
    assert.equal(finalized.length, 1, "exactly one message_finalized must land in the ledger");
    assert.equal(finalized[0]?.['entryId'], await s2.session.getLeafId());

    // A second recovery must not re-emit (ack persisted) and the ledger must
    // not gain duplicates.
    assert.equal(await harness2.recoverPendingCommitReceipts(), 0);
    assert.equal(
      ledger.listBySession(s2.epoch.runtimeSessionId).filter((e) => e.type === "message_finalized")
        .length,
      1,
    );

    await expectPending(s2, 0);
    ledger.close();
    await closeSessionStorage(s2.repo);
    s2.epochStore.close();
  } finally {
    // OS tmpdir 管理。
  }
});

test("f2-xrepo: duplicate recovery does not duplicate ledger commits (exactly-once)", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-f2-dupe-"));
  try {
    const s = await setupSlice(dataRoot);
    const { harness } = createIrisHarness({
      session: s.session,
      instanceEpoch: s.epoch.ordinalWithinDate,
      models: s.models,
      model: s.model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation: {
        input: sampleAgentInput(),
        prepared: s.prepared,
        invocationId: "inv-f2-dupe",
      },
      now: s.now,
      providerProfileId: s.providerProfileId,
    });
    const ledger = attachLedger(
      harness,
      s.paths,
      s.epoch.runtimeSessionId,
      s.epoch.runtimeSessionId,
    );

    const metadata = await s.session.getMetadata();
    const message = userMessage("duplicate window");
    const contentHash = await computeMessageContentHash(message);
    await s.session.appendMessageWithCommitReceipt(message, (entryId) => ({
      sessionId: metadata.id,
      entryId,
      contentHash,
      committedAt: new Date().toISOString(),
    }));
    await expectPending(s, 1);

    // Even if recovery runs twice (e.g. two restart paths raced), the ledger
    // idempotency key (message_finalized:sessionId:entryId) must collapse
    // duplicates and the Pi journal must ack only once.
    assert.equal(await harness.recoverPendingCommitReceipts(), 1);
    assert.equal(await harness.recoverPendingCommitReceipts(), 0);
    const finalized = ledger
      .listBySession(s.epoch.runtimeSessionId)
      .filter((e) => e.type === "message_finalized");
    assert.equal(finalized.length, 1, "duplicate recovery must not duplicate ledger commits");
    await expectPending(s, 0);

    ledger.close();
    await closeSessionStorage(s.repo);
    s.epochStore.close();
  } finally {
    // OS tmpdir 管理。
  }
});

test("f2-xrepo: out-of-order recovery replays in commit order with stable identity", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-f2-order-"));
  try {
    const s = await setupSlice(dataRoot);
    const { harness } = createIrisHarness({
      session: s.session,
      instanceEpoch: s.epoch.ordinalWithinDate,
      models: s.models,
      model: s.model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation: {
        input: sampleAgentInput(),
        prepared: s.prepared,
        invocationId: "inv-f2-order",
      },
      now: s.now,
      providerProfileId: s.providerProfileId,
    });
    const ledger = attachLedger(
      harness,
      s.paths,
      s.epoch.runtimeSessionId,
      s.epoch.runtimeSessionId,
    );
    const metadata = await s.session.getMetadata();

    const texts = ["first", "second", "third"];
    const entryIds: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      assert.ok(text !== undefined, "test vector must exist");
      const message = userMessage(text);
      const contentHash = await computeMessageContentHash(message);
      const { entryId } = await s.session.appendMessageWithCommitReceipt(message, (id) => ({
        sessionId: metadata.id,
        entryId: id,
        contentHash,
        committedAt: new Date(Date.now() + i).toISOString(),
      }));
      entryIds.push(entryId);
    }
    await expectPending(s, 3);

    assert.equal(await harness.recoverPendingCommitReceipts(), 3);
    const finalized = ledger
      .listBySession(s.epoch.runtimeSessionId)
      .filter((e) => e.type === "message_finalized");
    assert.equal(finalized.length, 3);
    // Commit order preserved and receipt identity (entryId) stable.
    assert.deepEqual(
      finalized.map((e) => (e as unknown as Record<string, unknown>)['entryId']),
      entryIds,
    );

    ledger.close();
    await closeSessionStorage(s.repo);
    s.epochStore.close();
  } finally {
    // OS tmpdir 管理。
  }
});

test("f2-xrepo: rollover keeps per-session recovery independent and never resets events", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-f2-rollover-"));
  try {
    const s = await setupSlice(dataRoot);
    const { harness } = createIrisHarness({
      session: s.session,
      instanceEpoch: s.epoch.ordinalWithinDate,
      models: s.models,
      model: s.model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation: {
        input: sampleAgentInput(),
        prepared: s.prepared,
        invocationId: "inv-f2-roll-1",
      },
      now: s.now,
      providerProfileId: s.providerProfileId,
    });
    const ledger = attachLedger(
      harness,
      s.paths,
      s.epoch.runtimeSessionId,
      s.epoch.runtimeSessionId,
    );
    const metadata = await s.session.getMetadata();

    // Session A: one committed message with a pending receipt (crash window).
    const aMessage = userMessage("pre-rollover");
    const aHash = await computeMessageContentHash(aMessage);
    const { entryId: aEntryId } = await s.session.appendMessageWithCommitReceipt(
      aMessage,
      (id) => ({
        sessionId: metadata.id,
        entryId: id,
        contentHash: aHash,
        committedAt: new Date().toISOString(),
      }),
    );
    await expectPending(s, 1);

    // Settled-only rollover rotates the Pi session within the same identity
    // lineage; session A stays closed with its pending receipt.
    const rolled = await rolloverActiveSession({
      dataRoot,
      config: s.config,
      now: s.now,
      settledEpochId: s.epoch.epochId,
    });
    assert.notEqual(
      rolled.newSessionId,
      s.epoch.runtimeSessionId,
      "rollover must mint a new runtime session",
    );
    const { repo: repoB, session: sessionB } = await openOrCreateSession(
      dataRoot,
      s.config,
      rolled.newSessionId,
    );

    // Recovery belongs to session A: reopen A's session and replay its
    // pending receipt into A's ledger stream. Session B must not see it.
    const { repo: repoA, session: sessionARestarted } = await openOrCreateSession(
      dataRoot,
      s.config,
      s.epoch.runtimeSessionId,
    );
    const { harness: harnessA } = createIrisHarness({
      session: sessionARestarted,
      instanceEpoch: s.epoch.ordinalWithinDate,
      models: s.models,
      model: s.model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation: {
        input: sampleAgentInput(),
        prepared: s.prepared,
        invocationId: "inv-f2-roll-a-recover",
      },
      now: s.now,
      providerProfileId: s.providerProfileId,
    });
    const ledgerA = attachLedger(
      harnessA,
      s.paths,
      s.epoch.runtimeSessionId,
      s.epoch.runtimeSessionId,
    );
    assert.equal(await harnessA.recoverPendingCommitReceipts(), 1);
    const finalizedA = ledgerA
      .listBySession(s.epoch.runtimeSessionId)
      .filter((e) => e.type === "message_finalized");
    assert.equal(finalizedA.length, 1);
    assert.equal(finalizedA[0]?.['entryId'], aEntryId);
    await closeSessionStorage(repoA);

    // Session B events continue cleanly (no reset, no cross-talk).
    const { harness: harness2 } = createIrisHarness({
      session: sessionB,
      instanceEpoch: s.epoch.ordinalWithinDate,
      models: s.models,
      model: s.model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation: {
        input: sampleAgentInput(),
        prepared: s.prepared,
        invocationId: "inv-f2-roll-2",
      },
      now: s.now,
      providerProfileId: s.providerProfileId,
    });
    const ledger2 = attachLedger(harness2, s.paths, rolled.newSessionId, rolled.newSessionId);
    await harness2.appendMessage(userMessage("post-rollover"));
    const finalizedB = ledger2
      .listBySession(rolled.newSessionId)
      .filter((e) => e.type === "message_finalized");
    assert.equal(finalizedB.length, 1, "session B events must start clean");
    assert.equal(
      await harness2.recoverPendingCommitReceipts(),
      0,
      "session B has no pending receipts",
    );
    assert.equal((await sessionB.readPendingCommitReceipts()).length, 0);

    ledger.close();
    ledgerA.close();
    ledger2.close();
    await closeSessionStorage(repoB);
    s.epochStore.close();
  } finally {
    // OS tmpdir 管理。
  }
});

test("f2-xrepo: same-millisecond committedAt ties replay in exact append order (iris_agent#50)", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-f2-ties-"));
  try {
    const s = await setupSlice(dataRoot);
    const { harness } = createIrisHarness({
      session: s.session,
      instanceEpoch: s.epoch.ordinalWithinDate,
      models: s.models,
      model: s.model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation: {
        input: sampleAgentInput(),
        prepared: s.prepared,
        invocationId: "inv-f2-ties",
      },
      now: s.now,
      providerProfileId: s.providerProfileId,
    });
    const ledger = attachLedger(
      harness,
      s.paths,
      s.epoch.runtimeSessionId,
      s.epoch.runtimeSessionId,
    );
    const metadata = await s.session.getMetadata();

    const sameTimestamp = new Date(2026, 7, 5, 0, 0, 0, 0).toISOString();
    const texts = ["alpha", "beta", "gamma"];
    const entryIds: string[] = [];
    for (const text of texts) {
      const message = userMessage(text);
      const contentHash = await computeMessageContentHash(message);
      const { entryId } = await s.session.appendMessageWithCommitReceipt(message, (id) => ({
        sessionId: metadata.id,
        entryId: id,
        contentHash,
        committedAt: sameTimestamp,
      }));
      entryIds.push(entryId);
    }
    await expectPending(s, 3);

    // All three receipts share the identical committed_at; replay must still
    // follow the authoritative commit sequence (append order), never the
    // timestamp or an opaque entry-id tie-break.
    assert.equal(await harness.recoverPendingCommitReceipts(), 3);
    const finalized = ledger
      .listBySession(s.epoch.runtimeSessionId)
      .filter((e) => e.type === "message_finalized");
    assert.deepEqual(
      finalized.map((e) => (e as unknown as Record<string, unknown>)['entryId']),
      entryIds,
      "same-timestamp receipts must replay in exact append order",
    );

    ledger.close();
    await closeSessionStorage(s.repo);
    s.epochStore.close();
  } finally {
    // OS tmpdir 管理。
  }
});

test("f2-xrepo: tampered persisted receipt is quarantined, never emitted, never acked (iris_agent#50)", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-f2-tamper-"));
  try {
    const s = await setupSlice(dataRoot);
    const { harness } = createIrisHarness({
      session: s.session,
      instanceEpoch: s.epoch.ordinalWithinDate,
      models: s.models,
      model: s.model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation: {
        input: sampleAgentInput(),
        prepared: s.prepared,
        invocationId: "inv-f2-tamper",
      },
      now: s.now,
      providerProfileId: s.providerProfileId,
    });
    const ledger = attachLedger(
      harness,
      s.paths,
      s.epoch.runtimeSessionId,
      s.epoch.runtimeSessionId,
    );
    const metadata = await s.session.getMetadata();

    const message = userMessage("tamper target");
    const contentHash = await computeMessageContentHash(message);
    const { entryId } = await s.session.appendMessageWithCommitReceipt(message, (id) => ({
      sessionId: metadata.id,
      entryId: id,
      contentHash,
      committedAt: new Date().toISOString(),
    }));
    await expectPending(s, 1);

    // Tamper with the persisted row: flip the content hash in the SQLite
    // journal (as a corrupt or malicious write would).
    const repo = s.repo as unknown as {
      raw: () => {
        prepare: (sql: string) => {
          run: (...args: Array<string | number>) => { changes: number };
        };
      };
    };
    const db = (repo as unknown as { database: unknown }).database as
      | { prepare: (sql: string) => { run: (...a: Array<string | number>) => { changes: number } } }
      | undefined;
    if (db !== undefined) {
      db.prepare(
        "UPDATE session_commit_receipts SET content_hash = ? WHERE session_id = ? AND entry_id = ?",
      ).run("0".repeat(64), metadata.id, entryId);
    } else {
      // Fallback: reach the sqlite connection through the backend internals
      // is intentionally not part of the contract; the tamper is applied via
      // a direct DatabaseSync open of the same file instead.
      const { DatabaseSync } = await import("node:sqlite");
      const direct = new DatabaseSync(s.paths.sessionDb);
      direct
        .prepare(
          "UPDATE session_commit_receipts SET content_hash = ? WHERE session_id = ? AND entry_id = ?",
        )
        .run("0".repeat(64), metadata.id, entryId);
      direct.close();
    }

    // Recovery must NOT emit the tampered receipt, must NOT ack it, must
    // quarantine it with a typed reason, and must not block.
    assert.equal(await harness.recoverPendingCommitReceipts(), 0);
    const finalized = ledger
      .listBySession(s.epoch.runtimeSessionId)
      .filter((e) => e.type === "message_finalized");
    assert.equal(finalized.length, 0, "tampered receipt must never reach the ledger");
    assert.equal(
      (await s.session.readPendingCommitReceipts()).length,
      0,
      "quarantined rows leave pending",
    );
    const quarantined = await s.session.readQuarantinedCommitReceipts();
    assert.equal(quarantined.length, 1);
    assert.equal(quarantined[0]?.['entryId'], entryId);
    assert.match(quarantined[0]?.reason ?? "", /content_hash_mismatch/);

    ledger.close();
    await closeSessionStorage(s.repo);
    s.epochStore.close();
  } finally {
    // OS tmpdir 管理。
  }
});

test("f2-xrepo: the seam refuses to ingest an event whose payload contradicts its content hash (iris_agent#50)", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-f2-seam-"));
  try {
    const s = await setupSlice(dataRoot);
    const ledger = RuntimeEventLedger.open(s.paths.runtimeLedgerDb);

    // A fake harness-shaped emitter: the seam subscribes to it and must fail
    // closed when the emitted event's payload does not match its hash.
    let captured:
      | ((event: {
          type: string;
          entryId: string;
          role: string;
          contentHash: string;
          message: {
            role: string;
            content: Array<{ type: string; text: string }>;
            timestamp: number;
          };
          receipt: { entrySeq?: number };
        }) => void | Promise<void>)
      | undefined;
    const fakeHarness = {
      subscribe: (fn: typeof captured) => {
        captured = fn;
      },
    } as unknown as import("@earendil-works/pi-agent-core").AgentHarness;

    attachRuntimeEventSeam(fakeHarness, {
      ledger,
      runtimeSessionId: s.epoch.runtimeSessionId,
      piSessionId: s.epoch.runtimeSessionId,
    });
    assert.ok(captured, "seam must subscribe to the harness");

    const message = userMessage("seam payload");
    const goodHash = await computeMessageContentHash(message);
    await assert.rejects(async () => {
      await captured?.({
        type: "message_finalized",
        entryId: "e-seam",
        role: "user",
        contentHash: "f".repeat(64),
        message,
        receipt: { entrySeq: 1 },
      });
    }, /content hash mismatch/);
    // The inconsistent event never reached the ledger.
    assert.equal(
      ledger.listBySession(s.epoch.runtimeSessionId).filter((e) => e.type === "message_finalized")
        .length,
      0,
    );
    assert.notEqual(goodHash, "f".repeat(64), "test vector must actually be inconsistent");

    ledger.close();
    await closeSessionStorage(s.repo);
    s.epochStore.close();
  } finally {
    // OS tmpdir 管理。
  }
});

async function expectPending(slice: Awaited<ReturnType<typeof setupSlice>>, count: number) {
  const pending = await slice.session.readPendingCommitReceipts();
  assert.equal(
    pending.length,
    count,
    `expected ${count} pending commit receipt(s), got ${pending.length}`,
  );
}

test("f2-xrepo: mixed legacy+framed JSONL journal replays in physical commit order into the Agent ledger (iris_agent#60)", async () => {
  // The issue's exact file shape: a legacy pre-framing journal that was
  // upgraded — legacy marker at line 3 (order=lineNumber), framed frame at
  // line 4 with seq=1 (old sort key). The old code sorted the NEWER frame
  // BEFORE the older pending legacy receipt; the Agent ledger must instead
  // receive legacy-first, framed-second.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-f2-mixed-order-"));
  try {
    const fs = new NodeExecutionEnv({ cwd: dataRoot });
    const repo = new JsonlSessionRepository({ fs, sessionsRoot: dataRoot });

    // Build the legacy part by hand: header + bare entry + legacy marker.
    const header = JSON.stringify({
      type: "session",
      version: 3,
      id: "mixed-session-1",
      timestamp: "2026-08-01T00:00:00.000Z",
      cwd: dataRoot,
    });
    const legacyMessage = userMessage("legacy committed first");
    const legacyHash = await computeMessageContentHash(legacyMessage);
    const legacyEntry = JSON.stringify({
      id: "e-legacy-a",
      parentId: null,
      timestamp: "2026-08-01T00:00:01.000Z",
      type: "message",
      message: legacyMessage,
    });
    const legacyMarker = JSON.stringify({
      __piReceipt: true,
      receipt: {
        sessionId: "mixed-session-1",
        entryId: "e-legacy-a",
        contentHash: legacyHash,
        committedAt: "2026-08-01T00:00:02.000Z",
      },
    });
    const mixedPath = join(dataRoot, "mixed.jsonl");
    writeFileSync(mixedPath, `${header}\n${legacyEntry}\n${legacyMarker}\n`);

    // Append the first post-upgrade FRAMED pair through the real backend
    // (seq=1, exactly the upgrade scenario).
    const metadata = await loadJsonlSessionMetadata(fs, mixedPath);
    const storage = await repo.open(metadata);
    const framedMessage = userMessage("framed committed second");
    const framedHash = await computeMessageContentHash(framedMessage);
    const { entryId: framedEntryId } = await storage.appendMessageWithCommitReceipt(
      framedMessage,
      (id) => ({
        sessionId: metadata.id,
        entryId: id,
        contentHash: framedHash,
        committedAt: "2026-08-01T00:00:03.000Z",
      }),
    );

    // The pending set MUST be in physical commit order: legacy first.
    const pending = await storage.readPendingCommitReceipts();
    assert.deepEqual(
      pending.map((r) => (r as unknown as Record<string, unknown>)['entryId']),
      ["e-legacy-a", framedEntryId],
      "mixed journal must replay in physical commit order",
    );

    // Drive the REAL Agent harness + RuntimeEvent ledger over the same file,
    // with the REAL Context ingestion transaction wired to the seam (the
    // production wiring from vertical-slice: lineage binding → ContextIngest
    // → seam). Every replayed receipt must land as a persisted
    // ContextMessageUnit with a lineage-global monotonic contextSeq.
    const { models, model, providerProfileId } = await composeProvider("mock");
    const { harness } = createIrisHarness({
      session: storage as unknown as import("@earendil-works/pi-agent-core").Session,
      instanceEpoch: 1,
      models,
      model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation: {
        input: sampleAgentInput(),
        prepared: prepareContextSources(
          sampleAgentInput(),
          metadata.id,
          "invocation-mixed",
          defaultAgentConfig(),
          "2026-08-01T00:00:00.000Z",
        ),
        invocationId: "inv-f2-mixed-order",
      },
      now: "2026-08-01T00:00:00.000Z",
      providerProfileId,
    });
    const ledger = RuntimeEventLedger.open(join(dataRoot, "runtime-events.sqlite"));
    const context = openContextWithLineage(
      ledger,
      dataRoot,
      metadata.id,
      providerProfileId,
      "2026-08-01T00:00:00.000Z",
    );
    attachRuntimeEventSeam(harness, {
      ledger,
      runtimeSessionId: metadata.id,
      piSessionId: metadata.id,
      contextIngest: context.ingest,
    });

    const replayed = await harness.recoverPendingCommitReceipts();
    assert.equal(replayed, 2, "both receipts must replay (legacy + framed)");

    const finalized = ledger
      .listBySession(metadata.id)
      .filter((e) => e.type === "message_finalized");
    assert.deepEqual(
      finalized.map((e) => (e as unknown as Record<string, unknown>)['entryId']),
      ["e-legacy-a", framedEntryId],
      "Agent ledger must observe the exact physical commit order",
    );

    // REAL Context units, persisted in the same order with lineage-global
    // monotonic contextSeq — not a stub, not an entrySeq projection.
    const units = context.store.listUnits(metadata.id);
    assert.deepEqual(
      units.map((u) => (u as unknown as Record<string, unknown>)['entryId']),
      ["e-legacy-a", framedEntryId],
      "Context units must follow the exact physical commit order",
    );
    assert.deepEqual(
      units.map((u) => u.contextSeq),
      [1, 2],
      "contextSeq must be lineage-global and strictly monotonic",
    );
    // Unit identity binds to the canonical RuntimeEvent, not the Session.
    assert.deepEqual(
      units.map((u) => (u as unknown as Record<string, unknown>)['sourceEventId']),
      finalized.map((e) => e.eventId),
      "each Context unit must bind the exact canonical RuntimeEvent",
    );
    assert.equal(units[0]?.contentHash, legacyHash);
    assert.equal(units[1]?.contentHash, framedHash);

    // exactly-once: re-running the ingestion transaction adds nothing.
    context.ingest.ensureUnitsUpTo(metadata.id);
    assert.equal(context.store.listUnits(metadata.id).length, 2);

    // Restart: reopen the session + ledger + context.db from disk and repeat
    // recovery — acked receipts replay nothing and no contextSeq is
    // re-allocated (the persisted units are immutable).
    const metadata2 = await loadJsonlSessionMetadata(fs, mixedPath);
    const storage2 = await repo.open(metadata2);
    const { harness: harness2 } = createIrisHarness({
      session: storage2 as unknown as import("@earendil-works/pi-agent-core").Session,
      instanceEpoch: 1,
      models,
      model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation: {
        input: sampleAgentInput(),
        prepared: prepareContextSources(
          sampleAgentInput(),
          metadata2.id,
          "invocation-mixed-restart",
          defaultAgentConfig(),
          "2026-08-01T00:00:00.000Z",
        ),
        invocationId: "inv-f2-mixed-restart",
      },
      now: "2026-08-01T00:00:00.000Z",
      providerProfileId,
    });
    const ledger2 = RuntimeEventLedger.open(join(dataRoot, "runtime-events.sqlite"));
    const context2 = openContextWithLineage(
      ledger2,
      dataRoot,
      metadata2.id,
      providerProfileId,
      "2026-08-01T00:00:00.000Z",
    );
    attachRuntimeEventSeam(harness2, {
      ledger: ledger2,
      runtimeSessionId: metadata2.id,
      piSessionId: metadata2.id,
      contextIngest: context2.ingest,
    });
    assert.equal(await harness2.recoverPendingCommitReceipts(), 0, "restart must replay nothing");
    context2.ingest.ensureUnitsUpTo(metadata2.id);
    const unitsAfterRestart = context2.store.listUnits(metadata2.id);
    assert.deepEqual(
      unitsAfterRestart.map((u) => [(u as unknown as Record<string, unknown>)['entryId'], u.contextSeq]),
      [
        ["e-legacy-a", 1],
        [framedEntryId, 2],
      ],
      "restart must preserve unit identity and contextSeq exactly",
    );

    context.store.close();
    ledger.close();
    context2.store.close();
    ledger2.close();
    await closeSessionStorage(repo);
  } finally {
    // OS tmpdir 管理。
  }
});

test("f2-xrepo: acked+pending legacy, framed and torn-tail receipts recover into persisted Context units with global monotonic contextSeq (iris_agent#77)", async () => {
  // One mixed journal containing: an ACKED legacy pair (CJK + marker-looking
  // text), a PENDING legacy pair, a post-upgrade FRAMED pair (CJK +
  // marker-looking text) and a torn tail. Recovery must emit exactly the
  // pending legacy + framed receipts in physical commit order, never the
  // acked pair, never the torn line; every emitted event must produce one
  // persisted ContextMessageUnit with a lineage-global monotonic contextSeq.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-f2-ctx-matrix-"));
  try {
    const fs = new NodeExecutionEnv({ cwd: dataRoot });
    const repo = new JsonlSessionRepository({ fs, sessionsRoot: dataRoot });

    const header = JSON.stringify({
      type: "session",
      version: 3,
      id: "ctx-mixed-1",
      timestamp: "2026-08-01T00:00:00.000Z",
      cwd: dataRoot,
    });
    // ACKED legacy pair: CJK + marker-looking text, receipt acked before the
    // restart — it must NEVER re-emit.
    const ackedMessage = userMessage("旧消息正文：标记文本 __piReceipt 在正文里");
    const ackedHash = await computeMessageContentHash(ackedMessage);
    const ackedEntry = JSON.stringify({
      id: "e-acked-a",
      parentId: null,
      timestamp: "2026-08-01T00:00:01.000Z",
      type: "message",
      message: ackedMessage,
    });
    const ackedMarker = JSON.stringify({
      __piReceipt: true,
      receipt: {
        sessionId: "ctx-mixed-1",
        entryId: "e-acked-a",
        contentHash: ackedHash,
        committedAt: "2026-08-01T00:00:01.500Z",
      },
    });
    const ackMarker = JSON.stringify({ __piReceiptAck: true, entryId: "e-acked-a" });
    // PENDING legacy pair.
    const pendingMessage = userMessage("pending legacy committed second");
    const pendingHash = await computeMessageContentHash(pendingMessage);
    const pendingEntry = JSON.stringify({
      id: "e-pending-b",
      parentId: null,
      timestamp: "2026-08-01T00:00:02.000Z",
      type: "message",
      message: pendingMessage,
    });
    const pendingMarker = JSON.stringify({
      __piReceipt: true,
      receipt: {
        sessionId: "ctx-mixed-1",
        entryId: "e-pending-b",
        contentHash: pendingHash,
        committedAt: "2026-08-01T00:00:03.000Z",
      },
    });
    const mixedPath = join(dataRoot, "mixed.jsonl");
    writeFileSync(
      mixedPath,
      `${header}\n${ackedEntry}\n${ackedMarker}\n${ackMarker}\n${pendingEntry}\n${pendingMarker}\n`,
    );

    // Post-upgrade FRAMED pair through the real backend (CJK + marker text).
    const metadata = await loadJsonlSessionMetadata(fs, mixedPath);
    const storage = await repo.open(metadata);
    const framedMessage = userMessage("新帧正文：你好，世界 __piReceiptQuarantine 混排测试");
    const framedHash = await computeMessageContentHash(framedMessage);
    const { entryId: framedEntryId } = await storage.appendMessageWithCommitReceipt(
      framedMessage,
      (id) => ({
        sessionId: metadata.id,
        entryId: id,
        contentHash: framedHash,
        committedAt: "2026-08-01T00:00:04.000Z",
      }),
    );

    // Torn tail: a truncated ack marker appended directly.
    await fs.appendFile(mixedPath, '{"__piReceiptAck": true, "entryId": "');
    const { session: reopened } = await openSessionFile(fs, repo, mixedPath);
    const diagnostics = await reopened.journalDiagnostics();
    assert.ok(
      diagnostics.some((d) => d.includes("torn_tail")),
      "the torn tail must be reported, not silently dropped",
    );
    assert.deepEqual(
      (await reopened.readPendingCommitReceipts()).map((r) => (r as unknown as Record<string, unknown>)['entryId']),
      ["e-pending-b", framedEntryId],
      "pending = pending legacy + framed, in physical commit order; acked and torn excluded",
    );

    // Recovery through the real harness + ledger + Context ingestion. The
    // harness runs on the FRESH handle that observed the torn tail.
    const { models, model, providerProfileId } = await composeProvider("mock");
    const { harness } = createIrisHarness({
      session: reopened as unknown as import("@earendil-works/pi-agent-core").Session,
      instanceEpoch: 1,
      models,
      model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation: {
        input: sampleAgentInput(),
        prepared: prepareContextSources(
          sampleAgentInput(),
          metadata.id,
          "invocation-matrix",
          defaultAgentConfig(),
          "2026-08-01T00:00:00.000Z",
        ),
        invocationId: "inv-f2-ctx-matrix",
      },
      now: "2026-08-01T00:00:00.000Z",
      providerProfileId,
    });
    const ledger = RuntimeEventLedger.open(join(dataRoot, "runtime-events.sqlite"));
    const context = openContextWithLineage(
      ledger,
      dataRoot,
      metadata.id,
      providerProfileId,
      "2026-08-01T00:00:00.000Z",
    );
    attachRuntimeEventSeam(harness, {
      ledger,
      runtimeSessionId: metadata.id,
      piSessionId: metadata.id,
      contextIngest: context.ingest,
    });

    assert.equal(await harness.recoverPendingCommitReceipts(), 2, "pending legacy + framed replay");
    const finalized = ledger
      .listBySession(metadata.id)
      .filter((e) => e.type === "message_finalized");
    assert.deepEqual(
      finalized.map((e) => (e as unknown as Record<string, unknown>)['entryId']),
      ["e-pending-b", framedEntryId],
      "RuntimeEvent identity/order = physical commit order",
    );
    // Real persisted Context units: one per emitted event, global monotonic
    // contextSeq in the same order, content lossless (CJK + marker-looking).
    const units = context.store.listUnits(metadata.id);
    assert.deepEqual(
      units.map((u) => [(u as unknown as Record<string, unknown>)['entryId'], u.contextSeq]),
      [
        ["e-pending-b", 1],
        [framedEntryId, 2],
      ],
      "one persisted Context unit per recovered receipt, monotonic contextSeq",
    );
    assert.equal(units[0]?.contentHash, pendingHash);
    assert.equal(units[1]?.contentHash, framedHash);
    assert.deepEqual(
      units.map((u) => (u as unknown as Record<string, unknown>)['sourceEventId']),
      finalized.map((e) => e.eventId),
      "unit identity binds the canonical RuntimeEvent",
    );
    // No unit may exist for the acked pair or the torn tail.
    assert.ok(
      !context.store.listUnits(metadata.id).some((u) => (u as unknown as Record<string, unknown>)['entryId'] === "e-acked-a"),
      "acked receipts must never produce Context units",
    );

    // Repeated recovery + full restart: nothing re-emits, no contextSeq is
    // re-allocated.
    assert.equal(await harness.recoverPendingCommitReceipts(), 0);
    context.ingest.ensureUnitsUpTo(metadata.id);
    assert.equal(context.store.listUnits(metadata.id).length, 2);

    const metadata2 = await loadJsonlSessionMetadata(fs, mixedPath);
    const storage2 = await repo.open(metadata2);
    const { harness: harness2 } = createIrisHarness({
      session: storage2 as unknown as import("@earendil-works/pi-agent-core").Session,
      instanceEpoch: 1,
      models,
      model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation: {
        input: sampleAgentInput(),
        prepared: prepareContextSources(
          sampleAgentInput(),
          metadata2.id,
          "invocation-matrix-restart",
          defaultAgentConfig(),
          "2026-08-01T00:00:00.000Z",
        ),
        invocationId: "inv-f2-ctx-matrix-restart",
      },
      now: "2026-08-01T00:00:00.000Z",
      providerProfileId,
    });
    const ledger2 = RuntimeEventLedger.open(join(dataRoot, "runtime-events.sqlite"));
    const context2 = openContextWithLineage(
      ledger2,
      dataRoot,
      metadata2.id,
      providerProfileId,
      "2026-08-01T00:00:00.000Z",
    );
    attachRuntimeEventSeam(harness2, {
      ledger: ledger2,
      runtimeSessionId: metadata2.id,
      piSessionId: metadata2.id,
      contextIngest: context2.ingest,
    });
    assert.equal(await harness2.recoverPendingCommitReceipts(), 0, "restart must replay nothing");
    context2.ingest.ensureUnitsUpTo(metadata2.id);
    assert.deepEqual(
      context2.store.listUnits(metadata2.id).map((u) => [(u as unknown as Record<string, unknown>)['entryId'], u.contextSeq]),
      [
        ["e-pending-b", 1],
        [framedEntryId, 2],
      ],
      "restart preserves persisted unit identity and contextSeq exactly",
    );

    context.store.close();
    ledger.close();
    context2.store.close();
    ledger2.close();
    await closeSessionStorage(repo);
  } finally {
    // OS tmpdir 管理。
  }
});

async function openSessionFile(
  fs: NodeExecutionEnv,
  repo: JsonlSessionRepository,
  sessionPath: string,
): Promise<{
  session: Awaited<ReturnType<JsonlSessionRepository["open"]>>;
  repo: JsonlSessionRepository;
}> {
  const metadata = await loadJsonlSessionMetadata(fs, sessionPath);
  const session = await repo.open(metadata);
  return { session, repo };
}
