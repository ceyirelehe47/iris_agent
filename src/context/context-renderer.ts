import { createHash } from "node:crypto";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { M0_EMPTY_BODY, M1_EMPTY_PLACEHOLDER } from "../contracts/context.js";
import type { ContextMessageUnitV1 } from "../contracts/context-v27.js";
import type { ContextLineage, ContextStore } from "./context-store.js";
import {
  decidePass,
  type HardReason,
  type HardSignals,
  type PassClassification,
} from "./pass-taxonomy.js";

/**
 * R2-P1 Provider Renderer（Roadmap v13 canonical chain 的 Provider 投影）。
 *
 * 从 immutable ContextMessageUnit + persisted lineage（context_lineages）渲染
 * provider-visible 消息数组：
 *
 *   [m0 synthetic user, m1 synthetic user, ...p5Tail, ...liveDelta]
 *
 *  - m0 = persisted m0Body ?? M0_EMPTY_BODY（materialized 前缀的稳定基线）；
 *  - m1 = 有新单元（contextSeq > representedThroughContextSeq）时渲染
 *        renderHistorySince 的 `<session-history-since>` 块；无新单元时字节
 *        不变地回放 persisted m1Body（SOFT+ byte-identical replay），persisted
 *        缺失则退化为 M1_EMPTY_PLACEHOLDER；
 *  - p5Tail = representedThrough 之后的单元 payload（materialized 前缀已由 m0
 *        表示，绝不重复下发）；
 *  - liveDelta = 当前 invocation 的 live 消息（harness 控制器路径恒为 []，由
 *        runAgentLoop prompts + context hook 处理 steer pair）。
 *
 * 渲染是 PURE（不写库）；物化决策（HARD→materializeM0ByContextSeq /
 * SOFT→materializeM1ByContextSeq / SOFT+→仅推进 watermark）由 ContextRenderer
 * 在 prompt 完成后由 vertical-slice 调用 persistRender 提交，保持 createIrisHarness
 * 的 controller 纯投影。
 *
 * m0/m1 是 synthetic user 消息（role user + 固定 timestamp 0），永不写入 Pi
 * Session；context hook 的 transformContextMessages 对非 IRIS_INPUT_V1 的 user
 * 内容原样透传（decodeInputFrames 抛错 → decodeUserFrames 返回 undefined →
 * pass-through），因此 m0/m1 不会被二次折叠。
 */

/** R2-P1 序列化器身份（lineage.context_serializer_version；变化 → HARD）。 */
export const CONTEXT_SERIALIZER_VERSION = "iris-context-units-v1";
/** R2-P1 carrier schema 身份（lineage.carrier_schema_version）。 */
export const CONTEXT_CARRIER_SCHEMA_VERSION = "1";

/** R2 固定：synthetic 消息的确定性时间戳（m0/m1 永不写入 Session）。 */
export const SYNTHETIC_MESSAGE_TIMESTAMP = 0;

/** 单行 tool result 摘要的最大长度（超出截断，保证 compact + 确定性）。 */
const TOOL_RESULT_LINE_CAP = 200;

/** 构建 m0/m1 synthetic user 消息（role user，内容为 body 本身）。 */
export function syntheticUserMessage(body: string): AgentMessage {
  return { role: "user", content: body, timestamp: SYNTHETIC_MESSAGE_TIMESTAMP };
}

function textParts(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: string[] = [];
  for (const part of content) {
    const record = part as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string" && record.text.length > 0) {
      parts.push(record.text);
    }
  }
  return parts;
}

/** user / toolResult 消息的文本（string 内容原样；数组内容取 text part）。 */
function textOf(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  return textParts(content).join("\n");
}

/** assistant 摘要：text part 逐行 + toolCall part 折叠为 [tool call: name]。 */
function assistantSummary(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const part of content) {
    const record = part as { type?: unknown; text?: unknown; name?: unknown };
    if (record.type === "text" && typeof record.text === "string" && record.text.length > 0) {
      parts.push(record.text);
    } else if (record.type === "toolCall" && typeof record.name === "string") {
      parts.push(`[tool call: ${record.name}]`);
    }
  }
  return parts.join("\n");
}

/** tool result 摘要：toolName + 首行非空文本（截断到 TOOL_RESULT_LINE_CAP）。 */
function toolResultSummary(message: AgentMessage): string {
  const record = message as { toolName?: unknown };
  const name = typeof record.toolName === "string" ? record.toolName : "unknown";
  const text = textOf(message);
  const firstLine = text.split("\n").find((line) => line.length > 0) ?? "";
  const truncated =
    firstLine.length > TOOL_RESULT_LINE_CAP
      ? `${firstLine.slice(0, TOOL_RESULT_LINE_CAP)}…`
      : firstLine;
  return `${name}: ${truncated}`;
}

/** Feature A (#110): the canonical semanticContent IS the AgentMessage. */
function payloadOf(unit: ContextMessageUnitV1): AgentMessage {
  return unit.semanticContent as unknown as AgentMessage;
}

function lineFor(unit: ContextMessageUnitV1, label: string): string {
  switch (unit.kind) {
    case "user":
      return `[user ${label}] ${textOf(payloadOf(unit))}`;
    case "assistant":
      return `[assistant ${label}] ${assistantSummary(payloadOf(unit))}`;
    case "tool_result":
      return `[tool-result ${label}] ${toolResultSummary(payloadOf(unit))}`;
    case "tool_call":
    case "body_event":
    case "operational":
      return `[${unit.kind} ${label}]`;
  }
}

/**
 * 把 representedThrough 之后的"新单元"渲染为 compact `<session-history-since>`
 * 块（title + user/assistant 文本行；tool result 摘要）。确定性：只依赖单元
 * 的 contextSeq/unitType/payload，不含时钟。空输入 → M1_EMPTY_PLACEHOLDER。
 */
export function renderHistorySince(newUnits: ContextMessageUnitV1[]): string {
  const firstSeq = newUnits[0]?.contextSeq;
  if (firstSeq === undefined) {
    return M1_EMPTY_PLACEHOLDER;
  }
  const lastSeq = newUnits[newUnits.length - 1]?.contextSeq ?? firstSeq;
  const lines: string[] = [`[history since context_seq ${firstSeq}..${lastSeq}]`];
  for (const unit of newUnits) {
    lines.push(lineFor(unit, String(unit.contextSeq)));
  }
  return `<session-history-since>\n${lines.join("\n")}\n</session-history-since>`;
}

/**
 * 把 materialized 前缀（contextSeq ≤ representedThrough）渲染为
 * `<session-history>` 块（HARD 重建 m0 用：fold m1 进 m0 后，m0 是全部已表示
 * 单元的快照）。空前缀 → M0_EMPTY_BODY。
 */
export function renderSessionHistory(
  units: ContextMessageUnitV1[],
  representedThroughContextSeq: number,
): string {
  const materialized = units.filter((unit) => unit.contextSeq <= representedThroughContextSeq);
  if (materialized.length === 0) {
    return M0_EMPTY_BODY;
  }
  const lines: string[] = [];
  for (const unit of materialized) {
    lines.push(lineFor(unit, String(unit.contextSeq)));
  }
  return `<session-history>\n${lines.join("\n")}\n</session-history>`;
}

/** HARD 重建 m0：以全部已表示单元重渲染 <session-history>（fold m1）。 */
export function rebuildM0Body(
  units: ContextMessageUnitV1[],
  representedThroughContextSeq: number,
): string {
  return renderSessionHistory(units, representedThroughContextSeq);
}

export interface RenderProviderMessagesInput {
  /** 该 session 的全部语义单元（已按 contextSeq 升序）。 */
  units: ContextMessageUnitV1[];
  /** 当前 watermark：此前已表示（进 m0）的单元序号。 */
  representedThroughContextSeq: number;
  /** persisted m0Body（null = 从未 materialized → M0_EMPTY_BODY）。 */
  m0Body: string | null;
  /** persisted m1Body（无新单元时字节不变回放；null → M1_EMPTY_PLACEHOLDER）。 */
  m1Body: string | null;
  /** 当前 invocation 的 live 消息（controller 路径恒为 []）。 */
  liveDelta: AgentMessage[];
}

export interface RenderProviderMessagesResult {
  messages: AgentMessage[];
  m0Body: string;
  m1Body: string;
  /** 本次 render 覆盖到的最大单元序号（persist 时推进 watermark 用）。 */
  representedThroughContextSeq: number;
}

/**
 * 纯渲染：给定 persisted m0/m1 + 单元 + watermark，产出 provider-visible 消息。
 * m0/m1 永远位于数组头部（两个 synthetic user 消息），其后是 p5Tail + liveDelta。
 */
export function renderProviderMessages(
  input: RenderProviderMessagesInput,
): RenderProviderMessagesResult {
  const m0Body = input.m0Body ?? M0_EMPTY_BODY;
  const newUnits = input.units.filter(
    (unit) => unit.contextSeq > input.representedThroughContextSeq,
  );
  // 无新单元 → 字节不变回放 persisted m1（SOFT+ 的 byte-identical 契约）；
  // persisted 缺失 → M1_EMPTY_PLACEHOLDER。
  const m1Body =
    newUnits.length > 0 ? renderHistorySince(newUnits) : (input.m1Body ?? M1_EMPTY_PLACEHOLDER);
  const messages: AgentMessage[] = [
    syntheticUserMessage(m0Body),
    syntheticUserMessage(m1Body),
    ...newUnits.map((unit) => payloadOf(unit)),
    ...input.liveDelta,
  ];
  const lastSeq = input.units[input.units.length - 1]?.contextSeq;
  const representedThroughContextSeq =
    newUnits.length > 0 && lastSeq !== undefined ? lastSeq : input.representedThroughContextSeq;
  return { messages, m0Body, m1Body, representedThroughContextSeq };
}

export interface ClassifyAndAdvanceInput {
  lineage: ContextLineage | undefined;
  hardSignals: HardSignals;
  units: ContextMessageUnitV1[];
  representedThroughContextSeq: number;
}

export interface ClassifyAndAdvanceResult {
  decision: ReturnType<typeof decidePass>;
  classification: PassClassification;
  reason: HardReason | null;
  /** true = 存在 watermark 之后的 live 单元（wouldAdvanceLive）。 */
  hasLiveDelta: boolean;
  /** watermark 之后的新单元（p5Tail / m1 delta 的数据源）。 */
  newUnits: ContextMessageUnitV1[];
}

/**
 * 纯分类：复用 v12 decidePass（与 OpenCode v0.33.0 mustMaterialize 对齐）。
 * wouldAdvanceLive 由单元 delta（contextSeq > representedThroughContextSeq）
 * 推导 —— delta 为空 → SOFT+（byte-identical m0/m1 回放），有 delta 且无
 * HARD 信号 → SOFT（m1 更新），任何 HARD 信号 → HARD（m0 重建）。
 */
export function classifyAndAdvance(input: ClassifyAndAdvanceInput): ClassifyAndAdvanceResult {
  const newUnits = input.units.filter(
    (unit) => unit.contextSeq > input.representedThroughContextSeq,
  );
  const decision = decidePass(input.lineage, input.hardSignals, {
    wouldAdvanceLive: newUnits.length > 0,
  });
  return {
    decision,
    classification: decision.classification,
    reason: decision.reason,
    hasLiveDelta: newUnits.length > 0,
    newUnits,
  };
}

function maxContextSeqOr(units: ContextMessageUnitV1[], fallback: number): number {
  const last = units[units.length - 1]?.contextSeq;
  return last ?? fallback;
}

export interface RenderRecord {
  runtimeSessionId: string;
  classification: PassClassification;
  reason: HardReason | null;
  m0Body: string;
  m1Body: string;
  representedThroughContextSeq: number;
  hasLiveDelta: boolean;
  /** 本次 pass 的 cache 身份（HARD 时写入 cached_m0_*，bust 缓存）。 */
  cachedIdentity: {
    systemHash: string;
    modelKey: string;
    providerProfileId: string;
  };
}

export interface RenderForProviderCallArgs {
  runtimeSessionId: string;
  units: ContextMessageUnitV1[];
  liveDelta: AgentMessage[];
  hardSignals: HardSignals;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * 每 provider call 的渲染入口（harness contextController 调用；只读 store）。
 * 保留最近一次 RenderRecord 供 prompt 完成后的 persistRender 提交 —— 控制器
 * 本身保持纯投影，物化写入全部延迟到 vertical-slice 的 persist 步骤。
 *
 * HARD fold 的 mid-turn 复用：persist 发生在 prompt 完成之后，因此同一次
 * prompt 内的第二次 provider call（工具结果后）会再次读到"未物化"的 lineage
 * 并再次分类为 HARD。若二次重建 m0 并清空 p5Tail，provider 数组会丢失
 * assistant toolUse + toolResult 实消息（真实 provider API 会拒绝这种无配对
 * 的 tool result 数组）。因此首次 HARD fold 记入 activeFold，同 slice 内
 * 未持久化的后续 HARD 复用 fold 状态：m0/m1 字节不变，fold 之后的新单元继续
 * 作为 p5Tail 下发 —— 与 magic-context 的"fold 一次，live tail 持续流动"一致。
 * 持久化之后（lineage 已有 m0）的新 HARD（如 model_change）总是重建。
 */
export class ContextRenderer {
  private lastRender: RenderRecord | undefined;
  private activeFold:
    { representedThroughContextSeq: number; m0Body: string; m1Body: string } | undefined;

  /**
   * R3-P1：HARD fold 提交后的回调（freeze-trigger 接线点）。persistRender 在
   * HARD 物化成功落库后调用，携带本次 fold watermark 对应的 entrySeq（null =
   * 该前缀内无携带 entry_seq 的单元 / watermark 为 0）。SOFT / SOFT+ 绝不触发
   * （m0 未推进，无新的"已物化 compartment"信号）。由 vertical-slice 在
   * historianManager 存在时注入；缺省 = 不接线（行为与 R2 完全一致）。
   */
  onMaterialized:
    ((runtimeSessionId: string, representedThroughEntrySeq: number | null) => void) | undefined =
    undefined;

  constructor(private readonly store: ContextStore) {}

  renderForProviderCall(args: RenderForProviderCallArgs): {
    messages: AgentMessage[];
    record: RenderRecord;
  } {
    // R2-P3：provider 视图防御性过滤——只渲染 disposition="include" 的单元。
    // 正常路径 store.listUnits 已默认只返回 include（store 级过滤，覆盖
    // renderForProviderCall / renderProviderMessages / rebuildM0Body /
    // renderHistorySince 的整条消费链）；此处兜底保证任何调用方传入的原始
    // units（含 excluded / reference_only，如直传测试）都不会泄漏进 provider
    // 数组或 m0/m1 内容。渲染保持 PURE（不改写 store）。
    const visibleUnits = args.units.filter((unit) => unit.historianDisposition === "include");
    const lineage = this.store.getLineage(args.runtimeSessionId);
    const representedThrough = lineage?.representedThroughContextSeq ?? 0;
    const lineageHasM0 = lineage?.m0Body !== null && lineage?.m0Body !== undefined;
    const classified = classifyAndAdvance({
      lineage,
      hardSignals: args.hardSignals,
      units: visibleUnits,
      representedThroughContextSeq: representedThrough,
    });
    const isHard = classified.classification === "HARD";

    const buildFold = (): {
      representedThroughContextSeq: number;
      m0Body: string;
      m1Body: string;
    } => {
      const foldThrough = maxContextSeqOr(visibleUnits, representedThrough);
      if (!lineageHasM0) {
        // first_render / cached_m1_missing：空基线（M0_EMPTY_BODY），当前单元
        // 保持 live tail（与 magic-context 一致：新 session 的 m0 是空的历史
        // 快照，现有消息继续作为实消息下发，watermark 随后按"渲染到的最大 seq"
        // 推进）。
        return {
          representedThroughContextSeq: representedThrough,
          m0Body: M0_EMPTY_BODY,
          m1Body: M1_EMPTY_PLACEHOLDER,
        };
      }
      // 已物化后的重建（model_change 等）：fold 全部已表示单元进 m0，m1 重置。
      return {
        representedThroughContextSeq: foldThrough,
        m0Body: rebuildM0Body(visibleUnits, foldThrough),
        m1Body: M1_EMPTY_PLACEHOLDER,
      };
    };

    // 渲染基准：HARD 用 fold 状态（m0 重建 / 同 slice 复用），否则用 lineage。
    // N1 parity 修复：activeFold 覆盖两个分支——persist 之前的任何 HARD
    // （含 lineage 已有 m0 的 model_change mid-turn 双 HARD）都复用首次 fold，
    // 保证 fold 之后的单元继续作为 p5Tail 下发（不丢失 assistant toolCall/
    // toolResult 实消息）。
    let baseWatermark: number;
    let baseM0Body: string | null;
    let baseM1Body: string | null;
    if (isHard) {
      this.activeFold ??= buildFold();
      baseWatermark = this.activeFold.representedThroughContextSeq;
      baseM0Body = this.activeFold.m0Body;
      baseM1Body = this.activeFold.m1Body;
    } else {
      baseWatermark = representedThrough;
      baseM0Body = lineage?.m0Body ?? null;
      baseM1Body = lineage?.m1Body ?? null;
    }

    const render = renderProviderMessages({
      units: visibleUnits,
      representedThroughContextSeq: baseWatermark,
      m0Body: baseM0Body,
      m1Body: baseM1Body,
      liveDelta: args.liveDelta,
    });

    const record: RenderRecord = {
      runtimeSessionId: args.runtimeSessionId,
      classification: classified.classification,
      reason: classified.reason,
      m0Body: render.m0Body,
      m1Body: render.m1Body,
      representedThroughContextSeq: render.representedThroughContextSeq,
      hasLiveDelta: classified.hasLiveDelta,
      cachedIdentity: {
        systemHash: args.hardSignals.systemHash ?? "",
        modelKey: args.hardSignals.modelKey ?? "",
        providerProfileId: args.hardSignals.providerProfileId ?? "",
      },
    };
    this.lastRender = record;
    return { messages: render.messages, record };
  }

  /** 最近一次 render 记录（prompt 完成后 persist 用；测试可读）。 */
  get lastRenderRecord(): RenderRecord | undefined {
    return this.lastRender;
  }

  /**
   * 提交最近一次 render 的物化决策：
   *  - HARD  → materializeM0ByContextSeq（重建 m0、cached_m0_* bust、推进
   *           representedThroughContextSeq 到 fold 水位）；
   *  - SOFT  → materializeM1ByContextSeq（仅 m1，watermark 不推进——m1 从
   *           物化水位后累积渲染，未进 m0 的单元不丢失，B1 parity 修复）；
   *  - SOFT+ → 幂等对齐 watermark（m0/m1 字节不变）。
   * 无 render 记录（例如无 provider call）→ no-op。单行事务，fail-closed。
   */
  persistRender(nowMs: number): RenderRecord | undefined {
    const record = this.lastRender;
    if (record === undefined) {
      return undefined;
    }
    switch (record.classification) {
      case "HARD":
        this.store.materializeM0ByContextSeq({
          runtimeSessionId: record.runtimeSessionId,
          m0Body: record.m0Body,
          m1Body: record.m1Body,
          m0ContentHash: sha256(record.m0Body),
          m1ContentHash: sha256(record.m1Body),
          cachedM0SystemHash: record.cachedIdentity.systemHash,
          cachedM0ModelKey: record.cachedIdentity.modelKey,
          cachedM0ProviderProfileId: record.cachedIdentity.providerProfileId,
          representedThroughContextSeq: record.representedThroughContextSeq,
          atMs: nowMs,
        });
        // R3-P1：HARD fold 已提交 → 通知外部 freeze-trigger。该信号点是
        // "一个 compartment 已物化"的权威时刻（materializeM0ByContextSeq
        // 已推进 represented_through_context_seq）；回调携带该 watermark
        // 对应的 entrySeq（store 聚合，与 ContextHistoryReadPort 同源）。
        if (this.onMaterialized !== undefined) {
          const representedThroughEntrySeq = this.store.maxEntrySeqAtOrBelowWatermark(
            record.runtimeSessionId,
            record.representedThroughContextSeq,
          );
          this.onMaterialized(record.runtimeSessionId, representedThroughEntrySeq);
        }
        break;
      case "SOFT":
        this.store.materializeM1ByContextSeq({
          runtimeSessionId: record.runtimeSessionId,
          m1Body: record.m1Body,
          m1ContentHash: sha256(record.m1Body),
          atMs: nowMs,
        });
        break;
      case "SOFT+":
        // m0/m1 字节不变（byte-identical 契约）；watermark 只做幂等推进。
        this.store.updateRepresentedThrough(
          record.runtimeSessionId,
          record.representedThroughContextSeq,
        );
        break;
    }
    // fold 状态已落库：重置 activeFold，保证下一个物化周期的首次 HARD 重新 fold
    // （否则跨 pass 复用旧 fold 会把 m0 锁在错误字节上，如 turn4 复用了 first_render
    // 的空 fold）。
    this.activeFold = undefined;
    return record;
  }
}
