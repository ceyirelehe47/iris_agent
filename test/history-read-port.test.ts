/**
 * R3-P1：ContextHistoryReadPort + 纯映射/状态推导的单元测试。
 *
 * 覆盖：
 *  - 全新 lineage（watermark 0）→ representedThroughEntrySeq = null、
 *    m0ContentHash = null、lineageStatus = ok；
 *  - HARD fold 且单元携带 entry_seq → MAX(entry_seq)（context_seq <=
 *    watermark）映射；
 *  - lineageStatus 推导（emergency_fail_closed / transform_unavailable / ok）；
 *  - 缺 lineage → fail-closed 抛出；
 *  - 纯函数 resolveEntrySeqForWatermark 的边界情况（空、watermark 0、
 *    NULL entry_seq 跳过、取 MAX、watermark 截断）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type { ContextMessageUnit } from "../src/contracts/context-units.js";
import { ContextStore } from "../src/context/context-store.js";
import {
  createContextHistoryReadPort,
  deriveLineageStatus,
  resolveEntrySeqForWatermark,
  type MaterializedLineageBoundary,
} from "../src/context/history-read-port.js";

const SESSION = "iris-runtime-2026-08-01-1";
const M1_PLACEHOLDER = "<session-history-since>(no new content)</session-history-since>";

function makeLineageInput(): Parameters<ContextStore["createLineage"]>[0] {
  return {
    lineageId: "identity-test",
    runtimeSessionId: SESSION,
    contextSourceSnapshotId: "src-1",
    epochId: SESSION,
    personaSnapshotId: "persona-default-v1",
    declarationVersion: "decl-v1",
    providerProfileId: "mock-provider-profile-v1",
    canonicalSystemPrompt: "IRIS SYSTEM PROMPT V1",
    systemProjectionHash: "sys-hash-1",
    preparedAt: "2026-08-01T00:00:00.000Z",
    materializationId: "mat-1",
    contextSerializerVersion: "iris-context-units-v1",
    carrierSchemaVersion: "1",
  };
}

function makeStore(): { store: ContextStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "iris-history-port-"));
  return { store: ContextStore.open(join(dir, "context.db"), { lineageId: "identity-test" }), dir };
}

function closeStore(store: ContextStore, dir: string): void {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

function makeUnit(overrides: Partial<ContextMessageUnit>): ContextMessageUnit {
  return {
    lineageId: "identity-test",
    runtimeSessionId: SESSION,
    contextSeq: 0,
    contextUnitId: "unit-x",
    unitId: "unit-x",
    sourceEventId: "evt-x",
    unitType: "input",
      semanticSchemaId: "iris.semantic.context_message.user.v1",
    disposition: "include",
    contentHash: "h",
    payload: { role: "user", content: "x", timestamp: 0 } as AgentMessage,
    paired: false,
    derivationRefs: { memoryRefs: [], compartmentIds: [], sourceContextMessageUnitIds: [] },
    schemaVersion: "context-unit-v1",
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

/** 断言 MaterializedLineageBoundary 的每个字段（无 as/非空断言）。 */
function assertBoundary(
  actual: MaterializedLineageBoundary,
  expected: {
    representedThroughContextSeq: number;
    representedThroughEntrySeq: number | null;
    m0ContentHash: string | null;
    lineageStatus: MaterializedLineageBoundary["lineageStatus"];
    providerProfileId: string;
  },
): void {
  assert.deepEqual(actual, expected);
}

test("R3-P1 port: fresh lineage exposes watermark 0 with null entrySeq mapping and ok status", () => {
  const { store, dir } = makeStore();
  try {
    store.createLineage(makeLineageInput());
    const port = createContextHistoryReadPort(store);
    assertBoundary(port.getMaterializedBoundary(SESSION), {
      representedThroughContextSeq: 0,
      representedThroughEntrySeq: null,
      m0ContentHash: null,
      lineageStatus: "ok",
      providerProfileId: "mock-provider-profile-v1",
    });
  } finally {
    closeStore(store, dir);
  }
});

test("R3-P1 port: after HARD fold, representedThroughEntrySeq = MAX(entry_seq) over context_seq <= watermark", () => {
  const { store, dir } = makeStore();
  try {
    store.createLineage(makeLineageInput());
    // 三个单元：contextSeq 1/2 携带 entry_seq（3 / 8），contextSeq 3 无
    // entry_seq（NULL，不参与映射）。
    store.insertUnit(makeUnit({ contextSeq: 1, entrySeq: 3, contextUnitId: "u-1", unitId: "u-1", sourceEventId: "e-1" }));
    store.insertUnit(makeUnit({ contextSeq: 2, entrySeq: 8, contextUnitId: "a-2", unitId: "a-2", sourceEventId: "e-2" }));
    store.insertUnit(
      makeUnit({ contextSeq: 3, unitType: "assistant",
      semanticSchemaId: "iris.semantic.context_message.assistant.v1", contextUnitId: "a-3", unitId: "a-3", sourceEventId: "e-3" }),
    );
    // HARD fold 推进 watermark 到 2：只有 contextSeq <= 2 的单元进入 m0。
    store.materializeM0ByContextSeq({
      runtimeSessionId: SESSION,
      m0Body: "<session-history>…</session-history>",
      m1Body: M1_PLACEHOLDER,
      m0ContentHash: "h0",
      m1ContentHash: "h1",
      cachedM0SystemHash: "sys-hash-1",
      cachedM0ModelKey: "mock/model-v1",
      cachedM0ProviderProfileId: "mock-provider-profile-v1",
      representedThroughContextSeq: 2,
      atMs: 1_785_000_000_000,
    });
    const port = createContextHistoryReadPort(store);
    const boundary = port.getMaterializedBoundary(SESSION);
    assert.equal(boundary.representedThroughContextSeq, 2);
    assert.equal(boundary.representedThroughEntrySeq, 8, "MAX(entry_seq) of the covered prefix");
    assert.equal(boundary.m0ContentHash, "h0");
    assert.equal(boundary.lineageStatus, "ok");
  } finally {
    closeStore(store, dir);
  }
});

test("R3-P1 port: units with NULL entry_seq inside the prefix are skipped (MAX over non-null only)", () => {
  const { store, dir } = makeStore();
  try {
    store.createLineage(makeLineageInput());
    // 前缀内唯一携带 entry_seq 的是 contextSeq 2（entry_seq 5）；contextSeq 1
    // 无 entry_seq → 不参与，MAX 仍为 5。
    store.insertUnit(makeUnit({ contextSeq: 1, contextUnitId: "u-1", unitId: "u-1", sourceEventId: "e-1" }));
    store.insertUnit(makeUnit({ contextSeq: 2, entrySeq: 5, contextUnitId: "a-2", unitId: "a-2", sourceEventId: "e-2" }));
    store.materializeM0ByContextSeq({
      runtimeSessionId: SESSION,
      m0Body: "<session-history>…</session-history>",
      m1Body: M1_PLACEHOLDER,
      m0ContentHash: "h0",
      m1ContentHash: "h1",
      cachedM0SystemHash: "sys-hash-1",
      cachedM0ModelKey: "mock/model-v1",
      cachedM0ProviderProfileId: "mock-provider-profile-v1",
      representedThroughContextSeq: 2,
      atMs: 1_785_000_000_000,
    });
    const boundary = createContextHistoryReadPort(store).getMaterializedBoundary(SESSION);
    assert.equal(boundary.representedThroughEntrySeq, 5);
  } finally {
    closeStore(store, dir);
  }
});

test("R3-P1 port: lineageStatus derivation matches the emergency machinery", () => {
  const { store, dir } = makeStore();
  try {
    store.createLineage(makeLineageInput());
    const port = createContextHistoryReadPort(store);
    // transform_unavailable：last_transform_error 存在 → transform_unavailable。
    store.setEmergencyState(SESSION, "transform_unavailable", "context pass blocked: timeout");
    assert.equal(port.getMaterializedBoundary(SESSION).lineageStatus, "transform_unavailable");
    // emergency_fail_closed 覆盖 transform_unavailable（最高级）。
    store.setEmergencyState(SESSION, "emergency_fail_closed", "hard cap exceeded");
    assert.equal(port.getMaterializedBoundary(SESSION).lineageStatus, "emergency_fail_closed");
    // 恢复 ok：清空错误后状态回落。
    store.setEmergencyState(SESSION, "ok", null);
    assert.equal(port.getMaterializedBoundary(SESSION).lineageStatus, "ok");
  } finally {
    closeStore(store, dir);
  }
});

test("R3-P1 port: missing lineage fails closed with a typed error", () => {
  const { store, dir } = makeStore();
  try {
    const port = createContextHistoryReadPort(store);
    assert.throws(
      () => port.getMaterializedBoundary(SESSION),
      /no lineage for .*\(fail closed\)/,
      "port must refuse to guess a boundary without lineage",
    );
  } finally {
    closeStore(store, dir);
  }
});

test("R3-P1 port: deriveLineageStatus pure helper precedence (fail_closed > transform_unavailable > ok)", () => {
  assert.equal(deriveLineageStatus({ emergencyState: "ok", lastTransformError: null }), "ok");
  assert.equal(
    deriveLineageStatus({ emergencyState: "ok", lastTransformError: "boom" }),
    "transform_unavailable",
  );
  assert.equal(
    deriveLineageStatus({ emergencyState: "transform_unavailable", lastTransformError: "boom" }),
    "transform_unavailable",
  );
  assert.equal(
    deriveLineageStatus({
      emergencyState: "emergency_fail_closed",
      lastTransformError: "hard cap exceeded",
    }),
    "emergency_fail_closed",
    "fail_closed wins even with a transform error present",
  );
});

test("R3-P1 port: resolveEntrySeqForWatermark edge cases (pure)", () => {
  // 空单元 → null。
  assert.equal(resolveEntrySeqForWatermark([], 10), null);
  // watermark 0 → 无 contextSeq <= 0 的单元 → null。
  assert.equal(
    resolveEntrySeqForWatermark(
      [
        { contextSeq: 1, entrySeq: 3 },
        { contextSeq: 2, entrySeq: 4 },
      ],
      0,
    ),
    null,
  );
  // NULL entry_seq（undefined）的单元被跳过。
  assert.equal(
    resolveEntrySeqForWatermark(
      [{ contextSeq: 1 }, { contextSeq: 2, entrySeq: 4 }, { contextSeq: 3 }],
      3,
    ),
    4,
  );
  // 取前缀内 MAX，忽略 watermark 之后（contextSeq > watermark）的单元。
  assert.equal(
    resolveEntrySeqForWatermark(
      [
        { contextSeq: 1, entrySeq: 3 },
        { contextSeq: 2, entrySeq: 9 },
        { contextSeq: 3, entrySeq: 12 },
        { contextSeq: 4, entrySeq: 20 },
      ],
      3,
    ),
    12,
  );
  // 前缀内全部无 entry_seq → null。
  assert.equal(
    resolveEntrySeqForWatermark([{ contextSeq: 1 }, { contextSeq: 2 }, { contextSeq: 3 }], 3),
    null,
  );
  // 与 SQL 实现同语义：多个携带 entry_seq 的单元取 MAX。
  assert.equal(
    resolveEntrySeqForWatermark(
      [
        { contextSeq: 1, entrySeq: 7 },
        { contextSeq: 2, entrySeq: 5 },
      ],
      2,
    ),
    7,
  );
});
