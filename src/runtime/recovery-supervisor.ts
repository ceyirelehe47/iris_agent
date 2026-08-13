import type { AgentRuntimeEvent, AgentRuntimePort } from "../contracts/ports.js";
import type { AgentInput } from "../contracts/origin.js";

import {
  type FallbackConfig,
  type PendingOutcomeUnknown,
  type RecoveryStateSnapshot,
  type RetryClassification,
  DurableOutcomeResolutionStore,
  freshRecoveryState,
} from "./recovery-state.js";

/**
 * iris_agent#68: Runtime Recovery Supervisor.
 *
 * Sits BETWEEN the Host and RuntimeCoordinator, wrapping the existing
 * `prompt()` call. It does NOT call provider APIs directly — it delegates to a
 * RuntimeCoordinator (AgentRuntimePort) which delegates to Pi. The supervisor
 * observes the `AgentRuntimeEvent` stream and native failure signals, and
 * enforces higher-level escalation bounds that Pi's own native retry loop does
 * not cover:
 *
 *   Host → RecoverySupervisor → RuntimeCoordinator → PiRuntimeAdapter → Pi
 *
 * Responsibilities:
 * 1. Bounded same-model retry escalation (budget=3, backoff 2s/4s/8s).
 * 2. Provider/model fallback chain (budget=3, cooldown=60s).
 * 3. Fallback no-progress watchdog (30s).
 * 4. Subagent first-progress watchdog (90s).
 * 5. Reserved dispatch retry (6 linear retries).
 * 6. outcome_unknown reconciliation before replay.
 * 7. Durable recovery state (survives restart/rollover).
 * 8. Overall recovery budget (10min).
 *
 * Design rules:
 * - The supervisor never calls provider APIs; it only retries model computation
 *   by re-invoking the RuntimeCoordinator.
 * - Classification is based on error types/signals from the native loop.
 * - Single-flight: only one dispatch in flight at any time.
 * - Side effects: the supervisor never re-executes external effects; it only
 *   retries model computation. Tool execution is governed by Pi's idempotency.
 * - Semantic failures (test failures, schema errors, review BLOCKING) are NOT
 *   provider retry events — they are terminal for recovery.
 */

/** Signals the supervisor can observe from the native loop. */
export interface RecoverySignal {
  /** The classification of the observed failure or signal. */
  classification: RetryClassification;
  /** Free-form diagnostic detail (error message, http status, etc.). */
  detail?: string | undefined;
  /** The model that was active when the signal occurred (for cooldown). */
  model?: string | undefined;
  /**
   * Native Retry-After hint (iris_agent#89): when the native failure carries
   * one (e.g. a provider 429 with a retry_after directive), the supervisor
   * uses this delay instead of the default exponential backoff.
   */
  retryAfterMs?: number | undefined;
  /**
   * iris_agent#102: the stable logical execution identity the signal belongs
   * to (survives rollover/restart). Lets a caller-supplied reconciler
   * correlate the ambiguity to durable state.
   */
  logicalExecutionId?: string | undefined;
  /**
   * iris_agent#102: the stable input identity of the possibly-accepted
   * dispatch (the Host's dedupe identity). Lets a reconciler verify whether
   * the input's effects landed before deciding replay safety.
   */
  inputId?: string | undefined;
  /**
   * iris_agent#111: the dispatch identity of the possibly-accepted
   * dispatch. Lets a reconciler correlate the ambiguity to the exact
   * provider dispatch record.
   */
  dispatchId?: string | undefined;
}

/**
 * iris_agent#102: the disposition a reconciler returns for a possibly-accepted
 * (outcome_unknown) dispatch.
 *
 * - `replay_safe`: the prior outcome was confirmed NOT applied — replay with
 *   the same logical execution/idempotency identity is permitted.
 * - `confirmed_applied`: the prior outcome was confirmed applied — settle
 *   WITHOUT replay (never duplicate the side effects).
 * - `ambiguous`: the prior outcome is still unknown — remain durably
 *   outcome_unknown and fail closed (zero replay across restarts).
 */
export type OutcomeUnknownDisposition = "replay_safe" | "confirmed_applied" | "ambiguous";

/**
 * A reconcile result. Booleans are accepted for backward compatibility:
 * `true` === `replay_safe`, `false` === `ambiguous`.
 */
export type ReconcileOutcome = boolean | OutcomeUnknownDisposition;

/** Normalize a {@link ReconcileOutcome} to the typed disposition. */
export function normalizeReconcileOutcome(outcome: ReconcileOutcome): OutcomeUnknownDisposition {
  if (outcome === true) {
    return "replay_safe";
  }
  if (outcome === false) {
    return "ambiguous";
  }
  return outcome;
}

/**
 * Port the supervisor uses to (a) invoke the underlying runtime and (b)
 * reconcile outcome_unknown before replay. The reconcile callback must return
 * the disposition of the possibly-accepted dispatch (see
 * {@link OutcomeUnknownDisposition}); callers SHOULD supply a real
 * reconciler, the default blocks (ambiguous → fail closed).
 */
export interface RecoverySupervisorOptions {
  /** The underlying RuntimeCoordinator (or any AgentRuntimePort). */
  runtime: AgentRuntimePort;
  /** Ordered fallback chain + budgets/timeouts. */
  config: FallbackConfig;
  /**
   * Called when the native loop reports outcome_unknown, or when a pending
   * outcome_unknown is restored from durable state at prompt() entry. Must
   * reconcile the prior partial state (did the side effect commit?) and
   * return the replay disposition. Defaults to blocking (ambiguous) —
   * callers SHOULD supply a real reconciler.
   */
  reconcileOutcomeUnknown?: (signal: RecoverySignal) => Promise<ReconcileOutcome>;
  /**
   * Round 7 (#118/#125): durable terminal-resolution store. When provided,
   * confirmed_applied / replay_safe decisions are persisted so a restart
   * reads the durable resolution instead of re-querying external subsystems
   * forever.
   */
  resolutionStore?: DurableOutcomeResolutionStore;
  /**
   * Optional override for the wall clock. Returns epoch milliseconds. Used by
   * tests to avoid real waits. Defaults to Date.now().
   */
  now?: () => number;
  /**
   * Optional sleep function injected for backoff. Defaults to a real promise
   * sleep; tests inject a fake to avoid real delays.
   */
  sleep?: (ms: number) => Promise<void>;
}

/** Events the supervisor emits alongside forwarding the native stream. */
export interface RecoveryEscalationEvent {
  type: "recovery_escalation";
  logicalExecutionId: string;
  reason: RetryClassification;
  action: "same_model_retry" | "fallback" | "abort" | "reserved_dispatch_retry" | "terminal";
  attempt?: number | undefined;
  nextModel?: string | undefined;
  detail?: string | undefined;
}

export type RecoverySupervisorEvent = AgentRuntimeEvent | RecoveryEscalationEvent;

/** Sentinel thrown when the overall budget or terminal classification is hit. */
export class RecoveryExhaustedError extends Error {
  public readonly logicalExecutionId: string;
  public readonly reason: string;
  public constructor(logicalExecutionId: string, reason: string, detail?: string) {
    super(
      detail !== undefined
        ? `recovery exhausted for ${logicalExecutionId}: ${reason} (${detail})`
        : `recovery exhausted for ${logicalExecutionId}: ${reason}`,
    );
    this.name = "RecoveryExhaustedError";
    this.logicalExecutionId = logicalExecutionId;
    this.reason = reason;
  }
}

const TERMINAL_CLASSIFICATIONS: ReadonlySet<RetryClassification> = new Set([
  "context_overflow",
  "semantic_failure",
  "abort",
  "terminal",
]);

const FALLBACK_CLASSIFICATIONS: ReadonlySet<RetryClassification> = new Set([
  "model_not_found",
  "quota_exhausted",
  "provider_unavailable",
]);

/**
 * Classify a native failure code/message into a recovery classification.
 *
 * This is the default heuristic; callers can wrap the runtime to emit richer
 * signals. It maps common HTTP/network/error strings to the strategy enum.
 */
export function classifyNativeFailure(
  code: string | undefined,
  message: string | undefined,
): RetryClassification {
  const text = `${code ?? ""} ${message ?? ""}`.toLowerCase();

  if (text.includes("context") && text.includes("overflow")) {
    return "context_overflow";
  }
  if (text.includes("semantic") || text.includes("test fail") || text.includes("schema error")) {
    return "semantic_failure";
  }
  if (text.includes("abort")) {
    return "abort";
  }
  if (text.includes("outcome_unknown") || text.includes("ambiguous")) {
    return "outcome_unknown";
  }
  if (text.includes("reserved") && text.includes("dispatch")) {
    return "reserved_dispatch";
  }
  if (text.includes("model_not_found") || text.includes("not found")) {
    return "model_not_found";
  }
  if (text.includes("quota") || text.includes("rate_limit_budget")) {
    return "quota_exhausted";
  }
  if (text.includes("provider") && text.includes("unavailable")) {
    return "provider_unavailable";
  }
  // 429 / 5xx / network are transient and retryable on the SAME model first.
  if (
    text.includes("429") ||
    text.includes("rate") ||
    text.includes("500") ||
    text.includes("502") ||
    text.includes("503") ||
    text.includes("504") ||
    text.includes("timeout") ||
    text.includes("network") ||
    text.includes("econnreset") ||
    text.includes("socket hang up")
  ) {
    return "transient_retryable";
  }
  return "terminal";
}

/** Compute exponential backoff for same-model retry: 2s, 4s, 8s. */
export function sameModelBackoffMs(attempt: number): number {
  // attempt is 0-indexed: first retry → 2s, second → 4s, third → 8s.
  return 2000 * 2 ** attempt;
}

/**
 * Parse a native Retry-After hint embedded in a failure code/message, e.g.
 * `"429 rate limit retry_after:1500"` or `"retry_after=2000"`. Returns the
 * delay in milliseconds, or undefined when no hint is present.
 */
export function extractRetryAfterMs(
  code: string | undefined,
  message: string | undefined,
): number | undefined {
  const text = `${code ?? ""} ${message ?? ""}`;
  const match = /retry_after[=:]\s*(\d+)/i.exec(text);
  if (match === null) {
    return undefined;
  }
  const ms = Number(match[1]);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

export class RecoverySupervisor {
  private readonly runtime: AgentRuntimePort;
  private readonly config: FallbackConfig;
  private readonly reconcile: (signal: RecoverySignal) => Promise<ReconcileOutcome>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** #102: stored inputId from the current prompt() call for reconciliation. */
  private currentInputId: string | undefined;
  /**
   * Round 7 (#118/#125): durable terminal-resolution store. When provided,
   * confirmed_applied / replay_safe decisions are persisted so a restart
   * reads the resolution instead of re-querying external subsystems forever.
   */
  private readonly resolutionStore: DurableOutcomeResolutionStore | undefined;

  /**
   * In-memory mirror of the durable snapshot. On dispatch, the supervisor loads
   * from the store (if provided) or starts fresh, then persists after each
   * transition.
   */
  private state: RecoveryStateSnapshot | null = null;
  private dispatchInFlight = false;

  constructor(options: RecoverySupervisorOptions) {
    this.runtime = options.runtime;
    this.config = options.config;
    this.reconcile = options.reconcileOutcomeUnknown ?? (() => Promise.resolve(false));
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.resolutionStore = options.resolutionStore;
  }

  /**
   * Round 7 (#118/#125): persist a durable terminal resolution for a logical
   * execution. Identity + evidence are preserved; evidenceSource/evidenceRef
   * identify the subsystem that produced the proof.
   */
  private persistResolution(input: {
    logicalExecutionId: string;
    inputId: string;
    dispatchId: string;
    resolution: "confirmed_applied" | "replay_safe";
    evidenceSource: string;
    evidenceRef: string;
  }): void {
    this.resolutionStore?.save({
      ...input,
      resolvedAt: new Date(this.now()).toISOString(),
    });
  }

  /**
   * Round 7 (#118/#125): reconcile a DURABLE pendingOutcomeUnknown at Host
   * startup — before ANY dispatch — even when the input was already appended
   * to the Pi Session (the crash window persists pending first). Persists the
   * durable result and returns the disposition.
   *
   * - confirmed_applied: durable resolution written + pending cleared →
   *   restart performs zero replay and zero external re-query.
   * - replay_safe: durable resolution written + pending cleared → bounded
   *   replay preserves the original recovery budget and identity.
   * - ambiguous: pending kept + exhausted persisted → fail closed.
   */
  async reconcilePendingOnStartup(
    snapshot: RecoveryStateSnapshot,
  ): Promise<"confirmed_applied" | "replay_safe" | "ambiguous"> {
    const pending = snapshot.pendingOutcomeUnknown;
    if (pending === null) {
      return "replay_safe";
    }
    const outcome = await this.reconcilePendingOutcomeUnknown(pending);
    if (outcome === "settled") {
      this.persistResolution({
        logicalExecutionId: snapshot.logicalExecutionId,
        inputId: pending.inputId,
        dispatchId: pending.dispatchId,
        resolution: "confirmed_applied",
        evidenceSource: "outcome_reconciler",
        evidenceRef: `reconciled:${pending.dispatchId}`,
      });
      this.state = { ...snapshot, pendingOutcomeUnknown: null, exhausted: false };
      return "confirmed_applied";
    }
    if (outcome === "ambiguous") {
      this.state = { ...snapshot, exhausted: true };
      return "ambiguous";
    }
    this.persistResolution({
      logicalExecutionId: snapshot.logicalExecutionId,
      inputId: pending.inputId,
      dispatchId: pending.dispatchId,
      resolution: "replay_safe",
      evidenceSource: "outcome_reconciler",
      evidenceRef: `reconciled:${pending.dispatchId}`,
    });
    this.state = { ...snapshot, pendingOutcomeUnknown: null };
    return "replay_safe";
  }

  getPhase(): "idle" | "turn" | "retry" | "compaction" | "branch_summary" | "failed" {
    return this.runtime.getPhase();
  }

  async abort(invocationId: string, reason?: string): Promise<void> {
    await this.runtime.abort(invocationId, reason);
  }

  /**
   * Internal: inject a state snapshot (used by tests + load-from-store).
   * When `store` is provided the snapshot is also persisted.
   */
  _setState(snapshot: RecoveryStateSnapshot | null): void {
    this.state = snapshot;
  }

  /** Read the current in-memory recovery state (for tests/diagnostics). */
  getState(): RecoveryStateSnapshot | null {
    return this.state;
  }

  /**
   * Run one logical execution through the recovery escalation loop.
   *
   * The `logicalExecutionId` is stable across epoch rollover for the same
   * logical invocation; the `initialState` (when provided) restores a durable
   * budget so a restart cannot silently reset it. The `onStateChange` callback
   * lets the caller persist state to the RecoveryStateStore after each
   * transition.
   *
   * Yields the native AgentRuntimeEvent stream, interleaved with
   * recovery_escalation events when escalation/fallback occurs.
   */
  async *prompt(
    input: AgentInput,
    options?: {
      logicalExecutionId?: string;
      initialState?: RecoveryStateSnapshot;
      onStateChange?: (snapshot: RecoveryStateSnapshot) => void;
      /**
       * When provided, the supervisor calls this on each native attempt instead
       * of `runtime.prompt`. Used by tests to inject fault sequences. Each call
       * returns the events emitted AND an optional terminal signal (when the
       * attempt failed in a way the native loop surfaced).
       */
      dispatch?: (
        input: AgentInput,
        model: string | null,
        attempt: number,
      ) => AsyncIterable<AgentRuntimeEvent>;
    },
  ): AsyncIterable<RecoverySupervisorEvent> {
    if (this.dispatchInFlight) {
      throw new Error("recovery supervisor: a dispatch is already in flight (single-flight)");
    }
    this.dispatchInFlight = true;

    const logicalExecutionId = options?.logicalExecutionId ?? `exec-${input.inputId}`;
    this.currentInputId = input.inputId;
    const now = this.now;
    const startedAt = now();

    // Load or restore durable state.
    this.state =
      options?.initialState ??
      this.state ??
      freshRecoveryState(logicalExecutionId, new Date(startedAt).toISOString());
    const persist = (snapshot: RecoveryStateSnapshot): void => {
      this.state = snapshot;
      options?.onStateChange?.(snapshot);
    };

    // iris_agent#89 Fix 1: production dispatch must honor the selected
    // fallback model. Prefer promptWithModel when the runtime supports model
    // override; fall back to plain prompt() for backward compatibility.
    const dispatch =
      options?.dispatch ??
      ((inputArg: AgentInput, model: string | null): AsyncIterable<AgentRuntimeEvent> =>
        this.runtime.promptWithModel !== undefined
          ? this.runtime.promptWithModel(inputArg, model)
          : this.runtime.prompt(inputArg));

    // iris_agent#90 Fix 2: the overall budget is anchored to the DURABLE
    // creation time — a restart cannot silently reset the recovery budget by
    // re-anchoring to a fresh wall clock.
    const budgetDeadline = new Date(this.state.createdAt).getTime() + this.config.overallBudgetMs;

    try {
      for (;;) {
        // iris_agent#90 Fix 1: fail closed before ANY dispatch — a logical
        // execution restored in the exhausted state must not dispatch again.
        if (this.state.exhausted) {
          throw new RecoveryExhaustedError(
            logicalExecutionId,
            "already_exhausted",
            "logical execution loaded in exhausted state — zero dispatch",
          );
        }

        // Round 7 (#125): a durable confirmed_applied resolution is a
        // restart-stable terminal decision — zero replay AND zero external
        // re-query. Read it BEFORE any dispatch or reconciliation.
        const durableResolution = this.resolutionStore?.load(logicalExecutionId);
        if (durableResolution !== null && durableResolution !== undefined) {
          if (durableResolution.resolution === "confirmed_applied") {
            yield {
              type: "recovery_escalation",
              logicalExecutionId,
              reason: "outcome_unknown",
              action: "terminal",
              detail: "durable_confirmed_applied_settle_without_replay",
            };
            return;
          }
          if (durableResolution.resolution === "replay_safe") {
            // The prior dispatch was confirmed NOT applied; bounded replay
            // preserves the original recovery budget and identity.
            yield {
              type: "recovery_escalation",
              logicalExecutionId,
              reason: "outcome_unknown",
              action: "fallback",
              detail: "durable_replay_safe",
            };
          }
        }

        // iris_agent#102: a pending outcome_unknown restored from durable
        // state must be reconciled BEFORE any provider/runtime dispatch on
        // restart. Zero dispatches happen until the reconciliation
        // disposition is persisted (replay_safe → continue into dispatch;
        // confirmed_applied → settle without replay; ambiguous → fail closed
        // durably, pending stays set so repeated restarts never replay).
        if (this.state.pendingOutcomeUnknown !== null) {
          const pending = this.state.pendingOutcomeUnknown;
          const outcome = await this.reconcilePendingOutcomeUnknown(pending);
          if (outcome === "settled") {
            // Round 7 (#118/#125): confirmed_applied becomes a DURABLE
            // terminal resolution — restart reads it instead of re-querying
            // the reconciler forever.
            this.persistResolution({
              logicalExecutionId,
              inputId: pending.inputId,
              dispatchId: pending.dispatchId,
              resolution: "confirmed_applied",
              evidenceSource: "outcome_reconciler",
              evidenceRef: `reconciled:${pending.dispatchId}`,
            });
            persist({ ...this.state, pendingOutcomeUnknown: null, exhausted: false });
            return;
          }
          if (outcome === "ambiguous") {
            // #102: still ambiguous → durably fail-closed.
            // Zero replay across repeated restarts.
            persist({ ...this.state, exhausted: true });
            yield {
              type: "recovery_escalation",
              logicalExecutionId,
              reason: "outcome_unknown",
              action: "terminal",
              detail: "outcome_unknown_ambiguous_fail_closed",
            };
            throw new RecoveryExhaustedError(
              logicalExecutionId,
              "outcome_unknown_ambiguous_fail_closed",
            );
          }
          // "retry" — durable replay_safe resolution, clear pending, fall
          // through to the normal dispatch.
          this.persistResolution({
            logicalExecutionId,
            inputId: pending.inputId,
            dispatchId: pending.dispatchId,
            resolution: "replay_safe",
            evidenceSource: "outcome_reconciler",
            evidenceRef: `reconciled:${pending.dispatchId}`,
          });
          persist({ ...this.state, pendingOutcomeUnknown: null });
        }

        // 8. Overall recovery budget check (durable origin).
        if (now() > budgetDeadline) {
          const exhausted = { ...this.state, exhausted: true };
          persist(exhausted);
          yield {
            type: "recovery_escalation",
            logicalExecutionId,
            reason: "terminal",
            action: "terminal",
            detail: "overall_budget_exceeded",
          };
          throw new RecoveryExhaustedError(logicalExecutionId, "overall_budget_exceeded");
        }

        // Determine the current model for this attempt.
        const model = this.selectModel();
        const attempt = this.state.sameModelAttempts;

        let nativeSettled = false;
        let nativeFailedCode: string | undefined;
        let nativeFailedMessage: string | undefined;
        let stallDetected: "no_progress" | "subagent" | null = null;
        // iris_agent#89 Fix 2: the invocation id of the CURRENT dispatch,
        // captured from the first event the native loop emits, so a watchdog
        // stall can abort the exact active invocation before advancing.
        let activeInvocationId: string | null = null;

        // --- Dispatch with watchdogs (true Promise.race against timers) ---
        const iter = dispatch(input, model, attempt)[Symbol.asyncIterator]();
        let lastProgress = now();
        let subagentStarted = false;
        let subagentFirstProgress = false;

        try {
          for (;;) {
            // Race the next native event against the active watchdog timer.
            // The timer is (re)computed from the elapsed-since-progress time so
            // it correctly fires when the native loop stalls on iter.next().
            const result = await this.raceNextWithWatchdog(iter, lastProgress, () => {
              return {
                subagentStarted,
                subagentFirstProgress,
              };
            });
            if (result.kind === "watchdog") {
              stallDetected = result.stall;
              break;
            }
            if (result.value.done === true) {
              break;
            }
            const event = result.value.value;
            activeInvocationId = event.invocationId;
            // message_delta and tool_call both count as overall progress
            // (resetting the no-progress watchdog). A tool_call *dispatches* a
            // subagent — it does NOT count as the subagent's first progress;
            // the subagent-first-progress watchdog arms until a message_delta
            // arrives.
            if (event.type === "message_delta") {
              lastProgress = now();
              subagentFirstProgress = true;
            } else if (event.type === "tool_call") {
              lastProgress = now();
              subagentStarted = true;
            }
            if (event.type === "settled") {
              // Consume the FULL native generator: breaking early would
              // return() the Coordinator generator and skip its phase
              // transition to idle (leaving the single-writer latch held
              // forever) plus the onSettledBoundary settled-authorization.
              // Mirror the Coordinator's own settledSeen pattern. Post-settled
              // the generator only does local bookkeeping (phase flip, latch
              // release), so drain it WITHOUT the watchdog race — a stall
              // timer must never interrupt the latch release.
              nativeSettled = true;
              yield event;
              let rest = await iter.next();
              while (!rest.done) {
                const restEvent = rest.value;
                if (restEvent.type === "settled") {
                  nativeSettled = true;
                } else if (restEvent.type === "failed") {
                  nativeFailedCode = restEvent.code;
                  if (restEvent.message !== undefined) {
                    nativeFailedMessage = restEvent.message;
                  }
                }
                yield restEvent;
                rest = await iter.next();
              }
              break;
            }
            if (event.type === "failed") {
              nativeFailedCode = event.code;
              if (event.message !== undefined) {
                nativeFailedMessage = event.message;
              }
              yield event;
            } else {
              yield event;
            }
          }
        } catch (error) {
          // Native loop threw — classify from the error.
          nativeFailedMessage = error instanceof Error ? error.message : String(error);
        } finally {
          // iris_agent#114 (Feature C5): the watchdog teardown no longer uses
          // signalAbort — it was fire-and-forget and swallowed abort
          // rejection (the ONLY pre-return production abort seam). The
          // coordinator latch is NOT released by generator cleanup alone.
          //
          // When the watchdog broke out of the event loop (stallDetected),
          // the coordinator's async generator is parked on a stalled inner
          // `for await (handle.runtime.prompt(input))`. iter.return() here
          // would deadlock: the queued return only takes effect once the
          // suspended inner await settles, and nothing settles it without
          // an abort. The post-finally stall handling below therefore
          // issues the AWAITABLE abort FIRST (bounded by
          // abortSettlementTimeoutMs, rejection/timeout fail-closed) and
          // closes the generator AFTER the abort signal is in flight.
          if (stallDetected === null) {
            await iter.return?.().catch(() => undefined);
          }
        }

        // --- Success: clean exit ---
        if (nativeSettled && nativeFailedCode === undefined) {
          // #102-3: a successful (settled) dispatch resolves any pending
          // outcome_unknown — the fence must be cleared durably so a
          // restart after settlement never re-reconciles a stale ambiguity.
          persist({ ...this.state, currentModel: model, pendingOutcomeUnknown: null });
          return;
        }

        // --- Watchdog abort detection ---
        if (stallDetected !== null) {
          // iris_agent#89: abort the EXACT active invocation before
          // advancing the fallback chain. The abort is real — it calls
          // runtime.abort() with the captured invocationId.
          //
          // After abort, we must NOT fall through to classifyNativeFailure,
          // because there is no native failure code/message — the stall is
          // a no-progress watchdog event, not a provider error. The old code
          // fell through to classifyNativeFailure(undefined, undefined) which
          // returned "terminal", making a 30s stall become terminal exhaustion
          // instead of exact-abort + next-fallback.
          //
          // iris_agent#100: the exact single-flight sequence is
          //   identify exact active invocation
          //   → real abort (never swallowed)
          //   → validated settled/abort boundary (await with timeout)
          //   → only then advance fallback (markModelFailed + advanceFallback)
          //
          // Two fail-open cases are closed here:
          //   (a) abort rejection/timeout → typed fail-closed state, ZERO
          //       fallback dispatch (previously `.catch(() => undefined)`);
          //   (b) watchdog fires before any native event exposed an
          //       invocationId → resolve the identity via the
          //       getActiveInvocationId() seam; when the runtime cannot
          //       identify the accepted invocation, fail closed with ZERO
          //       fallback dispatch (never skip abort and advance).
          // Iterator cancellation (iter.return inside
          // abortWithSettlementTimeout) is NOT treated as proof the provider
          // invocation is dead — the abort + validated settlement is the
          // only proof accepted.
          let targetInvocationId = activeInvocationId;
          if (targetInvocationId === null && this.runtime.getActiveInvocationId !== undefined) {
            targetInvocationId = this.runtime.getActiveInvocationId();
          }
          if (targetInvocationId === null) {
            persist({ ...this.state, exhausted: true });
            yield {
              type: "recovery_escalation",
              logicalExecutionId,
              reason: "transient_retryable",
              action: "terminal",
              detail: "watchdog_unidentified_invocation",
            };
            throw new RecoveryExhaustedError(
              logicalExecutionId,
              "watchdog_unidentified_invocation",
              "no exact active invocation identity available — zero fallback dispatch",
            );
          }
          try {
            // iris_agent#114 (Feature C5): abortWithSettlementTimeout now
            // implements the production teardown order:
            //   1. start the AWAITABLE abort (signal in flight — never
            //      fire-and-forget; rejection surfaces below);
            //   2. iter.return() AFTER the abort signal — the return is
            //      queued while the generator is parked on the stalled
            //      inner await, and once the abort settles the harness the
            //      generator reaches its final yield where the queued
            //      return takes effect: the coordinator's finally runs
            //      (resolving runCompletion), which unblocks the abort's
            //      settlement wait;
            //   3. bounded settlement wait (abortSettlementTimeoutMs) —
            //      reject/timeout fail closed below with ZERO fallback.
            // The coordinator's own finally releases the latch only on a
            // validated native settled boundary (C5); generator cleanup
            // alone is never treated as settled proof.
            await this.abortWithSettlementTimeout(
              targetInvocationId,
              `watchdog_${stallDetected}`,
              iter,
            );
          } catch (error) {
            // Abort rejected or did not settle in time: never advance or
            // dispatch a fallback over a possibly-live invocation. The
            // fail-closed state is durable (exhausted=true) and typed.
            persist({ ...this.state, exhausted: true });
            yield {
              type: "recovery_escalation",
              logicalExecutionId,
              reason: "transient_retryable",
              action: "terminal",
              detail: "abort_settlement_failed",
            };
            throw new RecoveryExhaustedError(
              logicalExecutionId,
              "abort_settlement_failed",
              error instanceof Error ? error.message : String(error),
            );
          }
          // After abort, advance the fallback chain — this is a no-progress
          // escalation, not a native failure classification.
          const stallModel = model;
          const stallMarked = this.markModelFailed(stallModel, this.state);
          const { snapshot: stallAdvanced, nextModel: stallNext } =
            this.advanceFallback(stallMarked);
          if (stallNext === null) {
            const exhausted = { ...this.state, exhausted: true };
            persist(exhausted);
            yield {
              type: "recovery_escalation",
              logicalExecutionId,
              reason: "transient_retryable",
              action: "terminal",
              detail: "watchdog_fallback_chain_exhausted",
            };
            throw new RecoveryExhaustedError(
              logicalExecutionId,
              "watchdog_fallback_chain_exhausted",
            );
          }
          // iris_agent#101: ONE shared fallback-budget accounting rule across
          // watchdog, direct-fallback and same-model-exhaustion paths. The
          // increment and the `> budget` comparison operate on the SAME
          // value (no double increment via the mutating persist()).
          const consumed = this.consumeFallbackAttempt(stallAdvanced);
          if (!consumed.allowed) {
            persist({ ...this.state, exhausted: true });
            yield {
              type: "recovery_escalation",
              logicalExecutionId,
              reason: "transient_retryable",
              action: "terminal",
              detail: "watchdog_budget_exhausted",
            };
            throw new RecoveryExhaustedError(logicalExecutionId, "watchdog_budget_exhausted");
          }
          persist(consumed.snapshot);
          yield {
            type: "recovery_escalation",
            logicalExecutionId,
            reason: "transient_retryable",
            action: "fallback",
            detail: `watchdog_${stallDetected}`,
            nextModel: stallNext,
          };
          continue;
        }

        // --- Classify the failure ---
        const classification = classifyNativeFailure(nativeFailedCode, nativeFailedMessage);
        // iris_agent#89 Fix 5: surface a native Retry-After hint (if any) on
        // the failure signal so retryable paths can honor it.
        const retryAfterMs = extractRetryAfterMs(nativeFailedCode, nativeFailedMessage);

        // 6. outcome_unknown reconciliation before replay.
        if (classification === "outcome_unknown") {
          yield {
            type: "recovery_escalation",
            logicalExecutionId,
            reason: "outcome_unknown",
            action: "abort",
            detail: "awaiting_reconciliation",
          };
          // iris_agent#102: persist the TYPED pending state BEFORE any
          // reconciliation runs. A crash between the possibly-accepted
          // dispatch and the reconcile result must restore the exact pending
          // ambiguity (dispatch identity + model + timestamp), not a bare
          // counter. Reconciliation only ever runs on the persisted record.
          const pending: PendingOutcomeUnknown = {
            dispatchId: activeInvocationId ?? `invocation-${input.inputId}`,
            // #107: persist stable logical execution + input identity so
            // restart reconciliation uses durable fields, not borrowed state.
            logicalExecutionId: this.state.logicalExecutionId,
            inputId: input.inputId,
            model,
            occurredAt: new Date(this.now()).toISOString(),
            ...(nativeFailedMessage !== undefined
              ? { detail: nativeFailedMessage }
              : nativeFailedCode !== undefined
                ? { detail: nativeFailedCode }
                : {}),
          };
          persist({
            ...this.state,
            outcomeUnknown: this.state.outcomeUnknown + 1,
            pendingOutcomeUnknown: pending,
          });
          const disposition = await this.reconcile({
            classification,
            detail: nativeFailedMessage ?? nativeFailedCode,
            ...(model !== undefined ? { model: model ?? undefined } : {}),
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            logicalExecutionId,
            inputId: input.inputId,
            // iris_agent#114 (C5 finding 5): the same-run reconcile uses the
            // EXACT dispatch identity already persisted in the durable
            // pending record — never a re-read of the mutable current-active
            // id, which may already be cleared after teardown/coordinator
            // finally. Restart reconciliation (reconcilePendingOutcomeUnknown)
            // uses the same pending.dispatchId authority.
            dispatchId: pending.dispatchId,
          });
          const normalized = normalizeReconcileOutcome(disposition);
          if (normalized === "ambiguous") {
            // Still ambiguous: remain durably outcome_unknown AND fail
            // closed. The pending record is deliberately NOT cleared — a
            // restart restores it and performs zero replay (the exhausted
            // fence above also guarantees zero dispatch).
            persist({ ...this.state, exhausted: true });
            yield {
              type: "recovery_escalation",
              logicalExecutionId,
              reason: "outcome_unknown",
              action: "terminal",
              detail: "outcome_unknown_still_ambiguous",
            };
            throw new RecoveryExhaustedError(
              logicalExecutionId,
              "outcome_unknown_unreconciled",
              "replay blocked pending reconciliation",
            );
          }
          if (normalized === "confirmed_applied") {
            // Confirmed applied: settle WITHOUT replay — the external
            // effects already landed; replaying would duplicate them.
            persist({ ...this.state, pendingOutcomeUnknown: null });
            yield {
              type: "recovery_escalation",
              logicalExecutionId,
              reason: "outcome_unknown",
              action: "terminal",
              detail: "outcome_unknown_confirmed_applied",
            };
            return;
          }
          // replay_safe: the prior outcome was confirmed NOT applied — the
          // bounded retry uses the same logical execution/idempotency
          // identity. Clear the pending fence (persisted) and continue.
          persist({ ...this.state, pendingOutcomeUnknown: null });
          continue;
        }

        // Terminal classifications — do NOT retry.
        if (TERMINAL_CLASSIFICATIONS.has(classification)) {
          const exhausted = { ...this.state, exhausted: true };
          persist(exhausted);
          yield {
            type: "recovery_escalation",
            logicalExecutionId,
            reason: classification,
            action: "terminal",
          };
          throw new RecoveryExhaustedError(logicalExecutionId, classification);
        }

        // 5. Reserved dispatch — bounded linear retry, does NOT consume
        // fallback budget. The consumed-retry counter is durable (#90) so a
        // restart cannot silently reset the acquisition budget.
        if (classification === "reserved_dispatch") {
          if (this.state.reservedRetries < this.config.reservedDispatchRetries) {
            const updated: RecoveryStateSnapshot = {
              ...this.state,
              reservedRetries: this.state.reservedRetries + 1,
            };
            persist(updated);
            yield {
              type: "recovery_escalation",
              logicalExecutionId,
              reason: "reserved_dispatch",
              action: "reserved_dispatch_retry",
              attempt: updated.reservedRetries,
            };
            // iris_agent#89 Fix 4: linear backoff 0.5s/1s/1.5s/2s/2.5s/3s
            // (replaces the previous fixed 100ms delay). The index is clamped
            // to the array bounds, so the fallback is unreachable in practice.
            const reservedBackoffMs = [500, 1000, 1500, 2000, 2500, 3000];
            const delay =
              reservedBackoffMs[
                Math.min(updated.reservedRetries - 1, reservedBackoffMs.length - 1)
              ] ?? 3000;
            await this.sleep(delay);
            continue;
          }
          // Reserved dispatch exhausted → terminal.
          const exhausted = { ...this.state, exhausted: true };
          persist(exhausted);
          yield {
            type: "recovery_escalation",
            logicalExecutionId,
            reason: "reserved_dispatch",
            action: "terminal",
            detail: "reserved_dispatch_exhausted",
          };
          throw new RecoveryExhaustedError(logicalExecutionId, "reserved_dispatch_exhausted");
        }

        // Fallback classifications — skip same-model retry, advance chain.
        if (FALLBACK_CLASSIFICATIONS.has(classification)) {
          // iris_agent#90 Fix 3: advanceFallback returns the updated snapshot;
          // persist immediately so the chain position survives restart.
          const { snapshot: advanced, nextModel } = this.advanceFallback(this.state);
          persist(advanced);
          if (nextModel === null) {
            const exhausted = { ...this.state, exhausted: true };
            persist(exhausted);
            yield {
              type: "recovery_escalation",
              logicalExecutionId,
              reason: classification,
              action: "terminal",
              detail: "fallback_chain_exhausted",
            };
            throw new RecoveryExhaustedError(logicalExecutionId, "fallback_chain_exhausted");
          }
          // iris_agent#101: ONE shared budget rule (see consumeFallbackAttempt).
          // The increment and the `> budget` comparison use the SAME value —
          // the old code persisted `fallbackAttempts + 1` and then compared
          // `this.state.fallbackAttempts + 1`, double-counting the increment
          // and rejecting the Nth allowed fallback before dispatch.
          const consumed = this.consumeFallbackAttempt(advanced);
          if (!consumed.allowed) {
            const exhausted = { ...this.state, exhausted: true };
            persist(exhausted);
            yield {
              type: "recovery_escalation",
              logicalExecutionId,
              reason: classification,
              action: "terminal",
              detail: "fallback_budget_exhausted",
            };
            throw new RecoveryExhaustedError(logicalExecutionId, "fallback_budget_exhausted");
          }
          persist(consumed.snapshot);
          yield {
            type: "recovery_escalation",
            logicalExecutionId,
            reason: classification,
            action: "fallback",
            nextModel,
          };
          continue;
        }

        // 1. Transient retryable — same-model retry with exponential backoff.
        //
        // iris_agent#89 Fix 6: this loop escalates ONLY after Pi's own native
        // retry loop has exhausted — the native loop's terminal failure signal
        // is what reaches the supervisor here. The supervisor must observe
        // that native retry status rather than blindly resubmitting; it never
        // duplicates the native loop's retries.
        if (classification === "transient_retryable") {
          const attempts = this.state.sameModelAttempts;
          if (attempts < this.config.sameModelRetryBudget) {
            // iris_agent#89 Fix 5: honor a native Retry-After hint when the
            // failure signal carries one; otherwise exponential backoff.
            const backoff = retryAfterMs ?? sameModelBackoffMs(attempts);
            const updated: RecoveryStateSnapshot = {
              ...this.state,
              sameModelAttempts: attempts + 1,
              currentModel: model,
            };
            persist(updated);
            yield {
              type: "recovery_escalation",
              logicalExecutionId,
              reason: "transient_retryable",
              action: "same_model_retry",
              attempt: attempts + 1,
              ...(model !== null ? { nextModel: model } : {}),
            };
            await this.sleep(backoff);
            continue;
          }
          // Same-model budget exhausted → advance fallback.
          // iris_agent#90 Fix 3: markModelFailed + advanceFallback return the
          // updated snapshot; persist immediately so the cooldown and chain
          // position survive restart.
          const marked = this.markModelFailed(model, this.state);
          const { snapshot: advanced, nextModel } = this.advanceFallback(marked);
          persist(advanced);
          if (nextModel === null) {
            const exhausted = { ...this.state, exhausted: true };
            persist(exhausted);
            yield {
              type: "recovery_escalation",
              logicalExecutionId,
              reason: "transient_retryable",
              action: "terminal",
              detail: "same_model_and_fallback_exhausted",
            };
            throw new RecoveryExhaustedError(
              logicalExecutionId,
              "same_model_and_fallback_exhausted",
            );
          }
          // iris_agent#101: ONE shared budget rule (see consumeFallbackAttempt).
          const consumed = this.consumeFallbackAttempt(advanced);
          if (!consumed.allowed) {
            const exhausted = { ...this.state, exhausted: true };
            persist(exhausted);
            throw new RecoveryExhaustedError(logicalExecutionId, "fallback_budget_exhausted");
          }
          persist(consumed.snapshot);
          yield {
            type: "recovery_escalation",
            logicalExecutionId,
            reason: "transient_retryable",
            action: "fallback",
            nextModel,
            detail: "same_model_exhausted",
          };
          continue;
        }

        // Unreachable: all classifications handled above.
        const exhausted = { ...this.state, exhausted: true };
        persist(exhausted);
        throw new RecoveryExhaustedError(logicalExecutionId, `unhandled:${classification}`);
      }
    } finally {
      this.dispatchInFlight = false;
    }
  }

  /**
   * Select the current model for this attempt based on fallback index and
   * cooldown expiry. Returns null when no models are configured.
   */
  private selectModel(): string | null {
    if (this.state === null || this.config.models.length === 0) {
      return null;
    }
    const idx = Math.min(this.state.fallbackIndex, this.config.models.length - 1);
    const candidate = this.config.models[idx];
    if (candidate === undefined) {
      return null;
    }
    // If the candidate is in cooldown and expired, we may reuse it.
    const cooldownUntil = this.state.failedModels[candidate];
    if (cooldownUntil !== undefined) {
      const expiry = new Date(cooldownUntil).getTime();
      if (this.now() < expiry) {
        // Still cooling down — try to skip to the next available model.
        return this.nextAvailableModel(idx) ?? candidate;
      }
    }
    return candidate;
  }

  private nextAvailableModel(fromIdx: number): string | null {
    if (this.state === null) {
      return null;
    }
    for (let i = fromIdx + 1; i < this.config.models.length; i += 1) {
      const m = this.config.models[i];
      if (m === undefined) {
        continue;
      }
      const cooldownUntil = this.state.failedModels[m];
      if (cooldownUntil === undefined || this.now() >= new Date(cooldownUntil).getTime()) {
        return m;
      }
    }
    return null;
  }

  /**
   * Mark a model as failed with a cooldown. Pure: returns the updated
   * snapshot; the caller persists it (iris_agent#90 Fix 3).
   */
  private markModelFailed(
    model: string | null,
    snapshot: RecoveryStateSnapshot,
  ): RecoveryStateSnapshot {
    if (model === null) {
      return snapshot;
    }
    const cooldownUntil = new Date(this.now() + this.config.failedModelCooldownMs).toISOString();
    return {
      ...snapshot,
      failedModels: { ...snapshot.failedModels, [model]: cooldownUntil },
    };
  }

  /**
   * Advance the fallback index to the next available model. Pure: returns the
   * updated snapshot plus the new model id (or null when the chain is
   * exhausted); the caller persists it (iris_agent#90 Fix 3).
   */
  private advanceFallback(snapshot: RecoveryStateSnapshot): {
    snapshot: RecoveryStateSnapshot;
    nextModel: string | null;
  } {
    const nextIdx = snapshot.fallbackIndex + 1;
    // #101: increment the fallback attempt counter here so the shared
    // consumeFallbackAttempt budget check works correctly.
    const incremented = {
      ...snapshot,
      fallbackIndex: nextIdx,
      fallbackAttempts: snapshot.fallbackAttempts + 1,
    };
    if (nextIdx >= this.config.models.length) {
      return { snapshot: incremented, nextModel: null };
    }
    const nextModel = this.config.models[nextIdx];
    return {
      snapshot: incremented,
      nextModel: nextModel ?? null,
    };
  }

  /**
   * Race the next native iterator result against the active watchdog timer.
   *
   * When the no-progress or subagent-first-progress timeout fires before the
   * native loop produces an event, returns a watchdog result (the caller breaks
   * and escalates). Otherwise returns the native iterator result.
   */
  private async raceNextWithWatchdog(
    iter: AsyncIterator<AgentRuntimeEvent>,
    lastProgressAt: number,
    getFlags: () => { subagentStarted: boolean; subagentFirstProgress: boolean },
  ): Promise<
    | { kind: "watchdog"; stall: "no_progress" | "subagent" }
    | { kind: "event"; value: IteratorResult<AgentRuntimeEvent> }
  > {
    const now = this.now;
    const elapsed = now() - lastProgressAt;
    const flags = getFlags();

    // Determine the active watchdog timeout. If no subagent started, or the
    // subagent already produced first progress, the no-progress watchdog
    // governs. While a subagent is running WITHOUT first progress, the
    // subagent watchdog governs INDEPENDENTLY (iris_agent#89 Fix 3): the two
    // serve different purposes — the 30s no-progress window decides the main
    // model fallback, the 90s subagent window catches silent subagent stalls.
    // Taking the min would always pick 30s and make the 90s window dead code.
    let watchdogTimeout = this.config.fallbackNoProgressTimeoutMs;
    let watchdogKind: "no_progress" | "subagent" = "no_progress";
    if (flags.subagentStarted && !flags.subagentFirstProgress) {
      watchdogTimeout = this.config.subagentFirstProgressMs;
      watchdogKind = "subagent";
    }
    const remaining = watchdogTimeout - elapsed;
    if (remaining <= 0) {
      return { kind: "watchdog", stall: watchdogKind };
    }

    // Race iter.next() against a real setTimeout-based timer.
    const timer: { promise: Promise<"timeout">; cancel: () => void } =
      this.makeWatchdogTimer(remaining);
    try {
      const outcome = await Promise.race([
        iter.next().then((value) => {
          return { kind: "event" as const, value };
        }),
        timer.promise.then(() => {
          return { kind: "watchdog" as const, stall: watchdogKind };
        }),
      ]);
      return outcome;
    } finally {
      timer.cancel();
    }
  }

  /**
   * Create a cancellable timer. Uses real setTimeout for accurate watchdog
   * timing — the sleep injection is for backoff only.
   */
  private makeWatchdogTimer(ms: number): {
    promise: Promise<"timeout">;
    cancel: () => void;
  } {
    let cancelled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const promise = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => {
        if (!cancelled) {
          resolve("timeout");
        }
      }, ms);
    });
    return {
      promise,
      cancel: () => {
        cancelled = true;
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
      },
    };
  }

  /**
   * #102: Reconcile a durable pending outcome_unknown state before any
   * provider dispatch. Returns "settled" (confirmed applied, no replay),
   * "retry" (confirmed not applied, bounded retry), or "ambiguous" (still
   * unknown, fail closed).
   */
  private async reconcilePendingOutcomeUnknown(
    pending: PendingOutcomeUnknown,
  ): Promise<"settled" | "retry" | "ambiguous"> {
    try {
      const result = await this.reconcile({
        classification: "outcome_unknown" as RetryClassification,
        logicalExecutionId: pending.logicalExecutionId,
        inputId: pending.inputId,
        dispatchId: pending.dispatchId,
        detail: pending.detail,
        model: pending.model ?? undefined,
      });
      const normalized = normalizeReconcileOutcome(result);
      if (normalized === "confirmed_applied") {
        return "settled";
      }
      if (normalized === "replay_safe") {
        return "retry";
      }
      return "ambiguous";
    } catch {
      return "ambiguous";
    }
  }

  /**
   * #100: Abort the exact active invocation and wait for validated
   * settlement within a bounded timeout. Throws on abort rejection or
   * timeout — the caller must NOT swallow the error.
   *
   * iris_agent#114 (Feature C5): when `iter` is provided (watchdog teardown
   * of a PARKED generator), the production teardown order is:
   *
   *   1. START the abort (never fire-and-forget — the promise is awaited
   *      below; a rejection is surfaced, not swallowed). Sending the
   *      signal first is what unblocks the suspended inner native await;
   *   2. THEN call iter.return(). The return is queued while the
   *      coordinator generator is parked on the stalled inner await; once
   *      the abort settles the harness, the generator reaches its final
   *      yield, the queued return takes effect and the coordinator's
   *      finally runs — resolving runCompletion, which is exactly what
   *      unblocks the abort's own settlement wait (breaking the circular
   *      deadlock by ordering, not by fire-and-forget);
   *   3. bounded settlement wait. On reject/timeout the generator may
   *      remain parked and the coordinator latch stays held — the caller
   *      fails closed (zero fallback, runtime non-reusable until explicit
   *      recovery).
   */
  private async abortWithSettlementTimeout(
    invocationId: string,
    reason: string,
    iter?: AsyncIterator<AgentRuntimeEvent>,
  ): Promise<void> {
    const abortTimeoutMs = this.config.abortSettlementTimeoutMs;
    // 1. Abort signal in flight BEFORE the generator close. Note: the
    //    coordinator's abort() itself validates the active invocation and
    //    awaits runCompletion; that wait is resolved by step 2's queued
    //    return once the abort unblocks the harness.
    const abortPromise = this.runtime.abort(invocationId, reason);
    // 2. Close the parked generator AFTER the abort signal. If the abort
    //    rejects synchronously the generator stays parked (fail-closed —
    //    the caller never advances over a possibly-live invocation).
    const closePromise = iter?.return?.().catch(() => undefined) ?? Promise.resolve();
    const timer: { promise: Promise<"timeout">; cancel: () => void } =
      this.makeWatchdogTimer(abortTimeoutMs);
    try {
      const outcome = await Promise.race([
        abortPromise.then(() => "aborted" as const),
        timer.promise.then(() => "timeout" as const),
      ]);
      if (outcome === "timeout") {
        throw new Error(
          `abort settlement timeout for invocation ${invocationId} (reason: ${reason})`,
        );
      }
      // Abort succeeded — the runtime has confirmed the invocation is settled.
      // Ensure the generator close (step 2) also completed before advancing.
      await closePromise;
    } finally {
      timer.cancel();
    }
  }

  /**
   * #101: ONE shared fallback-budget accounting rule. Takes the advanced
   * state (already incremented by the caller), checks against the budget,
   * and returns whether the attempt is allowed plus the snapshot to persist.
   */
  private consumeFallbackAttempt(advanced: RecoveryStateSnapshot): {
    allowed: boolean;
    snapshot: RecoveryStateSnapshot;
  } {
    const budget = this.config.fallbackAttemptBudget;
    if (advanced.fallbackAttempts > budget) {
      return { allowed: false, snapshot: advanced };
    }
    return { allowed: true, snapshot: advanced };
  }
}
