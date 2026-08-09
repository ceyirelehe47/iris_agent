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
import type { HistorianStore } from "./historian-store.js";
import { HistorianQueue, HistorianWorker, type HistorianJob } from "./historian-queue.js";
import {
  unitsToSequencedEntries,
  HistorianRunner,
  unprocessedFromContextSeq,
  type RunnerCommitHook,
} from "./historian-runner.js";
import { freezeBoundary, type LineageBoundaryInput } from "./historian-boundary.js";

/** iris_agent#76: freeze-head probe ceiling in CONTEXT coordinates. The
 * claim clamps to the store's actual max contextSeq, so this is only a
 * bound for the freeze's head observation (never a batch ceiling). */
const MAX_FREEZE_HEAD_CONTEXT_SEQ = Number.MAX_SAFE_INTEGER;
import { buildAnalysisView, validateRange } from "./historian-analysis.js";
import { PublicationService } from "./historian-publication.js";
import { runWrapup } from "./historian-continuity.js";
import { createCompactionAuthorizer, type CompactionAuthorization } from "./compaction-trigger.js";
import type { ContextHistoryReadPort } from "../context/history-read-port.js";
import type { MemoryClientPort } from "../contracts/ports.js";
/**
 * R3 Historian product integration (issue #8 Phase B Feature B8).
 *
 * One HistorianManager per Host, wiring the B1-B7 capability layers into
 * the Host lifecycle:
 *  - active incremental trigger: after every settled turn the manager
 *    freezes the current Session head and enqueues a `highest` job
 *    (pressure-critical incremental);
 *  - rollover wrapup: on rollover the OLD Session is finalized via a
 *    `normal` wrapup job — rollover does NOT wait for it;
 *  - closed Session retry: at startup the manager scans for closed /
 *    closed_incomplete Sessions with unconsumed snapshots and re-enqueues
 *    `low` retries;
 *  - publication outbox claim/delivery: a background loop claims pending
 *    rows (with lease expiry recovery) and marks delivered/failed;
 *  - shutdown: drain the queue and close the store;
 *  - health/readiness: queue + store counters.
 *
 * Boundaries: the manager NEVER reads Context m0/m1/LKG; it reads Session
 * entries only through the RuntimeSessionHistoryReadPort; it NEVER writes
 * the Pi Session; it never creates a second durable outbox.
 */

export interface HistorianManagerOptions {
  store: HistorianStore;
  /** Model/provider profile for boundary freeze. */
  modelProviderProfile: string;
  nowMs?: () => number;
  claimLeaseMs?: number;
  maxQueuedJobs?: number;
  maxAttempts?: number;
  /**
   * R3-P4 + iris_agent#66: the Context-owned history read/claim port. THIS
   * is the Historian's normal semantic input (committed Context units,
   * contextSeq order); construction REQUIRES it (fail-closed — a Historian
   * without Context input cannot exist in production). Pi Session access is
   * not part of the normal path.
   */
  historyPort: ContextHistoryReadPort;
  /** Optional per-invocation recall projections for B7 assessments. */
  recallProjectionsFor?: (
    runtimeSessionId: string,
  ) => import("./historian-assessment.js").InvocationMemoryRecallProjection[];
  /**
   * iris_agent#53: terminal-successor registry bound (defaults to
   * maxQueuedJobs). The successors map is memory too: it gets its own
   * explicit capacity model.
   */
  maxSuccessors?: number;
  /**
   * iris_agent#53: durable-backlog refill batch size — how many closing
   * sessions are re-admitted per refill pass, FIFO by finalization intent
   * time (fair and deterministic).
   */
  durableRefillBatchSize?: number;
  /**
   * R4: Memory Client (投递 publication 到 iris_memory)。缺省 = 未接线:
   * iris_agent#46 —— outbox 行永不标记 delivered,health.memoryDelivery
   * 报 "unavailable";只有真实 receipt 才授权 delivered / reclaim。
   */
  memoryClient?: MemoryClientPort;
}

export interface HistorianHealth {
  ready: boolean;
  queue: ReturnType<HistorianQueue["stats"]>;
  sessionCount: number;
  publicationCount: number;
  outboxPending: number;
  /**
   * iris_agent#53: scheduler saturation in [0,1] — (pending + running +
   * successors) / maxQueuedJobs. 1 means the in-memory scheduler is full;
   * new finalization intents are being deferred to the durable backlog.
   */
  saturation: number;
  /** iris_agent#53: durable finalization intents awaiting completion. */
  durableBacklog: number;
  /** iris_agent#53: age in ms of the oldest pending finalization intent (0 when none). */
  oldestFinalizationIntentAgeMs: number;
  /** iris_agent#53: permanently failed (retry-exhausted) jobs. */
  retryExhausted: number;
  /**
   * iris_agent#46: Memory Client wiring state. "unavailable" means outbox
   * rows can NEVER be marked delivered (no fabricated receipts) and stay
   * retryable; "configured" means delivery is possible.
   */
  memoryDelivery: "configured" | "unavailable";
  /** iris_agent#46: count of caught delivery exceptions (never unhandled). */
  deliveryErrors: number;
  /** iris_agent#46: most recent delivery error (diagnostics). */
  lastDeliveryError: string | undefined;
}

export class HistorianManager {
  private readonly store: HistorianStore;
  private readonly historyPort: ContextHistoryReadPort;
  private readonly modelProviderProfile: string;
  private readonly nowMs: () => number;
  private readonly queue: HistorianQueue;
  private readonly worker: HistorianWorker;
  private readonly recallProjectionsFor: HistorianManagerOptions["recallProjectionsFor"];
  private readonly service: PublicationService;
  private readonly runner: HistorianRunner;
  private readonly memoryClient: MemoryClientPort | undefined;
  private readonly claimLeaseMs: number;
  /** iris_agent#53: successor-registry bound (memory model). */
  private readonly maxSuccessors: number;
  /** iris_agent#53: durable backlog refill batch size (fair, FIFO). */
  private readonly durableRefillBatchSize: number;
  private readonly maxQueuedJobs: number;
  private draining = false;
  private refilling = false;
  /** iris_agent#46: delivery diagnostics (no unhandled rejections). */
  private deliveryErrors = 0;
  private lastDeliveryError: string | undefined;

  constructor(options: HistorianManagerOptions) {
    this.store = options.store;
    // iris_agent#66: the Context-owned port is REQUIRED — a production
    // Historian must be constructed with its normal semantic input wired,
    // never a Pi Session port. Fail closed on missing wiring.
    if (options.historyPort === undefined) {
      throw new Error(
        "historian manager: ContextHistoryReadPort is required (iris_agent#66 — Historian's normal semantic input must be Context-owned committed units)",
      );
    }
    this.historyPort = options.historyPort;
    this.modelProviderProfile = options.modelProviderProfile;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.recallProjectionsFor = options.recallProjectionsFor;
    this.historyPort = options.historyPort;
    this.memoryClient = options.memoryClient;
    this.claimLeaseMs = options.claimLeaseMs ?? 60_000;
    this.maxQueuedJobs = options.maxQueuedJobs ?? 256;
    this.maxSuccessors = options.maxSuccessors ?? this.maxQueuedJobs;
    this.durableRefillBatchSize = options.durableRefillBatchSize ?? 16;
    this.queue = new HistorianQueue({
      maxQueuedJobs: this.maxQueuedJobs,
      maxSuccessors: this.maxSuccessors,
      maxAttempts: options.maxAttempts ?? 8,
      nowMs: this.nowMs,
      // iris_agent#65: persist retry accounting at the durable
      // finalization-intent boundary so exhaustion survives restart and
      // refill/recovery can never reset an exhausted finalizer to zero.
      onAttemptPersist: (runtimeSessionId, attempts) => {
        this.store.recordRetryAttempt(runtimeSessionId, attempts);
      },
      onExhausted: (job) => {
        this.store.markRetryExhausted(job.runtimeSessionId);
      },
    });
    this.service = new PublicationService({
      store: this.store,
      nowMs: this.nowMs,
      claimLeaseMs: this.claimLeaseMs,
      historyPort: this.historyPort,
    });
    const commitHook: RunnerCommitHook = {
      commitSafePrefix: (input) => {
        this.service.commitSafePrefix(input);
      },
    };
    this.runner = new HistorianRunner({
      store: this.store,
      historyPort: this.historyPort,
      commitHook,
    });
    this.worker = new HistorianWorker(this.queue, (job) => this.executeJob(job));
  }

  getStore(): HistorianStore {
    return this.store;
  }

  getService(): PublicationService {
    return this.service;
  }

  getQueue(): HistorianQueue {
    return this.queue;
  }

  /** Active incremental trigger: freeze the current Session head and
   * enqueue a highest-priority job (fire-and-forget — never blocks the Pi
   * main turn). The freeze reads the Session head through the read port. */
  async triggerIncremental(runtimeSessionId: string): Promise<boolean> {
    return this.enqueueIncremental(runtimeSessionId);
  }

  /**
   * R3-P1：lineage 感知的 active incremental trigger。冻结当前 Session head 并
   * 以 highest 优先级入队（fire-and-forget）。lineageBoundary（由
   * ContextHistoryReadPort 提供的物化边界）在 freeze 时 clamp eligible 范围：
   * 只有已进入 m0/m1 的 compartment 才可被 raw 替换（v13 m0-clamp 规格）。
   * lineageBoundary 缺省 = 纯 raw 语义（R3-P0 行为，与 triggerIncremental
   * 完全一致）。freeze-trigger 接线（vertical-slice）在 HARD fold 提交后经
   * 端口读取边界并调用本方法。
   */
  async enqueueIncremental(
    runtimeSessionId: string,
    lineageBoundary?: LineageBoundaryInput,
  ): Promise<boolean> {
    // R3-P4 B1 修复（v13 状态机不变量）：closing/closed 会话不再接收增量提交。
    // closing = wrapup 已入队（收尾中）；closed/closed_incomplete = 已终结；
    // corrupt = fail-closed（不可自动修复）。这些状态下入队增量会破坏
    // active→closing→closed 状态机（post-close 提交 / wedge 风险），拒绝并返回
    // false。只有 active 会话可以增量入队。
    const durable = this.store.getSessionState(runtimeSessionId);
    if (
      durable?.status === "closing" ||
      durable?.status === "closed" ||
      durable?.status === "closed_incomplete" ||
      durable?.status === "corrupt"
    ) {
      return false;
    }
    const frozen = await this.freezeCurrent(runtimeSessionId, lineageBoundary);
    if (frozen === null) {
      return false;
    }
    const state = durable ?? {
      runtimeSessionId,
      processedThroughEntrySeq: 0,
      status: "active" as const,
      updatedAt: new Date(this.nowMs()).toISOString(),
    };
    // iris_agent#53: highest-priority increments are never finalizers, so
    // they cannot be deferred; "refused" only occurs for manual jobs.
    return (
      this.queue.enqueue({
        priority: "highest",
        runtimeSessionId,
        boundary: frozen.snapshot,
        sessionState: state,
      }) !== "refused"
    );
  }

  /** Rollover wrapup: finalize the OLD Session at `normal` priority.
   * Returns immediately — rollover does NOT wait for the wrapup job.
   *
   * R3-P4 v13 状态机：wrapup 入队即持久化 status="closing"（closing 是收尾阶段，
   * 不可再接收 incremental 提交）；wrapup 任务的最终事务把 closing → closed /
   * closed_incomplete（与 ContinuitySnapshot 同事务）。 */
  async enqueueWrapup(runtimeSessionId: string): Promise<boolean> {
    const frozen = await this.freezeCurrent(runtimeSessionId);
    if (frozen === null) {
      return false;
    }
    const durable = this.store.getSessionState(runtimeSessionId) ?? {
      runtimeSessionId,
      processedThroughEntrySeq: 0,
      status: "active" as const,
      updatedAt: new Date(this.nowMs()).toISOString(),
    };
    // F5 (iris_agent#42 AC6): an already-finalized Session must not be moved
    // back to closing. Duplicate wrapup requests (e.g. a rollover racing a
    // completed finalization, or recovery re-enqueue) are idempotent no-ops —
    // the terminal transition already ran; re-writing closing would let the
    // next wrapup produce a SECOND ContinuitySnapshot.
    if (durable.status === "closed" || durable.status === "closed_incomplete") {
      return true;
    }
    const closing: HistorianSessionState = {
      ...durable,
      status: "closing",
      observedHeadEntrySeq: frozen.snapshot.observedHeadEntrySeq,
      ...(frozen.snapshot.observedHeadContextSeq !== undefined
        ? { observedHeadContextSeq: frozen.snapshot.observedHeadContextSeq }
        : {}),
      updatedAt: new Date(this.nowMs()).toISOString(),
    };
    this.store.upsertSessionState(closing);
    // iris_agent#53: a deferred_durable outcome is still success for the
    // caller — the authoritative closing intent IS durable and the backlog
    // refill re-admits the finalizer when the bounded scheduler has
    // capacity. Only a refusal (impossible for finalizers) means "not
    // arranged".
    const outcome = this.queue.enqueue({
      priority: "normal",
      runtimeSessionId,
      boundary: frozen.snapshot,
      sessionState: closing,
    });
    return outcome !== "refused";
  }

  /** Startup recovery: re-enqueue `low` retries for closed sessions whose
   * snapshots are unconsumed, plus any retry_wait outbox rows. F5
   * (iris_agent#42): `closing` sessions are ALSO recovered — a durable
   * closing transition must always have a guaranteed execution path, so a
   * crash after persisting closing but before the finalizer ran re-enqueues
   * the wrapup at `normal` (the terminal transition itself is idempotent:
   * runWrapup only writes closing → closed / closed_incomplete and its
   * ContinuitySnapshot atomically). */
  async recover(): Promise<void> {
    const sessions = this.store.listSessions();
    for (const session of sessions) {
      // iris_agent#65: a retry-exhausted session must not be re-admitted by
      // startup recovery — only explicit reactivation resumes it.
      if (session.retryExhaustedAt !== undefined) {
        continue;
      }
      if (session.status === "closed" || session.status === "closed_incomplete") {
        const frozen = await this.freezeCurrent(session.runtimeSessionId);
        if (frozen !== null && !frozen.nothingNew) {
          this.queue.enqueue({
            priority: "low",
            runtimeSessionId: session.runtimeSessionId,
            boundary: frozen.snapshot,
            sessionState: session,
          });
        }
      } else if (session.status === "closing") {
        // Durable closing intent: the wrapup must be re-enqueued (a running
        // non-finalizing job at crash time may have suppressed the successor,
        // or the successor never ran before the crash).
        const frozen = await this.freezeCurrent(session.runtimeSessionId);
        if (frozen !== null) {
          this.queue.enqueue({
            priority: "normal",
            runtimeSessionId: session.runtimeSessionId,
            boundary: frozen.snapshot,
            sessionState: session,
          });
        }
      }
    }
  }

  /** Drain ONE job (the background pump calls this repeatedly). */
  async pumpOnce(): Promise<void> {
    await this.worker.runOnce();
    // iris_agent#53: after the worker drains (or finds nothing runnable),
    // refill the bounded scheduler from the durable finalization backlog.
    await this.refill();
  }

  /**
   * Delivery loop (iris_agent#46): claim pending outbox rows and deliver via
   * the Memory Client. A row may become `delivered` ONLY from a validated
   * real acceptance/duplicate receipt returned by iris_memory and bound to
   * the exact publication idempotency identity — NEVER from a placeholder or
   * from the absence of a client.
   *
   * - No memoryClient: rows stay retryable (claim lease expires and the row
   *   is re-claimed); NOTHING is marked delivered; health/readiness exposes
   *   the missing client.
   * - Typed validation/version rejection → failed/quarantined by policy.
   * - Thrown network/client exceptions are caught, classified and recorded
   *   (no unhandled rejection); transient failures remain retryable.
   * - Returns metrics that distinguish claimed vs completed outcomes.
   */
  async drainOutbox(batchSize = 10): Promise<{
    claimed: number;
    accepted: number;
    rejected: number;
    deferred: number;
  }> {
    const batch = this.service.claimBatch({ batchSize });
    const metrics = { claimed: batch.length, accepted: 0, rejected: 0, deferred: 0 };
    if (this.memoryClient === undefined) {
      // iris_agent#46 P0: never fabricate receipts. Without a client every
      // claimed row is deferred — the claim lease expires and the row is
      // re-claimed later; it stays retryable and visible in health.
      metrics.deferred = batch.length;
      return metrics;
    }
    for (const row of batch) {
      if (row.payloadJson === undefined) {
        // 无 payload(旧行/未写 payload_json)→ 保留待重试,不误标 delivered。
        metrics.deferred += 1;
        continue;
      }
      const outcome = await this.deliverOne(row);
      if (outcome === "accepted") {
        metrics.accepted += 1;
      } else if (outcome === "rejected") {
        metrics.rejected += 1;
      } else {
        metrics.deferred += 1;
      }
    }
    return metrics;
  }

  /** 单条投递(await;失败分类记录,绝不 unhandled rejection)。 */
  private async deliverOne(row: {
    publicationId: string;
    payloadJson: string | null;
  }): Promise<"accepted" | "rejected" | "deferred"> {
    if (row.payloadJson === null) {
      return "deferred";
    }
    let publication: unknown;
    try {
      publication = JSON.parse(row.payloadJson);
    } catch {
      this.service.markFailed({
        publicationId: row.publicationId,
        errorCode: "invalid_payload_json",
        maxAttempts: 1,
      });
      return "rejected";
    }
    let outcome: Awaited<ReturnType<MemoryClientPort["deliverPublication"]>> | undefined;
    try {
      outcome = await this.memoryClient?.deliverPublication(publication);
    } catch (error) {
      // iris_agent#46 P0: a thrown client/network error must never become an
      // unhandled rejection. Classify it as transient — the row stays
      // `delivering` and the claim lease expiry re-claims it.
      this.recordDeliveryError(row.publicationId, error);
      return "deferred";
    }
    if (outcome === undefined) {
      return "deferred";
    }
    if (outcome.ok) {
      // iris_agent#64: ONLY a receipt bound to THIS exact Publication
      // authorizes `delivered`. The client already verified
      // publicationId + canonicalPayloadHash + contractVersion; the manager
      // re-checks the binding defensively: the receipt's publicationId must
      // equal the CONTRACT identity of the delivered envelope (the envelope's
      // publicationId — the idempotency key sent to Memory), not the
      // internal row key.
      const envelopePublicationId = (publication as { publicationId?: unknown }).publicationId;
      const receiptPublicationId =
        outcome.receipt.schemaVersion === "duplicate-replay-receipt-v2"
          ? outcome.receipt.originalPublicationId
          : outcome.receipt.publicationId;
      if (
        typeof envelopePublicationId !== "string" ||
        receiptPublicationId !== envelopePublicationId
      ) {
        // Receipt bound to a DIFFERENT publication (or to no envelope
        // identity) cannot ACK this row — fail closed into quarantine
        // (typed policy: mismatch is never retryable noise; it is a
        // service/contract violation).
        this.service.markFailed({
          publicationId: row.publicationId,
          errorCode: "memory_receipt_mismatch",
          maxAttempts: 1,
        });
        return "rejected";
      }
      this.service.markDelivered({
        publicationId: row.publicationId,
        receipt: outcome.receipt,
      });
      return "accepted";
    }
    if (outcome.error === "rejected") {
      this.service.markFailed({
        publicationId: row.publicationId,
        errorCode: "memory_rejected",
        maxAttempts: 1,
      });
      return "rejected";
    }
    // unavailable / http_5xx:保持 delivering,lease 过期后重认领。
    return "deferred";
  }

  /** iris_agent#46: 记录投递异常（无 unhandled rejection;诊断可见）。 */
  private recordDeliveryError(publicationId: string, error: unknown): void {
    this.deliveryErrors += 1;
    this.lastDeliveryError = `publication ${publicationId}: ${String(
      error instanceof Error ? error.message : error,
    )}`;
  }

  /** iris_agent#65: durable exhausted-finalizer count (health/readiness). */
  countExhaustedSessions(): number {
    return this.store.countExhaustedSessions();
  }

  /**
   * iris_agent#65: explicit operator/manual reactivation of a retry-exhausted
   * finalizer. Clears the durable exhaustion marker and the attempt counter,
   * then re-admits the finalization intent through the normal refill path —
   * the terminal transition (closing → closed / closed_incomplete) is
   * idempotent, so reactivation cannot duplicate Publication/snapshot/outbox
   * commits. Returns false when the session is unknown or not exhausted.
   * The returned promise resolves after the re-admission pass completes, so
   * callers can observe the fresh job deterministically.
   */
  async reactivateExhaustedSession(runtimeSessionId: string): Promise<boolean> {
    const cleared = this.store.reactivateExhaustedSession(runtimeSessionId);
    if (cleared) {
      // Re-admit through the durable backlog (fair FIFO path).
      await this.refill();
    }
    return cleared;
  }

  /** Health/readiness snapshot. */
  health(): HistorianHealth {
    const sessionCount = this.store.countSessions();
    const publicationCount = this.store.countPublications();
    const outboxPending = this.store.countOutboxPending();
    const stats = this.queue.stats();
    const occupancy = stats.pending + stats.running + stats.successors;
    const durableBacklog = this.store.countClosingSessions();
    const oldestIntentMs = this.store.oldestClosingRequestedAtMs();
    return {
      ready: !this.draining,
      queue: stats,
      sessionCount,
      publicationCount,
      outboxPending,
      // iris_agent#53: saturation in [0,1] against the in-memory scheduler
      // bound. 1 => new finalization intents defer to the durable backlog.
      saturation: this.maxQueuedJobs > 0 ? Math.min(1, occupancy / this.maxQueuedJobs) : 0,
      durableBacklog,
      oldestFinalizationIntentAgeMs:
        oldestIntentMs === undefined ? 0 : Math.max(0, this.nowMs() - oldestIntentMs),
      retryExhausted: this.store.countExhaustedSessions(),
      // iris_agent#46: missing Memory Client is visible in readiness; without
      // one, outbox rows can never be marked delivered.
      memoryDelivery: this.memoryClient === undefined ? "unavailable" : "configured",
      deliveryErrors: this.deliveryErrors,
      lastDeliveryError: this.lastDeliveryError,
    };
  }

  /**
   * iris_agent#53: fair, deterministic durable-backlog refill. Re-admits up
   * to `durableRefillBatchSize` closing sessions (FIFO by finalization
   * intent time, then session id) into the bounded scheduler, skipping
   * sessions that already have a pending/running/successor job. A deferred
   * finalization intent therefore always has a guaranteed execution path
   * without ever growing memory. Called when the worker drains a job.
   * Returns a promise so callers (pump loop and tests) can await the pass.
   */
  refill(): Promise<void> {
    if (this.refilling) {
      return Promise.resolve();
    }
    this.refilling = true;
    return (async () => {
      try {
        // iris_agent#65: refill reads ONLY closing sessions that are not
        // retry-exhausted — an exhausted finalizer must never be re-admitted
        // automatically with a fresh attempt budget.
        const closing = this.store.listClosingSessionsNotExhausted(this.durableRefillBatchSize);
        for (const session of closing) {
          if (this.queue.hasSession(session.runtimeSessionId)) {
            continue;
          }
          const frozen = await this.freezeCurrent(session.runtimeSessionId);
          if (frozen === null) {
            continue;
          }
          const outcome = this.queue.enqueue({
            priority: "normal",
            runtimeSessionId: session.runtimeSessionId,
            boundary: frozen.snapshot,
            sessionState: session,
          });
          if (outcome === "deferred_durable" || outcome === "refused") {
            // Capacity still full — stop this pass; the next pump refills.
            break;
          }
        }
      } finally {
        this.refilling = false;
      }
    })();
  }

  /** Recomp maintenance (manual priority). */
  async enqueueRecomp(runtimeSessionId: string): Promise<boolean> {
    const frozen = await this.freezeCurrent(runtimeSessionId);
    if (frozen === null) {
      return false;
    }
    const state = this.store.getSessionState(runtimeSessionId) ?? {
      runtimeSessionId,
      processedThroughEntrySeq: 0,
      status: "active" as const,
      updatedAt: new Date(this.nowMs()).toISOString(),
    };
    return (
      this.queue.enqueue({
        priority: "manual",
        runtimeSessionId,
        boundary: frozen.snapshot,
        sessionState: state,
      }) === "queued"
    );
  }

  /** Shutdown: stop draining, drain the queue, close the store. */
  close(): void {
    this.draining = true;
    this.store.close();
  }

  /**
   * R3-P4：Pi Session compaction 授权（v13 "只有已进入 m0/m1 的 compartment 才可
   * 替换 raw P5"）。cut = min(protectedTailStartEntrySeq - 1,
   * lineageMaterializedEntrySeq)——保护尾部 raw-inviolable，任何授权都绝不越过
   * protectedTailStartEntrySeq - 1；lineage 从未物化 → cut = 0（不授权）。
   * iris_agent#66: the authorizer consumes ONLY Context-owned values
   * (historyPort) + Historian boundary snapshots — no Pi Session read is
   * involved in the normal authorization path.
   */
  authorizeCompaction(runtimeSessionId: string): CompactionAuthorization {
    const authorizer = createCompactionAuthorizer({
      historyPort: this.historyPort,
      latestBoundaryFor: (sessionId) => this.store.listBoundarySnapshots(sessionId, 1)[0],
    });
    return authorizer.authorize(runtimeSessionId);
  }

  /**
   * R3-P4：在 wrapup 的最终事务内发布剩余未处理窗口（复用 B5
   * PublicationService.commitSafePrefix）。只发布 [cursor+1 ..
   * eligibleThroughEntrySeq] 的未处理 safe prefix（与 frozen sourceRangeHash
   * 同窗口）；validateRange 失败 → 本次 wrapup 只落快照（B3 语义：验证失败不
   * 推进、不发布）。recallProjectionsFor 提供的投影（若存在）在同一事务内派生
   * assessment delta。调用方必须在事务内调用本方法。
   */
  private commitWrapupPublication(input: {
    runtimeSessionId: string;
    boundary: HistorianBoundarySnapshot;
    eligible: SequencedSessionEntry[];
    state: HistorianSessionState;
  }): void {
    const unprocessedFrom = Math.max(1, (input.state.processedThroughEntrySeq ?? 0) + 1);
    const unprocessed = input.eligible.filter((e) => e.entrySeq >= unprocessedFrom);
    if (unprocessed.length === 0) {
      return; // 全部已发布 → 仅快照，不产生新 publication
    }
    const analysis = buildAnalysisView({
      runtimeSessionId: input.runtimeSessionId,
      boundary: input.boundary,
      eligibleEntries: unprocessed,
    });
    const outcome = validateRange({
      runtimeSessionId: input.runtimeSessionId,
      boundary: input.boundary,
      eligibleEntries: unprocessed,
      // iris_agent#76: same anchor as the freeze (durable contextSeq cursor
      // + 1, Context coordinates).
      unprocessedFromContextSeq: unprocessedFromContextSeq(input.state),
    });
    if (!outcome.ok) {
      return; // 边界漂移 → 本次 wrapup 只落快照（不推进、不发布）
    }
    const projections = this.recallProjectionsFor?.(input.runtimeSessionId) ?? [];
    const service =
      projections.length === 0
        ? this.service
        : new PublicationService({
            store: this.store,
            nowMs: this.nowMs,
            claimLeaseMs: this.claimLeaseMs,
            // iris_agent#45: the wrapup publication path needs the SAME
            // Context read/claim port as the incremental path (fail closed
            // otherwise — never publish from Session semantics).
            ...(this.historyPort !== undefined ? { historyPort: this.historyPort } : {}),
            recallProjections: projections,
          });
    service.commitSafePrefix({
      runtimeSessionId: input.runtimeSessionId,
      boundary: input.boundary,
      safePrefix: unprocessed.filter((e) => e.entrySeq <= outcome.commitThroughEntrySeq),
      analysis,
      outcome,
      previousProcessedThroughEntrySeq: input.state.processedThroughEntrySeq ?? 0,
    });
  }

  // ---- internals ----

  private async freezeCurrent(
    runtimeSessionId: string,
    lineageBoundary?: LineageBoundaryInput,
  ): Promise<{ snapshot: HistorianBoundarySnapshot; nothingNew: boolean } | null> {
    const state = this.store.getSessionState(runtimeSessionId);
    const processed = state?.processedThroughEntrySeq ?? 0;
    // iris_agent#84: the AUTHORITATIVE cursor is lineage-scoped. A Session
    // rollover creates a new runtime_session_id with no session_state row —
    // reading the session-scoped cursor would rewind to 0 and re-claim units
    // that Session A already processed. The lineage cursor persists across
    // rollover and is the sole source of truth for "where did this Iris
    // identity last commit to?"
    const lineageCursor = this.store.getLineageCursor(this.historyPort.lineageId());
    const processedContextSeq = lineageCursor?.processedThroughContextSeq ?? 0;
    // iris_agent#76: the freeze head comes from a CONTEXT claim (global
    // contextSeq, lineage-scoped) — never a Pi Session read and never an
    // entrySeq window. The claim starts AT the durable cursor (inclusive)
    // so a fully-processed lineage still yields a non-empty batch: the
    // freeze must observe the current head to conclude nothingNew and
    // finalize (F5 — a rollover wrapup must never be refused just because
    // the last incremental already committed everything). The batch's
    // below-cursor unit is excluded from the ordinal window, so the frozen
    // sourceRangeHash still covers ONLY the unprocessed range.
    const batch = this.historyPort.claimHistorianBatch({
      afterContextSeqExclusive: Math.max(0, processedContextSeq - 1),
      throughContextSeqInclusive: MAX_FREEZE_HEAD_CONTEXT_SEQ,
    });
    const entries = unitsToSequencedEntries(runtimeSessionId, batch.units);
    if (entries.length === 0) {
      return null;
    }
    const result = freezeBoundary({
      rawSeamInput: {
        runtimeSessionId,
        lineageId: this.historyPort.lineageId(),
        entries,
        processedThroughEntrySeq: processed,
        processedThroughContextSeq: processedContextSeq,
        // No fixed tail margin: the freeze's arc/in-flight seam logic is the
        // protected-tail authority (a fixed margin would leave short sessions
        // permanently nothing_new). The runner's validation re-verifies the
        // seam before any commit.
        tailMarginEntries: 0,
        modelProviderProfile: this.modelProviderProfile,
        frozenAt: new Date(this.nowMs()).toISOString(),
      },
      // R3-P1 m0-clamp：lineage 物化边界（存在时）在 freeze 内收紧 eligible
      // 范围——只有已进入 m0/m1 的 compartment 才可被 raw 替换。
      ...(lineageBoundary !== undefined ? { lineageBoundary } : {}),
    });
    return { snapshot: result.snapshot, nothingNew: result.nothingNew };
  }

  private async executeJob(job: HistorianJob): Promise<{ ok: boolean; errorCode?: string }> {
    const { runtimeSessionId, boundary, priority } = job;
    try {
      if (priority === "normal" || priority === "low") {
        // Wrapup / closed retry: finalize the Session + persist snapshot.
        // The durable state may not exist yet (a fresh wrapup enqueued
        // before any incremental commit) — use the job's frozen snapshot of
        // the state in that case.
        const state = this.store.getSessionState(runtimeSessionId) ?? job.sessionState;
        if (state === undefined) {
          return { ok: false, errorCode: "session_state_missing" };
        }
        // iris_agent#84: wrapup reads the AUTHORITATIVE lineage-scoped cursor,
        // not the session-scoped cursor. This ensures Session B's wrapup
        // correctly starts after A's committed contextSeq ceiling.
        const lineageId = this.historyPort.lineageId();
        const lineageCursor = this.store.getLineageCursor(lineageId);
        const wrapupCursor = lineageCursor?.processedThroughContextSeq ?? 0;
        // iris_agent#76: wrapup claims committed Context units through the
        // Context-owned port by global contextSeq (the frozen ceiling) —
        // never a Pi Session read, never an entrySeq window.
        const batch = this.historyPort.claimHistorianBatch({
          afterContextSeqExclusive: wrapupCursor,
          throughContextSeqInclusive: boundary.eligibleThroughContextSeq,
        });
        const eligible = unitsToSequencedEntries(runtimeSessionId, batch.units);
        const analysis = buildAnalysisView({
          runtimeSessionId,
          boundary,
          eligibleEntries: eligible,
        });
        // R3-P4 v13：wrapup 的最终事务 = session_state（cursor 载体 + 状态
        // 转移）+ continuity_snapshot + 最终 publication + outbox（+
        // assessment）在 ONE 事务内原子提交（B6 review #3 原子性的规格化）。
        // runWrapup(commit:false) 只写不提交；PublicationService 在同一事务
        // 内复用 B5 的 commitSafePrefix；任何一步失败 → 整事务回滚（cursor /
        // snapshot / publication 都不落盘）。
        this.store.begin();
        try {
          runWrapup({
            store: this.store,
            runtimeSessionId,
            state,
            boundary,
            eligibleEntries: eligible,
            analysis,
            nowMs: this.nowMs,
            commit: false,
          });
          this.commitWrapupPublication({ runtimeSessionId, boundary, eligible, state });
          // iris_agent#84: advance the lineage-scoped cursor atomically
          // with the wrapup transaction. The wrapup cursor was computed
          // from the lineage cursor (not session_state), so we persist it
          // back to ensure the lineage watermark stays correct.
          this.store.upsertLineageCursor(
            lineageId,
            boundary.eligibleThroughContextSeq,
            boundary.observedHeadContextSeq ?? boundary.eligibleThroughContextSeq,
          );
          this.store.commit();
        } catch (error) {
          this.store.rollback();
          throw error;
        }
        return { ok: true };
      }
      // highest / manual: incremental commit via the runner.
      const result = await this.runner.run({ runtimeSessionId, boundary });
      if (result.status === "validation_failed") {
        return { ok: false, errorCode: result.errorCode ?? "validation_failed" };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, errorCode: error instanceof Error ? error.message : "unknown" };
    }
  }
}

/**
 * iris_agent#53: map the configuration-backed historian.queue section onto
 * the bounded-scheduler options. Production assembly (Host) and tests both
 * go through this so the capacity model is single-sourced and tested at
 * boundary values. Missing keys fall back to the documented defaults.
 */
export function historianSchedulerOptions(
  config: import("../config/schema.js").HistorianConfig | undefined,
): Pick<
  HistorianManagerOptions,
  "maxQueuedJobs" | "maxSuccessors" | "maxAttempts" | "durableRefillBatchSize"
> {
  const queue = config?.queue;
  return {
    maxQueuedJobs: queue?.max_pending_jobs ?? 256,
    maxSuccessors: queue?.max_successors ?? queue?.max_pending_jobs ?? 256,
    maxAttempts: queue?.max_attempts ?? 8,
    durableRefillBatchSize: queue?.durable_refill_batch_size ?? 16,
  };
}
