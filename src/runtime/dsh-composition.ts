/**
 * DSH/Cordis production composition root（iris_agent#128 Phase B B1）。
 *
 * 组合：
 *   DSH/Cordis Host（Cordis Context + AgentRegistry）
 *   → Iris plugin/profile bundle（createIrisContextPlugin：ContextService）
 *   → custom Iris AgentFactory / Agent Loop（IrisAgentFactory / IrisLoopAgent）
 *   → Provider Renderer（renderGenerationForProvider）
 *
 * 约束（Notion DSH Runtime Migration）：
 *   - 注册 Iris 自己的 AgentFactory（ctx.agents.setFactory），不 monkey-patch
 *     DSH 默认 ReactLoopAgent（本组合不加载 @deepseek-ai/dsh-agent-loop）；
 *   - 不修改 DSH core；
 *   - provider 调用只来自 validated ContextGeneration → Provider Renderer；
 *   - P0–P4 不写入 DSH Session（DSH Session 只作 raw archive / evidence /
 *     audit / commit ordering）；
 *   - authority fence（assertNoConflictingDshFeatures）。
 *
 * Pi 路径保留为 compatibility/baseline（Pi runtime bridge），不被本
 * production profile 误选 —— 本组合不加载 Pi harness。
 */
import { Context, type Fiber } from "@deepseek-ai/cordis";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import { Session, type SessionId } from "@deepseek-ai/dsh-session";
import { createIrisContextPlugin } from "@iris/context";
import type { ContextService } from "@iris/context";

import { assertNoConflictingDshFeatures } from "./dsh-authority-fence.js";
import { IrisAgentFactory, type IrisGenerate } from "./iris-dsh-agent.js";
import type { AttachmentMaterializer } from "./context-render.js";
import { createIrisSourceContributors, type CurrentContextSource } from "./context-contributor.js";

export interface IrisDshRuntimeOptions {
  /** data root（context.db 所在目录；Context identity 的 durable 锚）。 */
  dataRoot: string;
  /** identity-level lineage id；缺省 = @iris/context deriveLineageId(dataRoot)。 */
  lineageId?: string;
  /** 当前 DSH Session id（raw runtime archive 的 ownership scope）。 */
  sessionId: SessionId;
  /** provider profile attribution（Context lineage 绑定）。 */
  providerProfileId: string;
  /** canonical system prompt（P0 声明的 source 输入）。 */
  canonicalSystemPrompt: string;
  systemProjectionHash: string;
  preparedAt: string;
  /** P0–P2 contributor 的权威 source holder（BUST 时冻结；缺省用选项固定值）。 */
  getCurrentSource?: () => CurrentContextSource;
  /** 受控 provider 调用（只接收 rendered context）。 */
  generate: IrisGenerate;
  /** 渲染期 attachment 物化器（A3；缺省 = fail-closed 默认）。 */
  attachmentMaterializer?: AttachmentMaterializer;
  withHistorian?: boolean;
  now?: () => string;
  nowMs?: () => number;
}

export interface IrisDshRuntime {
  ctx: Context;
  fiber: Fiber;
  contextService: ContextService;
  agents: AgentRegistry;
  factory: IrisAgentFactory;
  session: Session;
  lineageId: string;
  close(): Promise<void>;
}

/** 等待某服务在 ctx 上 ACTIVE（inject 驱动的异步加载，poll 直到可见）。 */
async function waitForActive(ctx: Context, name: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (ctx.get(name, true) !== undefined) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`service ${name} did not become ACTIVE within timeout`);
}

/**
 * 创建 Iris-owned 的 DSH/Cordis production composition（最小真实纵切）。
 * 返回 runtime 句柄；close() 摘除进程内 effect（不删 durable 状态）。
 */
export async function createIrisDshRuntime(
  options: IrisDshRuntimeOptions,
): Promise<IrisDshRuntime> {
  const ctx = new Context();
  const fiber: Fiber = await ctx.plugin(
    createIrisContextPlugin({
      dataRoot: options.dataRoot,
      ...(options.lineageId !== undefined ? { lineageId: options.lineageId } : {}),
      ...(options.withHistorian !== undefined ? { withHistorian: options.withHistorian } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
    }),
  );
  await waitForActive(ctx, "irisContext");
  const contextService: ContextService = ctx.irisContext;
  const lineageId = contextService.lineageId;

  // Session→lineage 绑定（幂等）。
  if (contextService.getStore().getLineageByLineageId(lineageId) === undefined) {
    contextService.createLineage({
      lineageId,
      runtimeSessionId: String(options.sessionId),
      providerProfileId: options.providerProfileId,
      canonicalSystemPrompt: options.canonicalSystemPrompt,
      systemProjectionHash: options.systemProjectionHash,
      preparedAt: options.preparedAt,
    });
  }

  // P0–P2 contributors（BUST 的声明层 source；Context 唯一 materialize 方）。
  const getCurrentSource: () => CurrentContextSource =
    options.getCurrentSource ??
    (() => ({
      canonicalSystemPrompt: options.canonicalSystemPrompt,
      personaSnapshotId: "persona-default-v1",
      providerProfileId: options.providerProfileId,
      toolDeclarations: [],
    }));
  for (const contributor of createIrisSourceContributors(getCurrentSource)) {
    contextService.registerContributor(contributor);
  }

  // DSH AgentRegistry（官方 seam；AgentLoop 的替代工厂注册点）。
  const agents = new AgentRegistry(ctx);
  const session = Session.create(options.sessionId);
  const factory = new IrisAgentFactory({
    session,
    contextService,
    generate: options.generate,
    ...(options.attachmentMaterializer !== undefined
      ? { attachmentMaterializer: options.attachmentMaterializer }
      : {}),
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
  });
  agents.setFactory(factory);

  // 真实 DSH Session（raw runtime archive；P0–P4 永不写入）。

  // authority fence：冲突 DSH 服务挂载 → fail-closed。
  assertNoConflictingDshFeatures(ctx);

  // 初始 BUST（声明层冻结；首个 provider 边界发布 generation）。
  contextService.requestBust("system_changed", {
    schemaId: "iris.bust_evidence.v1",
    detail: "iris dsh composition started",
    sourceRefs: ["iris-system-v1"],
  });

  let closed = false;
  return {
    ctx,
    fiber,
    contextService,
    agents,
    factory,
    session,
    lineageId,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await fiber.dispose();
    },
  };
}
