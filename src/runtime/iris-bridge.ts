/**
 * IrisContextBridge —— Pi runtime seam → @iris/context 统一 ContextUnit admission
 * （Pi-baseline 兼容适配）。
 *
 * 权威来源：Notion 2026-08-15 DSH Message SourceRef / Runtime Truth Boundary +
 * iris-context#2 + iris_agent#130：
 *
 *   DSH native user/assistant/tool-result message
 *   → DshMessageRef(sessionId, messageId)
 *   → Context admission（admitRuntimeMessage）
 *   → ContextUnit exactly once
 *   → P5 / Historian / representation / retirement
 *
 * 本 bridge 是 Pi-baseline 兼容适配（Pi 冻结为 compatibility 路径）：
 *  - **不把 Pi entry 伪装成 DshMessageRef**（iris_agent#130）：Pi
 *    runtimeSessionId + entryId 经 ContextService.admitGenericRuntimeSource 以
 *    通用 `ContextUnitSourceRefV1`（sourceSchemaId = `iris.pi_archive_entry.v1`，
 *    sourceId = Pi entryId，sourceHash = entry contentHash）接纳 —— raw
 *    provenance 可无歧义判定来源 runtime/archive；`iris.dsh_message_ref.v1`
 *    只保留给真实 DSH Session message；
 *  - 在 harness 的 message_finalized 事件处，把 Pi 消息解码为中性 canonical
 *    content 后接纳为 ContextUnit；
 *  - Pi UserMessage + iris_input_meta CustomMessage 的 companion 拆分在旧
 *    RuntimeEvent 模型中用于配对；统一 ContextUnit 模型下 DSH/运行时有稳定
 *    message identity，**不再**重建 hidden companion —— Pi raw archive 已保存
 *    原文；
 *  - 所有语义 payload 是符合 @iris/context 语义 schema 的中性 JsonValue；
 *  - 每接纳 user/assistant/tool_result 后提交 canonical BUST 请求（coalesce；
 *    下一安全 provider 边界 full rebuild）。
 *
 * Pi Session 只作 raw archive；Context 语义完全经 @iris/context 的
 * ContextService。tool_call 是 ledger-only 事件，新模型不建 ContextUnit
 * （工具弧身份由 tool_result 的 toolCallId 承担）。
 */
import type { AgentHarness } from "@iris/pi-agent-core";
import type { ContextService } from "@iris/context";
import type { JsonValue } from "@iris/context/contracts/context-unit";
import { decodeUserContentParts } from "./companion.js";

/**
 * Pi 兼容来源的通用 source schema id（iris_agent#130）。Pi archive entry 以
 * 通用 ContextUnitSourceRefV1 引用（不是 DshMessageRef），raw provenance 查找
 * 据此无歧义判定来源为 Pi runtime/archive。
 */
export const PI_COMPATIBILITY_SOURCE_SCHEMA_ID = "iris.pi_archive_entry.v1" as const;

export interface IrisContextBridgeOptions {
  /** identity-level runtime session id（Context 的 attribution/ownership 键）。 */
  runtimeSessionId: string;
  /** Host instance epoch（保留给未来 DSH 装配；当前 Pi baseline 不使用）。 */
  instanceEpoch: number;
  /** @iris/context ContextService（已 createLineage 绑定）。 */
  contextService: ContextService;
  /** 当前 invocation 的输入（保留接口；新模型下不用于 companion 配对）。 */
  getInput: () => unknown;
  /** 时间注入（默认 new Date().toISOString()）。 */
  now?: () => string;
}

/** 语义 content part 转换（Pi → neutral；thinking 字段名转换）。 */
function toSemanticParts(
  content: readonly {
    type: string;
    text?: string;
    thinking?: string;
    thinkingSignature?: string;
    signature?: string;
    redacted?: boolean;
    data?: string;
    mimeType?: string;
    id?: string;
    name?: string;
    arguments?: Record<string, unknown>;
    thoughtSignature?: string;
  }[],
): JsonValue[] {
  const parts: JsonValue[] = [];
  for (const part of content) {
    switch (part.type) {
      case "text":
        parts.push({ type: "text", text: part.text ?? "" });
        break;
      case "image":
        parts.push({ type: "image", data: part.data ?? "", mimeType: part.mimeType ?? "" });
        break;
      case "toolCall":
        parts.push({
          type: "toolCall",
          id: part.id ?? "",
          name: part.name ?? "",
          arguments: (part.arguments ?? {}) as JsonValue,
          ...(typeof part.thoughtSignature === "string"
            ? { thoughtSignature: part.thoughtSignature }
            : {}),
        });
        break;
      case "thinking":
        parts.push({
          type: "thinking",
          text: part.thinking ?? part.text ?? "",
          ...(typeof part.thinkingSignature === "string"
            ? { signature: part.thinkingSignature }
            : {}),
          ...(part.redacted === true ? { redacted: true } : {}),
        });
        break;
      default:
        // Unknown Pi content part → fail closed（不猜测）。
        throw new Error(
          `iris bridge: unsupported Pi content part type ${JSON.stringify(part.type)} (fail closed)`,
        );
    }
  }
  return parts;
}

/**
 * IrisContextBridge —— Pi baseline 的 Context admission 适配（统一 ContextUnit；
 * 不再产生 RuntimeEvent/companion）。
 */
export class IrisContextBridge {
  private readonly options: IrisContextBridgeOptions;
  private closed = false;

  constructor(options: IrisContextBridgeOptions) {
    this.options = options;
  }

  attach(harness: AgentHarness): void {
    harness.subscribe(async (event) => {
      if (this.closed) {
        return;
      }
      switch (event.type) {
        case "message_finalized": {
          this.onMessageFinalized(event);
          return;
        }
        default:
          // tool_execution_committed 等 ledger-only 事件：新模型不建 ContextUnit。
          return;
      }
    });
  }

  close(): void {
    this.closed = true;
  }

  /**
   * 经统一 Context admission 接纳一条 Pi runtime-origin 消息为 ContextUnit。
   * Pi 兼容来源使用**通用** ContextUnitSourceRefV1（sourceSchemaId =
   * `iris.pi_archive_entry.v1`；sourceId = Pi entryId；sourceHash = entry
   * contentHash；sourceRevision = Pi entrySeq），**不是** DshMessageRef
   * （iris_agent#130）。exactly-once：同一 (sourceSchemaId, sourceId) 幂等。
   */
  private admit(
    messageId: string,
    contentSchemaId: string,
    content: JsonValue,
    options: {
      contentHash?: string;
      entrySeq?: number;
      runtimeSourceKind?: "user" | "plugin" | "model" | "tool" | "other";
    } = {},
  ): void {
    this.options.contextService.admitGenericRuntimeSource({
      sourceSchemaId: PI_COMPATIBILITY_SOURCE_SCHEMA_ID,
      sourceId: messageId,
      ...(options.entrySeq !== undefined ? { sourceRevision: String(options.entrySeq) } : {}),
      ...(options.contentHash !== undefined ? { sourceHash: options.contentHash } : {}),
      contentSchemaId,
      content,
      runtimeSessionId: this.options.runtimeSessionId,
      ...(options.runtimeSourceKind !== undefined
        ? { runtimeSourceKind: options.runtimeSourceKind }
        : {}),
    });
    this.requestBustAfterUnit(contentSchemaId, messageId);
  }

  private requestBustAfterUnit(schemaId: string, messageId: string): void {
    this.options.contextService.requestBust("source_invalidation", {
      schemaId: "iris.bust_evidence.v1",
      detail: `admitted ${schemaId} message ${messageId}`,
      sourceRefs: [messageId],
    });
  }

  private onMessageFinalized(event: {
    entryId: string;
    role: string;
    contentHash: string;
    receipt: { entrySeq?: number };
    message: unknown;
  }): void {
    const message = event.message as {
      role: string;
      content: string | unknown[];
      timestamp?: number;
      customType?: string;
      toolCallId?: string;
      toolName?: string;
      isError?: boolean;
      api?: string;
      provider?: string;
      model?: string;
      usage?: unknown;
      stopReason?: unknown;
      errorMessage?: string;
      addedToolNames?: string[];
    };

    switch (event.role) {
      case "user": {
        // 真人 user 输入（Pi baseline 的直接用户消息）→ user.role 内容。
        const payload: JsonValue = {
          role: "user",
          content: decodeUserContentParts(
            message as { content: string | { type: string; text?: string }[] },
          ),
        };
        this.admit(event.entryId, "iris.semantic.context_message.user.v1", payload, {
          contentHash: event.contentHash,
          ...(event.receipt.entrySeq !== undefined ? { entrySeq: event.receipt.entrySeq } : {}),
          runtimeSourceKind: "user",
        });
        return;
      }
      case "custom": {
        // 旧 Pi iris_input_meta companion：统一 ContextUnit 模型不再重建
        // hidden companion（DSH/运行时有稳定 message identity）。Pi raw
        // archive 已保存原文；此事件不进 Context。
        return;
      }
      case "assistant": {
        const payload = {
          role: "assistant",
          content: toSemanticParts(
            message.content as {
              type: string;
              text?: string;
              thinking?: string;
              thinkingSignature?: string;
              redacted?: boolean;
              data?: string;
              mimeType?: string;
              id?: string;
              name?: string;
              arguments?: Record<string, unknown>;
              thoughtSignature?: string;
            }[],
          ),
          ...(typeof message.api === "string" ? { api: message.api } : {}),
          ...(typeof message.provider === "string" ? { provider: message.provider } : {}),
          ...(typeof message.model === "string" ? { model: message.model } : {}),
          ...(message.usage !== undefined ? { usage: message.usage as JsonValue } : {}),
          ...(message.stopReason !== undefined
            ? { stopReason: message.stopReason as JsonValue }
            : {}),
          ...(typeof message.errorMessage === "string"
            ? { errorMessage: message.errorMessage }
            : {}),
          timestamp: message.timestamp ?? Date.now(),
        } as JsonValue;
        this.admit(event.entryId, "iris.semantic.context_message.assistant.v1", payload, {
          contentHash: event.contentHash,
          ...(event.receipt.entrySeq !== undefined ? { entrySeq: event.receipt.entrySeq } : {}),
        });
        return;
      }
      case "toolResult": {
        const payload = {
          role: "toolResult",
          toolCallId: message.toolCallId ?? "",
          toolName: message.toolName ?? "",
          content: toSemanticParts(
            (message.content ?? []) as {
              type: string;
              text?: string;
              thinking?: string;
              data?: string;
              mimeType?: string;
            }[],
          ),
          ...(message.usage !== undefined ? { usage: message.usage as JsonValue } : {}),
          ...(message.addedToolNames !== undefined
            ? { addedToolNames: message.addedToolNames as JsonValue }
            : {}),
          isError: message.isError === true,
          timestamp: message.timestamp ?? Date.now(),
        } as JsonValue;
        this.admit(event.entryId, "iris.semantic.context_message.tool_result.v1", payload, {
          contentHash: event.contentHash,
          ...(event.receipt.entrySeq !== undefined ? { entrySeq: event.receipt.entrySeq } : {}),
        });
        return;
      }
      default:
        // branchSummary / compactionSummary / 未知 role：Pi raw archive 已有；
        // 不进 canonical Context（避免第二套语义猜测）。
        return;
    }
  }
}
