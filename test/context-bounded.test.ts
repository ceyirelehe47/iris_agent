import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { ContextIngest } from "../src/context/context-ingest.js";
import { ContextRenderer } from "../src/context/context-renderer.js";
import {
  ContextBoundsExceededError,
  ContextStore,
  HARD_UNITS_CAP,
  MAX_UNITS_PER_SESSION,
} from "../src/context/context-store.js";
import {
  computeContextMessageUnitContentHashV1,
  type ContextMessageUnitV1,
} from "../src/contracts/context-v27.js";
import type { PiSeamEvent } from "../src/contracts/runtime-events.js";
import { RuntimeEventLedger } from "../src/runtime/runtime-event-ledger.js";
import { runMinimalSlice } from "../src/runtime/vertical-slice-demo.js";

/**
 * R2-P3：context_units 有界性 gate（Roadmap v13 "R2 有界 = context_units
 * append-only + 安全 cap fail-closed + disposition 标记（R3 裁剪）"）。
 *
 * 双级 cap 策略（详见 context-store.ts 常量注释）：
 *  - 软 cap（MAX_UNITS_PER_SESSION，可注入）：超限单元标记 disposition="exclude"
 *    照写不删（append-only），provider 视图经 listUnits 默认过滤不可见；
 *  - 硬 cap（= 2× 软 cap）：超限时 insertUnit 拒绝写入、记录 lineage 紧急态
 *    emergency_fail_closed 并抛 ContextBoundsExceededError → slice 大声失败。
 */

const SESSION = "iris-runtime-2026-08-05-1";

const HARD_SIGNALS_A = {
  modelKey: "mock-iris:mock-deepseek-v4-flash",
  systemHash: "sys-hash-1",
  providerProfileId: "mock",
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "iris-context-bounded-"));
}

function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows 文件锁，忽略。
  }
}

function makeLineageInput(runtimeSessionId: string = SESSION) {
  return {
    lineageId: "identity-test",
    runtimeSessionId,
    contextSourceSnapshotId: `src-${runtimeSessionId}`,
    epochId: runtimeSessionId,
    personaSnapshotId: "persona-default-v1",
    declarationVersion: "decl-v1",
    providerProfileId: "mock",
    canonicalSystemPrompt: "IRIS SYSTEM PROMPT V1",
    systemProjectionHash: "sys-hash-1",
    preparedAt: "2026-08-01T00:00:00.000Z",
    materializationId: "mat-1",
    contextSerializerVersion: "iris-context-units-v1",
    carrierSchemaVersion: "1",
  };
}

function makeUnit(
  runtimeSessionId: string,
  contextSeq: number,
  overrides: Partial<ContextMessageUnitV1> = {},
): ContextMessageUnitV1 {
  const unit: ContextMessageUnitV1 = {
    schemaId: "iris.context_message_unit.v1",
    contextLineageId: "identity-test",
    contextSeq,
    contextUnitId: `unit-${contextSeq}`,
    runtimeEventId: `event-${contextSeq}`,
    kind: "user",
    semanticSchemaId: "iris.semantic.context_message.user.v1",
    semanticContent: { role: "user", content: `body-${contextSeq}`, timestamp: 1 },
    historianDisposition: "include",
    contentHash: "",
    lifecycleState: "committed",
    createdAt: "2026-08-05T00:00:00.000Z",
    ...overrides,
  };
  // Feature A5 (#113): the store verifies content_hash on read against the
  // one versioned canonical basis — hand-built units must carry the real
  // canonical hash of their own durable semantic state.
  const contentHash =
    unit.contentHash !== ""
      ? unit.contentHash
      : computeContextMessageUnitContentHashV1({
          semanticSchemaId: unit.semanticSchemaId,
          kind: unit.kind,
          historianDisposition: unit.historianDisposition,
          derivationRefs: unit.derivationRefs ?? {
            schemaId: "iris.semantic_derivation_refs.v1",
            memoryRefs: [],
            compartmentIds: [],
            sourceContextMessageUnitIds: [],
          },
          semanticContent: unit.semanticContent,
        });
  return { ...unit, contentHash };
}

let eventOrdinal = 0;

function sampleEvent(overrides: Partial<PiSeamEvent>): PiSeamEvent {
  eventOrdinal += 1;
  return {
    type: "message_finalized",
    runtimeSessionId: SESSION,
    piSessionId: SESSION,
    entryId: `entry-${eventOrdinal}`,
    role: "assistant",
    contentHash: "a".repeat(64),
    occurredAt: "2026-08-05T00:00:00.000Z",
    ...overrides,
  };
}

function assistantWire(content: string): string {
  return JSON.stringify({ role: "assistant", content, timestamp: 1 });
}

test("r2-p3: soft cap marks over-cap units excluded without deleting rows (append-only)", () => {
  const dir = tempDir();
  const store = ContextStore.open(join(dir, "context.db"), { maxUnitsPerSession: 3 });
  try {
    store.createLineage(makeLineageInput());
    for (let seq = 1; seq <= 5; seq += 1) {
      store.insertUnit(makeUnit(SESSION, seq), { runtimeSessionId: SESSION });
    }
    // append-only：全部 5 行都在（disposition:"all" 读全部行）。
    const all = store.listUnits(SESSION, { disposition: "all" });
    assert.equal(all.length, 5);
    // 软 cap 语义：前 3 个 include，第 4-5 个被标记 exclude。
    assert.deepEqual(
      all.map((unit) => unit.historianDisposition),
      ["include", "include", "include", "exclude", "exclude"],
    );
    // provider 视图默认过滤：只返回 include。
    assert.deepEqual(
      store.listUnits(SESSION).map((unit) => unit.contextSeq),
      [1, 2, 3],
    );
    // SQL 层计数直接验证无 DELETE（append-only 不变量）。
    const count = store
      .raw()
      .prepare("SELECT COUNT(*) AS c FROM context_units WHERE context_lineage_id = ?")
      .get("identity-test") as { c: number };
    assert.equal(count.c, 5);
  } finally {
    store.close();
    cleanupDir(dir);
  }
});

test("r2-p3: renderer never renders excluded units; watermark advances past them", () => {
  const dir = tempDir();
  const store = ContextStore.open(join(dir, "context.db"), { maxUnitsPerSession: 3 });
  const renderer = new ContextRenderer(store);
  try {
    store.createLineage(makeLineageInput());
    for (let seq = 1; seq <= 5; seq += 1) {
      store.insertUnit(makeUnit(SESSION, seq), { runtimeSessionId: SESSION });
    }
    const allUnits = store.listUnits(SESSION, { disposition: "all" });
    assert.equal(allUnits.length, 5);

    // 直传包含 excluded 的原始数组：renderer 的防御性过滤（include-only）必须
    // 保证 excluded payload（body-4 / body-5）绝不进入 provider 数组 / m0 / m1。
    const pass = renderer.renderForProviderCall({
      runtimeSessionId: SESSION,
      units: allUnits,
      liveDelta: [],
      hardSignals: HARD_SIGNALS_A,
    });
    for (const message of pass.messages) {
      const text = JSON.stringify(message);
      assert.ok(!text.includes("body-4"), "excluded unit payload must never reach provider");
      assert.ok(!text.includes("body-5"), "excluded unit payload must never reach provider");
    }
    assert.ok(!pass.record.m0Body.includes("body-4"));
    assert.ok(!pass.record.m1Body.includes("body-4"));
    assert.ok(!pass.record.m1Body.includes("body-5"));
    renderer.persistRender(1_000);

    // model_change HARD 重建 m0：watermark 推进到可见最大 seq=3。
    const hardB = { ...HARD_SIGNALS_A, modelKey: "mock-iris:model-v2" };
    const rebuild = renderer.renderForProviderCall({
      runtimeSessionId: SESSION,
      units: allUnits,
      liveDelta: [],
      hardSignals: hardB,
    });
    assert.equal(rebuild.record.classification, "HARD");
    renderer.persistRender(2_000);
    assert.equal(store.getLineage(SESSION)?.representedThroughContextSeq, 3);

    // excluded（seq 4-5）位于 watermark 之外，但 store 级默认过滤使它们永不
    // 作为新单元重放（否则会泄漏进 p5Tail / m1 delta）。
    const next = renderer.renderForProviderCall({
      runtimeSessionId: SESSION,
      units: store.listUnits(SESSION),
      liveDelta: [],
      hardSignals: hardB,
    });
    for (const message of next.messages) {
      const text = JSON.stringify(message);
      assert.ok(!text.includes("body-4"), "excluded unit must never re-appear");
      assert.ok(!text.includes("body-5"), "excluded unit must never re-appear");
    }
    assert.equal(store.listUnits(SESSION).length, 3, "provider-visible units stay bounded");
  } finally {
    store.close();
    cleanupDir(dir);
  }
});

test("r2-p3: hard cap throws typed error and records emergency state (fail-closed)", () => {
  const dir = tempDir();
  const store = ContextStore.open(join(dir, "context.db"), { maxUnitsPerSession: 2 });
  try {
    store.createLineage(makeLineageInput());
    for (let seq = 1; seq <= 4; seq += 1) {
      store.insertUnit(makeUnit(SESSION, seq), { runtimeSessionId: SESSION });
    }
    // 硬 cap = 2×2 = 4：第 5 次写入被拒绝（typed 失败）。
    assert.throws(
      () => {
        store.insertUnit(makeUnit(SESSION, 5), { runtimeSessionId: SESSION });
      },
      (error: unknown) => error instanceof ContextBoundsExceededError,
    );
    // 紧急态 fail-closed：lineage 已标记（权威 owner 在抛错前记录）。
    const lineage = store.getLineage(SESSION);
    assert.equal(lineage?.emergencyState, "emergency_fail_closed");
    assert.match(lineage?.lastTransformError ?? "", /hard cap/);
    // append-only：被拒绝的行未写入（仍为 4 行）。
    assert.equal(store.listUnits(SESSION, { disposition: "all" }).length, 4);
  } finally {
    store.close();
    cleanupDir(dir);
  }
});

test("r2-p3: ingest surfaces hard-cap failure as typed error; rows before throw preserved", () => {
  const dir = tempDir();
  const ledger = RuntimeEventLedger.open(join(dir, "runtime-ledger.db"));
  const store = ContextStore.open(join(dir, "context.db"), {
    maxUnitsPerSession: 1,
    lineageId: "identity-test",
  });
  const ingest = new ContextIngest(ledger, store, store.lineageId);
  try {
    store.createLineage(makeLineageInput());
    // 软 cap=1（第 2 个单元 exclude），硬 cap=2（第 3 个单元写入时抛错）。
    for (let seq = 1; seq <= 3; seq += 1) {
      ledger.ingest(sampleEvent({ entryId: `e-${seq}`, payload: assistantWire(`m${seq}`) }));
    }
    assert.throws(
      () => ingest.ensureUnitsUpTo(SESSION),
      (error: unknown) => error instanceof ContextBoundsExceededError,
    );
    // 前 2 行保留（append-only），被拒绝的第 3 行未写入。
    const all = store.listUnits(SESSION, { disposition: "all" });
    assert.equal(all.length, 2);
    assert.deepEqual(
      all.map((unit) => unit.historianDisposition),
      ["include", "exclude"],
    );
  } finally {
    store.close();
    ledger.close();
    cleanupDir(dir);
  }
});

test("r2-p3: runMinimalSlice with a tiny hard cap fails loudly (fail-closed)", async () => {
  const dir = tempDir();
  try {
    // 软 cap=1 → 硬 cap=2：mock 流程第 3 个语义单元写入时触发硬 cap，错误经
    // seam subscribe 回调 → harness emitOwn rethrow → prompt 拒绝 → slice 大声
    // 失败（绝不静默继续）。typed 断言在 store/ingest 层（本文件 test 3/4）覆盖；
    // slice 层 harness 会先尝试 emitRunFailure（其 failure message 再次触发 ingest
    // → 再次抛 ContextBoundsExceededError），原始错误被包进 AggregateError，
    // 因此这里只断言"失败"，不匹配消息。
    await assert.rejects(runMinimalSlice({ dataRoot: dir, maxUnitsPerSession: 1 }));
  } finally {
    cleanupDir(dir);
  }
});

test("r2-p3: default caps keep normal sessions fully included (no regression)", () => {
  const dir = tempDir();
  const store = ContextStore.open(join(dir, "context.db"));
  try {
    store.createLineage(makeLineageInput());
    for (let seq = 1; seq <= 5; seq += 1) {
      store.insertUnit(makeUnit(SESSION, seq), { runtimeSessionId: SESSION });
    }
    assert.equal(HARD_UNITS_CAP, 2 * MAX_UNITS_PER_SESSION, "hard cap = 2× soft cap");
    const all = store.listUnits(SESSION, { disposition: "all" });
    assert.deepEqual(
      all.map((unit) => unit.historianDisposition),
      ["include", "include", "include", "include", "include"],
    );
  } finally {
    store.close();
    cleanupDir(dir);
  }
});
