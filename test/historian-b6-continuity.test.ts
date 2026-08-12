/**
 * R3-P4 移植说明：本文件从已通过审查的
 * `agent/r2-product-parity-fix-r3-historian` 分支（commit 5b94db7）的
 * `test/historian-b6-continuity.test.ts` 移植。
 *
 * 适配点：
 *  - `freezeBoundary` 签名由平铺参数改为 `{ rawSeamInput, lineageBoundary? }`
 *    （R3-P1 ContextHistoryReadPort m0-clamp），`freezeFor` 与 incomplete-drain
 *    用例改为传入 `rawSeamInput`，不传 lineageBoundary（纯 raw 语义，与 R3-P0
 *    一致）；
 *  - 其余导入（runWrapup / buildContinuitySnapshot / buildOverlapProjection /
 *    latestCompatibleSnapshot / buildAnalysisView / HistorianStore /
 *    SessionHistoryReadPort）在 main 上均已存在，签名一致。
 *
 * Feature B6 — ContinuitySnapshot、wrapup 与 previous-session overlap。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import type { SessionTreeEntry } from "@iris/pi-agent-core";

import { freezeBoundary } from "../src/historian/historian-boundary.js";
import {
  buildContinuitySnapshot,
  buildOverlapProjection,
  latestCompatibleSnapshot,
  runWrapup,
} from "../src/historian/historian-continuity.js";
import { buildAnalysisView } from "../src/historian/historian-analysis.js";
import { HistorianStore } from "../src/historian/historian-store.js";
import { SessionHistoryReadPort } from "../src/historian/history-read-port.js";

const OLD_SESSION = "iris-runtime-2026-08-01-1";
const NEW_SESSION = "iris-runtime-2026-08-02-1";

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

function assistantText(id: string, parentId: string, text: string, ts = 3): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "x",
      provider: "m",
      model: "v",
      timestamp: ts,
    },
  } as unknown as SessionTreeEntry;
}

function storeFixture(): { store: HistorianStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "iris-b6-"));
  return { store: HistorianStore.open({ databasePath: join(dir, "historian.db") }), dir };
}

async function freezeFor(
  session: string,
  entries: SessionTreeEntry[],
  processedThroughEntrySeq = 0,
) {
  const port = new SessionHistoryReadPort({ readRawEntries: async () => entries });
  const page = await port.readEntries({ runtimeSessionId: session, limit: 100 });
  // R3-P1 适配：freezeBoundary 拆分为 { rawSeamInput }（不传 lineageBoundary =
  // 纯 raw 语义，与 R3-P0 分支行为一致）。
  const freeze = freezeBoundary({
    rawSeamInput: {
      runtimeSessionId: session,
      lineageId: "identity-stub",
      entries: page.entries,
      processedThroughEntrySeq,
      tailMarginEntries: 0,
      modelProviderProfile: "opencode/deepseek-v4-flash",
      frozenAt: "2026-08-01T00:00:00.000Z",
    },
  });
  const analysis = buildAnalysisView({
    runtimeSessionId: session,
    boundary: freeze.snapshot,
    eligibleEntries: page.entries,
  });
  return { page, freeze, analysis };
}

test("B6: wrapup builds a ContinuitySnapshot with attributed fields and closes the session", async () => {
  const { store, dir } = storeFixture();
  try {
    const entries: SessionTreeEntry[] = [
      u("u-1", null, "please remember: I prefer short replies"),
      c("c-1", "u-1"),
      assistantText(
        "a-1",
        "c-1",
        "I commit to keeping replies short and will follow up on the open thread.",
      ),
    ];
    const { page, freeze, analysis } = await freezeFor(OLD_SESSION, entries);
    const state = {
      runtimeSessionId: OLD_SESSION,
      processedThroughEntrySeq: 0,
      status: "active" as const,
      updatedAt: "x",
    };
    const result = runWrapup({
      store,
      runtimeSessionId: OLD_SESSION,
      state,
      boundary: freeze.snapshot,
      eligibleEntries: page.entries,
      analysis,
    });
    assert.equal(result.status, "closed");
    const snapshot = result.snapshot;
    assert.ok(snapshot);
    assert.equal(snapshot.complete, true);
    assert.equal(snapshot.runtimeSessionId, OLD_SESSION);
    // User constraint preserved (not elevated to an unattributed fact).
    assert.ok(
      snapshot.activeUserConstraints.some((c) => c.includes("prefer short replies")),
      "user constraint preserved",
    );
    // Attribution attached (user/iris_decision roles distinct).
    const roles = snapshot.attribution.map((a) => a.role);
    assert.ok(roles.includes("user"));
    assert.ok(roles.includes("iris_decision"));
    // Persisted.
    const persisted = store.listContinuitySnapshots(OLD_SESSION);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]?.continuitySnapshotId, snapshot.continuitySnapshotId);
    // Session finalized.
    assert.equal(store.getSessionState(OLD_SESSION)?.status, "closed");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B6: incomplete drain marks closed_incomplete when a protected tail remains at freeze", async () => {
  const { store, dir } = storeFixture();
  try {
    // 6 entries with a tail margin of 2: the eligible seam stops before the
    // observed head → the drain is incomplete → closed_incomplete.
    const entries: SessionTreeEntry[] = [
      u("u-1", null, "hello"),
      c("c-1", "u-1"),
      assistantText("a-1", "c-1", "reply one"),
      u("u-2", "a-1", "more"),
      c("c-2", "u-2"),
      assistantText("a-2", "c-2", "reply two"),
    ];
    const port = new SessionHistoryReadPort({ readRawEntries: async () => entries });
    const page = await port.readEntries({ runtimeSessionId: OLD_SESSION, limit: 100 });
    // R3-P1 适配：freezeBoundary 拆分为 { rawSeamInput }。
    const freeze = freezeBoundary({
      rawSeamInput: {
        runtimeSessionId: OLD_SESSION,
        lineageId: "identity-stub",
        entries: page.entries,
        processedThroughEntrySeq: 0,
        tailMarginEntries: 2,
        modelProviderProfile: "m",
        frozenAt: "x",
      },
    });
    assert.ok(
      freeze.snapshot.eligibleThroughEntrySeq < freeze.snapshot.observedHeadEntrySeq,
      `incomplete setup: eligible ${freeze.snapshot.eligibleThroughEntrySeq} < head ${freeze.snapshot.observedHeadEntrySeq}`,
    );
    const analysis = buildAnalysisView({
      runtimeSessionId: OLD_SESSION,
      boundary: freeze.snapshot,
      eligibleEntries: page.entries,
    });
    const state = {
      runtimeSessionId: OLD_SESSION,
      processedThroughEntrySeq: 0,
      status: "active" as const,
      updatedAt: "x",
    };
    const result = runWrapup({
      store,
      runtimeSessionId: OLD_SESSION,
      state,
      boundary: freeze.snapshot,
      eligibleEntries: page.entries,
      analysis,
    });
    assert.equal(
      result.status,
      "closed_incomplete",
      "protected tail at freeze → closed_incomplete",
    );
    assert.equal(result.snapshot?.complete, false);
    assert.equal(store.getSessionState(OLD_SESSION)?.status, "closed_incomplete");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B6: previous-session overlap is BOUNDED and carries attribution (never new-Session messages)", async () => {
  const { store, dir } = storeFixture();
  try {
    const entries: SessionTreeEntry[] = [
      u("u-1", null, "please remember: I prefer short replies"),
      c("c-1", "u-1"),
      assistantText("a-1", "c-1", "I commit to keeping replies short."),
    ];
    const { page, freeze, analysis } = await freezeFor(OLD_SESSION, entries);
    const state = {
      runtimeSessionId: OLD_SESSION,
      processedThroughEntrySeq: 0,
      status: "active" as const,
      updatedAt: "x",
    };
    runWrapup({
      store,
      runtimeSessionId: OLD_SESSION,
      state,
      boundary: freeze.snapshot,
      eligibleEntries: page.entries,
      analysis,
    });

    const snapshot = latestCompatibleSnapshot(store, OLD_SESSION);
    assert.ok(snapshot);
    const overlap = buildOverlapProjection(snapshot, 4);
    assert.equal(overlap.bounded, true);
    assert.equal(overlap.runtimeSessionId, OLD_SESSION, "overlap comes ONLY from the old Session");
    assert.ok(
      overlap.activeUserConstraints.some((x) => x.includes("prefer short replies")),
      "user constraint carried into the overlap",
    );
    // The overlap NEVER contains new-Session messages (it is built solely
    // from the old snapshot; no NEW_SESSION content can appear).
    assert.ok(
      !overlap.currentSituation.includes("new-session"),
      "no new-Session content in the overlap",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B6: latestCompatibleSnapshot returns the newest snapshot for the fallback path", async () => {
  const { store, dir } = storeFixture();
  try {
    const entries: SessionTreeEntry[] = [u("u-1", null, "hello"), c("c-1", "u-1")];
    const { page, freeze, analysis } = await freezeFor(OLD_SESSION, entries);
    const state = {
      runtimeSessionId: OLD_SESSION,
      processedThroughEntrySeq: 0,
      status: "active" as const,
      updatedAt: "x",
    };
    runWrapup({
      store,
      runtimeSessionId: OLD_SESSION,
      state,
      boundary: freeze.snapshot,
      eligibleEntries: page.entries,
      analysis,
    });
    // A second (later) wrapup produces a newer snapshot.
    const state2 = {
      runtimeSessionId: OLD_SESSION,
      processedThroughEntrySeq: 2,
      status: "closing" as const,
      updatedAt: "x",
    };
    runWrapup({
      store,
      runtimeSessionId: OLD_SESSION,
      state: state2,
      boundary: freeze.snapshot,
      eligibleEntries: page.entries,
      analysis,
    });
    const latest = latestCompatibleSnapshot(store, OLD_SESSION);
    assert.equal(latest?.snapshotSequence, 2, "latest compatible snapshot is the newest");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B6: a fresh NEW Session has NO old-Session snapshot (fresh lineage; entries never spliced)", async () => {
  const { store, dir } = storeFixture();
  try {
    const oldEntries: SessionTreeEntry[] = [u("u-1", null, "old session text"), c("c-1", "u-1")];
    const { page, freeze, analysis } = await freezeFor(OLD_SESSION, oldEntries);
    const state = {
      runtimeSessionId: OLD_SESSION,
      processedThroughEntrySeq: 0,
      status: "active" as const,
      updatedAt: "x",
    };
    runWrapup({
      store,
      runtimeSessionId: OLD_SESSION,
      state,
      boundary: freeze.snapshot,
      eligibleEntries: page.entries,
      analysis,
    });

    // The NEW Runtime Session has no snapshot of its own.
    assert.equal(
      latestCompatibleSnapshot(store, NEW_SESSION),
      undefined,
      "new Session starts with a FRESH lineage (no old snapshot attached)",
    );
    // Old Session entries are never present in the new Session's store rows.
    const newSessionRows = store
      .raw()
      .prepare("SELECT COUNT(*) AS n FROM continuity_snapshots WHERE runtime_session_id = ?")
      .get(NEW_SESSION) as { n: number };
    assert.equal(newSessionRows.n, 0, "old entries never spliced into the new Session");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B6: snapshot preserves attribution — external statements are never unattributed facts", async () => {
  const { store, dir } = storeFixture();
  try {
    const entries: SessionTreeEntry[] = [
      u("u-1", null, "the sky is blue and my boss wants the report by Friday"),
      c("c-1", "u-1"),
    ];
    const { page, freeze, analysis } = await freezeFor(OLD_SESSION, entries);
    const snapshot = buildContinuitySnapshot({
      store,
      runtimeSessionId: OLD_SESSION,
      state: {
        runtimeSessionId: OLD_SESSION,
        processedThroughEntrySeq: 0,
        status: "active" as const,
        updatedAt: "x",
      },
      boundary: freeze.snapshot,
      eligibleEntries: page.entries,
      analysis,
    });
    // The user's statement is attributed to the user role — never promoted
    // to an unattributed fact.
    const userAttribution = snapshot.attribution.find((a) => a.role === "user");
    assert.ok(userAttribution, "user attribution attached");
    assert.ok(userAttribution?.entryIds.includes("u-1"));
    // currentSituation carries the user's real words (attributed).
    assert.ok(snapshot.currentSituation.includes("the sky is blue"));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
