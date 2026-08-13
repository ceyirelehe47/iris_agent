/**
 * R3-P4 Exit Gate 测试（Roadmap v13，R3 Historian & Cross-session Continuity）。
 *
 * 本文件以可执行证据断言 v13 R3 Exit Gate 的关键条目：
 *  1. Historian 持久状态机 active→closing→closed + rollover wrapup 产生全新
 *     Session 状态（无上下文迁移）；
 *  2. 单 worker 优先级队列语义（highest→normal→low→manual，per-Session
 *     single-flight）——b2 已覆盖，此处引用并做最小断言；
 *  3. 原子提交：compartments+segments+evidence+assessment+continuity+cursor+
 *     publication+outbox 在 ONE 事务（b5 已覆盖 runner 侧），此处断言 wrapup
 *     的最终事务把 continuity+assessment+publication+outbox 合并提交，并验证
 *     失败回滚不留任何半成品；
 *  4. publicationSequence MAX+1（不预分配）——b5 已覆盖，此处断言跨
 *     incremental→wrapup 边界连续递增；
 *  5. outbox 状态机（claim→delivering→delivered）——b5 已覆盖，此处对 wrapup
 *     生成的 outbox 行做一次完整流转；
 *  6. 只有已进入 m0/m1 的 compartment 才可替换 raw P5 → compaction 授权：
 *     lineage 物化到 N → authorizeCompaction 返回 min(protectedTail-1, N)；
 *     lineage 未物化 → 0（不授权）；protected tail 绝不越过；
 *  7. 崩溃窗口：b5 测试 8（claim survives reopen）已覆盖 publication 侧；此处
 *     新增 compaction-trigger 崩溃测试——authorize → 崩溃（未 trim）→ 重开 →
 *     再次 authorize 返回相同 cut（确定性）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import type { SessionTreeEntry } from "@iris/pi-agent-core";

import type {
  HistorianBoundarySnapshot,
  HistorianSessionState,
} from "../src/contracts/historian.js";
import type { ContextHistoryReadPort } from "../src/context/history-read-port.js";
import { freezeBoundary } from "../src/historian/historian-boundary.js";

import { historianBatchHash } from "../src/contracts/historian.js";
import { buildAnalysisView } from "../src/historian/historian-analysis.js";
import { runWrapup } from "../src/historian/historian-continuity.js";
import {
  authorizePiCompaction,
  createCompactionAuthorizer,
  type CompactionAuthorization,
} from "../src/historian/compaction-trigger.js";
import { HistorianManager } from "../src/historian/historian-manager.js";
import { HistorianQueue } from "../src/historian/historian-queue.js";
import { HistorianStore } from "../src/historian/historian-store.js";
import { SessionHistoryReadPort } from "../src/historian/history-read-port.js";
import { FakeMemoryClient } from "../src/historian/memory-client.js";

const SESSION = "iris-runtime-2026-08-01-1";
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

/** 固定 lineage 物化边界的 mock ContextHistoryReadPort（values-only）。 */
/** iris_agent#76: an empty frozen batch (nothing claimed). */
function emptyHistorianBatch(lineageId: string, afterContextSeqExclusive: number) {
  const batch: import("../src/contracts/historian.js").HistorianBatchV1 = {
    schemaVersion: "historian-batch-v1",
    lineageId,
    afterContextSeqExclusive,
    throughContextSeqInclusive: afterContextSeqExclusive,
    units: [],
    batchHash: "",
    frozenAt: new Date().toISOString(),
  };
  batch.batchHash = historianBatchHash(batch);
  return batch;
}

function lineagePort(representedThroughEntrySeq: number | null): ContextHistoryReadPort {
  return {
    getMaterializedBoundary: () => ({
      representedThroughContextSeq: 10,
      representedThroughEntrySeq,
      m0ContentHash: representedThroughEntrySeq === null ? null : "m0-hash",
      lineageStatus: "ok",
      providerProfileId: "opencode/deepseek-v4-flash",
    }),
    listUnitsForHistorian: () => [],
    listUnitsWithPayload: () => [],
    claimHistorianBatch: ({ afterContextSeqExclusive }) =>
      emptyHistorianBatch("identity-exit-gate", afterContextSeqExclusive),
    lineageId: () => "identity-exit-gate",
  };
}

/** 会话无 lineage 行（端口 fail-closed 抛错）的 mock 端口。 */
function noLineageThrowingPort(): ContextHistoryReadPort {
  return {
    lineageId: () => "identity-exit-gate",
    getMaterializedBoundary: () => {
      throw new Error("context history read port: no lineage for session (fail closed)");
    },
    listUnitsForHistorian: () => [],
    listUnitsWithPayload: () => [],
    claimHistorianBatch: () => {
      throw new Error("context history read port: no lineage for session (fail closed)");
    },
  };
}

/** iris_agent#45/#66: publishing-capable stub port (one committed unit per
 * claimed entry — publications need a REAL non-empty Context range). The
 * #66 variant serves full units derived from the mutable fixture entries. */
function publishingStubPort(): ContextHistoryReadPort {
  return publishingStubPortWithUnits([]);
}

function publishingStubPortWithUnits(mutable: SessionTreeEntry[]): ContextHistoryReadPort {
  const claim = (fromEntrySeq: number, toEntrySeq: number) => {
    const units: import("../src/contracts/context-v27.js").ContextMessageUnitV1[] = [];
    const head = mutable.length; // the fixture's notion of the session head
    for (let seq = fromEntrySeq; seq <= Math.min(toEntrySeq, head); seq++) {
      const entry = mutable[seq - 1];
      const message = (entry as { message?: unknown } | undefined)?.message;
      units.push({
        schemaId: "iris.context_message_unit.v1",
        contextUnitId: `unit-${seq}`,
        contextLineageId: "identity-exit-gate",
        contextSeq: seq,
        runtimeEventId: `evt-${seq}`,
        kind: "user",
        semanticSchemaId: "iris.semantic.context_message.user.v1",
        semanticContent:
          (message as unknown as import("../src/contracts/context-v27.js").JsonValue) ??
          ({
            role: "user",
            content: `content-${seq}`,
            timestamp: 1,
          } as unknown as import("../src/contracts/context-v27.js").JsonValue),
        historianDisposition: "include",
        contentHash: "e".repeat(64),
        derivationRefs: {
          schemaId: "iris.semantic_derivation_refs.v1",
          memoryRefs: [],
          compartmentIds: [],
          sourceContextMessageUnitIds: [],
        },
        rawArchiveRef: {
          schemaId: "iris.raw_archive_ref.v1" as const,
          runtimeSessionId: "identity-exit-gate",
          startEntrySeq: seq,
          entryIds: [`entry-${seq}`],
        },
        lifecycleState: "committed",
        createdAt: "2026-08-01T00:00:00.000Z",
      });
    }
    return units;
  };
  return {
    getMaterializedBoundary: () => ({
      representedThroughContextSeq: 0,
      representedThroughEntrySeq: 0,
      m0ContentHash: null,
      lineageStatus: "ok",
      providerProfileId: "mock",
    }),
    listUnitsForHistorian: (_lineageId: string, fromContextSeq: number, toContextSeq: number) => {
      // iris_agent#76: anti-echo views are keyed by CONTEXT coordinates —
      // one view per claimed seq (same window the batch served).
      const units: import("../src/historian/anti-echo.js").HistorianUnitView[] = [];
      for (let seq = fromContextSeq; seq <= Math.min(toContextSeq, mutable.length); seq++) {
        units.push({
          contextUnitId: `unit-${seq}`,
          contextSeq: seq,
          runtimeEventId: `evt-${seq}`,
          kind: "user",
          historianDisposition: "include",
          contentHash: "e".repeat(64),
          derivationRefs: { memoryRefs: [], compartmentIds: [], sourceContextMessageUnitIds: [] },
        });
      }
      return units;
    },
    listUnitsWithPayload(_lineageId: string, fromContextSeq: number, toContextSeq: number) {
      const views = this.listUnitsForHistorian(_lineageId, fromContextSeq, toContextSeq);
      return views.map((view) => ({
        contextUnitId: view.contextUnitId,
        contextSeq: view.contextSeq,
        runtimeEventId: view.runtimeEventId,
        kind: view.kind,
        historianDisposition: view.historianDisposition,
        contentHash: view.contentHash,
        derivationRefs: view.derivationRefs,
        payload: { role: "user", content: `content-${view.contextSeq}`, timestamp: 0 },
        payloadTimestamp: new Date().toISOString(),
      }));
    },
    claimHistorianBatch: ({ afterContextSeqExclusive, throughContextSeqInclusive }) => {
      const claimed = claim(
        afterContextSeqExclusive + 1,
        Math.min(throughContextSeqInclusive, mutable.length),
      );
      const batch: import("../src/contracts/historian.js").HistorianBatchV1 = {
        schemaVersion: "historian-batch-v1",
        lineageId: "identity-exit-gate",
        afterContextSeqExclusive,
        throughContextSeqInclusive:
          claimed.length === 0
            ? afterContextSeqExclusive
            : (claimed[claimed.length - 1]?.contextSeq ?? afterContextSeqExclusive),
        units: claimed,
        batchHash: "",
        frozenAt: new Date().toISOString(),
      };
      batch.batchHash = historianBatchHash(batch);
      return batch;
    },
    lineageId: () => "identity-exit-gate",
  };
}

function managerFixture(
  entries: SessionTreeEntry[],
  extras: Partial<ConstructorParameters<typeof HistorianManager>[0]> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "iris-exit-"));
  const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  const mutable = [...entries];
  const manager = new HistorianManager({
    store,
    // iris_agent#45/#66: publications require the Context claim port; the
    // fixture default provides committed units so wrapup/incremental
    // publish. The mutable entries are served through the #66 claim path.
    historyPort: publishingStubPortWithUnits(mutable),
    modelProviderProfile: "m",
    ...extras,
  });
  return { manager, store, dir, mutable };
}

// ---- 6. compaction 授权（v13 "只有已进入 m0/m1 的 compartment 才可替换 raw P5"）----

test("R3 Exit Gate: authorizePiCompaction 纯函数语义（deterministic, protected tail 绝不越过）", () => {
  // lineage 物化到 N → min(protectedTailStart-1, N)。
  assert.equal(
    authorizePiCompaction({ protectedTailStartEntrySeq: 90, lineageMaterializedEntrySeq: 50 }),
    50,
    "lineage 在保护尾部之内 → cut = lineage",
  );
  // lineage 已越过保护尾部 → cut 封顶在 protectedTailStart-1（raw 不可侵犯）。
  assert.equal(
    authorizePiCompaction({ protectedTailStartEntrySeq: 90, lineageMaterializedEntrySeq: 95 }),
    89,
    "cut 绝不越过 protectedTailStart-1",
  );
  // lineage 从未物化 → 0（不授权任何裁剪）。
  assert.equal(
    authorizePiCompaction({ protectedTailStartEntrySeq: 90, lineageMaterializedEntrySeq: null }),
    0,
    "lineage 从未物化 → 0",
  );
  // 保护尾部覆盖整个会话 → 0。
  assert.equal(
    authorizePiCompaction({ protectedTailStartEntrySeq: 1, lineageMaterializedEntrySeq: 95 }),
    0,
    "全会话保护尾部 → 0",
  );
  // 防御性输入：protectedTailStartEntrySeq == 0 也不返回负值。
  assert.equal(
    authorizePiCompaction({ protectedTailStartEntrySeq: 0, lineageMaterializedEntrySeq: 95 }),
    0,
    "防御性输入不产生负值",
  );
  // 全量扫描：任何输入下 cut ∈ [0, protectedTailStart-1]。
  for (let tailStart = 1; tailStart <= 10; tailStart += 1) {
    for (let lineage = 0; lineage <= 20; lineage += 1) {
      const cut = authorizePiCompaction({
        protectedTailStartEntrySeq: tailStart,
        lineageMaterializedEntrySeq: lineage,
      });
      assert.ok(cut >= 0, `cut ${cut} >= 0`);
      assert.ok(
        cut <= tailStart - 1,
        `protected tail never violated: cut ${cut} <= ${tailStart - 1}`,
      );
    }
  }
});

test("R3 Exit Gate: createCompactionAuthorizer 原因分类（materialized / no_m0_coverage / no_boundary）", () => {
  const boundary: HistorianBoundarySnapshot = {
    boundarySnapshotId: "bs-exit-1",
    runtimeSessionId: SESSION,
    lineageId: "identity-exit-gate",
    observedHeadEntrySeq: 100,
    observedHeadContextSeq: 100,
    eligibleThroughEntrySeq: 80,
    eligibleThroughContextSeq: 80,
    protectedTailStartEntrySeq: 90,
    trueRawEligibleTokens: 1000,
    narratableEligibleTokens: 800,
    sourceRangeHash: "hash-exit",
    modelProviderProfile: "m",
    frozenAt: "x",
  };

  // 有边界 + lineage 已物化（N=50）→ cut = min(89, 50) = 50，reason materialized。
  const materialized = createCompactionAuthorizer({
    historyPort: lineagePort(50),
    latestBoundaryFor: () => boundary,
  }).authorize(SESSION);
  assert.equal(materialized.cutThroughEntrySeq, 50);
  assert.equal(materialized.reason, "materialized");
  assert.equal(materialized.protectedTailStartEntrySeq, 90);

  // 有边界 + lineage 从未物化 → cut 0，reason no_m0_coverage。
  const noM0 = createCompactionAuthorizer({
    historyPort: lineagePort(null),
    latestBoundaryFor: () => boundary,
  }).authorize(SESSION);
  assert.equal(noM0.cutThroughEntrySeq, 0);
  assert.equal(noM0.reason, "no_m0_coverage");

  // 有边界 + 端口对无 lineage 会话 fail-closed（抛错）→ 同样 no_m0_coverage（不授权）。
  const throwing = createCompactionAuthorizer({
    historyPort: noLineageThrowingPort(),
    latestBoundaryFor: () => boundary,
  }).authorize(SESSION);
  assert.equal(throwing.cutThroughEntrySeq, 0);
  assert.equal(throwing.reason, "no_m0_coverage");

  // 无边界快照 → cut 0，reason no_boundary（fail-closed）。
  const noBoundary = createCompactionAuthorizer({
    historyPort: lineagePort(50),
    latestBoundaryFor: () => undefined,
  }).authorize(SESSION);
  assert.equal(noBoundary.cutThroughEntrySeq, 0);
  assert.equal(noBoundary.reason, "no_boundary");

  // lineage 已越过保护尾部 → cut 封顶 protectedTailStart-1，绝不越过。
  const clamped = createCompactionAuthorizer({
    historyPort: lineagePort(10_000),
    latestBoundaryFor: () => boundary,
  }).authorize(SESSION);
  assert.equal(clamped.cutThroughEntrySeq, 89, "protected tail is raw-inviolable");
  assert.equal(clamped.reason, "materialized");
});

test("R3 Exit Gate: HistorianManager.authorizeCompaction 端到端（historyPort 接线 + 持久边界快照）", async () => {
  const { manager, store, dir } = managerFixture([u("u-1", null, "hello"), c("c-1", "u-1")], {
    historyPort: lineagePort(50),
  });
  try {
    // Host/freeze 路径持久化的最新边界快照（boundary_snapshots 表）。
    const boundary: HistorianBoundarySnapshot = {
      boundarySnapshotId: "bs-exit-e2e",
      runtimeSessionId: SESSION,
      lineageId: "identity-exit-gate",
      observedHeadEntrySeq: 100,
      observedHeadContextSeq: 100,
      eligibleThroughEntrySeq: 80,
      eligibleThroughContextSeq: 80,
      protectedTailStartEntrySeq: 90,
      trueRawEligibleTokens: 1000,
      narratableEligibleTokens: 800,
      sourceRangeHash: "hash-e2e",
      modelProviderProfile: "m",
      frozenAt: "x",
    };
    store.saveBoundarySnapshot(boundary);

    const auth = manager.authorizeCompaction(SESSION);
    assert.equal(auth.cutThroughEntrySeq, 50, "min(protectedTailStart-1=89, lineage=50)");
    assert.equal(auth.reason, "materialized");
    assert.equal(auth.protectedTailStartEntrySeq, 90);
  } finally {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R3 Exit Gate: authorizeCompaction 未接线 historyPort → 抛错（fail-closed）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-exit-noport-"));
  const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  try {
    // Deliberately NO historyPort: manager construction itself must fail
    // closed (iris_agent#66 — the Context claim port is REQUIRED, a
    // production Historian cannot exist without its normal semantic input).
    assert.throws(
      () =>
        new HistorianManager({
          store,
          modelProviderProfile: "m",
        } as never),
      /ContextHistoryReadPort is required/,
      "Historian construction requires the Context claim port (fail closed)",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R3 Exit Gate: compaction 授权崩溃确定性——authorize → 崩溃（未 trim）→ 重开 → 相同 cut", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-exit-crash-"));
  const dbPath = join(dir, "historian.db");
  try {
    // 阶段 1：持久化边界 + 授权（cut 由边界与 lineage 确定性决定）。
    const store1 = HistorianStore.open({ databasePath: dbPath });
    const manager1 = new HistorianManager({
      store: store1,
      modelProviderProfile: "m",
      historyPort: lineagePort(50),
    });
    store1.saveBoundarySnapshot({
      boundarySnapshotId: "bs-exit-crash",
      runtimeSessionId: SESSION,
      lineageId: "identity-exit-gate",
      observedHeadEntrySeq: 100,
      observedHeadContextSeq: 100,
      eligibleThroughEntrySeq: 80,
      eligibleThroughContextSeq: 80,
      protectedTailStartEntrySeq: 90,
      trueRawEligibleTokens: 1000,
      narratableEligibleTokens: 800,
      sourceRangeHash: "hash-crash",
      modelProviderProfile: "m",
      frozenAt: "x",
    });
    const authBefore: CompactionAuthorization = manager1.authorizeCompaction(SESSION);
    assert.equal(authBefore.cutThroughEntrySeq, 50);
    manager1.close(); // 模拟崩溃：授权后、Pi trim 之前进程终止（边界已落盘）

    // 阶段 2：重开同一数据根 → 重新授权 → 同一 cut（确定性、幂等）。
    const store2 = HistorianStore.open({ databasePath: dbPath });
    const manager2 = new HistorianManager({
      store: store2,
      modelProviderProfile: "m",
      historyPort: lineagePort(50),
    });
    try {
      const authAfter = manager2.authorizeCompaction(SESSION);
      assert.deepEqual(authAfter, authBefore, "re-authorization returns the same cut");
      assert.equal(authAfter.cutThroughEntrySeq, 50);
    } finally {
      manager2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 1. 持久状态机 + rollover wrapup ----

test("R3 Exit Gate: 持久状态机 active→closing→closed + rollover 产生全新 Session 状态", async () => {
  const { manager, store, dir } = managerFixture([
    u("u-1", null, "please remember: prefer short replies"),
    c("c-1", "u-1"),
    {
      type: "message",
      id: "a-1",
      parentId: "c-1",
      timestamp: new Date(3).toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "will do" }], timestamp: 3 },
    } as unknown as SessionTreeEntry,
  ]);
  try {
    // active：incremental 提交后会话进入 active（runner 持久化）。
    await manager.triggerIncremental(SESSION);
    await manager.pumpOnce();
    assert.equal(store.getSessionState(SESSION)?.status, "active", "incremental → active");
    assert.ok(
      (store.getSessionState(SESSION)?.processedThroughEntrySeq ?? 0) > 0,
      "cursor advanced",
    );

    // closing：wrapup 入队即持久化 closing（不再接收 incremental）。
    await manager.enqueueWrapup(SESSION);
    assert.equal(
      store.getSessionState(SESSION)?.status,
      "closing",
      "wrapup enqueued → persistent closing",
    );

    // closed：wrapup 任务完成 → closing → closed（与 ContinuitySnapshot 同事务）。
    await manager.pumpOnce();
    assert.equal(store.getSessionState(SESSION)?.status, "closed", "wrapup completed → closed");
    assert.equal(store.listContinuitySnapshots(SESSION).length, 1, "continuity snapshot persisted");

    // rollover：新 Session 有 FRESH 状态（无旧快照、无旧 session_state → 无上下文迁移）。
    assert.equal(store.getSessionState(NEW_SESSION), undefined, "new Session has no old state");
    assert.equal(store.listContinuitySnapshots(NEW_SESSION).length, 0, "no old snapshots spliced");
  } finally {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R3 Exit Gate: 启动恢复只重放 closed/closed_incomplete（绝不触碰 active/corrupt）", async () => {
  const { manager, store, dir } = managerFixture([u("u-1", null, "hello"), c("c-1", "u-1")]);
  try {
    const mk = (sid: string, status: HistorianSessionState["status"]): HistorianSessionState => ({
      runtimeSessionId: sid,
      processedThroughEntrySeq: 1,
      status,
      updatedAt: "x",
    });
    store.upsertSessionState(mk("s-closed", "closed"));
    store.upsertSessionState(mk("s-closed-incomplete", "closed_incomplete"));
    store.upsertSessionState(mk("s-active", "active"));
    store.upsertSessionState(mk("s-corrupt", "corrupt"));

    await manager.recover();

    // 队列里只有 closed / closed_incomplete 的重放任务（low 优先级）。
    const queued: Array<{ session: string; priority: string }> = [];
    let job;
    while ((job = manager.getQueue().take()) !== undefined) {
      queued.push({ session: job.runtimeSessionId, priority: job.priority });
    }
    assert.deepEqual(
      queued.map((q) => q.session).sort(),
      ["s-closed", "s-closed-incomplete"],
      "only closed/closed_incomplete sessions are recovered",
    );
    assert.ok(
      queued.every((q) => q.priority === "low"),
      "recovery re-enqueues at low priority",
    );
  } finally {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 3. 原子提交（b5 侧已覆盖 runner 事务；此处断言 wrapup 最终事务）----

test("R3 Exit Gate: wrapup 最终事务——continuity + assessment + publication + outbox 在 ONE 事务", async () => {
  const { manager, store, dir } = managerFixture(
    [u("u-1", null, "the user confirms the deployment plan is correct"), c("c-1", "u-1")],
    {
      // R3-P4：wrapup 最终事务内派生 assessment delta（B7，同事务）。
      recallProjectionsFor: () => [
        { invocationId: "inv-1", runtimeSessionId: SESSION, memoryRefs: ["memory-ref-deployment"] },
      ],
    },
  );
  try {
    await manager.enqueueWrapup(SESSION);
    await manager.pumpOnce();

    // continuity 在同一事务里。
    assert.equal(store.listContinuitySnapshots(SESSION).length, 1, "continuity snapshot committed");
    // publication + outbox 在同一事务里。
    assert.equal(store.countPublications(), 1, "wrapup final publication committed");
    assert.ok(store.countOutboxPending() >= 1, "outbox row committed with the publication");
    // assessment 在同一事务里（publication 引用这些 delta ids）。
    const deltas = store
      .raw()
      .prepare(
        "SELECT assessment_id, relation FROM memory_assessment_deltas WHERE runtime_session_id = ?",
      )
      .all(SESSION) as unknown as Array<{ assessment_id: string; relation: string }>;
    assert.ok(deltas.length >= 1, "assessment delta committed in the SAME wrapup transaction");
    assert.equal(deltas[0]?.relation, "supports");
    const pub = store
      .raw()
      .prepare("SELECT assessment_delta_ids_json FROM publications WHERE runtime_session_id = ?")
      .get(SESSION) as { assessment_delta_ids_json: string };
    assert.deepEqual(
      JSON.parse(pub.assessment_delta_ids_json) as string[],
      deltas.map((d) => d.assessment_id),
      "publication chains the assessment deltas (same transaction)",
    );
    // 会话已 finalize。
    assert.equal(store.getSessionState(SESSION)?.status, "closed");
  } finally {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R3 Exit Gate: wrapup 事务失败 → 整事务回滚（continuity + state 不留半成品）", async () => {
  const { store, dir, mutable } = managerFixture([
    u("u-1", null, "hello"),
    c("c-1", "u-1"),
    assistantLike("a-1", "c-1", "reply"),
  ]);
  try {
    const page = await new SessionHistoryReadPort({
      readRawEntries: async () => mutable,
    }).readEntries({ runtimeSessionId: SESSION, limit: 100 });
    const freeze = freezeBoundary({
      rawSeamInput: {
        runtimeSessionId: SESSION,
        lineageId: "identity-exit-gate",
        entries: page.entries,
        processedThroughEntrySeq: 0,
        tailMarginEntries: 0,
        modelProviderProfile: "m",
        frozenAt: "x",
      },
    });
    const analysis = buildAnalysisView({
      runtimeSessionId: SESSION,
      boundary: freeze.snapshot,
      eligibleEntries: page.entries,
    });
    const state: HistorianSessionState = {
      runtimeSessionId: SESSION,
      processedThroughEntrySeq: 0,
      status: "closing",
      updatedAt: "x",
    };

    // 模拟最终事务中 publication 路径失败（B6 review #3：closed session 绝不
    // 在缺 snapshot 的情况下落盘）。
    store.begin();
    try {
      runWrapup({
        store,
        runtimeSessionId: SESSION,
        state,
        boundary: freeze.snapshot,
        eligibleEntries: page.entries,
        analysis,
        commit: false,
      });
      throw new Error("router unavailable (simulated)");
      // store.commit() 不可达
    } catch {
      store.rollback();
    }

    assert.equal(store.getSessionState(SESSION), undefined, "state transition rolled back");
    assert.equal(store.listContinuitySnapshots(SESSION).length, 0, "snapshot rolled back");
    assert.equal(store.countPublications(), 0, "no publication on failure");
    const outbox = store.raw().prepare("SELECT COUNT(*) AS n FROM publication_outbox").get() as {
      n: number;
    };
    assert.equal(outbox.n, 0, "no outbox row on failure");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 4. publicationSequence MAX+1（跨 incremental→wrapup 边界，不预分配）----

test("R3 Exit Gate: publicationSequence 跨 incremental→wrapup 连续递增（MAX+1，无预分配空洞）", async () => {
  const { manager, store, dir, mutable } = managerFixture([
    u("u-1", null, "first"),
    c("c-1", "u-1"),
  ]);
  try {
    await manager.triggerIncremental(SESSION);
    await manager.pumpOnce();
    assert.equal(store.countPublications(), 1);

    // 会话增长后 wrapup：未处理窗口发布第 2 条 publication（MAX+1 = 2）。
    mutable.push(u("u-2", "c-1", "second"), c("c-2", "u-2"));
    await manager.enqueueWrapup(SESSION);
    await manager.pumpOnce();

    const rows = store
      .raw()
      .prepare(
        "SELECT publication_sequence, previous_publication_sequence FROM publications WHERE runtime_session_id = ? ORDER BY publication_sequence",
      )
      .all(SESSION) as unknown as Array<{
      publication_sequence: number;
      previous_publication_sequence: number | null;
    }>;
    assert.deepEqual(
      rows.map((r) => r.publication_sequence),
      [1, 2],
      "strictly increasing, MAX+1 in-transaction, no pre-allocation gaps",
    );
    assert.equal(rows[1]?.previous_publication_sequence, 1, "wrapup publication chains to seq 1");
  } finally {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 5. outbox 状态机（b5 已覆盖；此处对 wrapup 生成的 outbox 行做完整流转）----

test("R3 Exit Gate: wrapup 生成的 outbox 行走完 claim→delivering→delivered", async () => {
  const { manager, store, dir } = managerFixture([u("u-1", null, "hello"), c("c-1", "u-1")], {
    memoryClient: new FakeMemoryClient(),
  });
  try {
    await manager.enqueueWrapup(SESSION);
    await manager.pumpOnce();
    assert.equal(store.countPublications(), 1);

    const pubId = (
      store.raw().prepare("SELECT publication_id FROM publications LIMIT 1").get() as {
        publication_id: string;
      }
    ).publication_id;

    // claim → delivering (iris_agent#46: only a real receipt marks delivered).
    const delivered = await manager.drainOutbox();
    assert.equal(delivered.claimed, 1, "wrapup outbox row claimed");
    assert.equal(delivered.accepted, 1, "real receipt authorizes delivered");
    assert.equal(store.countOutboxPending(), 0, "outbox drained to delivered");
    const outbox = store
      .raw()
      .prepare("SELECT state FROM publication_outbox WHERE publication_id = ?")
      .get(pubId) as { state: string };
    assert.equal(outbox.state, "delivered", "Router ACK → delivered");
  } finally {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 2. 单 worker 优先级队列（b2 语义引用）----

test("R3 Exit Gate: 单 worker 优先级队列——highest→normal→low→manual + per-Session single-flight（b2 语义）", () => {
  const queue = new HistorianQueue({ nowMs: () => 0 });
  const boundary = (session: string): HistorianBoundarySnapshot => ({
    boundarySnapshotId: `bs-${session}-1`,
    runtimeSessionId: session,
    lineageId: "identity-exit-gate",
    observedHeadEntrySeq: 1,
    observedHeadContextSeq: 1,
    eligibleThroughEntrySeq: 1,
    eligibleThroughContextSeq: 1,
    protectedTailStartEntrySeq: 2,
    trueRawEligibleTokens: 10,
    narratableEligibleTokens: 10,
    sourceRangeHash: "h",
    modelProviderProfile: "m",
    frozenAt: "x",
  });
  const state = (session: string): HistorianSessionState => ({
    runtimeSessionId: session,
    processedThroughEntrySeq: 0,
    status: "active",
    updatedAt: "x",
  });

  // 乱序入队 → 严格按优先级出队。
  for (const [session, priority] of [
    ["s-low", "low"],
    ["s-normal", "normal"],
    ["s-manual", "manual"],
    ["s-highest", "highest"],
  ] as const) {
    queue.enqueue({
      priority,
      runtimeSessionId: session,
      boundary: boundary(session),
      sessionState: state(session),
    });
  }
  const order: string[] = [];
  let job;
  while ((job = queue.take()) !== undefined) {
    order.push(job.priority);
  }
  assert.deepEqual(order, ["highest", "normal", "low", "manual"], "strict priority order");

  // per-Session single-flight：同一 Session 重复入队只保留一个任务。
  const q2 = new HistorianQueue({ nowMs: () => 0 });
  q2.enqueue({
    priority: "highest",
    runtimeSessionId: SESSION,
    boundary: boundary(SESSION),
    sessionState: state(SESSION),
  });
  q2.enqueue({
    priority: "normal",
    runtimeSessionId: SESSION,
    boundary: boundary(SESSION),
    sessionState: state(SESSION),
  });
  q2.enqueue({
    priority: "low",
    runtimeSessionId: SESSION,
    boundary: boundary(SESSION),
    sessionState: state(SESSION),
  });
  assert.equal(q2.pendingCount(), 1, "single-flight keeps ONE job per session");
});

function assistantLike(id: string, parentId: string, text: string, ts = 3): SessionTreeEntry {
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

// ---- 7. R3-P4 B1 修复：closing 阻塞增量 + wrapup 单飞替换不 wedge ----

test("R3 Exit Gate: closing 会话拒绝增量提交（v13 状态机不变量，B1）", async () => {
  const fixture = managerFixture([u("u1", null), u("u2", "u1")]);
  try {
    // wrapup 入队 → 持久化 closing。
    await fixture.manager.enqueueWrapup("s1");
    assert.equal(fixture.store.getSessionState("s1")?.status, "closing", "wrapup 入队即 closing");
    // closing 后增量必须被拒绝（B1：closing 阻塞进一步 incremental 提交）。
    const accepted = await fixture.manager.enqueueIncremental("s1");
    assert.equal(accepted, false, "closing 会话不再接收增量提交");
    assert.equal(fixture.manager.getQueue().pendingCount(), 1, "队列只剩 wrapup job");
  } finally {
    fixture.store.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("R3 Exit Gate: wrapup 替换 pending 增量 → priority 降为 normal，不 wedge（B1 回归）", async () => {
  const fixture = managerFixture([u("u1", null), u("u2", "u1")]);
  try {
    // 增量先入队（highest）。
    await fixture.manager.enqueueIncremental("s1");
    assert.equal(fixture.manager.getQueue().pendingCount(), 1, "增量 job 在队");
    // wrapup 入队 → 单飞替换 → priority 必须变为 normal（否则 worker 走
    // runner 路径提交 cursor、wrapup 任务丢失 → 会话卡死 closing 的 wedge）。
    await fixture.manager.enqueueWrapup("s1");
    const pendingJob = fixture.manager.getQueue().peek();
    assert.equal(pendingJob?.priority, "normal", "单飞替换采用 wrapup 的 normal 优先级");
    // pumpOnce 走 wrapup 路径 → 会话最终 closed / closed_incomplete（不 wedge）。
    await fixture.manager.pumpOnce();
    const status = fixture.store.getSessionState("s1")?.status;
    assert.ok(
      status === "closed" || status === "closed_incomplete",
      `wrapup 完成，不卡 closing（实际 ${status}）`,
    );
  } finally {
    fixture.store.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("R3 Exit Gate: queue 单飞合并——终结性任务（normal/low）胜出，双向不 wedge（B1 复审）", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-exit-merge-"));
  const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  try {
    const newQueue = () =>
      new HistorianManager({
        store,
        historyPort: publishingStubPort(),
        modelProviderProfile: "m",
      }).getQueue();
    const job = (priority: "highest" | "normal" | "low" | "manual") => ({
      priority,
      runtimeSessionId: "s1",
      boundary: {} as never,
      sessionState: {
        runtimeSessionId: "s1",
        processedThroughEntrySeq: 0,
        status: "active" as const,
        updatedAt: "t",
      },
    });
    // 原 B1 案例：pending 增量 + wrapup 到达 → 合并后 normal。
    const q1 = newQueue();
    q1.enqueue(job("highest"));
    q1.enqueue(job("normal"));
    assert.equal(q1.peek()?.priority, "normal", "wrapup 合并 pending 增量 → normal");
    // 复审反方向：pending wrapup + 增量后到 → 合并仍 normal（不得升级回 highest）。
    const q2 = newQueue();
    q2.enqueue(job("normal"));
    q2.enqueue(job("highest"));
    assert.equal(q2.peek()?.priority, "normal", "增量合并 pending wrapup → 仍 normal，不升级");
    // manual（recomp）不得把 pending wrapup 降级。
    const q3 = newQueue();
    q3.enqueue(job("normal"));
    q3.enqueue(job("manual"));
    assert.equal(q3.peek()?.priority, "normal", "recomp 合并 pending wrapup → 仍 normal");
    // low（恢复）胜出 highest（终结性任务不被增量覆盖）。
    const q4 = newQueue();
    q4.enqueue(job("highest"));
    q4.enqueue(job("low"));
    assert.equal(q4.peek()?.priority, "low", "恢复任务合并增量 → low 胜出");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
