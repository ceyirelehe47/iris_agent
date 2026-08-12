import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import type { SessionTreeEntry } from "@iris/pi-agent-core";

import {
  applyContextPass,
  renderProviderVisible,
  runContextPass,
} from "../src/context/pipeline.js";
import { ContextStore } from "../src/context/context-store.js";
import { IRIS_INPUT_META_CUSTOM_TYPE } from "../src/contracts/context.js";

function userEntry(id: string, parentId: string | null, text: string, ts = 1): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: { role: "user", content: text, timestamp: ts },
  };
}

function customCompanion(id: string, parentId: string, inputId: string, ts = 2): SessionTreeEntry {
  return {
    type: "custom_message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    customType: IRIS_INPUT_META_CUSTOM_TYPE,
    content: "<iris-input-meta/>",
    display: false,
    details: { iris: { inputId, pairKey: `k-${inputId}` } },
  };
}

function assistantEntry(
  id: string,
  parentId: string | null,
  text: string,
  ts = 3,
): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
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
      timestamp: ts,
    },
  };
}

function storeFixture(): { store: ContextStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "iris-pipeline-"));
  const path = join(dir, "context.db");
  return { store: ContextStore.open(path, { lineageId: "identity-test" }), path };
}

function baseInput(entries: SessionTreeEntry[]) {
  return {
    runtimeSessionId: "iris-runtime-2026-08-01-1",
    entries,
    lineage: undefined,
    source: {
      contextSourceSnapshotId: "src-1",
      personaSnapshotId: "persona-1",
      declarationVersion: "v1",
      providerProfileId: "mock",
      canonicalSystemPrompt: "system prompt",
      systemProjectionHash: "sys-hash-1",
    },
    model: { provider: "opencode", modelId: "model-a" },
    usagePercentage: 30,
    contextLimit: 8_000,
    executeThresholdPercentage: 65,
  };
}

function seedLineage(store: ContextStore, runtimeSessionId = "iris-runtime-2026-08-01-1") {
  store.createLineage({
    lineageId: "identity-test",
    runtimeSessionId,
    contextSourceSnapshotId: "src-1",
    epochId: runtimeSessionId,
    personaSnapshotId: "persona-1",
    declarationVersion: "v1",
    providerProfileId: "mock",
    canonicalSystemPrompt: "system prompt",
    systemProjectionHash: "sys-hash-1",
    preparedAt: "2026-08-01T12:00:00.000Z",
    materializationId: "mat-1",
    contextSerializerVersion: "iris-context-golden-v1",
    carrierSchemaVersion: "1",
  });
}

test("pipeline: first pass on a fresh session is HARD (first_render) with m0 carriers", () => {
  const entries: SessionTreeEntry[] = [
    userEntry("u-1", null, "hello"),
    customCompanion("c-1", "u-1", "in-1"),
    assistantEntry("a-1", "c-1", "hi back"),
  ];
  const decision = runContextPass(baseInput(entries));
  assert.equal(decision.classification, "HARD");
  assert.equal(decision.failClosed, "none");
  assert.equal(decision.action.kind, "materialize_m0");
  assert.ok(decision.carriers, "HARD pass builds carriers");
  if (decision.carriers) {
    assert.equal(decision.carriers.m0ContentHash.length, 64, "m0 carrier hash is sha256");
  }
});

test("pipeline: identical second pass with same lineage is SOFT+ and reuses m0", () => {
  const { store, path } = storeFixture();
  try {
    seedLineage(store);
    store.materializeM0({
      runtimeSessionId: "iris-runtime-2026-08-01-1",
      m0Body: "<session-history>baseline</session-history>",
      m1Body:
        "<session-history-since>(no new content since last materialization)</session-history-since>",
      m0ContentHash: "h0",
      m1ContentHash: "h1",
      atMs: 1,
      cachedM0SystemHash: "sys-hash-1",
      cachedM0ModelKey: "opencode:model-a",
      cachedM0ProviderProfileId: "mock",
      representedThroughEntrySeq: 3,
      protectedTailStartEntrySeq: 1,
      lastSafeUserAnchorEntrySeq: 1,
    });
    const lineage = store.getLineage("iris-runtime-2026-08-01-1");
    const entries: SessionTreeEntry[] = [
      userEntry("u-1", null, "hello"),
      customCompanion("c-1", "u-1", "in-1"),
      assistantEntry("a-1", "c-1", "hi back"),
    ];
    const decision = runContextPass({
      ...baseInput(entries),
      lineage,
    });
    assert.equal(decision.classification, "SOFT+");
    assert.equal(decision.action.kind, "reuse");
    assert.equal(decision.carriers, undefined);
    assert.equal(decision.failClosed, "none");
  } finally {
    store.close();
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("pipeline: model change forces HARD (rebuild m0)", () => {
  const { store, path } = storeFixture();
  try {
    seedLineage(store);
    store.materializeM0({
      runtimeSessionId: "iris-runtime-2026-08-01-1",
      m0Body: "<session-history>baseline</session-history>",
      m1Body:
        "<session-history-since>(no new content since last materialization)</session-history-since>",
      m0ContentHash: "h0",
      m1ContentHash: "h1",
      atMs: 1,
      cachedM0SystemHash: "sys-hash-1",
      cachedM0ModelKey: "opencode:model-OLD",
      cachedM0ProviderProfileId: "mock",
      representedThroughEntrySeq: 0,
      protectedTailStartEntrySeq: 1,
      lastSafeUserAnchorEntrySeq: 1,
    });
    const lineage = store.getLineage("iris-runtime-2026-08-01-1");
    const entries: SessionTreeEntry[] = [
      userEntry("u-1", null, "hello"),
      customCompanion("c-1", "u-1", "in-1"),
      assistantEntry("a-1", "c-1", "hi"),
    ];
    const decision = runContextPass({
      ...baseInput(entries),
      lineage,
      model: { provider: "opencode", modelId: "model-NEW" },
    });
    assert.equal(decision.classification, "HARD");
    assert.equal(decision.action.kind, "materialize_m0");
    assert.equal(decision.failClosed, "none");
  } finally {
    store.close();
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("pipeline: applyContextPass persists a HARD materialization durably", () => {
  const { store, path } = storeFixture();
  try {
    seedLineage(store);
    const entries: SessionTreeEntry[] = [
      userEntry("u-1", null, "hello"),
      customCompanion("c-1", "u-1", "in-1"),
      assistantEntry("a-1", "c-1", "hi back"),
    ];
    const decision = runContextPass(baseInput(entries));
    applyContextPass(store, "iris-runtime-2026-08-01-1", decision, 1000);
    const lineage = store.getLineage("iris-runtime-2026-08-01-1");
    assert.ok(lineage);
    assert.ok(lineage.m0Body !== null, "m0 persisted");
    assert.ok(lineage.m0ContentHash !== null, "m0 content hash persisted");
    assert.equal(lineage.m0MaterializedAt, 1000);
    assert.ok(lineage.m1Body !== null);
    // Reopen: persisted.
    store.close();
    const reopened = ContextStore.open(path, { lineageId: "identity-test" });
    try {
      const reloaded = reopened.getLineage("iris-runtime-2026-08-01-1");
      assert.ok(reloaded);
      assert.ok(reloaded.m0Body !== null);
    } finally {
      reopened.close();
    }
  } finally {
    try {
      store.close();
    } catch {
      // already closed
    }
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("pipeline: renderProviderVisible emits carriers + live tail, never raw messages", () => {
  const { store, path } = storeFixture();
  try {
    seedLineage(store);
    const entries: SessionTreeEntry[] = [
      userEntry("u-1", null, "hello"),
      customCompanion("c-1", "u-1", "in-1"),
      assistantEntry("a-1", "c-1", "hi back"),
      userEntry("u-2", "a-1", "more", 5),
      customCompanion("c-2", "u-2", "in-2", 6),
      assistantEntry("a-2", "c-2", "done", 7),
    ];
    const decision = runContextPass(baseInput(entries));
    const visible = renderProviderVisible(decision, decision.projection);
    // Carriers are injected (m0/m1) when materializing.
    assert.ok(visible.messages.length >= 2);
    const carrierCount = visible.messages.filter(
      (m) => (m as { customType?: string }).customType === "iris_context_carrier",
    ).length;
    assert.ok(carrierCount >= 2, `expected m0/m1 carriers, got ${carrierCount}`);
    // No raw user/assistant message text leaks through as content.
    const leaked = visible.messages.some((m) => {
      const content = (m as { content?: unknown }).content;
      return (
        typeof content === "string" && (content.includes("hello") || content.includes("hi back"))
      );
    });
    assert.equal(leaked, false, "raw message passthrough must not exist (R2 exit gate)");
  } finally {
    store.close();
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("pipeline: defer pass never commits watermarks (SOFT+ → reuse, no nextWatermarks)", () => {
  // Two turns with a sealed arc below the protected tail. The lineage has
  // already represented everything → SOFT+. A defer pass must NOT advance the
  // replay watermarks (no detect results are committed on a defer pass).
  const { store, path } = storeFixture();
  try {
    seedLineage(store);
    store.materializeM0({
      runtimeSessionId: "iris-runtime-2026-08-01-1",
      m0Body: "<session-history>baseline</session-history>",
      m1Body:
        "<session-history-since>(no new content since last materialization)</session-history-since>",
      m0ContentHash: "h0",
      m1ContentHash: "h1",
      atMs: 1,
      cachedM0SystemHash: "sys-hash-1",
      cachedM0ModelKey: "opencode:model-a",
      cachedM0ProviderProfileId: "mock",
      representedThroughEntrySeq: 7,
      protectedTailStartEntrySeq: 5,
      lastSafeUserAnchorEntrySeq: 1,
    });
    const lineage = store.getLineage("iris-runtime-2026-08-01-1");
    const entries: SessionTreeEntry[] = [
      userEntry("u-1", null, "hello", 1),
      customCompanion("c-1", "u-1", "in-1", 2),
      {
        type: "message",
        id: "a-1",
        parentId: "c-1",
        timestamp: "2026-08-01T00:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "read_only_test_tool", arguments: {} }],
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
          stopReason: "toolUse",
          timestamp: 3,
        },
      },
      {
        type: "message",
        id: "tr-1",
        parentId: "a-1",
        timestamp: "2026-08-01T00:00:00.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read_only_test_tool",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 4,
        },
      },
      userEntry("u-2", "tr-1", "newest turn", 5),
      customCompanion("c-2", "u-2", "in-2", 6),
      assistantEntry("a-2", "c-2", "live answer", 7),
    ];
    const decision = runContextPass({
      ...baseInput(entries),
      lineage,
      // Per-unit token estimates push the suffix walk so the boundary lands
      // at the newest turn (seq 5) — the arc (ends 4) falls below the tail.
      unitTokenCounts: [2_000, 2_000, 2_000, 2_000, 2_000, 2_000],
    });
    assert.equal(decision.classification, "SOFT+", "represented fully → no live delta");
    assert.equal(decision.action.kind, "reuse");
    assert.equal(decision.failClosed, "none");
    // Detect is off on a defer pass → nothing to commit.
    assert.equal(decision.nextWatermarks, undefined, "SOFT+ must not advance watermarks");
    assert.equal(decision.replay.newlyReclaimedToolArcUnitIds.length, 0);
  } finally {
    store.close();
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("pipeline: end-to-end round trip — pass 2 on identical materialized state is SOFT+ (reviewer F1/F2)", () => {
  // The Host flow: pass 1 (HARD) materializes m0 and records the CURRENT
  // identity + representedThrough = projection.toEntrySeq. Pass 2 with the
  // SAME entries and the persisted lineage must resolve SOFT+ (byte-identical
  // replay) — the authority's isCacheBustingPass:false semantics. This test
  // would fail before the F1/F2 fix (cached identity lost → HARD; or
  // representedThrough = headEnd → SOFT forever).
  const { store, path } = storeFixture();
  try {
    seedLineage(store);
    const entries: SessionTreeEntry[] = [
      userEntry("u-1", null, "hello"),
      customCompanion("c-1", "u-1", "in-1"),
      assistantEntry("a-1", "c-1", "hi back"),
    ];

    // Pass 1: HARD first_render, materialize.
    const pass1 = runContextPass(baseInput(entries));
    assert.equal(pass1.classification, "HARD");
    applyContextPass(store, "iris-runtime-2026-08-01-1", pass1, 1000);

    // Pass 2: identical entries + persisted lineage.
    const lineage = store.getLineage("iris-runtime-2026-08-01-1");
    assert.ok(lineage);
    assert.equal(lineage.cachedM0ModelKey, "opencode:model-a", "current identity recorded (F1)");
    assert.equal(
      lineage.representedThroughEntrySeq,
      pass1.projection.toEntrySeq,
      "representedThrough covers the whole projection (F2)",
    );
    const pass2 = runContextPass({
      ...baseInput(entries),
      lineage,
    });
    assert.equal(pass2.classification, "SOFT+", "identical second pass must be SOFT+");
    assert.equal(pass2.action.kind, "reuse");

    // Pass 3: a model change on the same state → HARD again.
    const lineageAfterSoft = store.getLineage("iris-runtime-2026-08-01-1");
    assert.ok(lineageAfterSoft);
    const pass3 = runContextPass({
      ...baseInput(entries),
      lineage: lineageAfterSoft,
      model: { provider: "opencode", modelId: "model-NEW" },
    });
    assert.equal(pass3.classification, "HARD", "model change after SOFT+ still forces HARD");
  } finally {
    store.close();
    rmSync(dirname(path), { recursive: true, force: true });
  }
});
