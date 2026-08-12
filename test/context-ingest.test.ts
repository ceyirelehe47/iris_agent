import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { ContextIngest } from "../src/context/context-ingest.js";
import { ContextStore, LATEST_MIGRATION_VERSION } from "../src/context/context-store.js";
import type { PiSeamEvent } from "../src/contracts/runtime-events.js";
import {
  computeContentLayoutHash,
  createInputMetaCompanion,
  encodeInputFrames,
} from "../src/runtime/companion.js";
import { RuntimeEventLedger } from "../src/runtime/runtime-event-ledger.js";
import { sampleAgentInput } from "../src/runtime/vertical-slice.js";

/**
 * R2-P0 ContextMessageUnit ingest gate：
 * - contextSeq 每 session 单调、无空洞；
 * - 事件→单元映射（message_finalized→input/assistant/tool_result；生命周期事件→无单元）；
 * - companion 配对折叠（pairKey/paired；未验证 → UNVERIFIED 占位）；
 * - exactly-once（重复 ensureUnitsUpTo 不重复单元）；
 * - 重放自愈（事件已提交、部分单元缺失 → 下一次补齐）；
 * - migration：空库初始化 + 0001-0004 幂等 + newer-schema fence。
 */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "iris-context-ingest-"));
}

function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows 文件锁，忽略。
  }
}

import { rmSync } from "node:fs";

function sampleEvent(overrides: Partial<PiSeamEvent>): PiSeamEvent {
  return {
    type: "message_finalized",
    runtimeSessionId: "session-1",
    piSessionId: "session-1",
    entryId: "entry-1",
    role: "user",
    contentHash: "a".repeat(64),
    occurredAt: "2026-08-05T00:00:00.000Z",
    ...overrides,
  };
}

function userMessageWire(): string {
  return JSON.stringify({
    role: "user",
    content: encodeInputFrames(sampleAgentInput().blocks),
    timestamp: 1700000000000,
  });
}

/** 真实 companion（createInputMetaCompanion + 真实 layout hash → 验证通过）。 */
function realCompanionWire(): string {
  const input = sampleAgentInput();
  const wire = encodeInputFrames(input.blocks);
  const layoutHash = computeContentLayoutHash(input, wire);
  return JSON.stringify(createInputMetaCompanion(input, layoutHash, "2026-08-05T00:00:00.000Z", 1));
}

function stubCompanionWire(): string {
  return JSON.stringify({
    role: "custom",
    customType: "iris_input_meta",
    content: "<iris-input-meta/>",
    display: false,
    timestamp: 1,
  });
}

function setup(dir: string): {
  ledger: RuntimeEventLedger;
  store: ContextStore;
  ingest: ContextIngest;
} {
  const ledger = RuntimeEventLedger.open(join(dir, "runtime-ledger.db"));
  const store = ContextStore.open(join(dir, "context.db"), { lineageId: "identity-test" });
  // F4 (iris_agent#9 / 4.1): the production write path requires an explicit
  // lineage binding for the runtime session before any unit can be written;
  // fail-closed resolution throws for unknown sessions instead of falling
  // back to a default lineage.
  store.createLineage({
    lineageId: "identity-test",
    runtimeSessionId: "session-1",
    contextSourceSnapshotId: "src-session-1",
    epochId: "epoch-1",
    personaSnapshotId: "persona-1",
    declarationVersion: "v1",
    providerProfileId: "mock",
    canonicalSystemPrompt: "system",
    systemProjectionHash: "sys-hash",
    preparedAt: "2026-08-05T00:00:00.000Z",
    materializationId: "mat-1",
    contextSerializerVersion: "iris-context-golden-v1",
    carrierSchemaVersion: "1",
  });
  const ingest = new ContextIngest(ledger, store, store.lineageId);
  return { ledger, store, ingest };
}

test("r2: contextSeq is per-session monotonic and gap-free", () => {
  const dir = tempDir();
  try {
    const { ledger, store, ingest } = setup(dir);
    ledger.ingest(sampleEvent({ entryId: "e1", role: "user", payload: userMessageWire() }));
    ledger.ingest(
      sampleEvent({
        entryId: "e2",
        role: "assistant",
        payload: JSON.stringify({ role: "assistant", content: "hi", timestamp: 1 }),
      }),
    );
    ledger.ingest(sampleEvent({ entryId: "e3", role: "user", payload: userMessageWire() }));
    const units = ingest.ensureUnitsUpTo("session-1");
    assert.deepEqual(
      units.map((unit) => unit.contextSeq),
      [1, 2, 3],
    );
    assert.deepEqual(
      units.map((unit) => unit.kind),
      ["user", "assistant", "user"],
    );
    store.close();
    ledger.close();
  } finally {
    cleanupDir(dir);
  }
});

test("r2: lifecycle events never become units", () => {
  const dir = tempDir();
  try {
    const { ledger, store, ingest } = setup(dir);
    // F4: lifecycle-only session has its own lineage binding; no units are
    // ever written for it.
    store.createLineage({
      lineageId: "identity-s",
      runtimeSessionId: "s",
      contextSourceSnapshotId: "src-s",
      epochId: "epoch-s",
      personaSnapshotId: "persona-1",
      declarationVersion: "v1",
      providerProfileId: "mock",
      canonicalSystemPrompt: "system",
      systemProjectionHash: "sys-hash",
      preparedAt: "2026-08-05T00:00:00.000Z",
      materializationId: "mat-s",
      contextSerializerVersion: "iris-context-golden-v1",
      carrierSchemaVersion: "1",
    });
    ledger.ingest({
      type: "turn_committed",
      runtimeSessionId: "s",
      toolResultCount: 0,
      hadPendingMutations: false,
      occurredAt: "2026-08-05T00:00:00.000Z",
    });
    ledger.ingest({
      type: "agent_settled",
      runtimeSessionId: "s",
      occurredAt: "2026-08-05T00:00:00.001Z",
    });
    assert.deepEqual(ingest.ensureUnitsUpTo("s"), []);
    store.close();
    ledger.close();
  } finally {
    cleanupDir(dir);
  }
});

test("r2: companion pair is folded at ingest with pairKey and provenance text", () => {
  const dir = tempDir();
  try {
    const { ledger, store, ingest } = setup(dir);
    ledger.ingest(sampleEvent({ entryId: "user-1", role: "user", payload: userMessageWire() }));
    ledger.ingest(sampleEvent({ entryId: "comp-1", role: "custom", payload: realCompanionWire() }));
    const units = ingest.ensureUnitsUpTo("session-1");
    assert.equal(units.length, 1, "companion folds into the input unit, no separate unit");
    const input = units[0];
    assert.equal(input?.kind, "user");
    // 配对元数据（paired/pairKey/companionEntryId）是持久化层细节，
    // V1 DTO 不携带 → 经 store 的 UnitStoreRecord 读取物理列。
    const inputRecord = store.findBySourceEvent(input?.runtimeEventId ?? "");
    assert.equal(inputRecord?.persistenceMeta.paired, true);
    assert.ok(
      typeof inputRecord?.persistenceMeta.pairKey === "string" &&
        inputRecord.persistenceMeta.pairKey.length > 0,
      "pairKey must be present",
    );
    assert.equal(inputRecord?.persistenceMeta.companionEntryId, "comp-1");
    const content = (input?.semanticContent as { content?: unknown })?.content;
    assert.equal(typeof content, "string");
    assert.ok(String(content).includes("hello iris"));
    store.close();
    ledger.close();
  } finally {
    cleanupDir(dir);
  }
});

test("r2: unverified pair degrades to UNVERIFIED placeholder (fail-conservative)", () => {
  const dir = tempDir();
  try {
    const { ledger, store, ingest } = setup(dir);
    ledger.ingest(sampleEvent({ entryId: "user-1", role: "user", payload: userMessageWire() }));
    ledger.ingest(sampleEvent({ entryId: "comp-1", role: "custom", payload: stubCompanionWire() }));
    const units = ingest.ensureUnitsUpTo("session-1");
    assert.equal(
      store.findBySourceEvent(units[0]?.runtimeEventId ?? "")?.persistenceMeta.paired,
      false,
    );
    assert.equal(
      (units[0]?.semanticContent as { content?: unknown })?.content,
      "[USER REQUEST | UNVERIFIED]",
    );
    store.close();
    ledger.close();
  } finally {
    cleanupDir(dir);
  }
});

test("r2: ensureUnitsUpTo is idempotent (exactly-once per source event)", () => {
  const dir = tempDir();
  try {
    const { ledger, store, ingest } = setup(dir);
    ledger.ingest(sampleEvent({ entryId: "e1", role: "user", payload: userMessageWire() }));
    ledger.ingest(
      sampleEvent({
        entryId: "e2",
        role: "assistant",
        payload: JSON.stringify({ role: "assistant", content: "hi", timestamp: 1 }),
      }),
    );
    const first = ingest.ensureUnitsUpTo("session-1");
    const second = ingest.ensureUnitsUpTo("session-1");
    assert.equal(second.length, first.length);
    assert.deepEqual(
      second.map((unit) => unit.contextSeq),
      [1, 2],
    );
    store.close();
    ledger.close();
  } finally {
    cleanupDir(dir);
  }
});

test("r2: replay heals partial ingest (crash between event commit and unit creation)", () => {
  const dir = tempDir();
  try {
    const { ledger, store, ingest } = setup(dir);
    ledger.ingest(sampleEvent({ entryId: "e1", role: "user", payload: userMessageWire() }));
    ledger.ingest(
      sampleEvent({
        entryId: "e2",
        role: "assistant",
        payload: JSON.stringify({ role: "assistant", content: "hi", timestamp: 1 }),
      }),
    );
    // 模拟崩溃：只建第一个单元（事件都提交了）。
    const partial = ingest.ensureUnitsUpTo("session-1", { limit: 1 });
    assert.equal(partial.length, 1);
    // 下一次 ensureUnitsUpTo 补齐缺失单元（重放自愈）。
    const healed = ingest.ensureUnitsUpTo("session-1");
    assert.equal(healed.length, 2);
    assert.deepEqual(
      healed.map((unit) => unit.contextSeq),
      [1, 2],
    );
    store.close();
    ledger.close();
  } finally {
    cleanupDir(dir);
  }
});

test("r2: multi-input session never mis-pairs a replayed companion (reviewer B BLOCKING #1)", () => {
  const dir = tempDir();
  try {
    const { ledger, store, ingest } = setup(dir);
    // 模拟 seam 逐事件 ingest（每次 ingest 后全量 ensureUnitsUpTo）。
    // 事件流：user-1, comp-1, user-2, comp-2（多轮对话）。
    ledger.ingest(sampleEvent({ entryId: "user-1", role: "user", payload: userMessageWire() }));
    ingest.ensureUnitsUpTo("session-1");
    ledger.ingest(sampleEvent({ entryId: "comp-1", role: "custom", payload: realCompanionWire() }));
    ingest.ensureUnitsUpTo("session-1");
    ledger.ingest(sampleEvent({ entryId: "user-2", role: "user", payload: userMessageWire() }));
    ingest.ensureUnitsUpTo("session-1");
    ledger.ingest(sampleEvent({ entryId: "comp-2", role: "custom", payload: realCompanionWire() }));
    ingest.ensureUnitsUpTo("session-1");

    const units = ingest.listUnits("session-1");
    assert.equal(units.length, 2);
    const first = units[0];
    const second = units[1];
    // 配对元数据是持久化层细节（V1 DTO 不携带）→ 经 store 读取物理列。
    assert.equal(
      store.findBySourceEvent(first?.runtimeEventId ?? "")?.persistenceMeta.companionEntryId,
      "comp-1",
      "input-1 must pair with comp-1",
    );
    assert.equal(
      store.findBySourceEvent(second?.runtimeEventId ?? "")?.persistenceMeta.companionEntryId,
      "comp-2",
      "input-2 must pair with comp-2, never re-paired by comp-1",
    );
    assert.equal(
      store.findBySourceEvent(first?.runtimeEventId ?? "")?.persistenceMeta.paired,
      true,
    );
    assert.equal(
      store.findBySourceEvent(second?.runtimeEventId ?? "")?.persistenceMeta.paired,
      true,
    );
    store.close();
    ledger.close();
  } finally {
    cleanupDir(dir);
  }
});

test("r2: input unit payload never stores raw wire before pairing (placeholder)", () => {
  const dir = tempDir();
  try {
    const { ledger, store, ingest } = setup(dir);
    ledger.ingest(sampleEvent({ entryId: "user-1", role: "user", payload: userMessageWire() }));
    // 只 ingest user（companion 未到）：unit payload 必须是 UNVERIFIED 占位，
    // 绝不能是 IRIS_INPUT_V1 raw wire。
    const units = ingest.ensureUnitsUpTo("session-1");
    assert.equal(
      (units[0]?.semanticContent as { content?: unknown })?.content,
      "[USER REQUEST | UNVERIFIED]",
    );
    store.close();
    ledger.close();
  } finally {
    cleanupDir(dir);
  }
});

test("r2: empty context.db initializes cleanly; 0001-0007 applied and idempotent", () => {
  const dir = tempDir();
  try {
    const store = ContextStore.open(join(dir, "context.db"));
    // F4: unknown session on the read path fails closed too — no silent
    // default-lineage fallback. The migration gate checks the DB shape.
    store.createLineage({
      lineageId: "identity-test",
      runtimeSessionId: "session-1",
      contextSourceSnapshotId: "src",
      epochId: "epoch",
      personaSnapshotId: "persona",
      declarationVersion: "v1",
      providerProfileId: "mock",
      canonicalSystemPrompt: "s",
      systemProjectionHash: "h",
      preparedAt: "2026-08-05T00:00:00.000Z",
      materializationId: "m",
      contextSerializerVersion: "iris-context-golden-v1",
      carrierSchemaVersion: "1",
    });
    assert.deepEqual(store.listUnits("session-1"), []);
    store.close();
    const reopened = ContextStore.open(join(dir, "context.db"));
    reopened.close();
    assert.equal(LATEST_MIGRATION_VERSION, "0007_archive_staging");
  } finally {
    cleanupDir(dir);
  }
});
