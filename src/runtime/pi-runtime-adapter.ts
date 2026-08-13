import type { AgentHarness, Session } from "@iris/pi-agent-core";

import type { AgentRuntimeEvent, AgentRuntimePort } from "../contracts/ports.js";
import type { AgentRuntimePhase } from "../contracts/runtime-ports.js";
import type { AgentInput } from "../contracts/origin.js";
import type { InvocationBinding } from "./harness-factory.js";
import { encodeInputFrames } from "./companion.js";
import { findInputPairsByProjection } from "./context-adapter.js";
import { projectSessionMessages } from "./session-projection.js";

/**
 * PiRuntimeAdapter wraps one AgentHarness + its mutable InvocationBinding into
 * an AgentRuntimePort. It owns the per-prompt binding update, the
 * input-frame encoding, native Pi event bridging and the settled gate —
 * exactly what the previous RuntimeCoordinator.prompt() did, but now as a
 * per-Capsule runtime object so the ActiveRuntimeRegistry can swap runtimes on
 * rollover without ever re-wiring the Coordinator to a new harness.
 *
 * The adapter is created once per Pi Session (per Runtime Epoch). After a
 * rollover the old adapter's harness is not reused; it only completes
 * cleanup/diagnostics (02 Runtime Sessions, 03 Host Runtime: Active Runtime
 * Registry).
 */

/** Minimal FIFO async queue used to bridge native Pi events into the port stream. */
class EventQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(item: T) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter(item);
      return;
    }
    this.items.push(item);
  }

  async next(): Promise<T | undefined> {
    const item = this.items.shift();
    if (item !== undefined) {
      return item;
    }
    if (this.closed) {
      return undefined;
    }
    return new Promise<T>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters) {
      waiter(undefined as T);
    }
    this.waiters.length = 0;
  }
}

export class PiRuntimeAdapter implements AgentRuntimePort {
  private readonly harness: AgentHarness;
  private readonly session: Session;
  private readonly binding: InvocationBinding;
  private phase: AgentRuntimePhase = "idle";
  /**
   * C6 (#119/#114/#100): Native settlement receipt — resolves ONLY when the
   * adapter observes the native Pi "settled" event for the current invocation.
   * This is distinct from runCompletion (generator cleanup) and is the
   * authoritative proof that the provider invocation has reached a terminal
   * native state.
   */
  private settlementResolve: (() => void) | null = null;
  private settlementReject: ((error: Error) => void) | null = null;
  private nativeSettlementReceipt: Promise<void> | null = null;

  constructor(options: {
    harness: AgentHarness;
    session: Session;
    binding: InvocationBinding;
    /** 0.83.0+：Session 连接由 repository 管理，dispose 经 repo asyncDispose。 */
    repo: { [Symbol.asyncDispose](): Promise<void> };
  }) {
    this.harness = options.harness;
    this.session = options.session;
    this.binding = options.binding;
    this.repo = options.repo;
  }

  getPhase(): AgentRuntimePhase {
    return this.phase;
  }

  /**
   * iris_agent#89: Apply a model override to the underlying Pi harness.
   * This is called by the RuntimeCoordinator's ModelOverridePort before a
   * fallback dispatch. The harness.setModel() call is asynchronous and
   * atomic from the perspective of the next prompt().
   */
  async setModel(model: import("@iris/pi-ai").Model<string>): Promise<void> {
    await this.harness.setModel(model);
  }

  /**
   * iris_agent#89: Get the current model from the harness.
   */
  getModel(): import("@iris/pi-ai").Model<string> {
    return this.harness.getModel() as import("@iris/pi-ai").Model<string>;
  }

  /**
   * iris_agent#107: Get the current active model's id from the harness.
   * Used by the ModelOverridePort to detect when setModel is redundant
   * and to reflect the current model after fallback/rollover.
   */
  /**
   * iris_agent#107/#111: Get the current active model's QUALIFIED identity
   * (provider/model) from the harness. Used by the ModelOverridePort to
   * detect when setModel is needed — comparing only model.id is insufficient
   * because the same model id can exist across multiple providers.
   */
  getCurrentModelId(): string | undefined {
    try {
      const m = this.harness.getModel() as { id?: string; provider?: string } | undefined;
      if (m === undefined) return undefined;
      return m.provider !== undefined ? `${m.provider}/${m.id ?? ""}` : m.id;
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve the committed Pi input pair (UserMessage + iris_input_meta
   * companion) for the CURRENT invocation's inputId, if the pair is durably
   * present. The Host uses this to mark the ingress record session_committed
   * (03 Host Runtime, Durable Input Acceptance) — never a synthetic repair.
   *
   * iris_agent#6: identity comes from the raw-entry projection, never from an
   * index into a compressed message array. This is the SECOND writer of
   * pi_user_entry_id (the settle path, host.ts) — it must honor the same
   * raw-identity invariant as reconcileUncommitted.
   */
  async resolveCommittedPair(): Promise<
    { userEntryId: string; companionEntryId: string } | undefined
  > {
    const entries = await this.session.getEntries();
    const projected = projectSessionMessages(entries);
    const pairs = findInputPairsByProjection(projected);
    const inputId = this.binding.input.inputId;
    // Find the LAST pair whose companion carries the current inputId.
    for (let index = pairs.length - 1; index >= 0; index -= 1) {
      const pair = pairs[index];
      if (pair === undefined) {
        continue;
      }
      const details = pair.companion.message.details as { iris?: { inputId?: string } } | undefined;
      if (details?.iris?.inputId === inputId) {
        // Both entry ids come from the projection, which preserved the real
        // raw entry ids (and verified raw adjacency / parent chain).
        return {
          userEntryId: pair.user.entryId,
          companionEntryId: pair.companion.entryId,
        };
      }
    }
    return undefined;
  }

  async *prompt(input: AgentInput): AsyncIterable<AgentRuntimeEvent> {
    if (this.phase === "failed") {
      throw new Error(
        "runtime is in failed state; the Epoch must be recovered before a new prompt",
      );
    }
    const invocationId = this.binding.invocationId;
    this.phase = "turn";
    let unsubscribe: (() => void) | undefined;
    let settledSeen = false;
    let failedCode: string | undefined;
    const queue = new EventQueue<AgentRuntimeEvent>();
    // C6: Create native settlement receipt for this invocation.
    this.nativeSettlementReceipt = new Promise<void>((resolve, reject) => {
      this.settlementResolve = resolve;
      this.settlementReject = reject;
    });
    try {
      // NOTE: the Coordinator emits turn_start; the adapter must not duplicate
      // it (single event truth for the port stream).

      unsubscribe = this.harness.subscribe(async (event) => {
        switch (event.type) {
          case "message_update": {
            const text = extractTextDelta(event);
            if (text !== "") {
              queue.push({ type: "message_delta", invocationId, text });
            }
            return;
          }
          case "tool_execution_start":
            queue.push({
              type: "tool_call",
              invocationId,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
            });
            return;
          case "tool_execution_end":
            queue.push({
              type: "tool_result",
              invocationId,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
            });
            return;
          case "settled":
            settledSeen = true;
            // C6: Resolve the native settlement receipt — proves native terminal state.
            this.settlementResolve?.();
            queue.push({ type: "settled", invocationId, nextTurnCount: event.nextTurnCount });
            return;
          default:
            return;
        }
      });

      // The binding was updated by the Coordinator before prompt(); encode the
      // CURRENT input's frames so companion pairing never uses a stale input.
      const promptPromise = this.harness.prompt(encodeInputFrames(input.blocks));
      for (;;) {
        const event = await Promise.race([queue.next(), promptPromise.then(() => undefined)]);
        if (event === undefined) {
          break;
        }
        if (event.type === "settled") {
          yield event;
          break;
        }
        yield event;
      }
      await promptPromise.catch(() => undefined);

      if (!settledSeen) {
        failedCode = "settled_not_observed";
        this.phase = "failed";
        yield { type: "failed", invocationId, code: failedCode };
      } else {
        this.phase = "idle";
      }
    } catch (error) {
      if (failedCode === undefined) {
        failedCode = "harness_error";
        this.phase = "failed";
        yield { type: "failed", invocationId, code: failedCode };
      }
      throw error;
    } finally {
      unsubscribe?.();
      queue.close();
      // C6: If the prompt exits WITHOUT observing settled, reject the receipt.
      if (!settledSeen) {
        this.settlementReject?.(new Error("prompt ended without native settled"));
      }
      this.nativeSettlementReceipt = null;
      this.settlementResolve = null;
      this.settlementReject = null;
    }
  }

  /**
   * C6 (#119/#114/#100): Abort and wait for NATIVE settled proof.
   * This is distinct from RuntimeCoordinator.runCompletion (generator cleanup).
   * The abort() waits for the nativeSettlementReceipt which resolves ONLY
   * when the adapter observes the native "settled" event.
   */
  async abort(invocationId: string, reason?: string, timeoutMs = 15000): Promise<void> {
    void reason;
    const receipt = this.nativeSettlementReceipt;
    await this.harness.abort();
    if (receipt === null) return;
    await Promise.race([
      receipt,
      new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error(`native settlement timeout for ${invocationId} after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  }

  /** Release the failed latch so the Epoch can be recovered/replaced. */
  reset(): void {
    if (this.phase === "failed") {
      this.phase = "idle";
    }
  }

  /**
   * Dispose this Capsule (审查 #4): closes the SAME Session storage this
   * adapter holds (not a re-opened wrapper), so rollover/shutdown actually
   * release the Pi SQLite/storage resources. The Host guarantees no prompt is
   * in flight when this is called (single-writer latch idle).
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    // 0.83.0+：Session 无 storage 访问器；释放其连接 = repo asyncDispose。
    await this.repo[Symbol.asyncDispose]();
  }

  private disposed = false;
  private readonly repo: { [Symbol.asyncDispose](): Promise<void> };
}

interface MessageUpdateEventLike {
  type: "message_update";
  assistantMessageEvent: {
    type: string;
    delta?: string;
    text?: string;
  };
}

function extractTextDelta(event: MessageUpdateEventLike): string {
  const delta = event.assistantMessageEvent.delta;
  if (typeof delta === "string") {
    return delta;
  }
  const text = event.assistantMessageEvent.text;
  if (typeof text === "string") {
    return text;
  }
  return "";
}
