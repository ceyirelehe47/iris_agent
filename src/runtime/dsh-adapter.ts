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
import type { JsonValue } from "@iris/context/contracts";
import type { Session } from "@deepseek-ai/dsh-session";
import type { Message, UserMessage } from "@deepseek-ai/dsh-llm";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";

export type RuntimeSourceKind = "user" | "plugin" | "model" | "tool" | "other";

/** 一次 ingest 的结果统计。 */
export interface DshIngestResult {
  admitted: number;
  rejected: number;
  skipped: number;
}

/** DSH ContentBlock → Iris 语义 canonical part（未知块 fail-closed）。 */
export function dshContentToSemanticParts(content: readonly ContentBlock[]): JsonValue[] {
  const parts: JsonValue[] = [];
  for (const block of content) {
    switch (block.type) {
      case "text":
        parts.push({ type: "text", text: block.text });
        break;
      case "reasoning":
        parts.push({ type: "thinking", text: block.text });
        break;
      case "image":
        parts.push({
          type: "image",
          data: block.attachment.attachmentId,
          mimeType: block.attachment.mediaType,
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
      sourceHash: messageSourceHash(message),
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
        ...(event.usage !== undefined ? { usage: event.usage as JsonValue } : {}),
        timestamp: time,
      },
      runtimeSourceKind: "model",
      sourceHash: messageSourceHash(event.message),
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
        content: dshContentToSemanticParts(resultBlock.content),
        isError: resultBlock.isError === true,
        timestamp: time,
      },
      runtimeSourceKind: "tool",
      sourceHash: messageSourceHash(event.message),
    });
    return true;
  }
}

/** 消息的确定性 source hash（canonical content 的 sha256；跨 restart 可重放）。 */
function messageSourceHash(message: { content: readonly ContentBlock[] }): string {
  return createHash("sha256").update(JSON.stringify(message.content), "utf8").digest("hex");
}
