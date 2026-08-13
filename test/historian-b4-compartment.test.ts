/**
 * R3-P2 移植说明：本测试从已验证的 `agent/r2-product-parity-fix-r3-historian`
 * 分支（commit 5b94db7）的 `test/historian-b4-compartment.test.ts` 移植。
 *
 * 适配点（R3-P1 变更）：
 *  - `freezeBoundary` 签名从扁平输入改为 `{ rawSeamInput, lineageBoundary? }`
 *    （R3-P1 ContextHistoryReadPort m0-clamp）。`buildFixture` 内改为包裹
 *    `rawSeamInput`，语义保持纯 raw（不传 lineageBoundary）；
 *  - 其余导入（buildCompartment / buildAnalysisView / SessionHistoryReadPort /
 *    HistorianStore）在 main 上均存在，无需改动。
 *
 * Feature B4 — Compartment, Segment, EvidenceSet & Attribution。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import type { SessionTreeEntry } from "@iris/pi-agent-core";

import { buildCompartment } from "../src/historian/historian-compartment.js";
import { buildAnalysisView } from "../src/historian/historian-analysis.js";
import { freezeBoundary } from "../src/historian/historian-boundary.js";
import { SessionHistoryReadPort } from "../src/historian/history-read-port.js";
import { HistorianStore } from "../src/historian/historian-store.js";

const SESSION = "iris-runtime-2026-08-01-1";

function u(id: string, parentId: string | null, text = "hello", ts = 1): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: { role: "user", content: text, timestamp: ts },
  } as unknown as SessionTreeEntry;
}

function c(id: string, parentId: string, ts = 2): SessionTreeEntry {
  return {
    type: "custom_message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    customType: "iris_input_meta",
    content: "<iris-input-meta/>",
    display: false,
  } as unknown as SessionTreeEntry;
}

function assistantWithToolCall(
  id: string,
  parentId: string,
  callId: string,
  ts = 3,
): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name: "read_file", arguments: { path: "a.txt" } }],
      api: "x",
      provider: "m",
      model: "v",
      timestamp: ts,
    },
  } as unknown as SessionTreeEntry;
}

function toolResult(
  id: string,
  parentId: string,
  callId: string,
  text = "file content: 42 lines",
  ts = 4,
): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "read_file",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: ts,
    },
  } as unknown as SessionTreeEntry;
}

async function buildFixture(entries: SessionTreeEntry[], tailMargin = 0) {
  const port = new SessionHistoryReadPort({ readRawEntries: async () => entries });
  const page = await port.readEntries({ runtimeSessionId: SESSION, limit: 100 });
  // R3-P1 适配：freezeBoundary 现接收 { rawSeamInput, lineageBoundary? }；
  // 不传 lineageBoundary = 纯 raw 语义（与 R3-P0 分支行为一致）。
  const freeze = freezeBoundary({
    rawSeamInput: {
      runtimeSessionId: SESSION,
      lineageId: "identity-stub",
      entries: page.entries,
      processedThroughEntrySeq: 0,
      tailMarginEntries: tailMargin,
      modelProviderProfile: "opencode/deepseek-v4-flash",
      frozenAt: "2026-08-01T00:00:00.000Z",
    },
  });
  const analysis = buildAnalysisView({
    runtimeSessionId: SESSION,
    boundary: freeze.snapshot,
    eligibleEntries: page.entries,
  });
  return { port, page, freeze, analysis };
}

test("B4: compartment content comes ONLY from verified projection units", async () => {
  const entries: SessionTreeEntry[] = [
    u("u-1", null, "please read the file and tell me"),
    c("c-1", "u-1"),
    assistantWithToolCall("a-1", "c-1", "call-1"),
    toolResult("tr-1", "a-1", "call-1"),
    u("u-2", "tr-1", "and summarize it"),
    c("c-2", "u-2"),
  ];
  const { freeze, analysis, page } = await buildFixture(entries);
  const commitThrough = freeze.snapshot.eligibleThroughEntrySeq;
  const built = buildCompartment({
    runtimeSessionId: SESSION,
    compartmentSequence: 1,
    boundary: freeze.snapshot,
    eligibleEntries: page.entries,
    analysis,
    commitThroughEntrySeq: commitThrough,
  });
  assert.ok(built, "compartment built");
  const compartment = built.compartment;
  assert.equal(compartment.runtimeSessionId, SESSION);
  assert.equal(compartment.compartmentSequence, 1);
  assert.ok(compartment.startEntrySeq >= 1);
  assert.ok(compartment.endEntrySeq <= commitThrough, "never crosses the frozen boundary");
  // Content carries the user's real words (semantics preserved).
  assert.ok(
    compartment.content.includes("please read the file"),
    "user semantics are in the compartment content",
  );
  // Source range hash is deterministic and endpoint-invariant.
  assert.equal(typeof compartment.sourceRangeHash, "string");
  assert.ok(compartment.sourceRangeHash.length === 64);
});

test("B4: EvidenceSet holds RAW entries — summaries never masquerade as evidence", async () => {
  const entries: SessionTreeEntry[] = [
    u("u-1", null, "please read the file and tell me"),
    c("c-1", "u-1"),
    assistantWithToolCall("a-1", "c-1", "call-1"),
    toolResult("tr-1", "a-1", "call-1", "file content: 42 lines"),
  ];
  const { freeze, analysis, page } = await buildFixture(entries);
  const built = buildCompartment({
    runtimeSessionId: SESSION,
    compartmentSequence: 1,
    boundary: freeze.snapshot,
    eligibleEntries: page.entries,
    analysis,
    commitThroughEntrySeq: freeze.snapshot.eligibleThroughEntrySeq,
  });
  assert.ok(built);
  // Evidence entries are RAW payloads — the tool result's exact text.
  const toolEvidence = built.evidence.entries.find((e) => e.role === "toolResult");
  assert.ok(toolEvidence, "toolResult evidence present");
  const toolPayload = toolEvidence?.payload as { message?: { content?: Array<{ text?: string }> } };
  assert.equal(toolPayload?.message?.content?.[0]?.text, "file content: 42 lines");
  // The compartment's p1 summary is DERIVED content, stored separately.
  assert.ok(built.compartment.p1.length > 0, "p1 summary derived");
  // Semantic content ≠ raw entry JSON: the compartment carries the rendered
  // semantics, the EvidenceSet carries the verbatim raw entries.
  const rawJson = built.evidence.entries.map((e) => JSON.stringify(e.payload)).join("\n");
  assert.notEqual(
    built.compartment.content,
    rawJson,
    "content is rendered semantics, not raw JSON",
  );
  assert.ok(
    !built.compartment.content.includes('"customType"'),
    "no internal custom-message metadata in the semantic content",
  );
});

test("B4: attribution keeps user / tool observation / Iris decision distinct", async () => {
  const entries: SessionTreeEntry[] = [
    u("u-1", null, "please read the file and tell me"),
    c("c-1", "u-1"),
    assistantWithToolCall("a-1", "c-1", "call-1"),
    toolResult("tr-1", "a-1", "call-1"),
  ];
  const { freeze, analysis, page } = await buildFixture(entries);
  const built = buildCompartment({
    runtimeSessionId: SESSION,
    compartmentSequence: 1,
    boundary: freeze.snapshot,
    eligibleEntries: page.entries,
    analysis,
    commitThroughEntrySeq: freeze.snapshot.eligibleThroughEntrySeq,
  });
  assert.ok(built);
  const roles = built.attributionManifest.attributions.map((a) => a.role).sort();
  assert.ok(roles.includes("user"), "user role attributed");
  assert.ok(roles.includes("iris_decision"), "assistant decision attributed");
  assert.ok(roles.includes("tool_observation"), "tool observation attributed");
  // The user attribution references the user entry id.
  const userAttribution = built.attributionManifest.attributions.find((a) => a.role === "user");
  assert.ok(userAttribution?.entryIds.includes("u-1"));
});

test("B4: segments are contiguous and scoped to the compartment", async () => {
  const entries: SessionTreeEntry[] = [
    u("u-1", null, "please read the file and tell me"),
    c("c-1", "u-1"),
    assistantWithToolCall("a-1", "c-1", "call-1"),
    toolResult("tr-1", "a-1", "call-1"),
  ];
  const { freeze, analysis, page } = await buildFixture(entries);
  const built = buildCompartment({
    runtimeSessionId: SESSION,
    compartmentSequence: 1,
    boundary: freeze.snapshot,
    eligibleEntries: page.entries,
    analysis,
    commitThroughEntrySeq: freeze.snapshot.eligibleThroughEntrySeq,
  });
  assert.ok(built);
  assert.ok(built.segments.length >= 1, "at least one segment");
  for (const segment of built.segments) {
    assert.equal(segment.compartmentId, built.compartment.compartmentId);
    assert.equal(segment.runtimeSessionId, SESSION);
    assert.ok(segment.startEntrySeq <= segment.endEntrySeq);
    assert.equal(segment.attributionManifestId, built.compartment.attributionManifestId);
  }
});

test("B4: store persists compartment + segments + evidence + manifest atomically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b4-store-"));
  const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  try {
    const entries: SessionTreeEntry[] = [
      u("u-1", null, "please read the file and tell me"),
      c("c-1", "u-1"),
      assistantWithToolCall("a-1", "c-1", "call-1"),
      toolResult("tr-1", "a-1", "call-1"),
      u("u-2", "tr-1", "and summarize it"),
      c("c-2", "u-2"),
    ];
    const { freeze, analysis, page } = await buildFixture(entries);
    const built = buildCompartment({
      runtimeSessionId: SESSION,
      compartmentSequence: 1,
      boundary: freeze.snapshot,
      eligibleEntries: page.entries,
      analysis,
      commitThroughEntrySeq: freeze.snapshot.eligibleThroughEntrySeq,
    });
    assert.ok(built);
    store.begin();
    store.insertCompartment(built.compartment);
    store.insertSegments(built.segments);
    store.insertEvidenceSet(built.evidence);
    store.insertAttributionManifest(built.attributionManifest);
    store.commit();

    const row = store
      .raw()
      .prepare(
        "SELECT compartment_id, p1, importance, episode_type FROM compartments WHERE compartment_id = ?",
      )
      .get(built.compartment.compartmentId) as
      { compartment_id: string; p1: string; importance: string; episode_type: string } | undefined;
    assert.ok(row, "compartment persisted");
    assert.equal(row.importance, built.compartment.importance);
    assert.equal(row.episode_type, built.compartment.episodeType);
    const segCount = store
      .raw()
      .prepare("SELECT COUNT(*) AS n FROM segments WHERE compartment_id = ?")
      .get(built.compartment.compartmentId) as { n: number };
    assert.equal(segCount.n, built.segments.length);
    const evidenceRow = store
      .raw()
      .prepare("SELECT entries_json FROM evidence_sets WHERE evidence_set_id = ?")
      .get(built.evidence.evidenceSetId) as { entries_json: string } | undefined;
    assert.ok(evidenceRow, "evidence persisted");
    const parsed = JSON.parse(evidenceRow.entries_json) as Array<{ entryId: string }>;
    assert.ok(
      parsed.some((e) => e.entryId === "tr-1"),
      "raw toolResult evidence persisted",
    );
    // Session-local sequence continuity.
    assert.equal(store.maxCompartmentSequence(SESSION), 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B4: compartment sequence is session-local and monotonic", async () => {
  const entries: SessionTreeEntry[] = [u("u-1", null), c("c-1", "u-1")];
  const { freeze, analysis, page } = await buildFixture(entries);
  // Simulate two sequential compartments.
  const built1 = buildCompartment({
    runtimeSessionId: SESSION,
    compartmentSequence: 1,
    boundary: freeze.snapshot,
    eligibleEntries: page.entries,
    analysis,
    commitThroughEntrySeq: 2,
  });
  const built2 = buildCompartment({
    runtimeSessionId: SESSION,
    compartmentSequence: 2,
    boundary: freeze.snapshot,
    eligibleEntries: page.entries,
    analysis,
    commitThroughEntrySeq: 2,
  });
  assert.ok(built1 && built2);
  assert.equal(built1.compartment.compartmentSequence, 1);
  assert.equal(built2.compartment.compartmentSequence, 2);
  assert.notEqual(built1.compartment.compartmentId, built2.compartment.compartmentId);
});

test("B4: empty range yields no compartment (null)", async () => {
  const { freeze, analysis, page } = await buildFixture([u("u-1", null), c("c-1", "u-1")]);
  const built = buildCompartment({
    runtimeSessionId: SESSION,
    compartmentSequence: 1,
    boundary: freeze.snapshot,
    eligibleEntries: page.entries,
    analysis,
    commitThroughEntrySeq: 0, // nothing eligible
  });
  assert.equal(built, null);
});

test("B4: a compartment never exceeds the frozen eligible boundary", async () => {
  const entries: SessionTreeEntry[] = [
    u("u-1", null, "hello"),
    c("c-1", "u-1"),
    assistantWithToolCall("a-1", "c-1", "call-1"),
    toolResult("tr-1", "a-1", "call-1"),
    u("u-2", "tr-1", "more"),
    c("c-2", "u-2"),
  ];
  const { freeze, analysis, page } = await buildFixture(entries);
  const built = buildCompartment({
    runtimeSessionId: SESSION,
    compartmentSequence: 1,
    boundary: freeze.snapshot,
    eligibleEntries: page.entries,
    // Pass a commitThrough FAR beyond the frozen boundary — the builder must
    // clamp to the frozen eligibleThroughEntrySeq (never widen).
    analysis,
    commitThroughEntrySeq: freeze.snapshot.eligibleThroughEntrySeq + 50,
  });
  assert.ok(built);
  assert.ok(built.compartment.endEntrySeq <= freeze.snapshot.eligibleThroughEntrySeq);
});
