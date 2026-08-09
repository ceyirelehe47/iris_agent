import { createHash } from "node:crypto";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type { SessionProjectionUnit } from "../context/projection.js";

/**
 * R3 Historian contracts (Notion 02 Historian + 02 Runtime Sessions &
 * History Archive — issue #8 Phase B).
 *
 * 移植说明（R3-P0 port）：本文件原样来自已验证的
 * `agent/r2-product-parity-fix-r3-historian` 分支（commit 5b94db7），作为 R3
 * Historian 模块的契约基座移植到 main。所有适配点均以内联中文注释标注。
 *
 * The Historian is the ONLY persistent semantic processor of the Pi Session
 * transcript. It reads Session entries exclusively through the narrow
 * RuntimeSessionHistoryReadPort (never the Context repository, never
 * m0/m1/LKG), consumes the SAME SessionProjectionUnit the Context pipeline
 * uses (one projection basis for the whole path — the Historian never
 * re-derives a different input/tool-arc boundary), and persists its own
 * immutable compartments/segments/evidence + publications in historian.db.
 */

/** Cursor-based read result of the Session history port. */
export interface SessionHistoryPage {
  /** Entries in ascending raw entrySeq order, strictly after the cursor. */
  entries: SequencedSessionEntry[];
  /**
   * Exclusive next cursor = the entrySeq AFTER the last returned entry.
   * `0` when the page is at the end of the Session (or the Session is
   * empty). When the page is NOT at the end, nextCursor is the last
   * returned entrySeq (the caller resumes with afterEntrySeqExclusive =
   * nextCursor). The cursor is forward-only and exclusive.
   */
  nextCursor: number;
  /** True when the returned page reaches the current end of the Session. */
  endOfSession: boolean;
  /**
   * A durable gap in the raw sequence (decode error / schema error /
   * missing sequence) — the port surfaces it instead of guessing content.
   */
  gap: HistoryGap | null;
}

/** Why a raw sequence cannot be read contiguously. */
export interface HistoryGap {
  /** entrySeq where the gap begins (inclusive). */
  fromEntrySeq: number;
  /** entrySeq where the gap ends (inclusive) — the last unreadable entry. */
  toEntrySeq: number;
  kind: "decode_error" | "schema_error" | "sequence_gap";
  detail: string;
}

/**
 * Narrow read port (Notion 02 Runtime Sessions): a single-page, cursor-based
 * view over the CURRENT Runtime Session's raw Pi entries. The port is
 * identity-preserving: every returned entry carries its raw entryId, its
 * session-local entrySeq and a content hash, so downstream consumers can
 * prove they processed exactly the bytes the Session actually wrote.
 */
export interface RuntimeSessionHistoryReadPort {
  /**
   * Read one finite page of raw entries strictly after `afterEntrySeqExclusive`
   * (default 0 = from the beginning), at most `limit` entries.
   * The port MUST NOT read the Context repository, m0/m1, or LKG.
   */
  readEntries(input: {
    runtimeSessionId: string;
    afterEntrySeqExclusive?: number;
    limit: number;
  }): Promise<SessionHistoryPage>;
}

/** One raw Session entry with its durable identity (entrySeq + hash). */
export interface SequencedSessionEntry {
  runtimeSessionId: string;
  /** Session-local raw ordinal (1-based, matches the Context projection).
   * iris_agent#76: attribution only — for units without a Pi entrySeq the
   * caller assigns a deterministic monotonic ordinal; it NEVER decides
   * semantic batch membership or order. */
  entrySeq: number;
  /**
   * iris_agent#76: the Context semantic coordinate (global contextSeq) this
   * entry was derived from. Attribution for hash/audit purposes; the
   * authoritative batch coordinates live on the boundary snapshot.
   */
  contextSeq?: number;
  /** The raw Pi entry id (authoritative; never derived from position). */
  entryId: string;
  /** The raw entry payload (identity-preserving; may be a non-message type). */
  entry: unknown;
  /** Deterministic content hash of `entry`. */
  contentHash: string;
}

/** Compact reference to a raw Session entry (Historian processing unit). */
export interface HistorianEntryRef {
  runtimeSessionId: string;
  entryId: string;
  entrySeq: number;
  contentHash: string;
}

/** Inclusive entrySeq range with a source range hash (endpoint-invariant). */
export interface HistorianRangeRef {
  runtimeSessionId: string;
  startEntrySeq: number;
  endEntrySeq: number;
  /** sha256 over (runtimeSessionId, startEntrySeq, endEntrySeq, entries). */
  sourceRangeHash: string;
}

/** Session processing state (the Historian's durable cursor + status). */
export interface HistorianSessionState {
  runtimeSessionId: string;
  /**
   * iris_agent#76: the AUTHORITATIVE durable cursor — the highest
   * contextSeq successfully committed by the Historian (exclusive cursor:
   * the next eligible batch starts at +1). Context-owned semantic
   * coordinates: lineage + global contextSeq. Never advances on a failed
   * transaction. Sessions may carry no value yet (nothing processed).
   */
  processedThroughContextSeq?: number;
  /**
   * Legacy attribution cursor (Session-local entrySeq). Kept for
   * audit/attribution only — it never decides batch membership, ordering
   * or the next claim window.
   */
  processedThroughEntrySeq?: number;
  status: "active" | "closing" | "closed" | "closed_incomplete" | "corrupt";
  /** Set when a boundary freeze captured the session head (B3). */
  observedHeadEntrySeq?: number;
  /** iris_agent#76: the frozen head in Context coordinates (attribution). */
  observedHeadContextSeq?: number;
  /**
   * iris_agent#53: durable finalization-intent timestamp. Set ONCE when the
   * session enters 'closing' (idempotent, never reset). Feeds readiness
   * (oldest finalization intent age) and the fair, deterministic durable
   * backlog refill (FIFO by this column).
   */
  finalizationRequestedAt?: string;
  /**
   * iris_agent#65: durable retry-accounting for the finalizer. retryAttempts
   * is the number of failed attempts already consumed (persisted on every
   * requeue, survives crash/restart); when it reaches maxAttempts the
   * session is marked retryExhaustedAt (set ONCE, never reset by refill or
   * recovery). Refill/startup-recovery skip exhausted sessions — only an
   * explicit operator/manual reactivation clears the marker. Absent fields
   * mean 0 attempts / not exhausted.
   */
  retryAttempts?: number;
  retryExhaustedAt?: string;
  updatedAt: string;
}

/**
 * Frozen boundary snapshot (Notion 02 Historian): captured by the cheap
 * trigger and consumed by the runner. The trigger and the runner MUST use
 * the SAME snapshot — the runner never widens the range.
 *
 * iris_agent#76: semantic batch authority lives in CONTEXT coordinates
 * (lineage + global contextSeq): eligibleThroughContextSeq is the frozen
 * ceiling that decides batch membership; the Session-local entrySeq fields
 * survive ONLY as attribution (the raw archive mapping), never as batch
 * selectors.
 */
export interface HistorianBoundarySnapshot {
  boundarySnapshotId: string;
  runtimeSessionId: string;
  /**
   * iris_agent#76: the identity-level Context lineage id — the batch
   * identity domain for sourceRangeHash (Context coordinates).
   */
  lineageId: string;
  /**
   * The frozen head in Context coordinates (inclusive contextSeq). The
   * semantic authority for "what the freeze observed".
   */
  observedHeadContextSeq: number;
  /** Session head observed at freeze time (inclusive entrySeq, attribution). */
  observedHeadEntrySeq: number;
  /**
   * Last contextSeq eligible for semantic processing at freeze time
   * (inclusive). The protected tail (dynamic) is EXCLUDED: units with
   * contextSeq > eligibleThroughContextSeq belong to the tail and are never
   * cut by a compartment boundary. Batch membership is decided by this
   * Context-owned coordinate.
   */
  eligibleThroughContextSeq: number;
  /**
   * Last entrySeq eligible at freeze time (attribution — the raw archive
   * mapping of eligibleThroughContextSeq).
   */
  eligibleThroughEntrySeq: number;
  /**
   * First entrySeq of the protected tail at freeze time (inclusive,
   * attribution). Compartments never cross this seam; the tail is always
   * preserved raw.
   */
  protectedTailStartEntrySeq: number;
  /** True raw eligible tokens at freeze time (semantic estimate). */
  trueRawEligibleTokens: number;
  /** Eligible tokens the Narrator may actually narrate (budgeted). */
  narratableEligibleTokens: number;
  /**
   * sha256 over the entire eligible range in CONTEXT coordinates
   * (lineageId + contextSeq endpoints + unit identity/hash sequence) —
   * iris_agent#76: never over Session-local entry sequences.
   */
  sourceRangeHash: string;
  /** Model/provider profile that produced the projection at freeze time. */
  modelProviderProfile: string;
  /** Frozen at (ISO). */
  frozenAt: string;
}

/**
 * iris_agent#76: the frozen Context-owned claim batch — the Historian's
 * normal semantic input. Batch membership/identity/order are defined by
 * lineage + global contextSeq ONLY; runtimeSessionId, Pi entry ids and
 * entry ranges are optional attribution on the units and can be absent
 * without changing the batch. The batch is immutable and replayable across
 * crash/restart (same window + same units ⇒ same batchHash).
 */
export interface HistorianBatchV1 {
  schemaVersion: "historian-batch-v1";
  lineageId: string;
  afterContextSeqExclusive: number;
  throughContextSeqInclusive: number;
  /** Immutable snapshot of the claimed units, ascending contextSeq order. */
  units: Array<import("./context-units.js").ContextMessageUnit>;
  /** sha256 over (lineageId, endpoints, unit contextSeq+unitId+contentHash). */
  batchHash: string;
  frozenAt: string;
}

/** Deterministic hash of a frozen Context-owned batch (pure). */
export function historianBatchHash(input: {
  lineageId: string;
  afterContextSeqExclusive: number;
  throughContextSeqInclusive: number;
  units: ReadonlyArray<
    Pick<import("./context-units.js").ContextMessageUnit, "contextSeq" | "unitId" | "contentHash">
  >;
}): string {
  const body = input.units
    .map((unit) => `${unit.contextSeq}:${unit.unitId}:${unit.contentHash}`)
    .join("\n");
  return createHash("sha256")
    .update(
      `${input.lineageId}|${input.afterContextSeqExclusive}|${input.throughContextSeqInclusive}|${body}`,
      "utf8",
    )
    .digest("hex");
}

/**
 * The shared semantic projection unit both Context and Historian consume
 * (issue #8: Context and Historian MUST NOT derive different projection
 * units — one basis for input/tool-arc boundaries).
 */
export type { SessionProjectionUnit };

/** Projection-unit token/length estimate for budget accounting. */
export interface ProjectionUnitEstimate {
  unit: SessionProjectionUnit;
  /** Deterministic token estimate (chars/4 unless a real counter is wired). */
  estimatedTokens: number;
}

/** Convenience: the shared projection unit's provider-visible text (B4). */
export function projectionUnitProviderText(unit: SessionProjectionUnit): string {
  // 适配说明（R3-P0 port）：main 上的 SessionProjectionUnit 仅扩展了可选的
  // providerVisible 字段（类型级），projectLogicalUnits 尚未填充真实渲染值
  // （分支上的 provider-visible 渲染器属于被排除的 A-phase 特性）。此处回退
  // 为空串，保证契约在 main 依赖集上可编译；R3-P1..P4 对齐 v13 规格时再接入
  // 真实渲染并改为必填。
  return unit.providerVisible ?? "";
}

/** Serialize a projection unit for hashing/evidence (stable byte form). */
export function serializeProjectionUnit(unit: SessionProjectionUnit): string {
  return JSON.stringify(unit);
}

/** Content hash of a raw entry (sha256 over the stable serialization). */
export function entryContentHash(entry: unknown): string {
  return stableHash(entry);
}

/** Stable, order-insensitive-safe JSON hashing (deterministic byte form). */
export function stableHash(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Marker: a projection unit whose semantics have been narrated/compacted. */
export interface NarratedProjectionUnit {
  unit: SessionProjectionUnit;
  narrationText: string;
  narrationHash: string;
}

export type { AgentMessage };
