import type { AgentRuntimeEvent, AgentRuntimePort } from "../contracts/ports.js";
import type { AgentInput } from "../contracts/origin.js";

import {
  type FallbackConfig,
  type RecoveryStateSnapshot,
  type RetryClassification,
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
}

/**
 * Port the supervisor uses to (a) invoke the underlying runtime and (b)
 * reconcile outcome_unknown before replay. The reconcile callback must return
 * true when it is safe to replay (the prior outcome was confirmed terminal or
 * never persisted); false blocks replay.
 */
export interface RecoverySupervisorOptions {
  /** The underlying RuntimeCoordinator (or any AgentRuntimePort). */
  runtime: AgentRuntimePort;
  /** Ordered fallback chain + budgets/timeouts. */
  config: FallbackConfig;
  /**
   * Called when the native loop reports outcome_unknown. Must reconcile the
   * prior partial state (did the side effect commit?) and return whether replay
   * is safe. Defaults to blocking (returns false) — callers SHOULD supply a
   * real reconciler.
   */
  reconcileOutcomeUnknown?: (signal: RecoverySignal) => Promise<boolean>;
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

export class RecoverySupervisor {
  private readonly runtime: AgentRuntimePort;
  private readonly config: FallbackConfig;
  private readonly reconcile: (signal: RecoverySignal) => Promise<boolean>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

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

    const dispatch =
      options?.dispatch ??
      ((inputArg: AgentInput): AsyncIterable<AgentRuntimeEvent> => this.runtime.prompt(inputArg));

    try {
      let fallbackAttempts = 0;
      let reservedRetries = 0;

      for (;;) {
        // 8. Overall recovery budget check.
        if (now() - startedAt > this.config.overallBudgetMs) {
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
              nativeSettled = true;
              yield event;
              break;
            }
            if (event.type === "failed") {
              nativeFailedCode = event.code;
              yield event;
              // Don't break — the iterator may produce more. But classify after.
            } else {
              yield event;
            }
          }
        } catch (error) {
          // Native loop threw — classify from the error.
          nativeFailedMessage = error instanceof Error ? error.message : String(error);
        } finally {
          await iter.return?.().catch(() => undefined);
        }

        // --- Success: clean exit ---
        if (nativeSettled && nativeFailedCode === undefined) {
          persist({ ...this.state, currentModel: model });
          return;
        }

        // --- Watchdog abort detection ---
        if (stallDetected !== null) {
          yield {
            type: "recovery_escalation",
            logicalExecutionId,
            reason: "transient_retryable",
            action: "abort",
            detail: stallDetected,
            ...(model !== null ? { nextModel: model } : {}),
          };
        }

        // --- Classify the failure ---
        const classification = classifyNativeFailure(nativeFailedCode, nativeFailedMessage);

        // 6. outcome_unknown reconciliation before replay.
        if (classification === "outcome_unknown") {
          yield {
            type: "recovery_escalation",
            logicalExecutionId,
            reason: "outcome_unknown",
            action: "abort",
            detail: "awaiting_reconciliation",
          };
          const safe = await this.reconcile({
            classification,
            detail: nativeFailedMessage ?? nativeFailedCode,
            ...(model !== undefined ? { model: model ?? undefined } : {}),
          });
          const updated: RecoveryStateSnapshot = {
            ...this.state,
            outcomeUnknown: this.state.outcomeUnknown + 1,
          };
          persist(updated);
          if (!safe) {
            // Do NOT replay until reconciliation confirms it is safe.
            throw new RecoveryExhaustedError(
              logicalExecutionId,
              "outcome_unknown_unreconciled",
              "replay blocked pending reconciliation",
            );
          }
          // Safe to replay as a fresh attempt (external effects already
          // guarded by Pi idempotency). Continue the loop.
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
        // fallback budget.
        if (classification === "reserved_dispatch") {
          if (reservedRetries < this.config.reservedDispatchRetries) {
            reservedRetries += 1;
            yield {
              type: "recovery_escalation",
              logicalExecutionId,
              reason: "reserved_dispatch",
              action: "reserved_dispatch_retry",
              attempt: reservedRetries,
            };
            // Linear backoff (no exponential); small fixed delay.
            await this.sleep(100);
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
          const nextModel = this.advanceFallback();
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
          fallbackAttempts += 1;
          if (fallbackAttempts > this.config.fallbackAttemptBudget) {
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
        if (classification === "transient_retryable") {
          const attempts = this.state.sameModelAttempts;
          if (attempts < this.config.sameModelRetryBudget) {
            const backoff = sameModelBackoffMs(attempts);
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
          this.markModelFailed(model);
          const nextModel = this.advanceFallback();
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
          fallbackAttempts += 1;
          if (fallbackAttempts > this.config.fallbackAttemptBudget) {
            const exhausted = { ...this.state, exhausted: true };
            persist(exhausted);
            throw new RecoveryExhaustedError(logicalExecutionId, "fallback_budget_exhausted");
          }
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

  /** Mark a model as failed with a cooldown. */
  private markModelFailed(model: string | null): void {
    if (model === null || this.state === null) {
      return;
    }
    const cooldownUntil = new Date(this.now() + this.config.failedModelCooldownMs).toISOString();
    this.state = {
      ...this.state,
      failedModels: { ...this.state.failedModels, [model]: cooldownUntil },
    };
  }

  /**
   * Advance the fallback index to the next available model. Returns the new
   * model id, or null when the chain is exhausted.
   */
  private advanceFallback(): string | null {
    if (this.state === null) {
      return null;
    }
    const nextIdx = this.state.fallbackIndex + 1;
    if (nextIdx >= this.config.models.length) {
      this.state = { ...this.state, fallbackIndex: nextIdx };
      return null;
    }
    const nextModel = this.config.models[nextIdx];
    this.state = { ...this.state, fallbackIndex: nextIdx };
    return nextModel ?? null;
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

    // Determine the active watchdog timeout. If no subagent started, or
    // subagent already has progress, the no-progress watchdog governs. If a
    // subagent started but has no progress yet, the shorter of the two wins.
    let watchdogTimeout = this.config.fallbackNoProgressTimeoutMs;
    let watchdogKind: "no_progress" | "subagent" = "no_progress";
    if (flags.subagentStarted && !flags.subagentFirstProgress) {
      watchdogTimeout = Math.min(watchdogTimeout, this.config.subagentFirstProgressMs);
      if (this.config.subagentFirstProgressMs < this.config.fallbackNoProgressTimeoutMs) {
        watchdogKind = "subagent";
      }
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
}
