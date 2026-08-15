/**
 * DSH ingress adapter —— 真实 DeepSeek Harness Session → Context 的统一入口
 * （iris_agent#128 / #130）。
 *
 * 权威来源：Notion 2026-08-15 DSH Message SourceRef / Runtime Truth Boundary +
 * iris-context#2：
 *
 *   DSH native user/assistant/tool-result message
 *   → DshMessageRef(sessionId, messageId, eventSeq?)
 *   → Context admission（admitRuntimeMessage）
 *   → ContextUnit exactly once
 *   → P5 / Historian / representation / retirement
 *
 * 规则（对照 deepseek-harness 当前源码，不按旧理解手写语义）：
 *  - `DshMessageRef` 只来自真实 DSH Session message：
 *      sessionId = Session.id（ownership/archive scope）
 *      messageId = Message.id（稳定 message identity）
 *      eventSeq  = event.seq（Session-local archive locator / recovery scan key，
 *                  不进入 Iris 语义 identity）；
 *  - 消费 `@deepseek-ai/dsh-session` 的 SessionEvent 流（`user/message` |
 *    `assistant/message` | `tool/result`；`SurfaceEventType`）；
 *  - **user/message 必须检查 MessageSource**：只有 `source.kind === 'user'`
 *    （真人直接输入）进入 experience；`source.kind === 'plugin'` 的注入上下文
 *    （instructions / catalog / snapshot / notice / relay / recall）与
 *    goal continuation 一律**不接纳**（合成上下文绝不进入 P5）；
 *  - assistant/message（source.kind='model'）与 tool/result
 *    （source.kind='tool'）按其来源接纳；
 *  - 本 adapter 只**读** Session（ingress）；绝不向 Session append 任何
 *    P0–P4 / Context / BUST 状态（P0–P4 不写 DSH Session）。
 *
 * content 转换：DSH provider-neutral ContentBlock[] → Iris 语义 canonical
 * part 形状（text/reasoning→text|thinking、image→image(attachment ref)、
 * tool-call→toolCall(解析后的 arguments 对象)；未知块 fail-closed）。
 */

import { createHash } from "node:crypto";

import type { ContextService } from "@iris/context";
import { canonicalJson, type JsonValue } from "@iris/context/contracts";
import type { Session } from "@deepseek-ai/dsh-session";
import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  UserMessage,
} from "@deepseek-ai/dsh-llm";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";

export type RuntimeSourceKind = "user" | "plugin" | "model" | "tool" | "other";

/** 一次 ingest 的结果统计。 */
export interface DshIngestResult {
  admitted: number;
  rejected: number;
  skipped: number;
}

/**
 * DSH ContentBlock → Iris 语义 canonical part（未知块 fail-closed）。
 *
 * reasoning 块的映射随目标语义 schema 变化：user/assistant content 接受
 * `thinking`，tool_result content 接受 `reasoning` —— 传 `toolResult: true`
 * 时按 `reasoning` 映射（否则 `thinking`）。
 *
 * image 块（A3）：DSH `ImageBlock.attachment` 是 content-addressed 不可变
 * attachment 的 **typed reference**（attachmentId 是 durable 存储标识，不是
 * 图片字节/base64/data URL）。Iris canonical content 保存该 typed
 * `iris.dsh_attachment_ref.v1`（含持久元数据 bytes/width/height），由
 * Provider Renderer 在渲染时经 AttachmentStore.readImage 物化为 provider 可
 * 消费的图片 data（fail-closed）。opaque attachmentId 绝不进入最终
 * image.data。
 */
export function dshContentToSemanticParts(
  content: readonly ContentBlock[],
  opts?: { toolResult?: boolean },
): JsonValue[] {
  const parts: JsonValue[] = [];
  for (const block of content) {
    switch (block.type) {
      case "text":
        parts.push({ type: "text", text: block.text });
        break;
      case "reasoning":
        parts.push({
          type: opts?.toolResult === true ? "reasoning" : "thinking",
          text: block.text,
        });
        break;
      case "image":
        parts.push({
          type: "image",
          attachmentRef: {
            schemaId: "iris.dsh_attachment_ref.v1",
            attachmentId: block.attachment.attachmentId,
            mediaType: block.attachment.mediaType,
            bytes: block.attachment.bytes,
            width: block.attachment.width,
            height: block.attachment.height,
            ...(block.attachment.name !== undefined ? { name: block.attachment.name } : {}),
          },
        });
        break;
      case "tool-call": {
        let args: unknown;
        try {
          args = JSON.parse(block.arguments) as unknown;
        } catch {
          throw new Error(
            `dsh adapter: tool-call ${block.id} carries invalid JSON arguments ` +
              `${JSON.stringify(block.arguments)} (fail closed)`,
          );
        }
        parts.push({
          type: "toolCall",
          id: block.id,
          name: block.name,
          arguments: args as JsonValue,
        });
        break;
      }
      default:
        throw new Error(
          `dsh adapter: unsupported content block type ${JSON.stringify((block as { type?: string }).type)} (fail closed)`,
        );
    }
  }
  return parts;
}

/**
 * DSH ingress adapter。构造后可对任意真实 DSH `Session` 执行 ingest：
 * 读取其事件流并经 @iris/context `admitRuntimeMessage`（DshMessageRef）接纳为
 * ContextUnit。绝不写 Session。
 */
export class DshIngressAdapter {
  constructor(private readonly contextService: ContextService) {}

  /** 从 DSH Session 事件流中接纳全部 admissible message 事件（幂等）。 */
  ingest(session: Session): DshIngestResult {
    const toolNames = new Map<string, string>();
    for (const event of session.events) {
      if (event.type === "tool/call") {
        toolNames.set(event.data.callId, event.data.name);
      }
    }
    let admitted = 0;
    let rejected = 0;
    let skipped = 0;
    for (const event of session.events) {
      switch (event.type) {
        case "user/message":
          if (this.ingestUserMessage(session.id, event.seq, event.time, event.data)) {
            admitted += 1;
          } else {
            rejected += 1;
          }
          break;
        case "assistant/message": {
          const admittedOne = this.ingestAssistantMessage(
            session.id,
            event.seq,
            event.time,
            event.data,
          );
          if (admittedOne) {
            admitted += 1;
          } else {
            rejected += 1;
          }
          break;
        }
        case "tool/result": {
          const admittedOne = this.ingestToolResult(
            session.id,
            event.seq,
            event.time,
            event.data,
            toolNames,
          );
          if (admittedOne) {
            admitted += 1;
          } else {
            rejected += 1;
          }
          break;
        }
        default:
          // 非 surface 事件（turn/step/chunk/usage/todo/request-header 等）不建
          // ContextUnit（与 SurfaceEventType 定义一致）。
          skipped += 1;
          break;
      }
    }
    return { admitted, rejected, skipped };
  }

  /** user/message：只有真实 user source 才进入 experience。 */
  private ingestUserMessage(
    sessionId: string,
    eventSeq: number,
    time: number,
    message: UserMessage,
  ): boolean {
    if (message.source.kind !== "user") {
      // plugin 注入上下文（instructions/catalog/snapshot/notice/relay/recall）、
      // goal continuation、synthetic recall —— 不得进入 P5。
      return false;
    }
    this.contextService.admitRuntimeMessage({
      sessionId,
      messageId: message.id,
      eventSeq,
      contentSchemaId: "iris.semantic.context_message.user.v1",
      content: {
        role: "user",
        content: dshContentToSemanticParts(message.content),
      },
      runtimeSourceKind: "user",
      sourceHash: dshUserSourceHash(message, time),
    });
    return true;
  }

  /** assistant/message：source.kind 必须是 'model'。 */
  private ingestAssistantMessage(
    sessionId: string,
    eventSeq: number,
    time: number,
    event: { message: Message; usage?: unknown },
  ): boolean {
    if (event.message.source.kind !== "model") {
      return false;
    }
    const source = event.message.source as { provider?: string; model?: string };
    this.contextService.admitRuntimeMessage({
      sessionId,
      messageId: event.message.id,
      eventSeq,
      contentSchemaId: "iris.semantic.context_message.assistant.v1",
      content: {
        role: "assistant",
        content: dshContentToSemanticParts(event.message.content),
        ...(source.provider !== undefined ? { provider: source.provider } : {}),
        ...(source.model !== undefined ? { model: source.model } : {}),
        ...(event.usage !== undefined ? { usage: dshUsageToIris(event.usage) } : {}),
        timestamp: time,
      },
      runtimeSourceKind: "model",
      sourceHash: dshAssistantSourceHash(event.message as AssistantMessage, {
        usage: event.usage,
        time,
      }),
    });
    return true;
  }

  /** tool/result：source.kind 必须是 'tool'；toolName 从匹配的 tool/call 关联。 */
  private ingestToolResult(
    sessionId: string,
    eventSeq: number,
    time: number,
    event: { message: Message & { content: [ContentBlock & { type: "tool-result" }] } },
    toolNames: Map<string, string>,
  ): boolean {
    if (event.message.source.kind !== "tool") {
      return false;
    }
    const callId = event.message.source.callId;
    const resultBlock = event.message.content[0];
    if (resultBlock?.type !== "tool-result") {
      return false;
    }
    const toolName = toolNames.get(callId);
    if (toolName === undefined) {
      // tool/result 没有对应的 tool/call → 无法获得权威 toolName（语义 schema
      // 必填）→ fail-closed 拒绝，绝不猜测。
      return false;
    }
    this.contextService.admitRuntimeMessage({
      sessionId,
      messageId: event.message.id,
      eventSeq,
      contentSchemaId: "iris.semantic.context_message.tool_result.v1",
      content: {
        role: "toolResult",
        toolCallId: callId,
        toolName,
        content: dshContentToSemanticParts(resultBlock.content, { toolResult: true }),
        isError: resultBlock.isError === true,
        timestamp: time,
      },
      runtimeSourceKind: "tool",
      sourceHash: dshToolResultSourceHash(event.message as ToolResultMessage, {
        toolName,
        time,
      }),
    });
    return true;
  }
}

/**
 * DSH TokenUsage → Iris 语义 usage 形状（review F4 BLOCKING + A4）。
 * DSH 计费字段为 inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens/
 * reasoningTokens；Iris 语义 schema 要求 {input,output,cacheRead,cacheWrite,
 * totalTokens,costStatus?}（cost 可选）且 additionalProperties:false —— 原样
 * 透传 DSH TokenUsage 会在真实带计费的 assistant 消息上 fail-closed。
 *
 * A4 知识状态：DSH 不携带 provider cost —— canonical usage 显式声明
 * `costStatus: "unavailable"` 且**不写 cost 字段**，绝不把未知 cost 写成真实
 * 的 0（不得被 benchmark 当作零成本）。`totalTokens` = input + output +
 * cacheRead + cacheWrite（reasoning 是 output 的子集，不重复加入 total）。
 */
export function dshUsageToIris(usage: unknown): JsonValue {
  const record = usage as {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  };
  const input = record.inputTokens ?? 0;
  const output = record.outputTokens ?? 0;
  const cacheRead = record.cacheReadTokens ?? 0;
  const cacheWrite = record.cacheWriteTokens ?? 0;
  const totalTokens = input + output + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(record.reasoningTokens !== undefined ? { reasoning: record.reasoningTokens } : {}),
    totalTokens,
    costStatus: "unavailable",
  };
}

/**
 * 版本化 canonical source snapshot（A5）。
 *
 * 背景：旧 `messageSourceHash` 只对 `JSON.stringify(message.content)` 取 hash
 * —— 未覆盖 provider/model/toolName/callId/isError/usage 等影响 accepted
 * canonical semantics 的 immutable source 字段，且普通 `JSON.stringify` 未
 * 声明为协议（对象键序不稳定）。
 *
 * 本实现为 user / assistant / tool result 分别定义版本化 canonical source
 * snapshot（canonical JSON，键序无关），覆盖：
 *  - message ID（Message.id）；
 *  - source kind（user / model / tool）；
 *  - provider / model（assistant）；
 *  - content blocks（含 image attachment 的 typed ref —— attachment 稳定
 *    identity/hash 进入 snapshot）；
 *  - tool call ID + resolved tool name（tool result；tool name 来自匹配的
 *    tool/call 事件）；
 *  - isError（tool result）；
 *  - usage token 计数（若存在）；
 *  - event time（进入 accepted content 的 timestamp；DSH 消息不可变，确定性）。
 *
 * `eventSeq` 是 Session-local locator（不进入 semantic identity），因此
 * **不进入** source snapshot —— 同一条消息无论 eventSeq 定位值如何都产生同一
 * sourceHash（与 unitId 派生一致）。
 */
export const DSH_SOURCE_SNAPSHOT_BASIS_VERSION = "iris.dsh_source_snapshot.v1" as const;

function dshSourceSnapshotHash(basis: JsonValue): string {
  return createHash("sha256").update(canonicalJson(basis), "utf8").digest("hex");
}

/** user/message 的 canonical source snapshot hash。 */
export function dshUserSourceHash(message: UserMessage, time: number): string {
  return dshSourceSnapshotHash({
    basis: DSH_SOURCE_SNAPSHOT_BASIS_VERSION,
    kind: "user",
    messageId: message.id,
    content: message.content as unknown as JsonValue,
    timestamp: time,
  });
}

/** assistant/message 的 canonical source snapshot hash。 */
export function dshAssistantSourceHash(
  message: AssistantMessage,
  extra: { usage?: unknown; time: number },
): string {
  const source = message.source as { provider?: string; model?: string };
  return dshSourceSnapshotHash({
    basis: DSH_SOURCE_SNAPSHOT_BASIS_VERSION,
    kind: "model",
    messageId: message.id,
    ...(source.provider !== undefined ? { provider: source.provider } : {}),
    ...(source.model !== undefined ? { model: source.model } : {}),
    content: message.content as unknown as JsonValue,
    usage: usageTokenCounts(extra.usage),
    timestamp: extra.time,
  });
}

/** tool/result 的 canonical source snapshot hash。 */
export function dshToolResultSourceHash(
  message: ToolResultMessage,
  extra: { toolName: string; time: number },
): string {
  const resultBlock = message.content[0];
  return dshSourceSnapshotHash({
    basis: DSH_SOURCE_SNAPSHOT_BASIS_VERSION,
    kind: "tool",
    messageId: message.id,
    callId: message.source.callId,
    toolName: extra.toolName,
    content: message.content as unknown as JsonValue,
    isError: resultBlock?.isError === true,
    timestamp: extra.time,
  });
}

/** DSH TokenUsage → snapshot 用的 token 计数（仅 immutable 计费字段）。 */
function usageTokenCounts(usage: unknown): JsonValue {
  const record = usage as {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  };
  if (record === null || typeof record !== "object") {
    return {};
  }
  return {
    ...(record.inputTokens !== undefined ? { input: record.inputTokens } : {}),
    ...(record.outputTokens !== undefined ? { output: record.outputTokens } : {}),
    ...(record.cacheReadTokens !== undefined ? { cacheRead: record.cacheReadTokens } : {}),
    ...(record.cacheWriteTokens !== undefined ? { cacheWrite: record.cacheWriteTokens } : {}),
    ...(record.reasoningTokens !== undefined ? { reasoning: record.reasoningTokens } : {}),
  };
}
