/**
 * R3-P1：ContextHistoryReadPort —— 跨库窄读取端口（Context lineage → Historian）。
 *
 * 权威来源：Roadmap v13 规格 + Oracle 咨询结论（binding）——"只有已进入 m0/m1
 * 的 compartment 才可替换 raw P5；一旦 Context lineage 的物化边界
 * （represented_through_context_seq）覆盖该 compartment，其 raw 条目才可被
 * 语义处理（raw-replacement eligible）"。分支 Historian（R3-P0 port）freeze
 * 边界时没有任何 lineage 感知（只读 raw Pi 条目），本端口封闭该缺口。
 *
 * 跨库规则（AGENTS.md）：本端口只把物化边界暴露为 VALUE（seq 序号、content
 * hash、状态字符串），绝不向消费方（Historian）泄漏 context.db 的句柄、
 * Repository / ORM entity / 具体 Adapter，也不建立跨 historian.db/context.db
 * 的外键。
 *
 * 设计决策：
 *  - 物化边界由 ContextStore.getLineage（既有）+ 新增专用 store 方法
 *    ContextStore.maxEntrySeqAtOrBelowWatermark（SQL 聚合 MAX(entry_seq)，
 *    O(log n)，避免把全部 context_units 行拉进 JS，且不受 listUnits 默认
 *    disposition 过滤影响——映射面向全部语义单元）组装；
 *  - lineageStatus 的推导与 ContextStore 既有 emergency 机制语义一致
 *    （emergency_fail_closed 优先，其次 last_transform_error 存在 →
 *    transform_unavailable，否则 ok），规则内聚为纯函数 deriveLineageStatus；
 *  - entrySeqOf(representedThroughContextSeq) 的映射规则内聚为纯函数
 *    resolveEntrySeqForWatermark（contextSeq <= watermark 的单元中取
 *    MAX(entry_seq)，NULL entry_seq 不参与），供消费方对内存中的单元做同一
 *    映射（与 SQL 实现语义一致，可单测）。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type { ContextMessageUnit } from "../contracts/context-units.js";

/** Legacy unit type — the old ContextUnitType values. */
export type ContextUnitType = "input" | "assistant" | "tool_result";
import { historianBatchHash, type HistorianBatchV1 } from "../contracts/historian.js";
import type { RuntimeEventDerivationRefs } from "../contracts/runtime-events.js";
import type { ContextLineage, ContextStore } from "./context-store.js";

/** Context lineage 物化状态（与 context_lineages.emergency_state 语义同源）。 */
export type LineageStatus = "ok" | "transform_unavailable" | "emergency_fail_closed";

/** 已物化边界（values-only，跨库安全：全是序号 / 哈希 / 状态字符串）。 */
export interface MaterializedLineageBoundary {
  /** lineage 的 context_seq 空间物化 watermark（m0 前缀覆盖到该 seq）。 */
  representedThroughContextSeq: number;
  /**
   * 物化 watermark 对应的 entrySeq（MAX(entry_seq) over context_seq <=
   * watermark 且 entry_seq IS NOT NULL 的单元）。null = watermark 为 0 或该
   * 前缀内没有任何携带 entry_seq 的单元。
   */
  representedThroughEntrySeq: number | null;
  /** 已物化 m0 的内容哈希（从未 HARD fold → null）。 */
  m0ContentHash: string | null;
  lineageStatus: LineageStatus;
  providerProfileId: string;
}

/**
 * R3-P1：窄读取端口契约。只暴露 VALUE，绝不暴露 context.db 内部对象。
 * 缺 lineage（session 尚无 context_lineages 行）→ fail-closed 抛出（调用方
 * 只应在 ensureLineage / HARD fold 提交之后调用）。
 */
export interface ContextHistoryReadPort {
  getMaterializedBoundary(runtimeSessionId: string): MaterializedLineageBoundary;

  /**
   * iris_agent#45: the authoritative identity-level Context lineage id of
   * THIS data root (one data root → one durable lineage). Publications must
   * identify exactly this id — never a Session-derived synthesis. Rollover
   * does not change it.
   */
  lineageId(): string;

  /**
   * R3 (anti-echo)：读取 lineage 内 [fromContextSeq, toContextSeq] 闭区间的
   * ContextMessageUnit 窄视图（values-only：contextSeq / disposition /
   * derivationRefs / contentHash / runtimeEventId / unitType）。供 Historian
   * 在构建 Evidence 时做 anti-echo 分类；不泄漏 context.db 句柄。
   * 越界（toContextSeq 超过当前物化边界）→ 由调用方负责（只读语义）。
   */
  listUnitsForHistorian(
    lineageId: string,
    fromContextSeq: number,
    toContextSeq: number,
  ): Array<{
    contextUnitId: string;
    contextSeq: number;
    runtimeEventId: string;
    unitType: ContextUnitType;
    disposition: ContextMessageUnit["disposition"];
    contentHash: string;
    derivationRefs: RuntimeEventDerivationRefs;
  }>;

  /**
   * iris_memory#11: read the lineage range WITH the canonical
   * provider-visible payloads (values-only — the same materialized rows
   * the Context pipeline committed; the Historian renders canonical
   * episode content from these and never touches raw archives). Used ONLY
   * by the publication envelope builder; the anti-echo view stays
   * content-free.
   */
  listUnitsWithPayload(
    lineageId: string,
    fromContextSeq: number,
    toContextSeq: number,
  ): Array<{
    contextUnitId: string;
    contextSeq: number;
    runtimeEventId: string;
    unitType: ContextUnitType;
    disposition: ContextMessageUnit["disposition"];
    contentHash: string;
    derivationRefs: RuntimeEventDerivationRefs;
    payload: AgentMessage;
    payloadTimestamp?: string;
  }>;

  /**
   * iris_agent#76: the Context-owned CLAIM — the Historian's ONLY normal
   * semantic batch selector. Claims committed, immutable Context semantic
   * units from the identity-level lineage by global contextSeq, and freezes
   * them into an immutable, replayable HistorianBatchV1. Batch membership,
   * order and identity are decided by Context coordinates ONLY:
   * runtimeSessionId, Pi entry ids and entry ranges are optional
   * attribution on the units and can be absent without changing the batch.
   * Missing lineage → fail-closed throw (same as the other port methods).
   */
  claimHistorianBatch(input: {
    afterContextSeqExclusive: number;
    throughContextSeqInclusive: number;
  }): HistorianBatchV1;
}

/**
 * 纯推导（可测）：lineageStatus 与 ContextStore 的 emergency 机制一致——
 *  - emergency_state === "emergency_fail_closed" → emergency_fail_closed（最高级）；
 *  - last_transform_error 存在（非 null/undefined）→ transform_unavailable；
 *  - 否则 ok。
 */
export function deriveLineageStatus(
  lineage: Pick<ContextLineage, "emergencyState" | "lastTransformError">,
): LineageStatus {
  if (lineage.emergencyState === "emergency_fail_closed") {
    return "emergency_fail_closed";
  }
  if (lineage.lastTransformError !== null && lineage.lastTransformError !== undefined) {
    return "transform_unavailable";
  }
  return "ok";
}

/**
 * 纯映射（可测）：entrySeqOf(representedThroughContextSeq) 的参考实现——
 * 在 contextSeq <= watermark 的单元中取 MAX(entry_seq)，跳过无 entry_seq
 * 的单元（NULL entry_seq 不参与）。watermark 为 0 或前缀内无携带 entry_seq
 * 的单元 → null。与 ContextStore.maxEntrySeqAtOrBelowWatermark（SQL 聚合）
 * 语义一致；消费方持有内存单元时可用本函数做同一映射。
 */
export function resolveEntrySeqForWatermark(
  units: ReadonlyArray<{ contextSeq: number; entrySeq?: number }>,
  representedThroughContextSeq: number,
): number | null {
  let max: number | null = null;
  for (const unit of units) {
    if (unit.contextSeq > representedThroughContextSeq) {
      continue;
    }
    if (unit.entrySeq === undefined) {
      continue; // NULL entry_seq 不参与映射
    }
    if (max === null || unit.entrySeq > max) {
      max = unit.entrySeq;
    }
  }
  return max;
}

/** Adapter：把 ContextStore（context.db 权威 owner）适配为窄读取端口。 */
export function createContextHistoryReadPort(store: ContextStore): ContextHistoryReadPort {
  return {
    lineageId() {
      // The store is opened with the data-root-derived lineage id; the
      // binding ledger (iris_agent#52) enforces one durable lineage per
      // data root, so this IS the authoritative identity.
      return store.lineageId;
    },
    getMaterializedBoundary(runtimeSessionId: string): MaterializedLineageBoundary {
      const lineage = store.getLineage(runtimeSessionId);
      if (lineage === undefined) {
        throw new Error(
          `context history read port: no lineage for ${runtimeSessionId} (fail closed)`,
        );
      }
      return {
        representedThroughContextSeq: lineage.representedThroughContextSeq,
        representedThroughEntrySeq: store.maxEntrySeqAtOrBelowWatermark(
          runtimeSessionId,
          lineage.representedThroughContextSeq,
        ),
        m0ContentHash: lineage.m0ContentHash,
        lineageStatus: deriveLineageStatus(lineage),
        providerProfileId: lineage.providerProfileId,
      };
    },
    listUnitsForHistorian(lineageId, fromContextSeq, toContextSeq) {
      // 只读 lineage 内闭区间的单元窄视图;按 contextSeq 升序返回。
      return store.listUnitsByLineageRange(lineageId, fromContextSeq, toContextSeq).map((unit) => ({
        contextUnitId: unit.unitId,
        contextSeq: unit.contextSeq,
        runtimeEventId: unit.runtimeEventId ?? unit.sourceEventId,
        unitType: unit.unitType,
        disposition: unit.disposition,
        contentHash: unit.contentHash,
        derivationRefs: unit.derivationRefs,
      }));
    },
    listUnitsWithPayload(lineageId, fromContextSeq, toContextSeq) {
      // iris_memory#11: 同一物化行的 payload 视图（canonical
      // provider-visible 序列化，非 raw 原文副本）——只用于 publication
      // envelope 的 episode content 渲染。
      return store.listUnitsByLineageRange(lineageId, fromContextSeq, toContextSeq).map((unit) => ({
        contextUnitId: unit.unitId,
        contextSeq: unit.contextSeq,
        runtimeEventId: unit.runtimeEventId ?? unit.sourceEventId,
        unitType: unit.unitType,
        disposition: unit.disposition,
        contentHash: unit.contentHash,
        derivationRefs: unit.derivationRefs,
        payload: unit.payload,
        payloadTimestamp: unit.createdAt,
      }));
    },
    claimHistorianBatch({
      afterContextSeqExclusive,
      throughContextSeqInclusive,
    }): HistorianBatchV1 {
      // iris_agent#76: the Context-owned claim — lineage-scoped, keyed by
      // global contextSeq ONLY (never by Session ids/entry ranges). The
      // lineage is the port's own authoritative identity; NO session→lineage
      // resolution is involved, so the same semantic units claimed across
      // different Runtime Session boundaries produce the IDENTICAL batch.
      const units = store.listUnitsByLineageRange(
        store.lineageId,
        afterContextSeqExclusive + 1,
        throughContextSeqInclusive,
      );
      const actualThrough =
        units.length === 0
          ? afterContextSeqExclusive
          : (units[units.length - 1]?.contextSeq ?? afterContextSeqExclusive);
      const batch: HistorianBatchV1 = {
        schemaVersion: "historian-batch-v1",
        lineageId: store.lineageId,
        afterContextSeqExclusive,
        throughContextSeqInclusive: actualThrough,
        units,
        batchHash: "",
        frozenAt: new Date().toISOString(),
      };
      // 先确定实际端点再计算哈希（哈希覆盖真实窗口）。
      batch.batchHash = historianBatchHash(batch);
      return batch;
    },
  };
}
