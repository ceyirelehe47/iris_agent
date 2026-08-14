import type { AgentInput } from "./origin.js";

/**
 * Agent-domain runtime port contracts (agent-domain, retained).
 *
 * These types describe the Iris runtime capsule seam over the Pi substrate —
 * the neutral event stream a runtime (PiRuntimeAdapter) emits and the Host /
 * RecoverySupervisor consume. They are Pi/transport-level contracts and are
 * NOT Context/Historian domain contracts (those now live in @iris/context).
 */
export type AgentRuntimePhase =
  "idle" | "turn" | "retry" | "compaction" | "branch_summary" | "failed";

export type AgentRuntimeEvent =
  | { type: "turn_start"; invocationId: string }
  | { type: "message_delta"; invocationId: string; text: string }
  | { type: "tool_call"; invocationId: string; toolCallId: string; toolName: string }
  | { type: "tool_result"; invocationId: string; toolCallId: string; toolName: string }
  | { type: "settled"; invocationId: string; nextTurnCount: number }
  | {
      type: "failed";
      invocationId: string;
      code: string;
      /** Native failure message (e.g. the harness failure-message errorMessage). */
      message?: string;
    };

export interface AgentRuntimePort {
  prompt(input: AgentInput): AsyncIterable<AgentRuntimeEvent>;
  abort(invocationId: string, reason?: string): Promise<void>;
  getPhase(): AgentRuntimePhase;
  /**
   * Optional model-override entry point (iris_agent#89): runs `prompt` but
   * forces the runtime to use the given model id (the recovery supervisor's
   * selected fallback model). Runtimes that cannot override the model leave
   * this undefined — callers fall back to `prompt` for backward compatibility.
   */
  promptWithModel?(input: AgentInput, model: string | null): AsyncIterable<AgentRuntimeEvent>;
  /**
   * iris_agent#100: optional seam to obtain the identity of the invocation
   * currently accepted by the runtime, WITHOUT waiting for the first stream
   * event. The supervisor needs this when a watchdog fires before the native
   * loop emitted anything (the accepted invocation id exists runtime-side but
   * has not been observed). Runtimes without an accepted-invocation concept
   * leave this undefined — the supervisor then fails closed instead of
   * dispatching a fallback over an unidentified invocation.
   */
  getActiveInvocationId?(): string | null;
  /**
   * iris_agent#111: optional seam to abort whatever invocation is currently
   * active without needing its id. Used by the supervisor's finally-block
   * teardown to unblock a stalled generator before calling iter.return().
   * Returns false when no invocation is active.
   */
  abortActive?(timeoutMs?: number): Promise<boolean>;
}
