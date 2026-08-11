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
import type {
  HistorianBoundarySnapshot,
  HistorianSessionState,
  SequencedSessionEntry,
} from "../contracts/historian.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextHistoryReadPort } from "../context/history-read-port.js";
import type { ContextMessageUnitV1 } from "../contracts/context-v27.js";
import type { HistorianStore } from "./historian-store.js";
import {
  buildAnalysisView,
  validateRange,
  type HistorianAnalysisView,
  type ValidationOutcome,
} from "./historian-analysis.js";

/**
 * iris_agent#66/#76: adapt committed Context semantic units to the runner's
 * internal SequencedSessionEntry shape. The payload IS the canonical
 * semanticContent (AgentMessage-shaped JsonValue), so the existing pure freeze/
 * analysis functions keep working — but the SOURCE is Context-owned
 * committed units, never Pi Session transcript. The session id and the
 * entrySeq survive only as opaque attribution; semantic identity/order come
 * from contextSeq (entrySeq is the narrow archive mapping).
 *
 * iris_agent#76: units without a Pi entrySeq are still full batch members —
 * the caller assigns a deterministic monotonic attribution ordinal so the
 * pure seam/arc analysis keeps a total order. Feature A (#110): the V1 DTO
 * carries no entrySeq — the attribution ordinal is ALWAYS the batch
 * position (strictly increasing).
 */
export function contextUnitToSequencedEntry(
  runtimeSessionId: string,
  unit: ContextMessageUnitV1,
  ordinalFallback?: number,
): SequencedSessionEntry {
  return {
    runtimeSessionId,
    // iris_agent#110: V1 units no longer carry a physical entrySeq. Use
    // contextSeq as the entry-level ordinal — it IS globally monotonic within
    // the lineage and uniquely ordered, which is exactly what the freeze/commit
    // cursor needs to track progress across batches. The ordinalFallback is
    // only used when contextSeq is absent (should not happen for committed units).
    entrySeq: unit.contextSeq ?? ordinalFallback ?? 0,
    contextSeq: unit.contextSeq,
    entryId: unit.contextUnitId,
    entry: { type: "message", message: unit.semanticContent as unknown as AgentMessage },
    contentHash: unit.contentHash,
  };
}

/**
 * iris_agent#76: map a claimed Context batch (ascending contextSeq order) to
 * the runner's internal entries. The attribution ordinal is ALWAYS the
 * strictly-increasing batch position — Feature A (#110) V1 units carry no
 * Pi entrySeq, so the ordinal IS the batch position (1-based), keeping the
 * seam/arc math total and the frozen hash window covering the WHOLE batch.
 */
export function unitsToSequencedEntries(
  runtimeSessionId: string,
  units: ContextMessageUnitV1[],
): SequencedSessionEntry[] {
  let ordinal = 0;
  return units.map((unit) => {
    ordinal += 1;
    return {
      runtimeSessionId,
      // iris_agent#110: use contextSeq as entrySeq (globally monotonic within lineage)
      entrySeq: unit.contextSeq ?? ordinal,
      contextSeq: unit.contextSeq,
      entryId: unit.contextUnitId,
      entry: { type: "message", message: unit.semanticContent as unknown as AgentMessage },
      contentHash: unit.contentHash,
    };
  });
}

/**
 * R3 Historian runner (issue #8 Phase B Feature B3).
 *
 *   cheap trigger → freeze boundary snapshot → read finite eligible range →
 *   build HistorianAnalysisView → provisional classification → pure
 *   validation → discard unsafe suffix → commit safe prefix
 *
 * Guarantees:
 *  - the runner consumes EXACTLY the frozen snapshot (same id) and NEVER
 *    widens the range beyond eligibleThroughEntrySeq;
 *  - source Session, range endpoints, entry IDs, hashes and cursor are
 *    re-verified BEFORE the commit (validateRange);
 *  - a failed validation NEVER advances the cursor;
 *  - protected tail, tool arcs and incomplete invocations are never cut
 *    (unsafe suffix discarded);
 *  - `unprocessedFromEntrySeq` is deterministic from the durable cursor.
 *
 * This feature commits ONLY the Session-local cursor advancement (the safe
 * prefix). Compartments/Segments/EvidenceSets + Publication + outbox are
 * committed in the SAME transaction by B5 (the commit hook is injected so
 * B3 stays a pure, verifiable seam and B5 atomically extends it).
 */

export interface RunnerCommitHook {
  /** Called INSIDE the transaction with the safe prefix; must throw on
   * failure so the whole transaction rolls back (cursor never advances). */
  commitSafePrefix(input: {
    runtimeSessionId: string;
    boundary: HistorianBoundarySnapshot;
    safePrefix: SequencedSessionEntry[];
    analysis: HistorianAnalysisView;
    outcome: Extract<ValidationOutcome, { ok: true }>;
    /** The durable cursor BEFORE this commit (B5 chain metadata). */
    previousProcessedThroughEntrySeq: number;
  }): void;
}

export interface HistorianRunnerOptions {
  store: HistorianStore;
  /** iris_agent#66: the Context-owned history read/claim port — the ONLY
   * normal semantic input (committed Context units, contextSeq order). Pi
   * Session access is not wired here at all; it lives behind the explicitly
   * separated recovery/audit interface. */
  historyPort: ContextHistoryReadPort;
  /** Optional hook for the atomic publication transaction (B5). */
  commitHook?: RunnerCommitHook;
  pageSize?: number;
}

export interface RunnerResult {
  /** True when a safe prefix was committed (cursor advanced). */
  committed: boolean;
  commitThroughEntrySeq: number;
  /** iris_agent#76: the committed ceiling in Context coordinates. */
  commitThroughContextSeq: number;
  unprocessedFromEntrySeq: number;
  discardedFromEntrySeq: number | null;
  status: "committed" | "nothing_new" | "validation_failed";
  errorCode?: string;
  detail?: string;
}

/** Deterministic first-unprocessed entrySeq from the durable cursor
 * (attribution). */
export function unprocessedFromEntrySeq(state: HistorianSessionState | undefined): number {
  return Math.max(1, (state?.processedThroughEntrySeq ?? 0) + 1);
}

/** iris_agent#76: deterministic first-unprocessed contextSeq from the
 * AUTHORITATIVE durable cursor (Context coordinates). */
export function unprocessedFromContextSeq(state: HistorianSessionState | undefined): number {
  return (state?.processedThroughContextSeq ?? 0) + 1;
}

export class HistorianRunner {
  private readonly store: HistorianStore;
  private readonly historyPort: ContextHistoryReadPort;
  private readonly commitHook: RunnerCommitHook | undefined;
  private readonly pageSize: number;

  constructor(options: HistorianRunnerOptions) {
    this.store = options.store;
    this.historyPort = options.historyPort;
    this.commitHook = options.commitHook;
    this.pageSize = options.pageSize ?? 256;
  }

  /**
   * Run one job: consume the frozen snapshot, claim the finite Context
   * batch, build the analysis view, PURE-validate, discard the unsafe
   * suffix, commit the safe prefix (cursor + optional B5 hook) atomically.
   * Never throws on validation failure; throws only on real storage errors
   * (the caller requeues with retry).
   *
   * iris_agent#76: batch membership/order/cursor are CONTEXT coordinates
   * (lineage + global contextSeq). The Session id and entrySeq ordinals are
   * attribution only.
   */
  async run(input: {
    runtimeSessionId: string;
    boundary: HistorianBoundarySnapshot;
  }): Promise<RunnerResult> {
    const { runtimeSessionId, boundary } = input;
    const state = this.store.getSessionState(runtimeSessionId);

    // iris_agent#84: the AUTHORITATIVE cursor is lineage-scoped, not
    // session-scoped. Session B after rollover has no session_state row,
    // so reading the session-scoped cursor would rewind to 0. Read the
    // lineage cursor instead — it persists across Session rollover.
    const lineageCursor = this.store.getLineageCursor(this.historyPort.lineageId());
    const lineageProcessedContextSeq = lineageCursor?.processedThroughContextSeq ?? 0;

    // The durable contextSeq cursor is the authoritative processed
    // watermark; the snapshot's batch starts strictly after it.
    // iris_agent#84: use the lineage-scoped cursor (authoritative), not
    // the session-scoped one.
    const fromContextSeq = lineageProcessedContextSeq + 1;
    const fromEntrySeq = unprocessedFromEntrySeq(state);
    if (boundary.eligibleThroughContextSeq < fromContextSeq) {
      return {
        committed: false,
        commitThroughEntrySeq: state?.processedThroughEntrySeq ?? 0,
        commitThroughContextSeq: lineageProcessedContextSeq,
        unprocessedFromEntrySeq: fromEntrySeq,
        discardedFromEntrySeq: null,
        status: "nothing_new",
      };
    }

    // Claim the FROZEN Context batch (capped by the frozen ceiling). The
    // claim happens BEFORE the transaction; the transaction itself is a
    // synchronous, atomic segment (BEGIN → writes → COMMIT).
    const batch = this.historyPort.claimHistorianBatch({
      afterContextSeqExclusive: fromContextSeq - 1,
      throughContextSeqInclusive: boundary.eligibleThroughContextSeq,
    });
    const eligibleEntries = unitsToSequencedEntries(runtimeSessionId, batch.units);
    if (eligibleEntries.length === 0) {
      return {
        committed: false,
        commitThroughEntrySeq: state?.processedThroughEntrySeq ?? 0,
        commitThroughContextSeq: lineageProcessedContextSeq,
        unprocessedFromEntrySeq: fromEntrySeq,
        discardedFromEntrySeq: null,
        status: "nothing_new",
      };
    }

    // Build the analysis view + pure validation.
    const analysis = buildAnalysisView({
      runtimeSessionId,
      boundary,
      eligibleEntries,
    });
    const outcome = validateRange({
      runtimeSessionId,
      boundary,
      eligibleEntries,
      // iris_agent#76: the range-hash anchor is the durable contextSeq
      // cursor + 1 (the freeze used the same anchor) — NOT the first
      // present unit (claim windows can start after entrySeq gaps).
      unprocessedFromContextSeq: fromContextSeq,
    });
    if (!outcome.ok) {
      return {
        committed: false,
        commitThroughEntrySeq: state?.processedThroughEntrySeq ?? 0,
        commitThroughContextSeq: lineageProcessedContextSeq,
        unprocessedFromEntrySeq: fromEntrySeq,
        discardedFromEntrySeq: null,
        status: "validation_failed",
        errorCode: outcome.errorCode,
        detail: outcome.detail,
      };
    }

    // Commit the safe prefix INSIDE one transaction: cursor + (B5) hook.
    const safePrefix = eligibleEntries.filter((e) => e.entrySeq <= outcome.commitThroughEntrySeq);
    this.store.begin();
    try {
      const nextState: HistorianSessionState = {
        runtimeSessionId,
        // iris_agent#76: the AUTHORITATIVE cursor is the Context semantic
        // ceiling; the entrySeq cursor is attribution.
        processedThroughContextSeq: outcome.commitThroughContextSeq,
        processedThroughEntrySeq: outcome.commitThroughEntrySeq,
        status: state?.status ?? "active",
        ...(state?.observedHeadEntrySeq === undefined
          ? {}
          : { observedHeadEntrySeq: state.observedHeadEntrySeq }),
        ...(state?.observedHeadContextSeq === undefined
          ? {}
          : { observedHeadContextSeq: state.observedHeadContextSeq }),
        updatedAt: new Date(this.store.now()).toISOString(),
      };
      this.store.upsertSessionState(nextState);
      // iris_agent#84: advance the AUTHORITATIVE lineage-scoped cursor in the
      // SAME transaction. This is the durable boundary that survives Session
      // rollover; session_state.processedThroughContextSeq is the secondary
      // attribution field.
      this.store.upsertLineageCursor(
        this.historyPort.lineageId(),
        outcome.commitThroughContextSeq,
        state?.observedHeadContextSeq ?? outcome.commitThroughContextSeq,
      );
      this.commitHook?.commitSafePrefix({
        runtimeSessionId,
        boundary,
        safePrefix,
        analysis,
        outcome,
        previousProcessedThroughEntrySeq: state?.processedThroughEntrySeq ?? 0,
      });
      this.store.commit();
    } catch (error) {
      this.store.rollback();
      throw error; // storage error → caller requeues; cursor never advanced
    }

    return {
      committed: true,
      commitThroughEntrySeq: outcome.commitThroughEntrySeq,
      commitThroughContextSeq: outcome.commitThroughContextSeq,
      unprocessedFromEntrySeq: outcome.commitThroughEntrySeq + 1,
      discardedFromEntrySeq: outcome.discardedFromEntrySeq,
      status: "committed",
    };
  }
}
