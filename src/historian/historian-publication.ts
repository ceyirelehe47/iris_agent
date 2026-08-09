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

import { canonicalJson } from "../contracts/tool.js";
import type { HistorianBoundarySnapshot, SequencedSessionEntry } from "../contracts/historian.js";
import type { ContextHistoryReadPort } from "../context/history-read-port.js";

/**
 * iris_memory#11: render ONE ordered Context unit as a canonical episode
 * content line `[contextSeq] role: text` — the same canonical
 * provider-visible rendering basis the Context pipeline uses (text parts
 * only; companions/tool internals are never rendered). Deterministic for a
 * given unit row.
 */
function renderEpisodeUnitLine(unit: {
  contextSeq: number;
  contextUnitId: string;
  unitType: string;
  payload: unknown;
}): string {
  const candidate = unit.payload as {
    message?: { role?: string; content?: unknown };
  };
  const message = candidate?.message;
  const role = message?.role ?? unit.unitType;
  const content = message?.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = (content as Array<{ type?: string; text?: string }>)
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join("\n");
  }
  return `[${unit.contextSeq}] ${role}: ${text}`;
}

/**
 * iris_memory#14: partition payload units into focused GraphitiEpisodeSource
 * entries by semantic category. Deterministic: the same units always yield the
 * same partitions. Independent of Runtime Session segmentation. Preserves
 * ordered Context provenance. Each episode source carries v2 focused metadata
 * (semanticKind, attributionClass, sourceTrust, referenceTime).
 *
 * Partition rule: group consecutive units by their payload role/unitType.
 * Common partitions:
 *   - user input => dialogue, user, observed
 *   - assistant output => reasoning, assistant, generated
 *   - tool results => tool_result, tool, verified
 *   - system/operational => system_event, system, verified
 * A single unit type spanning the whole batch yields one episode (backward-
 * compatible with the old single-episode behavior).
 */
function unitSemanticMetadata(
  unitType: string,
  payload: unknown,
): { semanticKind: string; attributionClass: string; sourceTrust: string } {
  const message = (payload as { message?: { role?: string } })?.message;
  const role = message?.role ?? unitType;
  switch (role) {
    case "user":
      return { semanticKind: "dialogue", attributionClass: "user", sourceTrust: "observed" };
    case "assistant":
      return { semanticKind: "reasoning", attributionClass: "assistant", sourceTrust: "generated" };
    case "tool":
      return { semanticKind: "tool_result", attributionClass: "tool", sourceTrust: "verified" };
    default:
      return { semanticKind: "system_event", attributionClass: "system", sourceTrust: "verified" };
  }
}

/**
 * iris_agent#92: compute a deterministic range hash for ONE partition's units.
 * This is separate from the batch-level rangeHash — each focused episode source
 * carries provenance for exactly the ordered Context units in its partition.
 */
function computePartitionRangeHash(
  lineageId: string,
  fromSeq: number,
  toSeq: number,
  units: ReadonlyArray<{
    contextSeq: number;
    contextUnitId: string;
    unitType: string;
    payload: unknown;
    payloadTimestamp?: string;
  }>,
): string {
  const body = units.map((u) => `${u.contextSeq}:${u.contextUnitId}`).join("\n");
  return createHash("sha256")
    .update(`${lineageId}|${fromSeq}|${toSeq}|${body}`, "utf8")
    .digest("hex");
}

function partitionEpisodeSources(
  payloadUnits: ReadonlyArray<{
    contextSeq: number;
    contextUnitId: string;
    unitType: string;
    payload: unknown;
    payloadTimestamp?: string;
  }>,
  lineageId: string,
  batchFromContextSeq: number,
  batchToContextSeq: number,
  rangeHash: string,
  wireCompartmentId: string,
  memoryRefs: string[],
  derivedOnly: boolean,
  now: string,
): Array<Record<string, unknown>> {
  // Group consecutive units by their semantic role into partitions.
  interface Partition {
    units: Array<{
      contextSeq: number;
      contextUnitId: string;
      unitType: string;
      payload: unknown;
      payloadTimestamp?: string;
    }>;
    kind: string;
    attribution: string;
    trust: string;
  }
  const partitions: Partition[] = [];
  for (const unit of payloadUnits) {
    const meta = unitSemanticMetadata(unit.unitType, unit.payload);
    const lastPartition = partitions[partitions.length - 1];
    if (
      lastPartition?.kind === meta.semanticKind &&
      lastPartition?.attribution === meta.attributionClass
    ) {
      lastPartition.units.push(unit);
    } else {
      partitions.push({
        units: [unit],
        kind: meta.semanticKind,
        attribution: meta.attributionClass,
        trust: meta.sourceTrust,
      });
    }
  }

  // Build one episode source per partition.
  const sources: Array<Record<string, unknown>> = [];
  let partitionIndex = 0;
  for (const part of partitions) {
    const partUnitIds = part.units.map((u) => u.contextUnitId);
    const partContent = part.units.map((u) => renderEpisodeUnitLine(u)).join("\n");
    const partTimestamps = part.units
      .map((u) => u.payloadTimestamp)
      .filter((t): t is string => typeof t === "string" && t.length > 0);
    const partStartedAt = partTimestamps.length > 0 ? partTimestamps[0] : now;
    const partEndedAt = partTimestamps.length > 0 ? partTimestamps[partTimestamps.length - 1] : now;
    const partFromSeq = part.units[0]?.contextSeq ?? batchFromContextSeq;
    const partToSeq = part.units[part.units.length - 1]?.contextSeq ?? batchToContextSeq;

    // iris_agent#92: per-partition provenance — each source's contextRange,
    // rangeHash, sourceUnitIds, canonicalContent and episode identity must
    // describe the SAME exact partition, not the enclosing batch.
    const partRangeHash = computePartitionRangeHash(lineageId, partFromSeq, partToSeq, part.units);
    const episodeId = `episode:${lineageId}:${partFromSeq}..${partToSeq}:${partRangeHash.slice(0, 8)}:p${partitionIndex}`;

    const episodeSourceBase = {
      episodeId,
      lineageId,
      contextRange: {
        contextLineageId: lineageId,
        fromContextSeq: partFromSeq,
        toContextSeq: partToSeq,
        rangeHash: partRangeHash,
      },
      sourceUnitIds: partUnitIds,
      canonicalContent: partContent,
      targetGroupId: `group:${lineageId}`,
      temporal: { startedAt: partStartedAt, endedAt: partEndedAt },
      isDerivedOnly: derivedOnly,
      derivation: {
        memoryRefs,
        compartmentIds: [wireCompartmentId],
        sourceContextMessageUnitIds: [],
      },
      // iris_memory#14: v2 focused semantic metadata
      semanticKind: part.kind,
      attributionClass: part.attribution,
      sourceTrust: part.trust,
      referenceTime: partEndedAt,
    };
    const episodeSourceHash = createHash("sha256")
      .update(canonicalJson(episodeSourceBase), "utf8")
      .digest("hex");
    sources.push({ ...episodeSourceBase, episodeSourceHash });
    partitionIndex++;
  }
  return sources;
}
import type { HistorianStore } from "./historian-store.js";
import type { RunnerCommitHook } from "./historian-runner.js";
import type { HistorianAnalysisView } from "./historian-analysis.js";
import type { ValidationOutcome } from "./historian-analysis.js";
import { buildCompartment } from "./historian-compartment.js";
import type { EvidenceBasisRef, HistorianUnitView } from "./anti-echo.js";
import type { MemoryAcceptanceReceipt } from "../contracts/ports.js";
import type { BuiltCompartment } from "./historian-compartment.js";
import {
  deriveMemoryAssessments,
  type InvocationMemoryRecallProjection,
} from "./historian-assessment.js";

/**
 * R3 Historian publication + authoritative outbox (issue #8 Phase B Feature
 * B5).
 *
 * ONE atomic historian.db transaction commits:
 *   safe Compartments + Segments + EvidenceSets + AttributionManifests +
 *   (B6 ContinuitySnapshot when closing) + (B7 MemoryAssessmentDeltas) +
 *   the Session-local processed cursor + HistorianPublication +
 *   the authoritative publication_outbox row.
 *
 * Invariants:
 *  - publicationSequence is allocated as MAX+1 ONLY inside the final commit
 *    transaction — never pre-allocated before model calls;
 *  - deterministic publication ID, processing key and output hash;
 *  - previous publication / session cursor chain;
 *  - outbox state machine pending → delivering → delivered / retry_wait /
 *    quarantined; claim lease expiry recovery; never deleted or marked
 *    delivered before the Router ACK;
 *  - this IS the only durable publication outbox (no second Memory Client
 *    durable outbox);
 *  - model / parse / repair / source-validation / transaction failure →
 *    cursor does not advance, no Publication, no outbox row.
 *
 * The service is wired as the B3 runner's commit hook: it runs INSIDE the
 * runner's BEGIN..COMMIT, so a throw rolls the whole transaction back.
 */

/** 确定性 RFC-4122 UUID(sha1(namespace || name),version 5 + variant 10)。
 * 满足 0.2.0 schema 的 format: uuid,且跨重启稳定(publication 幂等键)。 */
export function deterministicUuid(name: string): string {
  const NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8"; // DNS namespace
  const nsBytes = [...Buffer.from(NAMESPACE.replaceAll("-", ""), "hex")];
  const nameBytes = [...Buffer.from(name, "utf8")];
  const digest = createHash("sha1")
    .update(Buffer.from([...nsBytes, ...nameBytes]))
    .digest();
  const bytes = Array.from(digest.subarray(0, 16));
  const b6 = bytes[6];
  const b8 = bytes[8];
  if (b6 === undefined || b8 === undefined) {
    throw new Error("deterministicUuid: digest too short");
  }
  bytes[6] = (b6 & 0x0f) | 0x50; // version 5
  bytes[8] = (b8 & 0x3f) | 0x80; // variant 10
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export type OutboxState = "pending" | "delivering" | "retry_wait" | "delivered" | "quarantined";

export interface PublicationRecord {
  publicationSequence: number;
  publicationId: string;
  runtimeSessionId: string;
  processingKey: string;
  outputHash: string;
  compartmentIds: string[];
  segmentIds: string[];
  evidenceSetIds: string[];
  assessmentDeltaIds: string[];
  continuitySnapshotId: string | null;
  previousPublicationSequence: number | null;
  previousSessionProcessedThroughEntrySeq: number;
  state: OutboxState;
  attemptCount: number;
  claimLeasedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OutboxRow {
  outboxSequence: number;
  publicationId: string;
  runtimeSessionId: string;
  payloadHash: string;
  /** R4:完整 historian-publication-v2 envelope(投递到 iris_memory)。 */
  payloadJson: string | null;
  state: OutboxState;
  attemptCount: number;
  lastErrorCode: string | null;
  claimLeasedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicationServiceOptions {
  store: HistorianStore;
  /**
   * R3 (anti-echo)：Context lineage 窄读取端口。提供时,commitSafePrefix
   * 会把 Session-safe-prefix 的 entrySeq 范围映射到 Context 单元视图并
   * 传入 buildCompartment → EvidenceSet 携带 evidenceBasis/derivedOnly。
   * 缺省 = 旧行为(无 anti-echo 分类,向后兼容)。
   */
  historyPort?: ContextHistoryReadPort;
  nowMs?: () => number;
  /** Router claim lease TTL (ms). Default 60s. */
  claimLeaseMs?: number;
  /**
   * Recall projections for the invocation(s) covered by this publication
   * (B7). When provided, MemoryAssessmentDeltas are derived from THIS
   * publication's new Evidence and committed in the SAME transaction.
   */
  recallProjections?: InvocationMemoryRecallProjection[];
}

/** The commit hook the B3 runner invokes INSIDE its transaction. */
export function createPublicationCommitHook(options: PublicationServiceOptions): RunnerCommitHook {
  const service = new PublicationService(options);
  return {
    commitSafePrefix: (input) => {
      service.commitSafePrefix(input);
    },
  };
}

/**
 * iris_agent#45: typed fail-closed error for publications whose Context
 * provenance is missing or fabricated. Thrown BEFORE any row is written, so
 * the enclosing transaction rolls back and the job retries/exhausts with a
 * durable diagnosable intent (iris_agent#53 machinery).
 */
export class HistorianProvenanceError extends Error {
  readonly runtimeSessionId: string;

  constructor(runtimeSessionId: string, message: string) {
    super(`historian provenance (iris_agent#45): ${message}`);
    this.name = "HistorianProvenanceError";
    this.runtimeSessionId = runtimeSessionId;
  }
}

/**
 * iris_agent#45: canonical Context range hash over the EXACT ordered unit
 * identities of the committed batch (contextSeq asc, then unit id for full
 * determinism). Includes contextSeq, contextUnitId, runtimeEventId and
 * contentHash — any change to the committed batch changes the hash. When
 * unit views are absent but basis refs exist, the basis refs define the
 * membership (ordered by contextSeq, then contextUnitId).
 */
export function canonicalUnitRangeHash(
  units: HistorianUnitView[],
  basis: EvidenceBasisRef[],
): string {
  const ordered = [...units]
    .sort((a, b) => a.contextSeq - b.contextSeq || (a.contextUnitId < b.contextUnitId ? -1 : 1))
    .map((x) => ({
      contextSeq: x.contextSeq,
      contextUnitId: x.contextUnitId,
      runtimeEventId: x.runtimeEventId,
      contentHash: x.contentHash,
    }));
  const orderedBasis = [...basis]
    .sort((a, b) => a.contextSeq - b.contextSeq || (a.contextUnitId < b.contextUnitId ? -1 : 1))
    .map((x) => ({
      contextSeq: x.contextSeq,
      contextUnitId: x.contextUnitId,
      runtimeEventId: x.runtimeEventId,
      contentHash: x.contentHash,
    }));
  return createHash("sha256")
    .update(JSON.stringify(ordered.length > 0 ? ordered : orderedBasis), "utf8")
    .digest("hex");
}

export class PublicationService {
  private readonly store: HistorianStore;
  private readonly nowMs: () => number;
  private readonly claimLeaseMs: number;
  private readonly recallProjections: InvocationMemoryRecallProjection[];
  private readonly historyPort: ContextHistoryReadPort | undefined;

  constructor(options: PublicationServiceOptions) {
    this.store = options.store;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.claimLeaseMs = options.claimLeaseMs ?? 60_000;
    this.recallProjections = options.recallProjections ?? [];
    this.historyPort = options.historyPort;
  }

  /**
   * Runs INSIDE the runner's transaction. Builds the compartment from the
   * verified safe prefix, persists compartments/segments/evidence/manifest,
   * allocates the NEXT publicationSequence (MAX+1 — never pre-allocated),
   * inserts the HistorianPublication row and the authoritative outbox row.
   * Throws on failure → the whole transaction rolls back (cursor never
   * advances, no Publication, no outbox row).
   */
  commitSafePrefix(input: {
    runtimeSessionId: string;
    boundary: HistorianBoundarySnapshot;
    safePrefix: SequencedSessionEntry[];
    analysis: HistorianAnalysisView;
    outcome: Extract<ValidationOutcome, { ok: true }>;
    /** The durable cursor BEFORE this commit (chain metadata). */
    previousProcessedThroughEntrySeq: number;
  }): void {
    const { runtimeSessionId, boundary, safePrefix, analysis, outcome } = input;

    // iris_agent#45: production Historian CANNOT publish without the
    // Context-owned read/claim port. The old Session-semantic fallback
    // (no unit views, Session-derived provenance) is prohibited by v13 —
    // fail closed instead of degrading.
    if (this.historyPort === undefined) {
      throw new HistorianProvenanceError(
        runtimeSessionId,
        `cannot publish without a ContextHistoryReadPort (iris_agent#45 fail closed) ` +
          `for session ${runtimeSessionId}`,
      );
    }

    // Build the immutable compartment from the VERIFIED safe prefix.
    const nextSequence = this.store.maxCompartmentSequence(runtimeSessionId) + 1;

    // R3 (anti-echo):把 Context-safe-prefix 的 contextSeq 范围映射到单元窄
    // 视图,使 EvidenceSet 携带 evidenceBasis/derivedOnly(derived-only 内容
    // 不产生新 Evidence)。iris_agent#76: the mapping is CONTEXT coordinates
    // (lineage + global contextSeq) — never a Session entrySeq window.
    // Entries without a contextSeq attribution (legacy/recovery readers)
    // fall back to the ordinal, mirroring the freeze/validate fallback.
    let unitViews: HistorianUnitView[] | undefined;
    if (safePrefix.length > 0) {
      const first = safePrefix[0];
      const last = safePrefix[safePrefix.length - 1];
      const firstContextSeq = first?.contextSeq ?? first?.entrySeq;
      const lastContextSeq = last?.contextSeq ?? last?.entrySeq;
      if (firstContextSeq !== undefined && lastContextSeq !== undefined) {
        unitViews = this.historyPort.listUnitsForHistorian(
          this.historyPort.lineageId(),
          firstContextSeq,
          lastContextSeq,
        );
      }
    }
    const built = buildCompartment({
      runtimeSessionId,
      compartmentSequence: nextSequence,
      boundary,
      eligibleEntries: safePrefix,
      analysis,
      commitThroughEntrySeq: outcome.commitThroughEntrySeq,
      ...(unitViews !== undefined ? { unitViews } : {}),
    });
    if (built === null) {
      // No eligible entries in the safe prefix — nothing to publish. This is
      // NOT a failure (nothing new); the runner still advances the cursor.
      return;
    }

    this.store.insertCompartment(built.compartment);
    this.store.insertSegments(built.segments);
    this.store.insertEvidenceSet(built.evidence);
    this.store.insertAttributionManifest(built.attributionManifest);

    // Deterministic publication identity + processing key + output hash.
    // The publicationSequence is allocated ONCE here (MAX+1 in-transaction);
    // the same value is used for the assessment deltas so the chain stays
    // strictly increasing with no gaps.
    const publicationSequence = this.nextPublicationSequence();
    const publicationId = `publication-${runtimeSessionId}-${publicationSequence}`;

    // B7: MemoryAssessmentDeltas derived from THIS publication's new raw
    // Evidence (never old evidence; only recalled targets; deduplicated).
    const assessmentDeltas =
      this.recallProjections.length === 0
        ? []
        : deriveMemoryAssessments({
            runtimeSessionId,
            publicationSequence,
            newEvidenceSets: [built.evidence],
            recallProjections: this.recallProjections,
            nowMs: this.nowMs,
          });
    for (const delta of assessmentDeltas) {
      this.store.insertAssessmentDelta(delta);
    }

    const processingKey = `${runtimeSessionId}:${built.compartment.startEntrySeq}:${built.compartment.endEntrySeq}:${built.compartment.sourceRangeHash}`;
    const outputHash = createHash("sha256")
      .update(
        `${processingKey}:${built.compartment.content}:${built.evidence.entries.map((e) => e.entryId).join(",")}`,
        "utf8",
      )
      .digest("hex");

    const now = new Date(this.nowMs()).toISOString();

    const publication: PublicationRecord = {
      publicationSequence,
      publicationId,
      runtimeSessionId,
      processingKey,
      outputHash,
      compartmentIds: [built.compartment.compartmentId],
      segmentIds: built.segments.map((segment) => segment.segmentId),
      evidenceSetIds: [built.evidence.evidenceSetId],
      assessmentDeltaIds: assessmentDeltas.map((delta) => delta.assessmentId),
      continuitySnapshotId: null,
      previousPublicationSequence: this.previousPublicationSequence(runtimeSessionId),
      // The cursor BEFORE this commit (the runner passed it from the
      // pre-transaction state — never the already-upserted value).
      previousSessionProcessedThroughEntrySeq: input.previousProcessedThroughEntrySeq,
      state: "pending",
      attemptCount: 0,
      claimLeasedUntil: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertPublication(publication);

    this.store.insertOutboxRow({
      publicationId,
      runtimeSessionId,
      payloadHash: outputHash,
      payloadJson: this.buildPublicationEnvelope(built, nextSequence, now, unitViews),
      state: "pending",
      attemptCount: 0,
      lastErrorCode: null,
      claimLeasedUntil: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * R4 (iris_memory#6):构建 historian-publication-v2 envelope —— Memory
   * Client 投递到 iris_memory /historian/publications 的完整 payload。
   * 字段与 iris-memory-contracts 0.2.0 的 historian-publication-v2 schema
   * 对齐(evidenceBasis/derivedOnly 来自 anti-echo 分类)。
   */
  private buildPublicationEnvelope(
    built: BuiltCompartment,
    publicationSequence: number,
    now: string,
    unitViews?: HistorianUnitView[],
  ): string {
    const evidence = built.evidence;
    // Defense in depth: commitSafePrefix already requires the port; the
    // builder itself never runs without one.
    if (this.historyPort === undefined) {
      throw new HistorianProvenanceError(
        built.compartment.runtimeSessionId,
        "cannot build a Publication without a ContextHistoryReadPort (iris_agent#45 fail closed)",
      );
    }
    const basis =
      evidence.evidenceBasis !== undefined
        ? evidence.evidenceBasis.map((ref) => ({
            contextUnitId: ref.contextUnitId,
            contextSeq: ref.contextSeq,
            runtimeEventId: ref.runtimeEventId,
            contentHash: ref.contentHash,
            historianDisposition: ref.historianDisposition,
            ...(ref.derivationRefs !== undefined ? { derivationRefs: ref.derivationRefs } : {}),
          }))
        : [];
    // contextRange 覆盖本批 Context 单元(unitViews 优先;退化到 basis)。
    // iris_agent#45: 两者皆空 = 没有任何已提交 Context 批 → FAIL CLOSED
    // (绝不伪造 1..1 范围)。
    const rangeSeqs = (unitViews ?? []).map((u) => u.contextSeq);
    const basisSeqRefs = basis.map((b) => b.contextSeq);
    if (rangeSeqs.length === 0 && basisSeqRefs.length === 0) {
      throw new HistorianProvenanceError(
        built.compartment.runtimeSessionId,
        `no committed Context units or basis refs for the claimed batch ` +
          `(session ${built.compartment.runtimeSessionId}); refusing to fabricate a Context range`,
      );
    }
    const fromContextSeq =
      rangeSeqs.length > 0 ? Math.min(...rangeSeqs) : Math.min(...basisSeqRefs);
    const toContextSeq = rangeSeqs.length > 0 ? Math.max(...rangeSeqs) : Math.max(...basisSeqRefs);
    // iris_agent#45: rangeHash = canonical hash of the EXACT ordered unit
    // identities (contextSeq, unitId, runtimeEventId, contentHash) — never
    // the Session source-range hash.
    const rangeHash = canonicalUnitRangeHash(unitViews ?? [], basis);
    const lineageId = this.historyPort.lineageId();

    // iris_memory#11 (2026-08-08 Graphiti-ready boundary): the envelope is
    // built from ONE deterministic episode source over the batch's ordered
    // Context units, with the canonical provider-visible payloads read via
    // the narrow port view (values-only; raw archives are never touched).
    const payloadUnits = this.historyPort.listUnitsWithPayload(
      lineageId,
      fromContextSeq,
      toContextSeq,
    );
    if (payloadUnits.length === 0) {
      // unitViews/basis 非空但 payload 视图为空 = 物化边界不一致 → FAIL CLOSED
      // (绝不发布无内容 episode)。
      throw new HistorianProvenanceError(
        built.compartment.runtimeSessionId,
        `no payload units in [${fromContextSeq}..${toContextSeq}] for lineage ` +
          `${lineageId}; refusing to publish an empty episode source`,
      );
    }
    const timestamps = payloadUnits
      .map((unit) => unit.payloadTimestamp)
      .filter((t): t is string => typeof t === "string" && t.length > 0);
    const startedAt = timestamps.length > 0 ? timestamps[0] : now;
    const endedAt = timestamps.length > 0 ? timestamps[timestamps.length - 1] : now;
    const memoryRefs = [...new Set(basis.flatMap((ref) => ref.derivationRefs?.memoryRefs ?? []))];
    const derivedOnly = evidence.derivedOnly ?? basis.length === 0;
    // iris_agent#76/#11: the wire compartment identity is lineage-scoped and
    // Session-boundary-independent (the historian.db-internal id embeds the
    // runtime session for local bookkeeping only and never reaches Memory).
    const wireCompartmentId = `compartment:${lineageId}:${built.compartment.compartmentSequence}`;
    // iris_memory#14: partition the payload units into focused episode sources
    // by semantic category, instead of one giant batch-wide episode. Each
    // partition is deterministic (same units -> same partition), preserves
    // ordered Context provenance, and carries v2 focused metadata.
    const episodeSources = partitionEpisodeSources(
      payloadUnits,
      lineageId,
      fromContextSeq,
      toContextSeq,
      rangeHash,
      wireCompartmentId,
      memoryRefs,
      derivedOnly,
      now,
    );

    const envelopeBase = {
      schemaVersion: "historian-publication-v3",
      // 0.3.0 schema 要求 format: uuid;确定性派生(sha256 of
      // session:seq)保证跨重启稳定、可被 iris_memory 强校验通过。
      publicationId: deterministicUuid(
        `iris:historian-publication:${built.compartment.runtimeSessionId}:${publicationSequence}`,
      ),
      sourceSequence: publicationSequence,
      publishedAt: now,
      contractVersion: "0.3.0",
      projectionVersion: "graphiti-0.29.2",
      lineageId,
      contextRange: {
        contextLineageId: lineageId,
        fromContextSeq,
        toContextSeq,
        rangeHash,
      },
      compartmentRevisions: [
        {
          compartmentId: wireCompartmentId,
          sequence: built.compartment.compartmentSequence,
          headContextSeq: toContextSeq,
          summary: built.compartment.content.slice(0, 4000),
          memoryRefs,
        },
      ],
      episodeSources,
      derivationSummary: {
        derivedOnly,
        memoryRefs,
      },
      temporal: { startedAt, endedAt },
    };
    // iris_agent#45: payloadHash = canonical sha256 over the COMPLETE
    // versioned payload, with the payloadHash field blanked (documented
    // no-self-reference rule). Any provenance change (basis, disposition,
    // content hash, derivation refs, range, summary) changes it.
    const payloadHash = createHash("sha256")
      .update(canonicalJson({ ...envelopeBase, payloadHash: "" }), "utf8")
      .digest("hex");
    const envelope = { ...envelopeBase, payloadHash };
    return JSON.stringify(envelope);
  }

  /** publicationSequence = MAX(publication_sequence)+1 (in-transaction). */
  private nextPublicationSequence(): number {
    const row = this.store
      .raw()
      .prepare("SELECT MAX(publication_sequence) AS max_seq FROM publications")
      .get() as { max_seq: number | null } | undefined;
    return (row?.max_seq ?? 0) + 1;
  }

  /** The previous publication sequence for the Session (chain). */
  private previousPublicationSequence(runtimeSessionId: string): number | null {
    const row = this.store
      .raw()
      .prepare(
        "SELECT MAX(publication_sequence) AS max_seq FROM publications WHERE runtime_session_id = ?",
      )
      .get(runtimeSessionId) as { max_seq: number | null } | undefined;
    return row?.max_seq ?? null;
  }

  /**
   * Claim a batch of undelivered outbox rows (state pending/retry_wait with
   * an expired lease, or delivering with an EXPIRED lease = crashed claim).
   * Leases make delivery crash-recoverable: a claim that dies mid-delivery
   * is re-claimed after its lease expires.
   */
  claimBatch(input: { batchSize: number }): OutboxRow[] {
    const now = this.nowMs();
    const rows = this.store
      .raw()
      .prepare(
        "SELECT outbox_sequence, publication_id, runtime_session_id, payload_hash, payload_json, state, " +
          "attempt_count, last_error_code, claim_leased_until, created_at, updated_at " +
          "FROM publication_outbox " +
          "WHERE state IN ('pending','retry_wait','delivering') AND " +
          "(claim_leased_until IS NULL OR claim_leased_until < ?) " +
          "ORDER BY outbox_sequence ASC LIMIT ?",
      )
      .all(nowIso(now), input.batchSize) as unknown as Array<{
      outbox_sequence: number;
      publication_id: string;
      runtime_session_id: string;
      payload_hash: string;
      payload_json: string | null;
      state: OutboxState;
      attempt_count: number;
      last_error_code: string | null;
      claim_leased_until: string | null;
      created_at: string;
      updated_at: string;
    }>;
    const leasedUntil = new Date(now + this.claimLeaseMs).toISOString();
    const update = this.store
      .raw()
      .prepare(
        "UPDATE publication_outbox SET state = 'delivering', claim_leased_until = ?, updated_at = ? WHERE outbox_sequence = ?",
      );
    for (const row of rows) {
      update.run(leasedUntil, new Date(now).toISOString(), row.outbox_sequence);
    }
    return rows.map((row) => ({
      outboxSequence: row.outbox_sequence,
      publicationId: row.publication_id,
      runtimeSessionId: row.runtime_session_id,
      payloadHash: row.payload_hash,
      payloadJson: row.payload_json,
      state: "delivering",
      attemptCount: row.attempt_count,
      lastErrorCode: row.last_error_code,
      claimLeasedUntil: leasedUntil,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * iris_agent#64:delivered 只能由**验证过绑定身份**的 Memory receipt 授权
   * (publicationId + canonicalPayloadHash + contractVersion 全部匹配)。
   * 持久化完整绑定(不只是 hash),供 reclaim 授权与审计使用。
   */
  markDelivered(input: { publicationId: string; receipt: MemoryAcceptanceReceipt }): void {
    const now = new Date(this.nowMs()).toISOString();
    this.store
      .raw()
      .prepare(
        "UPDATE publication_outbox SET state = 'delivered', claim_leased_until = NULL, updated_at = ? WHERE publication_id = ?",
      )
      .run(now, input.publicationId);
    this.store
      .raw()
      .prepare(
        `UPDATE publications SET
           state = 'delivered', delivered_at = ?, delivered_receipt_hash = ?,
           delivered_receipt_id = ?, delivered_receipt_schema_version = ?,
           delivered_receipt_publication_id = ?,
           delivered_canonical_payload_hash = ?,
           delivered_contract_version = ?,
           delivered_duplicate_replay = ?,
           updated_at = ?
         WHERE publication_id = ?`,
      )
      .run(
        now,
        input.receipt.schemaVersion === "duplicate-replay-receipt-v2"
          ? `dup:${input.receipt.originalPublicationId}`
          : input.receipt.receiptId,
        input.receipt.schemaVersion === "duplicate-replay-receipt-v2"
          ? `dup:${input.receipt.originalPublicationId}`
          : input.receipt.receiptId,
        input.receipt.schemaVersion,
        input.receipt.schemaVersion === "duplicate-replay-receipt-v2"
          ? input.receipt.originalPublicationId
          : input.receipt.publicationId,
        input.receipt.schemaVersion === "duplicate-replay-receipt-v2"
          ? input.receipt.originalCanonicalPayloadHash
          : input.receipt.canonicalPayloadHash,
        input.receipt.schemaVersion === "duplicate-replay-receipt-v2"
          ? input.receipt.originalContractVersion
          : input.receipt.contractVersion,
        input.receipt.status === "duplicate_replay" ? 1 : 0,
        now,
        input.publicationId,
      );
  }

  /**
   * Mark a claimed publication failed (retry_wait up to attempts, then
   * quarantined).
   *
   * R3-P3 修复（R3-P0 oracle 审查标记）：retry_wait 必须携带未来退避 lease
   * （now + exponential backoff(attempt)），而不是 NULL。若为 NULL，
   * claimBatch 的 `claim_leased_until IS NULL` 分支会立即重新认领该行，
   * 产生无退避热循环。quarantined 不可认领（state 不在 claimBatch 候选），
   * lease 置 NULL 以便审计读取干净。
   */
  markFailed(input: { publicationId: string; errorCode: string; maxAttempts?: number }): void {
    const nowMs = this.nowMs();
    const now = new Date(nowMs).toISOString();
    const row = this.store
      .raw()
      .prepare("SELECT attempt_count FROM publication_outbox WHERE publication_id = ?")
      .get(input.publicationId) as { attempt_count: number } | undefined;
    const attempts = (row?.attempt_count ?? 0) + 1;
    const maxAttempts = input.maxAttempts ?? 8;
    const nextState = attempts >= maxAttempts ? "quarantined" : "retry_wait";
    // retry_wait → 未来退避 lease；quarantined → NULL（不可认领）。
    const claimLeasedUntil =
      nextState === "retry_wait"
        ? new Date(nowMs + this.retryBackoffMs(attempts)).toISOString()
        : null;
    this.store
      .raw()
      .prepare(
        "UPDATE publication_outbox SET state = ?, attempt_count = ?, last_error_code = ?, claim_leased_until = ?, updated_at = ? WHERE publication_id = ?",
      )
      .run(nextState, attempts, input.errorCode, claimLeasedUntil, now, input.publicationId);
    this.store
      .raw()
      .prepare(
        "UPDATE publications SET state = ?, attempt_count = ?, updated_at = ? WHERE publication_id = ?",
      )
      .run(nextState, attempts, now, input.publicationId);
  }

  /** 指数退避（毫秒）：attempt 1 → 1s，attempt 2 → 2s … 上限 5 分钟。 */
  private retryBackoffMs(attempt: number): number {
    return Math.min(1_000 * 2 ** (attempt - 1), 5 * 60_000);
  }
}

function nowIso(now: number): string {
  return new Date(now).toISOString();
}
