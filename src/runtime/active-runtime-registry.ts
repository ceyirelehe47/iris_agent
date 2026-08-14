import type { AgentRuntimePort } from "../contracts/runtime-ports.js";
import type { RuntimeSessionEpoch } from "../contracts/runtime.js";
import type { InvocationBinding } from "./harness-factory.js";

/**
 * Active runtime registry (00 Module Boundaries, 03 Host Runtime: Active
 * Runtime Registry).
 *
 * The Host exposes exactly one active runtime handle at a time:
 *
 *   interface ActiveRuntimeHandle {
 *     epochId: string;
 *     runtimeSessionId: string;
 *     runtime: AgentRuntimePort;
 *   }
 *
 * Updates must go through the Epoch Manager's CAS; ordinary modules must NOT
 * cache a stale Harness/Session concrete object. After a rollover the old
 * handle may only complete cleanup/diagnostics — it never receives a prompt
 * again. The registry is the single source of truth for "which Capsule is
 * currently ready".
 */

export interface ActiveRuntimeHandle {
  epochId: string;
  runtimeSessionId: string;
  runtime: AgentRuntimePort;
  /** Session-local binding updated by the Coordinator before each prompt(). */
  binding: InvocationBinding;
}

export interface ActiveRuntimePort {
  getActiveRuntime(): ActiveRuntimeHandle;
}

export class ActiveRuntimeRegistry implements ActiveRuntimePort {
  private handle: ActiveRuntimeHandle | null = null;

  /** Install the initial ready runtime (startup). Fails if already set. */
  install(handle: ActiveRuntimeHandle): void {
    if (this.handle !== null) {
      throw new Error(
        `active runtime already installed (${this.handle.epochId}); use casSwap for rollover`,
      );
    }
    this.handle = handle;
  }

  getActiveRuntime(): ActiveRuntimeHandle {
    if (this.handle === null) {
      throw new Error("no active runtime installed");
    }
    return this.handle;
  }

  getActiveOrNull(): ActiveRuntimeHandle | null {
    return this.handle;
  }

  /**
   * Rollover CAS (02 Runtime Sessions, Rollover Boundary). Replaces the
   * active handle atomically only when the current handle is exactly
   * `expectedEpochId`. Returns true when the swap happened; false when the
   * expected epoch is no longer active (a competing switch won).
   */
  casSwap(expectedEpochId: string, next: ActiveRuntimeHandle): boolean {
    if (this.handle === null) {
      throw new Error("no active runtime installed; cannot swap");
    }
    if (this.handle.epochId !== expectedEpochId) {
      return false;
    }
    // A rollover may only happen when no invocation is active: the old
    // runtime must have reached native settled and released its latch.
    if (this.handle.runtime.getPhase() === "turn") {
      throw new Error(`cannot swap active runtime while epoch ${expectedEpochId} is in turn`);
    }
    this.handle = next;
    return true;
  }

  clear(): void {
    this.handle = null;
  }
}

export function activeRuntimeHandle(
  epoch: RuntimeSessionEpoch,
  runtime: AgentRuntimePort,
  binding: InvocationBinding,
): ActiveRuntimeHandle {
  return {
    epochId: epoch.epochId,
    runtimeSessionId: epoch.runtimeSessionId,
    runtime,
    binding,
  };
}
