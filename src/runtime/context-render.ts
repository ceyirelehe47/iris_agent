/**
 * Provider Renderer —— ContextGeneration → provider-native wire（iris_agent 侧）。
 *
 * 架构级职责（Notion 01 Context Assembly｜Provider Wire Terminology Override）：
 * 把已验证的 P0–P5 `ContextGeneration { header, units: ContextUnit[] }` 转成 Pi
 * provider 的 native wire（systemPrompt + AgentMessage[]）。渲染结果是一次 provider-call-only
 * 视图，不写回 Session、不改写 canonical Context state、不构造 m0/m1/LKG 等
 * 第二套中间上下文表示。
 *
 * 层映射：
 *  - P0 System / P1 Persona / P2 Capability → system prompt 前缀（声明层）；
 *  - P3 Compartment / P4 Recollection → provider 可见的 user 前缀消息；
 *  - P5 Live Layer → 按 ContextUnit 的 canonical content 渲染为
 *    user/assistant/toolResult 消息（同一 ContextUnit，无投影 DTO）。
 *
 * fail-closed：generation 缺失/非法由调用方（contextController）处理；本模块
 * 遇到未知语义形状直接抛错，绝不猜测（无 iris.semantic.p5.unknown.v1 escape
 * hatch）。
 */
import type { AgentMessage } from "@iris/pi-agent-core";
import type { ContextGeneration, ContextUnitV3, JsonValue } from "@iris/context/contracts";

export interface RenderedProviderContext {
  systemPrompt: string;
  messages: AgentMessage[];
}

/** 空 usage（Pi 必需字段兜底；真实 provider 调用由 Pi 消息自身携带）。 */
const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * 渲染已验证 generation 为 provider-native wire。
 * layerEnds 约束由 @iris/context 的 validateGenerationV2Strict 保证
 * （0 <= e0 <= ... <= e5 == units.length）。
 */
export function renderGenerationForProvider(
  generation: ContextGeneration,
): RenderedProviderContext {
  const ends = generation.header.layerEnds;
  const e2 = ends[2] ?? 0;
  const e3 = ends[3] ?? 0;
  const e4 = ends[4] ?? 0;
  const e5 = ends[5] ?? generation.units.length;
  const units = generation.units;

  // P0–P2 → system prompt（声明层，逐层追加；layerEnds 权威约定
  // P0=[0,e0) P1=[e0,e1) P2=[e1,e2) → 覆盖 [0, e2)）。
  const systemParts: string[] = [];
  for (let index = 0; index < e2; index += 1) {
    const unit = units[index];
    if (unit !== undefined) {
      systemParts.push(declarationText(unit));
    }
  }

  const messages: AgentMessage[] = [];
  // P3 → user 前缀（compartment 叙事摘要）。
  for (let index = e2; index < e3; index += 1) {
    const unit = units[index];
    if (unit !== undefined) {
      messages.push(userPrefixMessage(compartmentText(unit), "context"));
    }
  }
  // P4 → user 前缀（memory recall projection）。
  for (let index = e3; index < e4; index += 1) {
    const unit = units[index];
    if (unit !== undefined) {
      messages.push(userPrefixMessage(recollectionText(unit), "memory"));
    }
  }
  // P5 → live units 1:1 消息投影。
  for (let index = e4; index < e5; index += 1) {
    const unit = units[index];
    if (unit !== undefined) {
      messages.push(renderP5Unit(unit));
    }
  }

  return {
    systemPrompt: systemParts.filter((part) => part !== "").join("\n\n"),
    messages,
  };
}

/** P0–P2 声明层文本（`{ type, data: { text } }` 形状，iris_agent 贡献者定义）。 */
function declarationText(unit: ContextUnitV3): string {
  const content = unit.content as Record<string, unknown> | undefined;
  if (content === null || typeof content !== "object" || Array.isArray(content)) {
    throw new Error(`provider render: P0-P2 unit ${unit.unitId} has non-object content`);
  }
  const data = content["data"] as Record<string, unknown> | undefined;
  const text = data === null || typeof data !== "object" ? undefined : data["text"];
  if (typeof text !== "string") {
    throw new Error(`provider render: P0-P2 unit ${unit.unitId} has no data.text declaration`);
  }
  return text;
}

function userPrefixMessage(text: string, kind: "context" | "memory"): AgentMessage {
  const label =
    kind === "context" ? "[CONTEXT | COMMITTED COMPARTMENT]" : "[CONTEXT | MEMORY RECALL]";
  return {
    role: "user",
    content: [{ type: "text", text: `${label}\n${text}` }],
    timestamp: 0,
  };
}

/** P3 compartment 语义内容 → 文本块（结构化摘要）。 */
function compartmentText(unit: ContextUnitV3): string {
  const content = unit.content as Record<string, unknown> | undefined;
  if (content === null || typeof content !== "object" || Array.isArray(content)) {
    throw new Error(`provider render: compartment unit ${unit.unitId} has non-object content`);
  }
  const parts: string[] = [];
  const compartmentId = stringField(content, "compartmentId");
  const importance = stringField(content, "importance");
  const episodeType = stringField(content, "episodeType");
  parts.push(`[Compartment ${compartmentId} | importance=${importance} | episode=${episodeType}]`);
  for (const key of ["content", "primarySummary", "secondarySummary", "decisions", "openThreads"]) {
    const value = stringField(content, key);
    if (value !== "") {
      parts.push(`${key}: ${value}`);
    }
  }
  return parts.join("\n");
}

/** P4 recollection 语义内容 → 文本块。 */
function recollectionText(unit: ContextUnitV3): string {
  const content = unit.content as Record<string, unknown> | undefined;
  if (content === null || typeof content !== "object" || Array.isArray(content)) {
    throw new Error(`provider render: recollection unit ${unit.unitId} has non-object content`);
  }
  if (content["status"] === "unavailable") {
    const reason = stringField(content, "unavailableReason");
    return `(memory service unavailable: ${reason || "unknown"})`;
  }
  const statement = stringField(content, "statement");
  const trust = stringField(content, "sourceTrust");
  return `[RECALL | ${trust}] ${statement}`;
}

/** P5 durable live unit → provider-native AgentMessage（1:1 投影）。 */
function renderP5Unit(unit: ContextUnitV3): AgentMessage {
  const content = unit.content as Record<string, unknown> | undefined;
  if (content === null || typeof content !== "object" || Array.isArray(content)) {
    throw new Error(`provider render: P5 unit ${unit.unitId} has non-object content (fail closed)`);
  }
  const role = content["role"];
  switch (role) {
    case "user":
      return {
        role: "user",
        content: normalizeContent(content["content"], "user"),
        timestamp: numberField(content, "timestamp", 0),
      } as unknown as AgentMessage;
    case "assistant":
      return {
        role: "assistant",
        content: normalizeContent(content["content"], "assistant"),
        api: stringField(content, "api", "unknown"),
        provider: stringField(content, "provider", "unknown"),
        model: stringField(content, "model", "unknown"),
        usage: (content["usage"] as typeof EMPTY_USAGE | undefined) ?? EMPTY_USAGE,
        stopReason:
          (content["stopReason"] as
            "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | undefined) ?? "stop",
        ...(typeof content["responseModel"] === "string"
          ? { responseModel: content["responseModel"] }
          : {}),
        ...(typeof content["responseId"] === "string" ? { responseId: content["responseId"] } : {}),
        ...(typeof content["errorMessage"] === "string"
          ? { errorMessage: content["errorMessage"] }
          : {}),
        timestamp: numberField(content, "timestamp", 0),
      } as unknown as AgentMessage;
    case "toolResult":
      return {
        role: "toolResult",
        toolCallId: stringField(content, "toolCallId"),
        toolName: stringField(content, "toolName"),
        content: normalizeContent(content["content"], "toolResult"),
        isError: content["isError"] === true,
        timestamp: numberField(content, "timestamp", 0),
      } as unknown as AgentMessage;
    default:
      throw new Error(
        `provider render: P5 unit ${unit.unitId} has unknown role ${JSON.stringify(role)} (fail closed)`,
      );
  }
}

/** 渲染产出的 provider content parts（Pi 形状）。 */
type RenderedPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | {
      type: "toolCall";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      thoughtSignature?: string;
    }
  | { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean };

/**
 * 语义 content → Pi content parts。语义形状（@iris/context 生成的 schema）：
 *  - text / image / toolCall / thinking（thinking 用 `text` 字段）；
 * Pi 形状：thinking 用 `thinking` 字段 —— 渲染时转换。
 */
function normalizeContent(
  raw: unknown,
  _kind: "user" | "assistant" | "toolResult",
): RenderedPart[] {
  void _kind;
  if (typeof raw === "string") {
    return [{ type: "text", text: raw }];
  }
  if (!Array.isArray(raw)) {
    throw new Error(`provider render: content is neither string nor array (fail closed)`);
  }
  const parts: RenderedPart[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`provider render: content part is not an object (fail closed)`);
    }
    const part = item as Record<string, unknown>;
    switch (part["type"]) {
      case "text":
        parts.push({ type: "text", text: stringField(part, "text") });
        break;
      case "image":
        parts.push({
          type: "image",
          data: stringField(part, "data"),
          mimeType: stringField(part, "mimeType"),
        });
        break;
      case "toolCall":
        parts.push({
          type: "toolCall",
          id: stringField(part, "id"),
          name: stringField(part, "name"),
          arguments: (part["arguments"] as Record<string, unknown>) ?? {},
          ...(typeof part["thoughtSignature"] === "string"
            ? { thoughtSignature: part["thoughtSignature"] }
            : {}),
        });
        break;
      case "thinking": {
        const text = stringField(part, "text");
        const signature = typeof part["signature"] === "string" ? part["signature"] : undefined;
        const redacted = part["redacted"] === true;
        parts.push({
          type: "thinking",
          thinking: text,
          ...(signature !== undefined ? { thinkingSignature: signature } : {}),
          ...(redacted ? { redacted: true } : {}),
        });
        break;
      }
      case "reasoning":
        parts.push({ type: "text", text: stringField(part, "text") });
        break;
      default:
        throw new Error(
          `provider render: unknown content part type ${JSON.stringify(part["type"])} (fail closed)`,
        );
    }
  }
  return parts;
}

function stringField(record: Record<string, unknown>, key: string, fallback = ""): string {
  const value = record[key];
  return typeof value === "string" ? value : fallback;
}

function numberField(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  return typeof value === "number" ? value : fallback;
}

/** 供测试/诊断使用的 generation → 文本快照（P0–P5 分层）。 */
export function generationLayerSummary(generation: ContextGeneration): string {
  const ends = generation.header.layerEnds;
  return `layers=[${ends.join(",")}] units=${generation.units.length} hash=${generation.header.contextGenerationHash.slice(0, 12)}`;
}

export type { ContextGeneration, ContextUnitV3, JsonValue };
