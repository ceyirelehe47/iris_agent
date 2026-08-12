import { computeMessageContentHash, type AgentHarness } from "@earendil-works/pi-agent-core";

import type { ContextIngestPort } from "../contracts/context-v27.js";
import type { PiSeamEvent, RuntimeEventIngestPort } from "../contracts/runtime-events.js";

export interface RuntimeEventSeamOptions {
  /** exactly-once 提交目标 ledger。 */
  ledger: RuntimeEventIngestPort;
  /** identity-level runtime session id（Context 的键，非 Pi 会话内部 id）。 */
  runtimeSessionId: string;
  piSessionId?: string;
  /** R2：事件提交后触发 Context ingest（可重放建单元）。 */
  contextIngest?: ContextIngestPort;
}

/**
 * R1-P1e：把 blueforst/pi 的 RuntimeEvent lifecycle seam（PI-016/017：
 * message_finalized / turn_committed / tool_execution_committed，加
 * settled / abort）转换并 exactly-once 提交到 RuntimeEvent ledger。
 *
 * fork 的 OwnEvent（含 save_point/settled/message_finalized 等）只通过
 * harness.subscribe（"*" 订阅）投递；on(type) 只覆盖 emitHook 事件。
 * 本 adapter 因此挂 harness.subscribe 并按其 event.type 分发。
 */
export function attachRuntimeEventSeam(
  harness: AgentHarness,
  options: RuntimeEventSeamOptions,
): void {
  harness.subscribe(async (event) => {
    const base = (
      payload: Omit<PiSeamEvent, "runtimeSessionId" | "piSessionId" | "occurredAt">,
    ): PiSeamEvent => ({
      ...payload,
      runtimeSessionId: options.runtimeSessionId,
      ...(options.piSessionId !== undefined ? { piSessionId: options.piSessionId } : {}),
      occurredAt: new Date().toISOString(),
    });
    switch (event.type) {
      case "message_finalized": {
        // iris_agent#50: the RuntimeEvent ledger must never receive an event
        // whose payload disagrees with its content hash or whose role is
        // inconsistent with the committed message. Recompute the canonical
        // hash of the committed message with the SAME exported implementation
        // the Pi append path uses; a mismatch means a corrupt or tampered
        // receipt/journal row and fails closed BEFORE ingest (the ledger row
        // is never created).
        const recomputed = await computeMessageContentHash(event.message);
        if (recomputed !== event.contentHash) {
          throw new Error(
            `runtime event seam: message_finalized content hash mismatch for entry ${event.entryId} ` +
              `(payload hashes to ${recomputed}, event records ${event.contentHash}); ` +
              "refusing to ingest (fail closed)",
          );
        }
        if (event.receipt.contentHash !== event.contentHash) {
          throw new Error(
            `runtime event seam: message_finalized receipt/event content hash mismatch for entry ${event.entryId} ` +
              `(receipt records ${event.receipt.contentHash}, event records ${event.contentHash}); ` +
              "refusing to ingest (fail closed)",
          );
        }
        if (event.message.role !== event.role) {
          throw new Error(
            `runtime event seam: message_finalized role mismatch for entry ${event.entryId} ` +
              `(message role ${JSON.stringify(event.message.role)}, event role ${JSON.stringify(event.role)}); ` +
              "refusing to ingest (fail closed)",
          );
        }
        options.ledger.ingest(
          base({
            type: "message_finalized",
            entryId: event.entryId,
            role: event.role,
            ...(event.receipt.entrySeq !== undefined ? { entrySeq: event.receipt.entrySeq } : {}),
            contentHash: event.contentHash,
            payload: JSON.stringify(event.message),
          }),
        );
        options.contextIngest?.ensureUnitsUpTo(options.runtimeSessionId);
        break;
      }
      case "turn_committed":
        options.ledger.ingest(
          base({
            type: "turn_committed",
            toolResultCount: event.toolResultCount,
            hadPendingMutations: event.hadPendingMutations,
          }),
        );
        break;
      case "tool_execution_committed":
        options.ledger.ingest(
          base({
            type: "tool_execution_committed",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            ...(event.isError !== undefined ? { isError: event.isError } : {}),
          }),
        );
        break;
      case "settled":
        options.ledger.ingest(base({ type: "agent_settled" }));
        break;
      case "abort":
        options.ledger.ingest(base({ type: "abort" }));
        break;
      default:
        break;
    }
  });
}
