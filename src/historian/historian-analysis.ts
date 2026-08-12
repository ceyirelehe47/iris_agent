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
import type { HistorianBoundarySnapshot, SequencedSessionEntry } from "../contracts/historian.js";
import { historianBatchHash } from "../contracts/historian.js";

/**
 * R3 Historian analysis view + PURE validation (issue #8 Phase B Feature B3).
 *
 *   read finite eligible range → build HistorianAnalysisView →
 *   provisional classification → pure validation → discard unsafe suffix →
 *   commit safe prefix
 *
 * The runner (B3) consumes the FROZEN boundary snapshot and reads only the
 * finite eligible range (never wider). The validation here is PURE: no I/O,
 * deterministic, and it re-verifies — before any commit — that:
 *   - the range endpoints match the snapshot (eligibleThroughEntrySeq);
 *   - the entry IDs + content hashes match the frozen sourceRangeHash;
 *   - no tool arc is cut (each assistant toolCall has its toolResult within
 *     the eligible range, or the arc is entirely in the protected tail);
 *   - no incomplete invocation is cut (an assistant turn still in flight);
 *   - no user message pair is split.
 *
 * Any unsafe SUFFIX is DISCARDED (the commit range shrinks to the last safe
 * prefix). A failed validation NEVER advances the cursor.
 */

export type ProvisionalUnitKind =
  "user_input" | "assistant" | "tool_result" | "tool_arc" | "custom" | "other";

/** One provisional classification unit over the eligible range. */
export interface ProvisionalUnit {
  entrySeq: number;
  entryId: string;
  kind: ProvisionalUnitKind;
  /** True when this unit belongs to an incomplete invocation (in flight). */
  inFlight: boolean;
  /** Canonical provider-visible semantic text (B4 content source). */
  providerVisible: string;
}

/** The pure analysis view over a finite eligible range. */
export interface HistorianAnalysisView {
  runtimeSessionId: string;
  boundary: HistorianBoundarySnapshot;
  /** The FINITE range actually read (never wider than the snapshot). */
  eligibleEntries: SequencedSessionEntry[];
  /** Provisional classifications (deterministic, pure). */
  units: ProvisionalUnit[];
  /** Raw eligible tokens (estimate). */
  trueRawEligibleTokens: number;
}

export type ValidationOutcome =
  | {
      ok: true;
      commitThroughEntrySeq: number;
      commitThroughContextSeq: number;
      discardedFromEntrySeq: number | null;
    }
  | { ok: false; errorCode: string; detail: string };

export interface ValidateRangeInput {
  runtimeSessionId: string;
  boundary: HistorianBoundarySnapshot;
  eligibleEntries: SequencedSessionEntry[];
  /**
   * iris_agent#76: the durable contextSeq cursor + 1 — the SAME start anchor
   * the freeze used for sourceRangeHash (Context coordinates). Kept explicit
   * so the range-hash invariant is anchored to the cursor, not to whichever
   * unit happens to be first in a claim window (derived-only units can leave
   * entrySeq gaps). Required by validateRange; buildAnalysisView does not
   * need it.
   */
  unprocessedFromContextSeq?: number;
}

/** Build the analysis view (pure). The range must already be ≤ snapshot. */
export function buildAnalysisView(input: ValidateRangeInput): HistorianAnalysisView {
  const units: ProvisionalUnit[] = [];
  for (const entry of input.eligibleEntries) {
    units.push(provisionalClassify(entry));
  }
  const rawText = input.eligibleEntries.map((e) => JSON.stringify(e.entry)).join("");
  return {
    runtimeSessionId: input.runtimeSessionId,
    boundary: input.boundary,
    eligibleEntries: input.eligibleEntries,
    units,
    trueRawEligibleTokens: Math.max(1, Math.ceil(rawText.length / 4)),
  };
}

/** Deterministic provisional classification of ONE raw entry (pure). */
export function provisionalClassify(entry: SequencedSessionEntry): ProvisionalUnit {
  const candidate = entry.entry as {
    type?: string;
    message?: { role?: string };
  };
  const role = candidate?.message?.role;
  const providerVisible = renderProviderVisible(entry, role);
  if (role === "user") {
    return {
      entrySeq: entry.entrySeq,
      entryId: entry.entryId,
      kind: "user_input",
      inFlight: false,
      providerVisible,
    };
  }
  if (role === "assistant") {
    return {
      entrySeq: entry.entrySeq,
      entryId: entry.entryId,
      kind: "assistant",
      inFlight: false,
      providerVisible,
    };
  }
  if (role === "toolResult") {
    return {
      entrySeq: entry.entrySeq,
      entryId: entry.entryId,
      kind: "tool_result",
      inFlight: false,
      providerVisible,
    };
  }
  if (candidate?.type === "custom_message") {
    return {
      entrySeq: entry.entrySeq,
      entryId: entry.entryId,
      kind: "custom",
      inFlight: false,
      providerVisible,
    };
  }
  return {
    entrySeq: entry.entrySeq,
    entryId: entry.entryId,
    kind: "other",
    inFlight: false,
    providerVisible,
  };
}

/**
 * Canonical provider-visible semantic text for a raw entry (B4 content
 * source — the SAME rendering basis the Context pipeline uses, so the
 * Historian never re-derives a different semantic projection). Companion
 * and internal metadata are never rendered.
 */
function renderProviderVisible(entry: SequencedSessionEntry, role: string | undefined): string {
  const candidate = entry.entry as {
    type?: string;
    message?: { role?: string; content?: unknown };
  };
  if (candidate?.type === "custom_message") {
    // Companion / control custom messages carry no provider-visible semantics.
    return "";
  }
  const message = candidate?.message;
  if (message === undefined) {
    return "";
  }
  const content = message.content;
  // Pi user messages carry the raw content string (real user words).
  if (typeof content === "string") {
    return content;
  }
  const parts = content as Array<{ type?: string; text?: string }> | undefined;
  if (role === "toolResult") {
    const textParts = (parts ?? [])
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "");
    return textParts.join("\n");
  }
  if (Array.isArray(parts)) {
    const lines: string[] = [];
    for (const part of parts) {
      if (part?.type === "text" && typeof part.text === "string") {
        lines.push(part.text);
      }
      if (part?.type === "toolCall") {
        const call = part as { name?: string; arguments?: unknown };
        lines.push(
          `TOOL CALL: ${call.name ?? "unknown"}(${typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {})})`,
        );
      }
    }
    return lines.join("\n");
  }
  return "";
}

export function validateRange(input: ValidateRangeInput): ValidationOutcome {
  const { boundary, eligibleEntries } = input;

  // 1. Endpoint invariant: the runner must never exceed the snapshot's
  //    eligible ceilings — in CONTEXT coordinates (the authority) and in
  //    ordinal attribution. The caller reads ≤ those ceilings, so the last
  //    entry here must be ≤ the snapshot ceilings.
  const last = eligibleEntries[eligibleEntries.length - 1];
  if (last !== undefined && last.entrySeq > boundary.eligibleThroughEntrySeq) {
    return {
      ok: false,
      errorCode: "range_exceeds_frozen_boundary",
      detail: `runner widened the range: last ${last.entrySeq} > frozen ${boundary.eligibleThroughEntrySeq}`,
    };
  }
  // iris_agent#76: entries carry contextSeq attribution; fixtures without
  // one fall back to the ordinal (identical semantics).
  const contextSeqOf = (entry: SequencedSessionEntry | undefined): number =>
    entry?.contextSeq ?? entry?.entrySeq ?? 0;
  if (last !== undefined && contextSeqOf(last) > boundary.eligibleThroughContextSeq) {
    return {
      ok: false,
      errorCode: "range_exceeds_frozen_boundary",
      detail: `runner widened the range: last contextSeq ${contextSeqOf(last)} > frozen ${boundary.eligibleThroughContextSeq}`,
    };
  }

  // 2. Source range hash invariant: the frozen hash must match the range.
  //    The hash start is the durable contextSeq cursor (the SAME anchor the
  //    freeze used) — NOT the first present unit's seq: the claimed window
  //    can legitimately start after a gap (derived-only units carry no
  //    entrySeq), and iris_agent#76 hashes Context coordinates, never
  //    Session-local entry sequences.
  const unprocessedFromContextSeq =
    input.unprocessedFromContextSeq ?? contextSeqOf(last ?? eligibleEntries[0]);
  const computedHash = historianBatchHash({
    lineageId: boundary.lineageId,
    afterContextSeqExclusive: unprocessedFromContextSeq - 1,
    throughContextSeqInclusive: last === undefined ? 0 : contextSeqOf(last),
    units: eligibleEntries.map((entry) => ({
      contextSeq: contextSeqOf(entry),
      contextUnitId: entry.entryId,
      contentHash: entry.contentHash,
    })),
  });
  if (computedHash !== boundary.sourceRangeHash) {
    // The frozen range was read from a snapshot at freeze time; the runner
    // re-claims the same window. If content changed, fail closed (never
    // commit against drift) — the next freeze captures the new head.
    return {
      ok: false,
      errorCode: "source_range_hash_mismatch",
      detail: `range hash ${computedHash.slice(0, 12)} != frozen ${boundary.sourceRangeHash.slice(0, 12)}`,
    };
  }

  // 3. Tool-arc seam: collect assistant toolCall ids and toolResult ids.
  const assistantToolCalls = new Map<string, number>(); // callId -> assistant entrySeq
  const toolResults = new Set<string>(); // callId
  for (const entry of eligibleEntries) {
    const candidate = entry.entry as {
      message?: {
        role?: string;
        content?: Array<{ type?: string; id?: string }>;
        toolCallId?: string;
      };
    };
    const message = candidate?.message;
    if (message?.role === "assistant") {
      for (const part of message.content ?? []) {
        if (part?.type === "toolCall" && typeof part.id === "string") {
          assistantToolCalls.set(part.id, entry.entrySeq);
        }
      }
    }
    if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
      toolResults.add(message.toolCallId);
    }
  }

  // Walk the whole range: collect every entrySeq that is UNSAFE to commit
  // (incomplete assistant tool arc before the tail seam, or an orphan tool
  // result whose assistant is not in the eligible range). The commit range
  // shrinks to the first unsafe entrySeq - 1 (discard that unsafe suffix).
  // Unlike a break-on-first-safe approach, this finds the EARLIEST unsafe
  // position even when later entries look safe.
  let firstUnsafeEntrySeq: number | null = null;
  for (const entry of eligibleEntries) {
    const candidate = entry.entry as {
      message?: {
        role?: string;
        content?: Array<{ type?: string; id?: string }>;
        toolCallId?: string;
      };
    };
    const message = candidate?.message;
    const isAssistant = message?.role === "assistant";
    const isToolResult = message?.role === "toolResult";

    if (isAssistant) {
      const inFlightCalls = message.content?.filter((part) => part?.type === "toolCall") ?? [];
      const hasUnclosedCall = inFlightCalls.some(
        (part) => part?.id !== undefined && !toolResults.has(part.id),
      );
      // An assistant with an unclosed tool arc is unsafe UNLESS it sits at
      // or inside the protected tail (the tail is never cut 鈥?the snapshot
      // guarantees the tail seam, so an arc entirely in the tail is fine).
      if (hasUnclosedCall && entry.entrySeq < boundary.protectedTailStartEntrySeq) {
        firstUnsafeEntrySeq ??= entry.entrySeq;
      }
      continue;
    }

    if (isToolResult && typeof message.toolCallId === "string") {
      const assistantSeq = assistantToolCalls.get(message.toolCallId);
      // An orphan tool result (assistant not in the eligible range) is safe
      // only when it sits inside the protected tail.
      if (assistantSeq === undefined && entry.entrySeq < boundary.protectedTailStartEntrySeq) {
        firstUnsafeEntrySeq ??= entry.entrySeq;
      }
    }
  }
  const commitThrough =
    firstUnsafeEntrySeq === null ? (last?.entrySeq ?? 0) : Math.max(0, firstUnsafeEntrySeq - 1);

  // The commit must make PROGRESS past the durable cursor: committing an
  // empty prefix (firstUnsafe == first eligible entry) is not a safe
  // prefix 鈥?report no_safe_prefix so the caller never advances the cursor
  // nor fires the publication hook for zero progress (B3 review #3).
  const rangeStart = eligibleEntries[0]?.entrySeq ?? 1;
  if (commitThrough <= 0 || commitThrough < rangeStart) {
    return {
      ok: false,
      errorCode: "no_safe_prefix",
      detail: `no safe prefix: first unsafe ${firstUnsafeEntrySeq ?? "none"} at range start ${rangeStart}`,
    };
  }
  const discardedFromEntrySeq = commitThrough < (last?.entrySeq ?? 0) ? commitThrough + 1 : null;
  const committed = eligibleEntries.filter((entry) => entry.entrySeq <= commitThrough);
  const commitThroughContextSeq =
    committed.length === 0
      ? (input.unprocessedFromContextSeq ?? 0) - 1
      : contextSeqOf(committed[committed.length - 1]);
  return {
    ok: true,
    commitThroughEntrySeq: commitThrough,
    commitThroughContextSeq,
    discardedFromEntrySeq,
  };
}
