import type { AgentRuntimeEvent, AgentRuntimePort } from "../contracts/ports.js";
import type { AgentRuntimePhase } from "../contracts/runtime-ports.js";
import type { PreparedV2Sources } from "../contracts/context-v27.js";
import type { AgentInput } from "../contracts/origin.js";
import type { ActiveRuntimePort } from "./active-runtime-registry.js";

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
   * Derives the frozen P0–P2 authoritative sources + canonical system prompt
   * for an input, scoped to the active runtime Session/Epoch. Called before
   * every prompt(). v27: invocation 只绑定 prepared V2 sources
   * （currentInvocation）；Context generation 由 V2 pipeline
   * （contextController → v2-generation + v2-renderer）在 provider render 时
   * 构建（m0/m1 物化语义已删除）。
   */
  prepareInvocation: (
    input: AgentInput,
    runtimeSessionId: string,
    epochId: string,
  ) => Promise<PreparedV2Sources>;
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

      // Prepare + bind the frozen P0-P2 V2 sources for THIS input, scoped to
      // the active Session/Epoch (invariant: the bound runtimeSessionId does
      // not change mid-invocation). The binding is a shared mutable container
      // (the adapter holds the same object reference), so updating its
      // fields keeps companion pairing and the context hook in sync — never
      // a stale input (review blocker #1).
      const prepared = await this.prepareInvocation(input, runtimeSessionId, epochId);
      handle.binding.input = input;
      handle.binding.prepared = prepared;
      handle.binding.invocationId = invocationId;

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
      if (this.phase === "idle" || this.phase === "failed") {
        if (this.phase === "idle") {
          this.activeInvocation = null;
        }
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
