import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { defaultAgentConfig } from "../src/config/load.js";
import { initializeDataRoot, resolveDataRootPaths } from "../src/host/data-root.js";
import { IrisHost } from "../src/host/host.js";
import { RuntimeEpochStore } from "../src/runtime/epoch-manager.js";
import { directUserRequest } from "../src/contracts/origin.js";
import type { AgentInput } from "../src/contracts/origin.js";
import { openOrCreateSession } from "../src/runtime/vertical-slice.js";
import {
  findInputPairsByProjection,
  type ProjectedInputPair,
} from "../src/runtime/context-adapter.js";
import { computeContentLayoutHash, createInputMetaCompanion } from "../src/runtime/companion.js";
import { projectSessionMessages } from "../src/runtime/session-projection.js";
import type { Session, SessionTreeEntry } from "@iris/pi-agent-core";

function makeInput(inputId: string, text = "hello iris"): AgentInput {
  return {
    inputId,
    triggerOrigin: directUserRequest(),
    blocks: [
      {
        blockId: `block-${inputId}`,
        sourceOrigin: directUserRequest(),
        content: { mode: "inline_text", text },
        contentHash: "",
      },
    ],
  };
}

function wireFor(text: string): string {
  return `IRIS_INPUT_V1\ninline_text:${Buffer.byteLength(text, "utf8")}\n${text}\n`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function openSessionFor(dataRoot: string, config: ReturnType<typeof defaultAgentConfig>) {
  const paths = resolveDataRootPaths(dataRoot, config);
  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const active = store.ensureActive("2026-08-01T12:00:00.000Z");
  store.close();
  return openOrCreateSession(dataRoot, config, active.runtimeSessionId);
}

/** Append a verified user+companion pair (real generator, Host instanceEpoch 1). */
async function appendVerifiedPair(
  session: Session,
  input: AgentInput,
): Promise<{ userEntryId: string; companionEntryId: string }> {
  const wire = wireFor(
    input.blocks[0]?.content.mode === "inline_text" ? input.blocks[0].content.text : "",
  );
  const layoutHash = computeContentLayoutHash(input, wire);
  const companion = createInputMetaCompanion(input, layoutHash, new Date().toISOString(), 1);
  const userEntryId = await session.appendMessage({
    role: "user",
    content: wire,
    timestamp: Date.now(),
  });
  const companionEntryId = await session.appendMessage(companion);
  return { userEntryId, companionEntryId };
}

async function acceptInput(
  dataRoot: string,
  config: ReturnType<typeof defaultAgentConfig>,
  input: AgentInput,
) {
  const paths = resolveDataRootPaths(dataRoot, config);
  const { InputAcceptanceLedger } = await import("../src/host/ingress.js");
  const ledger = new InputAcceptanceLedger(paths.ingressDb, paths.blobsIngress, 20, 1);
  ledger.accept(input, input.inputId);
  ledger.close();
}

async function closeSession(repo: { [Symbol.asyncDispose](): Promise<void> }): Promise<void> {
  await repo[Symbol.asyncDispose]();
}

test("issue-6 #1: model_change before the UserMessage — raw index preserved", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-issue6-mc-"));
  const config = defaultAgentConfig();
  initializeDataRoot(dataRoot, config);

  const handle = await openSessionFor(dataRoot, config);
  const session = handle.session;
  await session.appendModelChange("mock", "model-v1");
  const input = makeInput("mc-0001");
  const { userEntryId } = await appendVerifiedPair(session, input);
  await closeSession(handle.repo);

  await acceptInput(dataRoot, config, input);

  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  try {
    const record = host.getIngress().getRecord("mc-0001", 1);
    assert.equal(record?.state, "session_committed");
    // The REAL UserMessage raw entry id, never the model_change entry id.
    assert.equal(record.userEntryId, userEntryId);
  } finally {
    await host.shutdown();
  }
});

test("issue-6 #2: active_tools_change before the UserMessage — raw index preserved", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-issue6-atc-"));
  const config = defaultAgentConfig();
  initializeDataRoot(dataRoot, config);

  const handle = await openSessionFor(dataRoot, config);
  const session = handle.session;
  await session.appendActiveToolsChange(["read_only_test_tool"]);
  const input = makeInput("atc-0001");
  const { userEntryId } = await appendVerifiedPair(session, input);
  await closeSession(handle.repo);

  await acceptInput(dataRoot, config, input);

  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  try {
    const record = host.getIngress().getRecord("atc-0001", 1);
    assert.equal(record?.state, "session_committed");
    assert.equal(record.userEntryId, userEntryId);
  } finally {
    await host.shutdown();
  }
});

test("issue-6 #3: compaction before the UserMessage — raw index preserved", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-issue6-ct-"));
  const config = defaultAgentConfig();
  initializeDataRoot(dataRoot, config);

  const handle = await openSessionFor(dataRoot, config);
  const session = handle.session;
  await session.appendCompaction("summarized earlier", "compaction-marker", 0);
  const input = makeInput("ct-0001");
  const { userEntryId } = await appendVerifiedPair(session, input);
  await closeSession(handle.repo);

  await acceptInput(dataRoot, config, input);

  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  try {
    const record = host.getIngress().getRecord("ct-0001", 1);
    assert.equal(record?.state, "session_committed");
    assert.equal(record.userEntryId, userEntryId);
  } finally {
    await host.shutdown();
  }
});

test("issue-6 #4: companion persisted as a real Pi custom_message entry", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-issue6-cme-"));
  const config = defaultAgentConfig();
  initializeDataRoot(dataRoot, config);

  const handle = await openSessionFor(dataRoot, config);
  const session = handle.session;
  const input = makeInput("cme-0001");
  const wire = wireFor("hello iris");
  const layoutHash = computeContentLayoutHash(input, wire);
  const companion = createInputMetaCompanion(input, layoutHash, new Date().toISOString(), 1);
  // Persist via appendCustomMessageEntry → entry type is "custom_message".
  const userEntryId = await session.appendMessage({
    role: "user",
    content: wire,
    timestamp: Date.now(),
  });
  const companionEntryId = await session.appendCustomMessageEntry(
    companion.customType,
    companion.content,
    companion.display,
    companion.details,
  );
  await closeSession(handle.repo);

  // Sanity: the companion is a REAL custom_message raw entry.
  const paths = resolveDataRootPaths(dataRoot, config);
  const { SqliteSessionRepository, createNodeSqliteFactory } =
    await import("@iris/pi-storage-sqlite-node");
  const { nodeSqliteRepoEnv } = await import("../src/runtime/pi-env.js");
  const repo = new SqliteSessionRepository({
    env: nodeSqliteRepoEnv(dataRoot),
    sqlite: createNodeSqliteFactory(),
    databasePath: paths.sessionDb,
  });
  const list = await repo.list({ cwd: dataRoot });
  const metadataId = (await handle.session.getMetadata()).id;
  const metadata = list.find((candidate) => candidate.id === metadataId);
  assert.ok(metadata, "session metadata must exist");
  const reopened = await repo.open(metadata);
  const entries = await reopened.getEntries();
  const companionEntry = entries.find((entry) => entry.id === companionEntryId);
  assert.equal(companionEntry?.type, "custom_message");
  await closeSession(repo);

  await acceptInput(dataRoot, config, input);

  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  try {
    const record = host.getIngress().getRecord("cme-0001", 1);
    assert.equal(
      record?.state,
      "session_committed",
      "custom_message companion must be a first-class raw entry for pairing",
    );
    assert.equal(record.userEntryId, userEntryId);
  } finally {
    await host.shutdown();
  }
});

test("issue-6 #5: non-message entry between UserMessage and companion breaks raw adjacency → fail closed", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-issue6-sep-"));
  const config = defaultAgentConfig();
  initializeDataRoot(dataRoot, config);

  const handle = await openSessionFor(dataRoot, config);
  const session = handle.session;
  const input = makeInput("sep-0001");
  const wire = wireFor("hello iris");
  const layoutHash = computeContentLayoutHash(input, wire);
  const companion = createInputMetaCompanion(input, layoutHash, new Date().toISOString(), 1);
  const userEntryId = await session.appendMessage({
    role: "user",
    content: wire,
    timestamp: Date.now(),
  });
  // A label entry inserted between the UserMessage and the companion: the
  // companion now hangs off the LABEL (Pi leaf semantics), not the
  // UserMessage — raw adjacency is broken AND the parent chain is broken.
  await session.appendLabel(userEntryId, "interleaved");
  await session.appendMessage(companion);
  await closeSession(handle.repo);

  await acceptInput(dataRoot, config, input);

  // The pair is NOT verifiable (separated + broken parent chain) → the
  // orphan wire match makes recovery ambiguous → startup fails closed.
  await assert.rejects(
    IrisHost.open({ dataRoot, config, provider: "mock" }),
    /ambiguous ingress recovery for inputs: sep-0001/,
  );
  const paths = resolveDataRootPaths(dataRoot, config);
  const { DatabaseSync } = await import("node:sqlite");
  const repairDb = new DatabaseSync(paths.ingressDb);
  repairDb.prepare("DELETE FROM ingress_acceptances WHERE input_id = 'sep-0001'").run();
  repairDb.close();
  const second = await IrisHost.open({ dataRoot, config, provider: "mock" });
  await second.shutdown();
});

test("issue-6 #6: parent chain inconsistent — companion hangs off a different message", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-issue6-pc-"));
  const config = defaultAgentConfig();
  initializeDataRoot(dataRoot, config);

  const handle = await openSessionFor(dataRoot, config);
  const session = handle.session;
  const inputA = makeInput("pc-a-0001", "body A");
  const inputB = makeInput("pc-b-0001", "body B");
  // Pair A (verified, own parent chain).
  await appendVerifiedPair(session, inputA);
  // Pair B where the companion claims inputId B but is hung off message A's
  // companion entry via an interleaved foreign message — simulate by appending
  // B's user, then a DIFFERENT message, then B's companion (parent chain
  // points at the foreign message, not B's user).
  const wireB = wireFor("body B");
  const layoutHashB = computeContentLayoutHash(inputB, wireB);
  const companionB = createInputMetaCompanion(inputB, layoutHashB, new Date().toISOString(), 1);
  const userBEntryId = await session.appendMessage({
    role: "user",
    content: wireB,
    timestamp: Date.now(),
  });
  await session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "intermediate" }],
    api: "anthropic-messages",
    provider: "mock",
    model: "model-v1",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      totalTokens: 0,
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  await session.appendMessage(companionB);
  await closeSession(handle.repo);

  await acceptInput(dataRoot, config, inputA);
  await acceptInput(dataRoot, config, inputB);

  // B's companion is separated from B's user by an assistant message → the
  // parent chain is inconsistent (companion.parentId = assistant entry, not
  // user B's entry) → NOT a verified pair → B's orphan wire match makes the
  // startup ambiguous → fail closed into not-ready rather than falsely
  // committing B (or re-prompting it).
  await assert.rejects(
    IrisHost.open({ dataRoot, config, provider: "mock" }),
    /ambiguous ingress recovery for inputs: pc-b-0001/,
  );
  const paths = resolveDataRootPaths(dataRoot, config);
  const { DatabaseSync } = await import("node:sqlite");
  const repairDb = new DatabaseSync(paths.ingressDb);
  repairDb.prepare("DELETE FROM ingress_acceptances WHERE input_id = 'pc-b-0001'").run();
  repairDb.close();
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  try {
    // A is a clean verified pair → committed.
    const recA = host.getIngress().getRecord("pc-a-0001", 1);
    assert.equal(recA?.state, "session_committed");
    assert.ok(userBEntryId.length > 0);
  } finally {
    await host.shutdown();
  }
});

test("issue-6 #7: identical body for two inputs — each pair keeps its own raw identity", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-issue6-samebody-"));
  const config = defaultAgentConfig();
  initializeDataRoot(dataRoot, config);

  const handle = await openSessionFor(dataRoot, config);
  const session = handle.session;
  const a = makeInput("sb-a-0001", "same body");
  const b = makeInput("sb-b-0001", "same body");
  const pairA = await appendVerifiedPair(session, a);
  const pairB = await appendVerifiedPair(session, b);
  await closeSession(handle.repo);

  await acceptInput(dataRoot, config, a);
  await acceptInput(dataRoot, config, b);

  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  try {
    const recA = host.getIngress().getRecord("sb-a-0001", 1);
    const recB = host.getIngress().getRecord("sb-b-0001", 1);
    assert.equal(recA?.state, "session_committed");
    assert.equal(recB?.state, "session_committed");
    assert.equal(recA.userEntryId, pairA.userEntryId);
    assert.equal(recB.userEntryId, pairB.userEntryId);
    assert.notEqual(pairA.userEntryId, pairB.userEntryId, "distinct raw entries");
  } finally {
    await host.shutdown();
  }
});

test("issue-6 #8: duplicate pair for the same inputId fails closed (ambiguous)", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-issue6-dup-"));
  const config = defaultAgentConfig();
  initializeDataRoot(dataRoot, config);

  const handle = await openSessionFor(dataRoot, config);
  const session = handle.session;
  const input = makeInput("dup-0001");
  // The SAME logical input appended twice (local corruption / duplicate
  // delivery): two user+companion pairs with the same (inputId, pairKey).
  await appendVerifiedPair(session, input);
  await appendVerifiedPair(session, input);
  await closeSession(handle.repo);

  await acceptInput(dataRoot, config, input);

  await assert.rejects(
    IrisHost.open({ dataRoot, config, provider: "mock" }),
    /ambiguous ingress recovery for inputs: dup-0001/,
  );
  const paths = resolveDataRootPaths(dataRoot, config);
  const { DatabaseSync } = await import("node:sqlite");
  const repairDb = new DatabaseSync(paths.ingressDb);
  repairDb.prepare("DELETE FROM ingress_acceptances WHERE input_id = 'dup-0001'").run();
  repairDb.close();
  const second = await IrisHost.open({ dataRoot, config, provider: "mock" });
  await second.shutdown();
});

test("issue-6 #9: pi_user_entry_id equals the REAL raw UserMessage entry id (never a non-message entry)", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-issue6-exact-"));
  const config = defaultAgentConfig();
  initializeDataRoot(dataRoot, config);

  const handle = await openSessionFor(dataRoot, config);
  const session = handle.session;
  // Prepend several non-message entries to make the raw array diverge from
  // the compressed message array (the old bug bound to a WRONG raw entry).
  const modelChangeId = await session.appendModelChange("mock", "model-v1");
  await session.appendActiveToolsChange(["read_only_test_tool"]);
  const input = makeInput("exact-0001");
  const { userEntryId, companionEntryId } = await appendVerifiedPair(session, input);
  await closeSession(handle.repo);

  // Prove the raw entry itself is a "message" type carrying the user role.
  const paths = resolveDataRootPaths(dataRoot, config);
  const { SqliteSessionRepository, createNodeSqliteFactory } =
    await import("@iris/pi-storage-sqlite-node");
  const { nodeSqliteRepoEnv } = await import("../src/runtime/pi-env.js");
  const repo = new SqliteSessionRepository({
    env: nodeSqliteRepoEnv(dataRoot),
    sqlite: createNodeSqliteFactory(),
    databasePath: paths.sessionDb,
  });
  const list = await repo.list({ cwd: dataRoot });
  const metadataId = (await handle.session.getMetadata()).id;
  const metadata = list.find((candidate) => candidate.id === metadataId);
  assert.ok(metadata);
  const reopened = await repo.open(metadata);
  const entries = await reopened.getEntries();
  await closeSession(repo);
  const rawUser = entries.find((entry) => entry.id === userEntryId);
  assert.equal(rawUser?.type, "message", "pi_user_entry_id must name a real message entry");
  const rawMessage = (rawUser as SessionTreeEntry & { message?: { role?: string } }).message;
  assert.equal(rawMessage?.role, "user", "pi_user_entry_id must name the USER message entry");

  await acceptInput(dataRoot, config, input);

  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  try {
    const record = host.getIngress().getRecord("exact-0001", 1);
    assert.equal(record?.state, "session_committed");
    assert.equal(
      record.userEntryId,
      userEntryId,
      "pi_user_entry_id must equal the real raw UserMessage entry id",
    );
    assert.notEqual(record.userEntryId, modelChangeId, "must never bind to a model_change entry");
    assert.notEqual(record.userEntryId, companionEntryId);
  } finally {
    await host.shutdown();
  }
});

test("issue-6 #10/#11: restart promotes to session_committed and never re-prompts", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-issue6-restart-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);

  // First run: fully settle the input (creates the Pi pair).
  const first = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const pump1 = first.run();
  const events1: string[] = [];
  const unsub1 = first.onEvent((e) => events1.push(e.type));
  first.acceptInput(makeInput("rs-0001"), "rs-0001");
  await waitFor(() => events1.includes("settled"));
  const record = first.getIngress().getRecord("rs-0001", 1);
  assert.equal(record?.state, "session_committed");
  const committedUserEntryId = record.userEntryId;
  unsub1();
  await first.shutdown();
  await pump1;

  // Simulate the crash-before-settled window: rewind to `accepted`.
  const { InputAcceptanceLedger } = await import("../src/host/ingress.js");
  const ledger = new InputAcceptanceLedger(paths.ingressDb, paths.blobsIngress, 20, 1);
  ledger.rewindToAccepted("rs-0001", 1);
  ledger.close();

  // Restart with a fresh Epoch store instance — the projection must bind the
  // pair to the SAME real UserMessage entry id.
  const restarted = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const events2: string[] = [];
  const unsub2 = restarted.onEvent((e) => events2.push(e.type));
  const pump2 = restarted.run();
  await new Promise((resolve) => setTimeout(resolve, 800));
  const after = restarted.getIngress().getRecord("rs-0001", 1);
  assert.equal(after?.state, "session_committed", "restart must promote the full pair");
  assert.equal(after.userEntryId, committedUserEntryId, "raw identity stable across restart");
  assert.equal(events2.includes("turn_start"), false, "never re-prompted");
  unsub2();
  await restarted.shutdown();
  await pump2;
});

test("issue-6 #12: corrupt ordering (companion before user) fails closed → startup not-ready", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-issue6-corr-"));
  const config = defaultAgentConfig();
  initializeDataRoot(dataRoot, config);

  const handle = await openSessionFor(dataRoot, config);
  const session = handle.session;
  const input = makeInput("corr-0001");
  const wire = wireFor("hello iris");
  const layoutHash = computeContentLayoutHash(input, wire);
  const companion = createInputMetaCompanion(input, layoutHash, new Date().toISOString(), 1);
  // Corrupt ordering: companion appended BEFORE the UserMessage.
  await session.appendMessage(companion);
  await session.appendMessage({ role: "user", content: wire, timestamp: Date.now() });
  await closeSession(handle.repo);

  await acceptInput(dataRoot, config, input);

  await assert.rejects(
    IrisHost.open({ dataRoot, config, provider: "mock" }),
    /ambiguous ingress recovery for inputs: corr-0001/,
  );
  const paths = resolveDataRootPaths(dataRoot, config);
  const { DatabaseSync } = await import("node:sqlite");
  const repairDb = new DatabaseSync(paths.ingressDb);
  repairDb.prepare("DELETE FROM ingress_acceptances WHERE input_id = 'corr-0001'").run();
  repairDb.close();
  const second = await IrisHost.open({ dataRoot, config, provider: "mock" });
  await second.shutdown();
});

test("issue-6: findInputPairsByProjection raw linkage classification", async () => {
  // Unit-level proof of the raw-adjacency vs parent-chain decision rule.
  const entries: SessionTreeEntry[] = [
    {
      type: "model_change",
      id: "e1",
      parentId: null,
      timestamp: "2026-08-01T00:00:00.000Z",
      provider: "mock",
      modelId: "model-v1",
    },
    {
      type: "message",
      id: "user-1",
      parentId: "e1",
      timestamp: "2026-08-01T00:00:01.000Z",
      message: { role: "user", content: wireFor("hello"), timestamp: 1 },
    },
    {
      type: "label",
      id: "lbl-1",
      parentId: "user-1",
      timestamp: "2026-08-01T00:00:02.000Z",
      targetId: "user-1",
      label: undefined,
    },
    {
      type: "custom_message",
      id: "companion-1",
      // Broken parent: the label sits between and the companion hangs off the
      // label, NOT the UserMessage → parent chain inconsistent.
      parentId: "lbl-1",
      timestamp: "2026-08-01T00:00:03.000Z",
      customType: "iris_input_meta",
      content: "<iris-input-meta/>",
      display: false,
      details: { iris: { pairKey: "k" } },
    },
  ];
  const projected = projectSessionMessages(entries);
  assert.equal(projected.length, 2, "model_change and label are filtered out");
  assert.equal(projected[0]?.entryId, "user-1");
  assert.equal(projected[0]?.rawIndex, 1, "raw index preserved, not compressed");
  assert.equal(projected[1]?.entryId, "companion-1");
  assert.equal(projected[1]?.rawIndex, 3);
  const pairs: ProjectedInputPair[] = findInputPairsByProjection(projected);
  assert.equal(pairs.length, 0, "separated + broken parent chain must NOT pair");
});

test("issue-6: parent_chain linkage accepted when companion hangs directly off the UserMessage", async () => {
  const entries: SessionTreeEntry[] = [
    {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-08-01T00:00:01.000Z",
      message: { role: "user", content: wireFor("hello"), timestamp: 1 },
    },
    {
      type: "session_info",
      id: "info-1",
      parentId: "user-1",
      timestamp: "2026-08-01T00:00:02.000Z",
      name: "iris-session",
    },
    {
      type: "custom_message",
      id: "companion-1",
      parentId: "user-1", // authoritative Pi parent linkage → valid
      timestamp: "2026-08-01T00:00:03.000Z",
      customType: "iris_input_meta",
      content: "<iris-input-meta/>",
      display: false,
      details: { iris: { pairKey: "k" } },
    },
  ];
  const pairs = findInputPairsByProjection(projectSessionMessages(entries));
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]?.linkage, "parent_chain");
  assert.equal(pairs[0]?.user.entryId, "user-1");
});

test("issue-6 settle path: resolveCommittedPair binds pi_user_entry_id to the REAL raw UserMessage entry id even with a non-message entry before the pair", async () => {
  // The settle path (host.ts:468 resolveCommittedPair) is the SECOND writer
  // of pi_user_entry_id. It must honor the same raw-identity invariant as
  // reconcileUncommitted: a model_change (or any non-message entry) BEFORE
  // the UserMessage must never shift the entry id binding.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-issue6-settle-"));
  const config = defaultAgentConfig();
  initializeDataRoot(dataRoot, config);

  // Pre-create the active Epoch + Session and append a model_change entry so
  // the raw array is [model_change, user, companion] when the settle path runs.
  const handle = await openSessionFor(dataRoot, config);
  const session = handle.session;
  await session.appendModelChange("mock", "model-v1");
  await closeSession(handle.repo);

  // Open the Host over the SAME data root (active Epoch + Session exist).
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const events: string[] = [];
  const unsub = host.onEvent((e) => events.push(e.type));
  try {
    const pump = host.run();
    host.acceptInput(makeInput("settle-0001"), "settle-0001");
    await waitFor(() => events.includes("settled"));
    const record = host.getIngress().getRecord("settle-0001", 1);
    assert.equal(record?.state, "session_committed");

    // The recorded pi_user_entry_id must be the REAL UserMessage raw entry,
    // NOT the model_change entry that precedes it in the raw array.
    const paths = resolveDataRootPaths(dataRoot, config);
    const { SqliteSessionRepository, createNodeSqliteFactory } =
      await import("@iris/pi-storage-sqlite-node");
    const { nodeSqliteRepoEnv } = await import("../src/runtime/pi-env.js");
    const repo = new SqliteSessionRepository({
      env: nodeSqliteRepoEnv(dataRoot),
      sqlite: createNodeSqliteFactory(),
      databasePath: paths.sessionDb,
    });
    const list = await repo.list({ cwd: dataRoot });
    const runtimeSessionId = host.getCurrentEpoch().runtimeSessionId;
    const metadata = list.find((candidate) => candidate.id === runtimeSessionId);
    assert.ok(metadata);
    const reopened = await repo.open(metadata);
    const entries = await reopened.getEntries();
    await closeSession(repo);
    const modelChangeId = entries.find((entry) => entry.type === "model_change")?.id;
    const userEntry = entries.find(
      (entry) => entry.type === "message" && entry.message?.role === "user",
    );
    assert.ok(modelChangeId, "model_change entry must be present");
    assert.ok(userEntry, "real user message entry must be present");
    assert.notEqual(record.userEntryId, modelChangeId, "must never bind to model_change");
    assert.equal(record.userEntryId, userEntry.id, "settle path binds the REAL raw entry id");
    await host.shutdown();
    await pump;
  } finally {
    unsub();
    await host.shutdown().catch(() => undefined);
  }
});
