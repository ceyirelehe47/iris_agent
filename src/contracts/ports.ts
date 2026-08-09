import type { AgentRuntimePhase } from "./runtime-ports.js";
import type { AgentInput } from "./origin.js";
import type { ToolDescriptor } from "./tool.js";

export type AgentRuntimeEvent =
  | { type: "turn_start"; invocationId: string }
  | { type: "message_delta"; invocationId: string; text: string }
  | { type: "tool_call"; invocationId: string; toolCallId: string; toolName: string }
  | { type: "tool_result"; invocationId: string; toolCallId: string; toolName: string }
  | { type: "settled"; invocationId: string; nextTurnCount: number }
  | { type: "failed"; invocationId: string; code: string };

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
}

export interface HistorianPublicationOutboxPort {
  claimBatch(input: {
    batchSize: number;
  }): Promise<Array<{ publicationId: string; payloadHash: string }>>;
  markDelivered(input: { publicationId: string; receiptHash: string }): Promise<void>;
  markFailed(input: { publicationId: string; errorCode: string }): Promise<void>;
}

export interface MemoryRecallPort {
  recall(
    query: string,
    options?: { limit?: number; asOf?: string },
  ): Promise<{ cards: unknown[]; status: string }>;
}

export interface MemoryExpansionPort {
  expand(input: {
    memoryRef: string;
    mode: "summary" | "provenance" | "evidence";
  }): Promise<unknown>;
}

export interface MemoryHealthPort {
  health(): Promise<{ status: string; contractVersion: string; capabilities: string[] }>;
}

export interface ToolCatalogPort {
  getProcessCatalog(): Promise<{ catalogVersion: string; descriptors: ToolDescriptor[] }>;
  getByName(name: string): Promise<ToolDescriptor | undefined>;
}

export interface ToolExecutionPort {
  execute(call: { toolCallId: string; toolName: string; args: Record<string, unknown> }): Promise<{
    content: unknown[];
    details: Record<string, unknown>;
    isError: boolean;
  }>;
}

/**
 * R4 (iris_agent#9):Memory Client —— 投递 Historian publication 到
 * iris_memory 并接收 durable acceptance receipt。Agent 只经此窄端口
 * 与 memory 服务交互(不读其数据库、不连接 Neo4j)。
 *
 * iris_agent#64:成功/重复回执必须携带**版本化不可变身份**,足以把回执
 * 绑定到被投递的确切 Publication(idempotency 请求)。Agent 在 markDelivered
 * 前必须验证 publicationId 与 canonical payload hash(以及契约版本)。
 * 裸 `receiptHash` 字符串不再足以授权 delivered/reclaim。
 */
export type MemoryAcceptanceReceipt =
  | {
      schemaVersion: "acceptance-receipt-v1";
      status: "accepted";
      receiptId: string;
      publicationId: string;
      canonicalPayloadHash: string;
      contractVersion: string;
      acceptedAt: string;
    }
  | {
      // iris_memory#11: v3 acceptance receipts additionally bind the exact
      // episode-source batch.
      schemaVersion: "acceptance-receipt-v3";
      status: "accepted";
      receiptId: string;
      publicationId: string;
      canonicalPayloadHash: string;
      contractVersion: string;
      acceptedAt: string;
      episodeSourceHashes: string[];
    }
  | {
      schemaVersion: "duplicate-replay-receipt-v1";
      status: "duplicate_replay";
      receiptId: string;
      publicationId: string;
      canonicalPayloadHash: string;
      contractVersion: string;
      originalAcceptedAt: string;
    }
  | {
      schemaVersion: "duplicate-replay-receipt-v2";
      status: "duplicate_replay";
      originalPublicationId: string;
      originalContractVersion: string;
      originalCanonicalPayloadHash: string;
      originalAcceptedAt: string;
      replayedAt: string;
    };

export type PublicationDeliveryOutcome =
  | { ok: true; receipt: MemoryAcceptanceReceipt }
  | {
      ok: false;
      error: "rejected" | "unavailable" | `http_${number}`;
    };

export interface MemoryClientPort {
  deliverPublication(publication: unknown): Promise<PublicationDeliveryOutcome>;
}
