/**
 * Provider Renderer —— ContextGeneration → provider-native wire（iris_agent 侧）。
 *
 * 架构级职责（Notion 01 Context Assembly｜Provider Wire Terminology Override）：
 * 把已验证的 P0–P5 `ContextGeneration { header, units: ContextUnit[] }` 转成 Pi
 * provider 的 native wire（systemPrompt + AgentMessage[]）。渲染结果是一次
 * provider-call-only 视图，不写回 Session、不改写 canonical Context state、不
 * 构造 m0/m1/LKG 等第二套中间上下文表示。
 *
 * 层映射：
 *  - P0 System / P1 Persona / P2 Capability → system prompt 前缀（声明层）；
 *  - P3 Compartment / P4 Recollection → provider 可见的 user 前缀消息；
 *  - P5 Live Layer → 按 ContextUnit 的 canonical content 渲染为
 *    user/assistant/toolResult 消息（同一 ContextUnit，无投影 DTO）。
 *
 * image（A3）：canonical image part 可以是
 *   - `{ type: "image", attachmentRef: iris.dsh_attachment_ref.v1 }`（DSH typed
 *     attachment ref）→ 渲染时经 `AttachmentMaterializer`（DSH
 *     AttachmentStore.readImage）物化为 provider 可消费的 base64 data URL；
 *     materializer 缺失 / attachment 缺失 / hash 校验失败 → fail-closed
 *     （绝不静默输出损坏图片；opaque attachmentId 绝不进入最终 image.data）；
 *   - `{ type: "image", data, mimeType }`（Pi 内联 base64）→ 原样透传。
 *
 * usage/cost（A4）：canonical usage 区分 known cost（cost 存在）与 unavailable
 * cost（costStatus="unavailable"，无 cost 字段）。Pi wire 要求完整 Usage
 * （含 cost）—— 当 canonical cost 不可用时，renderer 构造 **adapter-private
 * placeholder**（模块级常量；只存在于本次 provider-call 视图，不写回
 * Context、不进入真实费用 telemetry）。基准/费用读数必须以 canonical
 * ContextUnit 为准：canonical 侧 unknown cost 绝不写成真实 0。
 *
 * fail-closed：generation 缺失/非法由调用方（contextController）处理；本模块
 * 遇到未知语义形状直接抛错，绝不猜测（无 iris.semantic.p5.unknown.v1 escape
 * hatch）。
 */
import type { AgentMessage } from "@iris/pi-agent-core";
import {
  parseDshAttachmentRef,
  type ContextGeneration,
  type ContextUnit,
  type DshAttachmentRef,
  type JsonValue,
} from "@iris/context/contracts";

export interface RenderedProviderContext {
  systemPrompt: string;
  messages: AgentMessage[];
}

/**
 * 渲染期 attachment 物化器（A3）。生产实现映射到 DSH
 * `AttachmentStore.readImage`（先校验 bytes 与 recorded reference 匹配，
 * 再返回 bytes —— 缺失/hash 不匹配 → throw → 渲染 fail-closed）。
 */
export interface AttachmentMaterializer {
  materializeImage(ref: DshAttachmentRef): Promise<{ data: string; mimeType: string }>;
}

/**
 * A4：Pi wire 需要完整 Usage（含 cost）。canonical usage 的 cost 不可用时
 * 使用的 **adapter-private placeholder** —— 模块级常量：
 *   - 只存在于本次 provider-call 视图（不写回 Context，不进入任何 durable
 *     state / 费用 telemetry）；
 *   - canonical ContextUnit 从未携带该对象（canonical cost 不可用 → 无 cost
 *     字段 + costStatus="unavailable"），因此任何读 canonical 的基准/telemetry
 *     都不可能把本 placeholder 当作零成本。
 * `PI_WIRE_USAGE_PLACEHOLDER` 与真实已知 cost 可通过 canonical 侧区分
 * （canonical 无 cost 字段 ⟺ placeholder 的输入）。
 */
const PI_WIRE_USAGE_PLACEHOLDER = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

interface PiWireUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/**
 * 渲染已验证 generation 为 provider-native wire。
 * layerEnds 约束由 @iris/context 的 validateGenerationV2Strict 保证
 * （0 <= e0 <= ... <= e5 == units.length）。
 *
 * `attachmentMaterializer`：DSH typed attachment ref 的渲染期物化器（A3）。
 * 缺省时（Pi baseline）inline `data` image 直接透传；任何 `attachmentRef`
 * 遇到缺省 materializer → fail-closed。
 */
export async function renderGenerationForProvider(
  generation: ContextGeneration,
  options: { attachmentMaterializer?: AttachmentMaterializer } = {},
): Promise<RenderedProviderContext> {
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
      // 生成式 wire 形状（sourceRef: Record<string, unknown>）→ 领域
      // ContextUnit 的边界收窄：真实 generation 成员均由 admission 物化
      // （sourceRef 恒为合法 ContextUnitSourceRef）。生产代码只用无版本
      // ContextUnit 领域名。
      systemParts.push(declarationText(unit as unknown as ContextUnit));
    }
  }

  const messages: AgentMessage[] = [];
  // P3 → user 前缀（compartment 叙事摘要）。
  for (let index = e2; index < e3; index += 1) {
    const unit = units[index];
    if (unit !== undefined) {
      messages.push(userPrefixMessage(compartmentText(unit as unknown as ContextUnit), "context"));
    }
  }
  // P4 → user 前缀（memory recall projection）。
  for (let index = e3; index < e4; index += 1) {
    const unit = units[index];
    if (unit !== undefined) {
      messages.push(userPrefixMessage(recollectionText(unit as unknown as ContextUnit), "memory"));
    }
  }
  // P5 → live units 1:1 消息投影。
  for (let index = e4; index < e5; index += 1) {
    const unit = units[index];
    if (unit !== undefined) {
      messages.push(
        await renderP5Unit(unit as unknown as ContextUnit, options.attachmentMaterializer),
      );
    }
  }

  return {
    systemPrompt: systemParts.filter((part) => part !== "").join("\n\n"),
    messages,
  };
}

/** P0–P2 声明层文本（`{ type, data: { text } }` 形状，iris_agent 贡献者定义）。 */
function declarationText(unit: ContextUnit): string {
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
function compartmentText(unit: ContextUnit): string {
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
function recollectionText(unit: ContextUnit): string {
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
async function renderP5Unit(
  unit: ContextUnit,
  materializer: AttachmentMaterializer | undefined,
): Promise<AgentMessage> {
  const content = unit.content as Record<string, unknown> | undefined;
  if (content === null || typeof content !== "object" || Array.isArray(content)) {
    throw new Error(`provider render: P5 unit ${unit.unitId} has non-object content (fail closed)`);
  }
  const role = content["role"];
  switch (role) {
    case "user":
      return {
        role: "user",
        content: await normalizeContent(content["content"], "user", materializer),
        timestamp: numberField(content, "timestamp", 0),
      } as unknown as AgentMessage;
    case "assistant":
      return {
        role: "assistant",
        content: await normalizeContent(content["content"], "assistant", materializer),
        api: stringField(content, "api", "unknown"),
        provider: stringField(content, "provider", "unknown"),
        model: stringField(content, "model", "unknown"),
        usage: piWireUsage(content["usage"]),
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
        content: await normalizeContent(content["content"], "toolResult", materializer),
        isError: content["isError"] === true,
        timestamp: numberField(content, "timestamp", 0),
      } as unknown as AgentMessage;
    default:
      throw new Error(
        `provider render: P5 unit ${unit.unitId} has unknown role ${JSON.stringify(role)} (fail closed)`,
      );
  }
}

/**
 * canonical usage → Pi wire usage（A4）。
 *
 * canonical cost **存在** → 原样透传（known cost 精确 round trip）；
 * canonical cost **不可用**（costStatus="unavailable" 或无 cost）→ Pi wire
 * 需要完整 Usage，使用 adapter-private `PI_WIRE_USAGE_PLACEHOLDER`
 * （provider-call-only；不写回 Context、不进入真实费用 telemetry；canonical
 * 侧保持 cost 不可用，因此基准读 canonical 时绝不会看到零成本）。
 */
function piWireUsage(canonicalUsage: unknown): PiWireUsage {
  const record =
    canonicalUsage === null || typeof canonicalUsage !== "object"
      ? {}
      : (canonicalUsage as Record<string, unknown>);
  const input = typeof record["input"] === "number" ? record["input"] : 0;
  const output = typeof record["output"] === "number" ? record["output"] : 0;
  const cacheRead = typeof record["cacheRead"] === "number" ? record["cacheRead"] : 0;
  const cacheWrite = typeof record["cacheWrite"] === "number" ? record["cacheWrite"] : 0;
  const totalTokens = typeof record["totalTokens"] === "number" ? record["totalTokens"] : 0;
  const cost = record["cost"];
  if (cost !== null && typeof cost === "object" && !Array.isArray(cost)) {
    return {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens,
      cost: cost as {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
      },
    };
  }
  return { ...PI_WIRE_USAGE_PLACEHOLDER, input, output, cacheRead, cacheWrite, totalTokens };
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
 *
 * image（A3）：`attachmentRef` typed ref → 渲染期物化（需 materializer；
 * 缺失 → fail-closed）；inline `data` → 原样透传（Pi 内联 base64）。
 */
async function normalizeContent(
  raw: unknown,
  _kind: "user" | "assistant" | "toolResult",
  materializer: AttachmentMaterializer | undefined,
): Promise<RenderedPart[]> {
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
      case "image": {
        const attachmentRef = part["attachmentRef"];
        if (attachmentRef !== undefined) {
          // DSH typed attachment ref → render-time materialization（A3）。
          // 严格解析（fail-closed）：opaque attachmentId 绝不作为图片 data。
          const ref = parseDshAttachmentRef(attachmentRef);
          if (materializer === undefined) {
            throw new Error(
              `provider render: image part carries an attachmentRef ` +
                `(${ref.attachmentId}) but no attachment materializer is available ` +
                "(fail closed; never emit an opaque attachment id as image data)",
            );
          }
          const materialized = await materializer.materializeImage(ref);
          parts.push({
            type: "image",
            data: materialized.data,
            mimeType: materialized.mimeType,
          });
        } else {
          // Pi 内联 base64 data（opaque attachmentId 绝不出现在此路径）。
          parts.push({
            type: "image",
            data: stringField(part, "data"),
            mimeType: stringField(part, "mimeType"),
          });
        }
        break;
      }
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

export type { ContextGeneration, ContextUnit, JsonValue };
