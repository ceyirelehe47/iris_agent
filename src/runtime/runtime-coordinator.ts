import type { AgentRuntimeEvent, AgentRuntimePort } from "../contracts/runtime-ports.js";
import type { AgentRuntimePhase } from "../contracts/runtime-ports.js";
import type { InvocationBinding } from "./harness-factory.js";
import type { AgentInput } from "../contracts/origin.js";
import type { ActiveRuntimePort } from "./active-runtime-registry.js";
import type { Model } from "@iris/pi-ai";

/**
 * iris_agent#89: Model resolution port for production fallback dispatch.
 *
 * The supervisor needs to select a fallback model/provider without duplicating
 * Pi's native provider loop. This port lets the coordinator resolve a model
 * identifier (from the fallback chain) to a concrete Pi `Model` object, then
 * apply it to the active harness before the next dispatch.
 *
 * Pi remains the sole same-provider/same-model transport retry loop. The
 * supervisor only decides WHEN to switch models; Pi's native retry handles
 * transient failures within one model.
 */
export interface ModelOverridePort {
  /**
   * Resolve a model identifier to a concrete Pi `Model` object.
   * Returns undefined when the model is not in the current provider catalog
   * or when the identifier is ambiguous across providers (iris_agent#101 —
   * callers must fail closed, never dispatch the prior model).
   */
  resolveModel(modelId: string): Model<string> | undefined;
  /**
   * Apply a model override to the currently active runtime capsule.
   * Called before dispatch when the supervisor selects a fallback model.
   */
  applyModelOverride(model: Model<string>): Promise<void>;
  /**
   * Return the currently active model's id, or undefined if unknown.
   * Used to skip redundant setModel calls that can reset provider state.
   */
  getActiveModelId?(): string | undefined;
}

/**
 * iris_agent#101: typed fail-closed error for a fallback target that cannot
 * be applied. Thrown BEFORE any dispatch when the selected provider/model
 * pair is missing from the catalog, ambiguous across providers, or the
 * runtime has no model-override port. The Recovery Supervisor classifies the
 * message (`model_not_found`) and advances the bounded fallback policy —
 * the prior model is never silently reused under the guise of a fallback.
 */
export class UnresolvableFallbackTargetError extends Error {
  public readonly targetId: string;
  public constructor(targetId: string, reason: string) {
    super(
      `unresolvable fallback target '${targetId}': model_not_found ${reason.replace(/\s+/g, "_")}`,
    );
    this.name = "UnresolvableFallbackTargetError";
    this.targetId = targetId;
  }
}

/**
 * iris_agent#101: resolve a fallback target id to a unique Pi `Model`.
 *
 * Target ids are qualified as `provider/model` for an unambiguous
 * provider+model identity. Bare legacy ids (no `/`) are also accepted, but
 * only when exactly ONE model in the catalog carries that id — a duplicate id
 * across providers is ambiguous and resolves to undefined (fail closed).
 */
export function resolveFallbackModel(
  catalog: Model<string>[],
  targetId: string,
): Model<string> | undefined {
  const slash = targetId.indexOf("/");
  if (slash > 0 && slash < targetId.length - 1) {
    const provider = targetId.slice(0, slash);
    const model = targetId.slice(slash + 1);
    const matches = catalog.filter((m) => m.provider === provider && m.id === model);
    return matches.length === 1 ? matches[0] : undefined;
  }
  const matches = catalog.filter((m) => m.id === targetId);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Thin Runtime Coordinator (00 Module Boundaries, 03 Runtime Coordinator).
 *
 * Owns only: one-active-invocation latch, process-local invocationId
 * correlation, precise abort forwarding to the CURRENT active Capsule, native
 * event forwarding, and latch release gated on Pi settled. It does NOT own a
 * second phase machine, model/tool loop, message persistence, pending-write
 * recovery, durable invocation outcome or assistant result store — those
 * belong to Pi / the Capsule (PiRuntimeAdapter).
 *
 * The Coordinator obtains the active Capsule through the ActiveRuntimePort
 * (registry) on every prompt() — ordinary modules never cache a stale
 * Harness/Session, and after a rollover CAS the old runtime is no longer
 * reachable (03 Host Runtime: Active Runtime Registry).
 *
 * The Coordinator observes the native settled boundary and notifies the Host
 * through `onSettledBoundary`. The Host (not the Coordinator) drives the
 * rollover; this callback is the "settled authorization" — only a settled
 * observed on the CURRENT active Epoch may authorize one switch.
 */

export interface SettledBoundaryInfo {
  invocationId: string;
  epochId: string;
  runtimeSessionId: string;
  settledAt: string;
}

export interface RuntimeCoordinatorOptions {
  /** Registry providing the current ready Capsule (ActiveRuntimePort). */
  activeRuntime: ActiveRuntimePort;
  /**
   * iris_agent#89: Optional model override port for production fallback.
   * When provided, the coordinator implements `promptWithModel` by resolving
   * the model id via this port and applying it to the active harness before
   * dispatch. This is the ONLY production seam through which the supervisor
   * can switch models — it does NOT duplicate Pi's native provider loop.
   */
  modelOverride?: ModelOverridePort;
  /**
   * Derives the InvocationBinding（Pi-runtime binding：session binding + epoch
   * info + canonical system prompt identity）for an input, scoped to the
   * active runtime Session/Epoch. Called before every prompt().
   * Feature B (goal.txt §5): the binding is a MINIMAL Pi-runtime binding —
   * it carries NO Context assembly state. Context assembly is owned by
   * @iris/context（ContextService/generation）。
   */
  prepareInvocation: (
    input: AgentInput,
    runtimeSessionId: string,
    epochId: string,
  ) => Promise<InvocationBinding>;
  /**
   * Fired exactly once per invocation when Pi native settled is observed on
   * the bound active Epoch. The Host uses this to release the invocation and,
   * when a rollover was requested, to switch Epochs (02 Runtime Sessions,
   * Rollover Boundary: settled is the only normal switch point).
   */
  onSettledBoundary?: (info: SettledBoundaryInfo) => void | Promise<void>;
  /**
   * review-pass-2 #3: fired at the START of every invocation so the Host can
   * invalidate any stale settled token from a previous invocation. A settled
   * token may only authorize a rollover for the invocation that produced it.
   */
  onInvocationStart?: (info: {
    epochId: string;
    runtimeSessionId: string;
    invocationId: string;
  }) => void;
  maxQueuedInputs?: number;
}

export class RuntimeCoordinator implements AgentRuntimePort {
  private readonly activeRuntime: ActiveRuntimePort;
  private readonly modelOverride: ModelOverridePort | undefined;
  private readonly prepareInvocation: RuntimeCoordinatorOptions["prepareInvocation"];
  private readonly onSettledBoundary: RuntimeCoordinatorOptions["onSettledBoundary"];
  private readonly onInvocationStart: RuntimeCoordinatorOptions["onInvocationStart"];
  private readonly maxQueuedInputs: number;
  private activeInvocation: string | null = null;
  private readonly queuedInputs: AgentInput[] = [];
  private phase: AgentRuntimePhase = "idle";
  /** Resolved when the current prompt() generator fully completes (settled
   * or failed). Used by abort/shutdown to wait for the Pi native settled
   * boundary without releasing the latch prematurely. */
  private runCompletion: Promise<void> | null = null;
  private resolveRunCompletion: (() => void) | null = null;

  constructor(options: RuntimeCoordinatorOptions) {
    this.activeRuntime = options.activeRuntime;
    this.modelOverride = options.modelOverride;
    this.prepareInvocation = options.prepareInvocation;
    this.onSettledBoundary = options.onSettledBoundary;
    this.onInvocationStart = options.onInvocationStart;
    this.maxQueuedInputs = options.maxQueuedInputs ?? 20;
  }

  getPhase(): AgentRuntimePhase {
    return this.phase;
  }

  /**
   * Queue an origin-aware input for a later invocation. The Host input pump
   * drains the queue after each settled boundary and starts each queued input
   * as a fresh prompt() (spec: queued nextTurn is a fresh prompt, never a
   * bare steer). Queueing is bounded: overflow throws a typed error instead
   * of silently dropping the input.
   */
  enqueue(input: AgentInput): void {
    if (this.queuedInputs.length >= this.maxQueuedInputs) {
      throw new Error(`input queue full (max ${this.maxQueuedInputs})`);
    }
    this.queuedInputs.push(input);
  }

  queuedCount(): number {
    return this.queuedInputs.length;
  }

  /** FIFO dequeue; returns undefined when the queue is empty. */
  dequeue(): AgentInput | undefined {
    return this.queuedInputs.shift();
  }

  /**
   * Run one invocation through the CURRENT active Capsule.
   *
   * The runtimeSessionId is frozen at invocation start and never changes mid-
   * invocation (03 Runtime Coordinator, Invocation Invariant). The latch is
   * released ONLY after native settled is observed on that bound Epoch; an
   * abort without settled leaves the latch held until the Host recovers.
   */
  async *prompt(input: AgentInput): AsyncIterable<AgentRuntimeEvent> {
    if (this.activeInvocation !== null) {
      throw new Error(`invocation ${this.activeInvocation} already active`);
    }
    if (this.phase === "failed") {
      throw new Error("coordinator is in failed state; call reset() before a new invocation");
    }

    // Read the current ready Capsule from the registry — never a cached one.
    const handle = this.activeRuntime.getActiveRuntime();
    const epochId = handle.epochId;
    const runtimeSessionId = handle.runtimeSessionId;

    const invocationId = `invocation-${input.inputId}`;
    this.activeInvocation = invocationId;
    this.phase = "turn";
    let failedCode: string | undefined;
    let settledSeen = false;
    this.runCompletion = new Promise<void>((resolve) => {
      this.resolveRunCompletion = resolve;
    });
    // review-pass-2 #3: invalidate any stale settled token from a previous
    // invocation — the token may only authorize a rollover for THIS
    // invocation once it actually settles.
    this.onInvocationStart?.({ epochId, runtimeSessionId, invocationId });
    try {
      yield { type: "turn_start", invocationId };

      // Prepare + bind InvocationBinding for THIS input, scoped to the
      // active Session/Epoch (invariant: the bound runtimeSessionId does not
      // change mid-invocation). The binding is a shared mutable container
      // (the adapter holds the same object reference), so updating its
      // fields keeps companion pairing and the context hook in sync — never
      // a stale input (review blocker #1).
      const prepared = await this.prepareInvocation(input, runtimeSessionId, epochId);
      handle.binding.input = input;
      handle.binding.invocationId = invocationId;
      handle.binding.runtimeSessionId = prepared.runtimeSessionId;
      handle.binding.epochId = prepared.epochId;
      handle.binding.instanceEpoch = prepared.instanceEpoch;
      handle.binding.canonicalSystemPrompt = prepared.canonicalSystemPrompt;
      handle.binding.providerProfileId = prepared.providerProfileId;
      handle.binding.preparedAt = prepared.preparedAt;

      // Forward native events from the current Capsule. Consume the FULL
      // generator: breaking early would return() the Capsule generator and
      // skip its phase transition to idle, leaving the single-writer latch
      // held forever. `settledSeen` records the boundary without interrupting.
      for await (const event of handle.runtime.prompt(input)) {
        if (event.type === "settled") {
          settledSeen = true;
        }
        yield event;
      }

      if (!settledSeen) {
        // Native settled never observed even though prompt() resolved: enter
        // the explicit failure path instead of silently releasing the latch.
        failedCode = "settled_not_observed";
        this.phase = "failed";
        yield { type: "failed", invocationId, code: failedCode };
      } else {
        this.phase = "idle";
        await this.onSettledBoundary?.({
          invocationId,
          epochId,
          runtimeSessionId,
          settledAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      if (failedCode === undefined) {
        failedCode = "harness_error";
        this.phase = "failed";
        yield { type: "failed", invocationId, code: failedCode };
      }
      throw error;
    } finally {
      // Signal run completion so abort()/shutdown() can await the settled
      // boundary (M3). MUST run after the latch/phase transition above.
      this.resolveRunCompletion?.();
      this.runCompletion = null;
      this.resolveRunCompletion = null;
      // iris_agent#114 (Feature C5): the single-writer latch is released
      // ONLY on a validated native settled boundary — never on generator
      // cleanup alone ("generator cleanup != Pi native settled", goal.txt
      // §6). Three exit shapes:
      //  - settledSeen === true: Pi native settled was positively observed
      //    on the bound Epoch — the normal release authority. phase->"idle",
      //    activeInvocation=null. This also covers a generator closed by
      //    iter.return() AFTER the abort unblocked the run (the body's
      //    idle transition may not have run yet — the settled observation
      //    is the authority, not the body's bookkeeping).
      //  - phase === "turn" && !settledSeen: the generator was closed while
      //    parked on the native stream WITHOUT a settled boundary (watchdog
      //    iter.return() on a stalled run). Fail closed: phase->"failed"
      //    and activeInvocation is deliberately KEPT — the invocation may
      //    still be live, so the latch is only releasable through reset()
      //    (explicit recovery) or a successful dispatch. This reverts the
      //    iris_agent#111 force-release band-aid, which let Iris consider
      //    the invocation idle merely because the outer generator closed.
      //  - phase === "failed": normal completion without settled
      //    (settled_not_observed / harness_error). The native run ended —
      //    release the latch; phase "failed" still blocks new prompts
      //    until reset().
      if (settledSeen) {
        this.phase = "idle";
        this.activeInvocation = null;
      } else if (this.phase === "turn") {
        this.phase = "failed";
      } else {
        this.activeInvocation = null;
      }
    }
  }

  /**
   * Explicit recovery after a failed invocation (native settled never
   * observed): releases the latch so the Host may recover or replace the
   * Epoch. No-op when not in failed state.
   */
  reset(): void {
    if (this.phase === "failed") {
      this.phase = "idle";
      this.activeInvocation = null;
    }
  }

  /**
   * Precise abort forwarding (M3): forwards to the CURRENT active Capsule when
   * the invocation is active, then WAITS for the Pi native settled boundary
   * (abort -> native agent_end/settled -> release invocation). A wrong
   * invocation id is rejected; the latch is NOT released by abort alone (03
   * Runtime Coordinator, Abort). If the run does not settle within
   * `timeoutMs` the promise rejects so the caller can recover.
   */

  /**
   * iris_agent#89: Production model override dispatch.
   *
   * When the Recovery Supervisor selects a fallback model, it calls this
   * method instead of `prompt()`. The coordinator resolves the model id via
   * the ModelOverridePort, applies it to the active harness via
   * `harness.setModel()`, then proceeds with the normal dispatch flow.
   *
   * This is the ONLY production seam for model/provider fallback. Pi's native
   * same-provider/same-model retry loop remains L1 and is NOT duplicated here.
   *
   * iris_agent#101: fail-closed target resolution. A selected fallback target
   * must be EXACTLY the pair used by the next dispatch. When the target
   * cannot be resolved (missing) or is ambiguous (duplicate model ids across
   * providers), this throws {@link UnresolvableFallbackTargetError} BEFORE
   * any dispatch — the prior model is never silently reused under the guise
   * of a fallback. The supervisor classifies the typed error as
   * `model_not_found` and advances the bounded fallback policy.
   */
  async *promptWithModel(
    input: AgentInput,
    modelId: string | null,
  ): AsyncIterable<AgentRuntimeEvent> {
    if (modelId !== null) {
      if (this.modelOverride === undefined) {
        throw new UnresolvableFallbackTargetError(
          modelId,
          "no model override port is configured on this runtime",
        );
      }
      const resolved = this.modelOverride.resolveModel(modelId);
      if (resolved === undefined) {
        throw new UnresolvableFallbackTargetError(
          modelId,
          "target is missing from the provider catalog or ambiguous across providers",
        );
      }
      // Skip applyModelOverride when the model is already active — avoids
      // unnecessary harness.setModel() calls that can reset provider state
      // (mock providers, response counters, etc.) on initial dispatch.
      // iris_agent#111: compare using QUALIFIED identity (provider/model),
      // not just model.id — the same model id across providers must still
      // trigger setModel.
      const currentQualified = this.modelOverride.getActiveModelId?.();
      const resolvedQualified = `${resolved.provider}/${resolved.id}`;
      if (currentQualified !== resolvedQualified) {
        await this.modelOverride.applyModelOverride(resolved);
      }
    }
    yield* this.prompt(input);
  }

  /**
   * iris_agent#100: return the invocation currently accepted by this
   * coordinator, or null when no invocation is active. The Recovery
   * Supervisor uses this seam when a watchdog fires before the first native
   * stream event was observed, so it can abort the EXACT accepted invocation
   * instead of skipping abort (and dispatching a fallback over a zombie).
   */
  getActiveInvocationId(): string | null {
    return this.activeInvocation;
  }

  async abort(invocationId: string, reason?: string, timeoutMs = 15000): Promise<void> {
    if (this.activeInvocation !== invocationId) {
      throw new Error(`no active invocation ${invocationId}`);
    }
    const runCompletion = this.runCompletion;
    const handle = this.activeRuntime.getActiveRuntime();
    await handle.runtime.abort(invocationId, reason);
    if (runCompletion !== null) {
      await withTimeout(runCompletion, timeoutMs, "abort did not reach native settled");
    }
  }

  /**
   * Abort whatever invocation is currently active without needing its id —
   * used by Host graceful shutdown. Returns false when no invocation is
   * active; otherwise aborts and waits for settled like abort().
   */
  async abortActive(timeoutMs = 15000): Promise<boolean> {
    if (this.activeInvocation === null || this.phase !== "turn") {
      return false;
    }
    const invocationId = this.activeInvocation;
    await this.abort(invocationId, "host_shutdown", timeoutMs);
    return true;
  }
}

async function withTimeout(
  promise: Promise<void>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
