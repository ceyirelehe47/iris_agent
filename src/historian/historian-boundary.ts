/**
 * R3 Historian 模块移植说明（R3-P0 port）：
 *
 * 本文件从已通过审查的 `agent/r2-product-parity-fix-r3-historian` 分支
 * （commit 5b94db7，R3 v13 对齐实现 B1–B8）原样移植到 main，作为 R3
 * Historian 子系统的基座（issue #8 Phase B）。代码逻辑与分支保持逐字节一致；
 * 所有针对 main 依赖集的适配点均以内联中文注释（"移植说明/R3-P0"）标注。
 * 后续 R3-P1..P4 工作项负责对齐 v13 规格的增量（ContextHistoryReadPort
 * m0-clamp 等）。
 */
import { createHash } from "node:crypto";

import {
  historianBatchHash,
  type HistorianBoundarySnapshot,
  type SequencedSessionEntry,
} from "../contracts/historian.js";

/**
 * R3 Historian boundary freeze (issue #8 Phase B Feature B3).
 *
 * cheap trigger → freeze boundary snapshot.
 *
 * The freeze is a PURE computation over the Session head: it finds the
 * SAFEST eligible seam — the last entrySeq that can be semantically
 * processed WITHOUT cutting:
 *   - a tool arc (assistant toolCall … toolResult pair);
 *   - an incomplete invocation (an assistant turn still in flight);
 *   - a user message pair (user + companion) in the middle.
 *
 * The runner consumes EXACTLY this snapshot (same boundarySnapshotId) and
 * NEVER widens the range. `unprocessedFromEntrySeq` is derived
 * deterministically from the durable cursor + the snapshot.
 */

/** R3-P1：Context lineage 物化边界输入（m0-clamp）。representedThroughContextSeq
 * 为 lineage 物化 watermark（represented_through_context_seq）。null = 从未
 * 物化 → 不 clamp。iris_agent#76: the clamp is a CONTEXT coordinate — the
 * lineage materialization watermark, never a Session-local entrySeq. */
export interface LineageBoundaryInput {
  representedThroughContextSeq: number | null;
}

/** raw 部分：Session head 的纯 raw 输入（与 R3-P0 原 BoundaryFreezeInput 一致）。 */
export interface RawBoundaryFreezeInput {
  runtimeSessionId: string;
  /**
   * iris_agent#76: the identity-level Context lineage id — the batch
   * identity domain for the frozen sourceRangeHash.
   */
  lineageId: string;
  /** Raw sequenced entries of the CURRENT Session head (from the claim). */
  entries: SequencedSessionEntry[];
  /** The durable processed cursor (highest committed entrySeq, attribution). */
  processedThroughEntrySeq: number;
  /**
   * iris_agent#76: the AUTHORITATIVE durable cursor — the highest committed
   * contextSeq (Context-owned semantic coordinate). Absent = nothing
   * processed.
   */
  processedThroughContextSeq?: number;
  /** Tail margin in entrySeqs (how many raw entries stay in the protected
   * tail beyond the eligible seam). Default 2. */
  tailMarginEntries?: number;
  /** Model/provider profile that produced the projection. */
  modelProviderProfile: string;
  /** Frozen at. */
  frozenAt: string;
  /** Optional deterministic token estimate for the eligible range. */
  estimateTokens?: (text: string) => number;
}

/**
 * R3-P1 freeze 输入：raw 部分 + 可选 lineage 物化边界。lineageBoundary 缺省 =
 * 不 clamp（保持 R3-P0 纯 raw 语义）；提供时 eligible 范围以 lineage 边界为
 * 上界（v13 m0-clamp：只有已进入 m0/m1 的 compartment 才可被 raw 替换）。
 */
export interface BoundaryFreezeInput {
  rawSeamInput: RawBoundaryFreezeInput;
  /** Context lineage 物化边界（可选）。 */
  lineageBoundary?: LineageBoundaryInput;
}

export interface BoundaryFreezeResult {
  snapshot: HistorianBoundarySnapshot;
  /** Deterministic: the first entrySeq not yet semantically processed. */
  unprocessedFromEntrySeq: number;
  /** True when there is nothing new to process (head <= cursor). */
  nothingNew: boolean;
}

/** Assistant message entry (durable tool-arc discovery). */
interface AssistantLike {
  entrySeq: number;
  toolCallIds: string[];
}

function isToolResult(entry: SequencedSessionEntry): boolean {
  const candidate = entry.entry as { message?: { role?: string; toolCallId?: string } };
  const message = candidate?.message;
  return message?.role === "toolResult";
}

/** Collect assistant entries with their toolCall ids (raw scan, B3 seam). */
function collectAssistants(entries: SequencedSessionEntry[]): AssistantLike[] {
  const out: AssistantLike[] = [];
  for (const entry of entries) {
    const candidate = entry.entry as {
      message?: {
        role?: string;
        content?: Array<{ type?: string; id?: string }>;
      };
    };
    const message = candidate?.message;
    if (message?.role !== "assistant") {
      continue;
    }
    const toolCallIds: string[] = [];
    for (const part of message.content ?? []) {
      if (part?.type === "toolCall" && typeof part.id === "string") {
        toolCallIds.push(part.id);
      }
    }
    out.push({ entrySeq: entry.entrySeq, toolCallIds });
  }
  return out;
}

/** The last toolResult entrySeq whose callId resolves to an assistant
 * toolCall at or before the candidate seam (complete-arc end). */
function lastCompleteArcEnd(entries: SequencedSessionEntry[]): number {
  const assistants = collectAssistants(entries);
  const callIdsInFlight = new Set<string>();
  for (const assistant of assistants) {
    for (const id of assistant.toolCallIds) {
      callIdsInFlight.add(id);
    }
  }
  let lastEnd = 0;
  for (const entry of entries) {
    if (!isToolResult(entry)) {
      continue;
    }
    const candidate = entry.entry as {
      message?: { toolCallId?: string };
    };
    const callId = candidate?.message?.toolCallId;
    if (callId !== undefined && callIdsInFlight.has(callId)) {
      lastEnd = entry.entrySeq;
    }
  }
  return lastEnd;
}

/**
 * Freeze the boundary. PURE (no I/O). Deterministic for the same input.
 * The seam is the min of:
 *   - the last complete tool arc end;
 *   - the head minus the tail margin (protected tail never cut);
 *   - an entry inside an ACTIVE assistant's toolCall window is never a seam.
 */
export function freezeBoundary(input: BoundaryFreezeInput): BoundaryFreezeResult {
  const raw = input.rawSeamInput;
  const tailMargin = raw.tailMarginEntries ?? 2;
  const head = raw.entries.length === 0 ? 0 : (raw.entries[raw.entries.length - 1]?.entrySeq ?? 0);
  const headContextSeq =
    raw.entries.length === 0
      ? (raw.processedThroughContextSeq ?? 0)
      : (raw.entries[raw.entries.length - 1]?.contextSeq ??
        raw.entries[raw.entries.length - 1]?.entrySeq ??
        raw.processedThroughContextSeq ??
        0);
  const processedThroughContextSeq = raw.processedThroughContextSeq ?? 0;
  const unprocessedFromEntrySeq = Math.max(1, raw.processedThroughEntrySeq + 1);
  const unprocessedFromContextSeq = processedThroughContextSeq + 1;

  if (head <= raw.processedThroughEntrySeq || headContextSeq <= processedThroughContextSeq) {
    return {
      snapshot: emptySnapshot(raw, head, headContextSeq),
      unprocessedFromEntrySeq,
      nothingNew: true,
    };
  }

  // 1. Last complete tool arc end (never cut an arc).
  const arcEnd = lastCompleteArcEnd(raw.entries);
  // 2. Protected tail margin (never cut the dynamic tail).
  const tailBoundary = Math.max(0, head - tailMargin);
  // 3. In-flight invocation seam: the seam must NOT land INSIDE an
  //    assistant turn whose toolCall window extends past the seam. Walk
  //    back: find the last assistant entrySeq whose toolCall has no
  //    toolResult at or before the candidate seam, and clamp the seam
  //    strictly before it (an incomplete invocation is never cut).
  let seam = tailBoundary;
  if (arcEnd > 0) {
    seam = Math.min(seam, arcEnd);
  }
  const assistantEntries = collectAssistants(raw.entries);
  const toolResultCallIds = new Set<string>();
  for (const entry of raw.entries) {
    if (isToolResult(entry)) {
      const candidate = entry.entry as { message?: { toolCallId?: string } };
      const callId = candidate?.message?.toolCallId;
      if (callId !== undefined) {
        toolResultCallIds.add(callId);
      }
    }
  }
  for (const assistant of assistantEntries) {
    if (assistant.entrySeq >= seam) {
      continue; // entirely in the protected tail — never cut
    }
    const hasUnclosedCall = assistant.toolCallIds.some((id) => !toolResultCallIds.has(id));
    if (hasUnclosedCall) {
      // This assistant's toolCall is not closed within the eligible range →
      // the seam must be strictly before it (discard the in-flight turn).
      seam = Math.min(seam, assistant.entrySeq - 1);
    }
  }

  // Ensure the seam never exceeds the head or falls below the cursor.
  seam = Math.max(raw.processedThroughEntrySeq, Math.min(seam, tailBoundary));

  // iris_agent#76: the eligible window in ORDINAL space
  // [unprocessedFromEntrySeq .. rawSafeSeam] maps to CONTEXT coordinates via
  // the units' contextSeq attribution. The m0-clamp (lineage materialization
  // watermark) is a CONTEXT coordinate and tightens eligibleThroughContextSeq
  // only; protectedTailStart stays raw (the dynamic tail is never squeezed by
  // the lineage boundary).
  const rawSafeSeam = seam;
  // iris_agent#76: entries carry their Context coordinate (contextSeq) as
  // attribution; hand-built fixtures without one fall back to the ordinal
  // (the pure freeze semantics stay identical in that case).
  const contextSeqOf = (entry: SequencedSessionEntry | undefined): number =>
    entry?.contextSeq ?? entry?.entrySeq ?? 0;
  const ordinalEligible = raw.entries.filter(
    (e) => e.entrySeq >= unprocessedFromEntrySeq && e.entrySeq <= rawSafeSeam,
  );
  // iris_agent#84: also exclude units at or below the Context semantic cursor.
  // After Session rollover, the freeze claim starts AT the cursor (inclusive)
  // to observe the current head for nothingNew detection. But already-
  // processed units (contextSeq <= processedThroughContextSeq) must NOT
  // enter the eligible set — the runner starts strictly after the cursor
  // and the hash must match.
  const semanticEligible = ordinalEligible.filter(
    (e) => contextSeqOf(e) > processedThroughContextSeq,
  );
  const lineageContextSeq = input.lineageBoundary?.representedThroughContextSeq;
  const contextEligible =
    lineageContextSeq !== null && lineageContextSeq !== undefined
      ? semanticEligible.filter((e) => contextSeqOf(e) <= lineageContextSeq)
      : semanticEligible;
  const eligibleThroughContextSeq =
    contextEligible.length === 0
      ? processedThroughContextSeq
      : contextSeqOf(contextEligible[contextEligible.length - 1]);
  // Attribution mapping of the Context ceiling back to the raw archive.
  const eligibleThroughEntrySeq =
    contextEligible.length === 0
      ? raw.processedThroughEntrySeq
      : (contextEligible[contextEligible.length - 1]?.entrySeq ?? raw.processedThroughEntrySeq);
  const protectedTailStartEntrySeq = Math.min(head, rawSafeSeam + 1);
  // The source range hash covers ONLY the unprocessed window in CONTEXT
  // coordinates [unprocessedFromContextSeq .. eligibleThroughContextSeq] —
  // the SAME window the runner re-claims and re-verifies on its next run
  // (the runner starts from the durable contextSeq cursor). Including
  // already-processed units below the cursor would make the frozen hash
  // diverge on every cycle after the first commit (issue #8 R3 B3 review
  // blocker). iris_agent#76: hashed over Context coordinates, never over
  // Session-local entry sequences.
  const sourceRangeHash = historianBatchHash({
    lineageId: raw.lineageId,
    afterContextSeqExclusive: unprocessedFromContextSeq - 1,
    throughContextSeqInclusive: eligibleThroughContextSeq,
    units: contextEligible.map((entry) => ({
      contextSeq: entry.contextSeq ?? entry.entrySeq,
      contextUnitId: entry.entryId,
      contentHash: entry.contentHash,
    })),
  });
  const rawText = contextEligible.map((e) => JSON.stringify(e.entry)).join("");
  const trueRawEligibleTokens =
    raw.estimateTokens === undefined ? rawText.length : raw.estimateTokens(rawText);
  const narratableEligibleTokens = trueRawEligibleTokens;

  return {
    snapshot: {
      boundarySnapshotId: `bs-${raw.runtimeSessionId}-${headContextSeq}`,
      runtimeSessionId: raw.runtimeSessionId,
      lineageId: raw.lineageId,
      observedHeadContextSeq: headContextSeq,
      observedHeadEntrySeq: head,
      eligibleThroughContextSeq,
      eligibleThroughEntrySeq,
      protectedTailStartEntrySeq,
      trueRawEligibleTokens,
      narratableEligibleTokens,
      sourceRangeHash,
      modelProviderProfile: raw.modelProviderProfile,
      frozenAt: raw.frozenAt,
    },
    unprocessedFromEntrySeq,
    nothingNew: false,
  };
}

function emptySnapshot(
  input: RawBoundaryFreezeInput,
  head: number,
  headContextSeq: number,
): HistorianBoundarySnapshot {
  const processedThroughContextSeq = input.processedThroughContextSeq ?? 0;
  return {
    boundarySnapshotId: `bs-${input.runtimeSessionId}-${headContextSeq}-empty`,
    runtimeSessionId: input.runtimeSessionId,
    lineageId: input.lineageId,
    observedHeadContextSeq: headContextSeq,
    observedHeadEntrySeq: head,
    eligibleThroughContextSeq: processedThroughContextSeq,
    eligibleThroughEntrySeq: input.processedThroughEntrySeq,
    protectedTailStartEntrySeq: Math.max(1, head + 1),
    trueRawEligibleTokens: 0,
    narratableEligibleTokens: 0,
    sourceRangeHash: historianBatchHash({
      lineageId: input.lineageId,
      afterContextSeqExclusive: processedThroughContextSeq,
      throughContextSeqInclusive: processedThroughContextSeq,
      units: [],
    }),
    modelProviderProfile: input.modelProviderProfile,
    frozenAt: input.frozenAt,
  };
}

/** Deterministic sha256 over the range identity + entry content. */
export function rangeHash(
  runtimeSessionId: string,
  startEntrySeq: number,
  endEntrySeq: number,
  entries: Array<{ entryId: string; entrySeq: number; contentHash: string }>,
): string {
  const hash = createHash("sha256");
  hash.update(runtimeSessionId);
  hash.update(`:${startEntrySeq}:${endEntrySeq}:`);
  for (const entry of entries) {
    hash.update(`${entry.entrySeq}:${entry.entryId}:${entry.contentHash};`);
  }
  return hash.digest("hex");
}
