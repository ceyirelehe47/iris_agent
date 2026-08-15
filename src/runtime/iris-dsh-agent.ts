/**
 * Iris-owned DSH AgentFactory / Agent Loop（iris_agent#128 Phase B 最小真实纵切）。
 *
 * 权威来源：Notion 2026-08-15 DSH Runtime Migration｜Composition & Plugin Model：
 *   - 不 monkey-patch DSH 默认 `ReactLoopAgent`；Iris 注册**自己的** AgentFactory
 *     （`ctx.agents.setFactory`，dsh-agent 官方 seam）；
 *   - provider 调用只来自 **validated ContextGeneration → Provider Renderer →
 *     provider-native wire**；禁止扫描 DSH Session history 直接拼 prompt；
 *   - P0–P4 不写入 DSH Session；DSH Session 只作 raw runtime archive / recovery
 *     evidence / UI-audit / commit-ordering；
 *   - 一个 active Agent Loop lifecycle truth（不叠第二套 loop）。
 *
 * 最小纵切范围（诚实边界）：
 *   - `followup` 驱动一个完整 turn：runBustIfPending → 当前 validated
 *     ContextGeneration（fail-closed）→ renderGenerationForProvider → 受控
 *     `generate` provider 调用（**只**接收 rendered context）→ assistant 消息
 *     committed 到 DSH Session → assistant ContextUnit admission → requestBust
 *     → 下一 generation 重建；
 *   - `steer`/`inject` 在最小纵切中不支持 → fail-closed 抛错（不静默忽略）；
 *   - 持久化 resume、inbox 完整语义、并行 tool loop 属于 #128 后续项（非本
 *     轮范围）；`whenIdle`/`cancel` 提供最小可用语义。
 */
import type { Context } from "@deepseek-ai/cordis";
import {
  Inbox,
  type Agent,
  type AgentCancelCause,
  type AgentFactory,
  type AgentHandle,
  type AgentOptions,
  type AgentStatus,
  type CancelOptions,
  type CreateAgentOptions,
  type InboxTarget,
  type ResumeAgentOptions,
} from "@deepseek-ai/dsh-agent";
import { Session, type SessionId } from "@deepseek-ai/dsh-session";
import {
  createAssistantMessage,
  type AssistantMessage,
  type TokenUsage,
  type UserMessage,
} from "@deepseek-ai/dsh-llm";
import type { ContextService } from "@iris/context";

import {
  dshAssistantSourceHash,
  dshContentToSemanticParts,
  dshUsageToIris,
} from "./dsh-adapter.js";
import {
  renderGenerationForProvider,
  type AttachmentMaterializer,
  type RenderedProviderContext,
} from "./context-render.js";

/** 受控 provider 调用签名：只接收 rendered context（绝不接收 DSH Session）。 */
export interface IrisGenerateInput {
  rendered: RenderedProviderContext;
  signal?: AbortSignal;
  provider?: string;
  model?: string;
  maxTokens?: number;
}

/** provider 调用的结果：assistant 消息 + 可选 event-level usage（DSH 语义）。 */
export interface IrisGenerateOutput {
  assistant: AssistantMessage;
  usage?: TokenUsage;
}

export type IrisGenerate = (input: IrisGenerateInput) => Promise<IrisGenerateOutput>;

export interface IrisTurnResult {
  turn: number;
  step: number;
  assistantMessageId: string;
  assistantEventSeq: number;
  generationUnits: number;
}

export interface IrisLoopDeps {
  /** 运行时的 DSH Session（与 lineage 绑定的 raw archive；agent 驱动它）。 */
  session: Session;
  contextService: ContextService;
  generate: IrisGenerate;
  attachmentMaterializer?: AttachmentMaterializer;
  onTurnCompleted?: (result: IrisTurnResult) => void;
  nowMs?: () => number;
}

/** 空 inbox 通知（最小纵切不使用持久 inbox splice）。 */
const NOOP_NOTIFICATIONS = {
  inserted: () => undefined,
  discarded: () => undefined,
  claimed: () => undefined,
};

/**
 * Iris Agent Loop —— 最小可用 DSH Agent 实现。
 *
 * turn 语义（唯一 provider 调用路径）：
 *   runBustIfPending → validated ContextGeneration → Provider Renderer →
 *   generate({ rendered }) → assistant committed to DSH Session →
 *   assistant ContextUnit admission → requestBust。
 */
export class IrisLoopAgent implements Agent {
  readonly id: SessionId;
  readonly options: AgentOptions;
  readonly session: Session;
  readonly inbox: Inbox;
  readonly ctx: Context;
  private readonly deps: IrisLoopDeps;
  private statusValue: AgentStatus = "idle";
  private activeTurn: Promise<void> | undefined;
  private turnCounter = 0;
  private abortController: AbortController | undefined;
  private disposed = false;

  constructor(
    ctx: Context,
    id: SessionId,
    options: CreateAgentOptions["agentOptions"],
    session: Session,
    deps: IrisLoopDeps,
  ) {
    this.ctx = ctx;
    this.id = id;
    this.options = options ?? {};
    this.session = session;
    this.deps = deps;
    this.inbox = new Inbox(session, NOOP_NOTIFICATIONS);
  }

  get status(): AgentStatus {
    return this.statusValue;
  }

  /** 队列一个 follow-up turn 并唤醒 driver（最小纵切的主入口）。 */
  followup(message: UserMessage): void {
    this.requireNotDisposed();
    if (this.activeTurn !== undefined) {
      throw new Error(
        `iris agent ${this.id}: followup while a turn is active is not supported in the minimal slice ` +
          "(fail closed; #128 next slice)",
      );
    }
    // 输入消息必须已经由 Host append 进 Session（与 DshIngressAdapter 的
    // 重放语义一致）；未找到 → fail-closed，绝不静默丢弃（review F2）。
    const lastUser = [...this.session.events].reverse().find((e) => e.type === "user/message");
    if (lastUser?.type !== "user/message" || lastUser.data.id !== message.id) {
      throw new Error(
        `iris agent ${this.id}: followup message ${message.id} is not the latest committed ` +
          "user/message in the Session — Host must append it before followup (fail closed)",
      );
    }
    this.driveTurn();
  }

  /** send：wakeup=true 时按 followup 语义驱动（最小纵切）。 */
  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    void target;
    if (wakeup) {
      this.followup(message);
    }
    // wakeup=false：park（最小纵切不实现持久 inbox）。
  }

  /** steer：最小纵切不支持 → fail-closed。 */
  steer(message: UserMessage): void {
    void message;
    throw new Error(
      `iris agent ${this.id}: steer is not supported in the minimal slice (fail closed; #128 next slice)`,
    );
  }

  /** inject：最小纵切不支持 → fail-closed（provider hook 临时 patch 被禁止）。 */
  inject(message: UserMessage): void {
    void message;
    throw new Error(
      `iris agent ${this.id}: inject is not supported in the minimal slice (fail closed; ` +
        "dynamic provider-turn context patch is forbidden by the authority fence)",
    );
  }

  cancel(cause: AgentCancelCause, options?: CancelOptions): void {
    void cause;
    void options;
    this.abortController?.abort();
  }

  whenIdle(): Promise<void> {
    return this.activeTurn ?? Promise.resolve();
  }

  async runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return task(this.abortController?.signal ?? new AbortController().signal);
  }

  /** 关闭：停止 driver、标记 disposed。 */
  close(): void {
    this.disposed = true;
    this.abortController?.abort();
    this.activeTurn = undefined;
    this.statusValue = "idle";
  }

  private requireNotDisposed(): void {
    if (this.disposed) {
      throw new Error(`iris agent ${this.id}: agent is disposed (fail closed)`);
    }
  }

  /**
   * 驱动一个完整 turn（最小纵切的核心）。
   * Provider 调用只来自 validated ContextGeneration → Provider Renderer。
   */
  private driveTurn(): void {
    if (this.statusValue === "running") {
      throw new Error(
        `iris agent ${this.id}: a turn is already running (single active loop; fail closed)`,
      );
    }
    this.turnCounter += 1;
    const turn = this.turnCounter;
    this.statusValue = "running";
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const promise = this.runTurn(turn, signal).finally(() => {
      this.activeTurn = undefined;
      if (this.statusValue === "running") {
        this.statusValue = "idle";
      }
    });
    this.activeTurn = promise;
  }

  private async runTurn(turn: number, signal: AbortSignal): Promise<void> {
    const { contextService } = this.deps;
    // 1. 安全 provider 边界完成 canonical BUST（如有 pending）。
    await contextService.runBustIfPending();
    // 2. validated ContextGeneration（fail-closed：无 generation 不 dispatch）。
    const generation = contextService.getCurrentGeneration();
    if (generation === null) {
      throw new Error(
        `iris agent ${this.id}: no validated ContextGeneration at provider boundary ` +
          "(fail closed; IRIS_CONTEXT_TRANSFORM_UNAVAILABLE)",
      );
    }
    // 3. Provider Renderer：只消费 canonical ContextUnit。
    const rendered = await renderGenerationForProvider(
      generation,
      this.deps.attachmentMaterializer !== undefined
        ? { attachmentMaterializer: this.deps.attachmentMaterializer }
        : {},
    );
    // 4. provider 调用：只接收 rendered context（绝不接收 Session）。
    const { assistant, usage } = await this.deps.generate({
      rendered,
      ...(signal !== undefined ? { signal } : {}),
      ...(this.options.provider !== undefined ? { provider: this.options.provider } : {}),
      ...(this.options.model !== undefined ? { model: this.options.model } : {}),
      ...(this.options.maxTokens !== undefined ? { maxTokens: this.options.maxTokens } : {}),
    });
    // 5. assistant/message committed 到 DSH Session（raw archive；P0–P4 永不写入）。
    const appended = this.session.append(
      "assistant/message",
      { turn, step: 1, message: assistant, ...(usage !== undefined ? { usage } : {}) },
      { surfaceOp: "append" },
    );
    // 用 committed event 的权威 time/seq（与 dsh-adapter 的 event.time/event.seq
    // 语义一致）→ restart 后重 ingest 同一 Session 时 sourceHash 不变
    // （review F1：不得用进程内 nowMs()，否则重放会因 time 不同产生重复 Unit）。
    const eventSeq = appended.seq;
    const eventTime = appended.time;
    // 6. assistant ContextUnit admission（同一 ContextUnit 模型；exactly-once）。
    const source = (assistant.source as { provider?: string; model?: string }) ?? {};
    contextService.admitRuntimeMessage({
      sessionId: this.session.id,
      messageId: assistant.id,
      eventSeq,
      contentSchemaId: "iris.semantic.context_message.assistant.v1",
      content: {
        role: "assistant",
        content: dshContentToSemanticParts(assistant.content),
        ...(source.provider !== undefined ? { provider: source.provider } : {}),
        ...(source.model !== undefined ? { model: source.model } : {}),
        ...(usage !== undefined ? { usage: dshUsageToIris(usage) } : {}),
        timestamp: eventTime,
      },
      runtimeSourceKind: "model",
      sourceHash: dshAssistantSourceHash(assistant, {
        usage,
        time: eventTime,
      }),
    });
    // 7. 下一 generation 重建（BUST）。
    contextService.requestBust("source_invalidation", {
      schemaId: "iris.bust_evidence.v1",
      detail: `assistant ${assistant.id} committed at turn ${turn}`,
      sourceRefs: [assistant.id],
    });
    const result: IrisTurnResult = {
      turn,
      step: 1,
      assistantMessageId: assistant.id,
      assistantEventSeq: eventSeq,
      generationUnits: generation.units.length,
    };
    this.deps.onTurnCompleted?.(result);
  }
}

/** 构造 AssistantMessage 的便捷函数（供 provider generate 使用）。 */
export function buildAssistantMessage(input: {
  content: readonly {
    type: string;
    text?: string;
  }[];
  provider: string;
  model: string;
}): AssistantMessage {
  return createAssistantMessage({
    content: input.content as never,
    source: { provider: input.provider, model: input.model },
  });
}

/**
 * Iris AgentFactory —— 注册到 `ctx.agents.setFactory`（DSH 官方 seam；
 * 不 monkey-patch ReactLoopAgent）。
 */
export class IrisAgentFactory implements AgentFactory {
  constructor(private readonly deps: IrisLoopDeps) {}

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    void ownerCtx;
    // 最小纵切：一个 DSH Session = 一个 agent（运行时 session 与 lineage 绑定）。
    // 多 agent / 独立 session 属于 #128 后续。
    const session = this.deps.session;
    const agent = new IrisLoopAgent(ownerCtx, session.id, options.agentOptions, session, {
      ...this.deps,
      contextService: this.deps.contextService,
    });
    return {
      agent,
      dispose: async () => {
        agent.close();
      },
    };
  }

  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    void ownerCtx;
    void options;
    // 最小纵切不实现持久化 resume（DSH session persistence 属于 #128 后续）。
    // 重启语义由 Context 侧保证：同一 dataRoot 重开 → context.db 的
    // Context identity/order 不重置（Phase A 已证）；DSH Session 重新 ingest。
    throw new Error(
      "iris agent: resume requires DSH session persistence, not wired in the minimal slice " +
        "(fail closed; #128 next slice)",
    );
  }
}
