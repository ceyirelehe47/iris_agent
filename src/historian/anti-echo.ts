/**
 * R3 (iris_agent#9) — Historian anti-echo 纯函数层。
 *
 * Roadmap v13 R3 Exit Gate: "derived-only 内容不产生新 Evidence"。
 *
 * 语义权威(iris_memory#6 与 v13 一致):
 *  - 只有 disposition=include 且已进入 committed Historian batch 的
 *    ContextMessageUnit 可以成为新 Evidence 的 basis;
 *  - reference_only 可以参与解释关系/目标,但不增加 evidence 计数/置信度;
 *  - exclude 不得进入分析 basis;
 *  - derived-only(assistant 语句完全派生自已有 memory/Compartment/work/
 *    source-unit 引用,没有新的 user/tool/external observation basis)必须
 *    标记为 derived-only,不得成为新 supporting Evidence。
 *
 * 本模块是 PURE 层:无 I/O,确定性,输入为 values-only 的单元视图
 * (ContextHistoryReadPort 暴露的值,不持有 context.db 句柄)。
 */

import type { ContextUnitType } from "../context/history-read-port.js";
import type { RuntimeEventDerivationRefs } from "../contracts/runtime-events.js";

/** Historian 消费的单元视图(ContextHistoryReadPort 暴露的 values-only 窄视图)。 */
export interface HistorianUnitView {
  contextUnitId: string;
  contextSeq: number;
  runtimeEventId: string;
  unitType: ContextUnitType;
  disposition: "include" | "reference_only" | "exclude" | "retired";
  contentHash: string;
  derivationRefs: RuntimeEventDerivationRefs;
}

/** 新 Evidence basis 引用(v13/iris_memory#6 的 EvidenceBasisRef 语义)。 */
export interface EvidenceBasisRef {
  contextUnitId: string;
  contextSeq: number;
  runtimeEventId: string;
  contentHash: string;
  historianDisposition: "include" | "reference_only" | "exclude";
  /** 派生引用(anti-echo 审计面;derived-only 单元不得进入 basis)。 */
  derivationRefs?: RuntimeEventDerivationRefs;
}

/**
 * 派生引用是否为"空"(没有任何 memory/compartment/work/source-unit 引用)。
 * 空派生引用 = 该单元有独立观察 basis(不可能是纯回显)。
 */
export function hasAnyDerivationRefs(refs: RuntimeEventDerivationRefs): boolean {
  return (
    refs.memoryRefs.length > 0 ||
    refs.compartmentIds.length > 0 ||
    refs.sourceContextMessageUnitIds.length > 0 ||
    refs.workSnapshotVersion !== undefined
  );
}

/**
 * 判断单元是否为 derived-only(纯回显)。
 *
 * 规则:
 *  - 非 assistant 单元(user_input / tool_result)永远不是 derived-only ——
 *    user 输入和 tool 结果是新的外部观察 basis;
 *  - assistant 单元只有在完全派生自已有引用(memory/compartment/work/
 *    source-unit),且没有任何独立 basis 时才判定 derived-only。
 *    保守起见:只要存在任何 derivation refs 且单元不是 user/tool,即视为
 *    派生内容 —— 它不能独立产生新 Evidence(它只解释/重述既有记忆)。
 *
 * 注意:assistant 对"新 user 提问 + 新 tool 结果"的回答带有新 basis,
 * 由调用方(compartment builder)通过 sourceContextMessageUnitIds 是否指向本批
 * 新单元来判定;本函数只做单元级保守分类。
 */
export function isDerivedOnlyUnit(
  unit: Pick<HistorianUnitView, "unitType" | "derivationRefs">,
): boolean {
  if (unit.unitType === "input" || unit.unitType === "tool_result") {
    return false;
  }
  // assistant:存在任何既有引用 → 视为派生内容(anti-echo 保守面)。
  return hasAnyDerivationRefs(unit.derivationRefs);
}

/**
 * 单元能否成为新 Evidence basis:
 *  - disposition 必须是 include(reference_only/exclude/retired 不进入 basis);
 *  - 且不是 derived-only(纯回显不产生新 Evidence)。
 */
export function isEvidenceEligibleUnit(unit: HistorianUnitView): boolean {
  if (unit.disposition !== "include") {
    return false;
  }
  return !isDerivedOnlyUnit(unit);
}

/**
 * 从单元视图构建 EvidenceBasisRef(仅 eligible 单元调用)。
 * 返回 undefined 当单元不是 include(不进入 basis)。
 */
export function toEvidenceBasisRef(unit: HistorianUnitView): EvidenceBasisRef | undefined {
  if (unit.disposition !== "include" || isDerivedOnlyUnit(unit)) {
    return undefined;
  }
  const ref: EvidenceBasisRef = {
    contextUnitId: unit.contextUnitId,
    contextSeq: unit.contextSeq,
    runtimeEventId: unit.runtimeEventId,
    contentHash: unit.contentHash,
    historianDisposition: "include",
  };
  if (hasAnyDerivationRefs(unit.derivationRefs)) {
    ref.derivationRefs = unit.derivationRefs;
  }
  return ref;
}

/**
 * 批量分类(供 compartment builder 使用):输入本批单元的窄视图,输出
 *  (evidenceBasis, derivedOnly) —— evidenceBasis 只含 eligible 单元;
 * derivedOnly=true 当本批没有产生任何新 Evidence basis(整批是回显/重述)。
 *
 * 批级语义(anti-echo 注释承诺的实现):assistant 单元若引用了**本批内的
 * 新单元**(derivationRefs.sourceContextMessageUnitIds 与本批 include 且非
 * derived-only 的 input/tool_result 单元有交集),说明它是"基于新输入/
 * 新 tool 结果的回答"而非纯回显 —— 此时即使它携带 memory/compartment
 * 派生引用,也不判 derived-only(避免误杀正常回答)。
 */
export function classifyEvidenceBasis(units: HistorianUnitView[]): {
  evidenceBasis: EvidenceBasisRef[];
  derivedOnly: boolean;
} {
  const evidenceBasis: EvidenceBasisRef[] = [];
  // 第一遍:收集本批内真正的新 observation 单元(input/tool_result,
  // include 且无派生引用)。
  const newObservationIds = new Set<string>();
  for (const unit of units) {
    if (unit.disposition !== "include") {
      continue;
    }
    if (unit.unitType === "input" || unit.unitType === "tool_result") {
      if (!hasAnyDerivationRefs(unit.derivationRefs)) {
        newObservationIds.add(unit.contextUnitId);
      }
    }
  }
  // 第二遍:分类。assistant 引用本批新单元 → 不判 derived-only。
  for (const unit of units) {
    if (unit.disposition !== "include") {
      continue;
    }
    const groundedInNewObservations =
      unit.unitType === "assistant" &&
      unit.derivationRefs.sourceContextMessageUnitIds.some((id) => newObservationIds.has(id));
    if (groundedInNewObservations) {
      // 基于本批新观察的回答:即使携带派生引用也不是纯回显,直接进入
      // basis(保留原始 derivationRefs 作审计面)。
      evidenceBasis.push({
        contextUnitId: unit.contextUnitId,
        contextSeq: unit.contextSeq,
        runtimeEventId: unit.runtimeEventId,
        contentHash: unit.contentHash,
        historianDisposition: "include",
        derivationRefs: unit.derivationRefs,
      });
      continue;
    }
    if (isEvidenceEligibleUnit(unit)) {
      const ref = toEvidenceBasisRef(unit);
      if (ref !== undefined) {
        evidenceBasis.push(ref);
      }
    }
  }
  return { evidenceBasis, derivedOnly: evidenceBasis.length === 0 };
}
