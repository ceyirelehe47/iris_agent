/**
 * iris_agent 侧 @iris/context 装配（Cordis）。
 *
 * 装配点职责（Notion 08 Composition & Plugin Model v29）：
 *  - `new Context()` + `createIrisContextPlugin({ dataRoot, ... })` —— 单个
 *    root plugin；ContextService（irisContext）/ HistorianService
 *    （irisHistorian）/ MemoryService（irisMemory）在 Identity scope 注册；
 *  - `createLineage` 绑定 identity-level lineage 与当前 Runtime Session；
 *  - 注册 P0–P2 source contributors（P0–P2 权威 source 的 contribution
 *    seam；BUST 时冻结投影）；
 *  - 提交初始 canonical BUST 请求，使第一个安全 provider 边界能构建初始
 *    generation（不依赖任何 LKG/旧 generation）。
 *
 * 本模块同时是 vertical-slice 与 Host 的共享装配根；unload（fiber.dispose）
 * 只摘进程内注册，绝不删除 durable context.db / historian.db 行。
 */
import { Context, type Fiber } from "@deepseek-ai/cordis";
import { createIrisContextPlugin, type ContextService } from "@iris/context";
import { createHash } from "node:crypto";

import {
  createIrisSourceContributors,
  type CurrentContextSource,
  type IrisSourceContributor,
} from "./context-contributor.js";

export type { CurrentContextSource } from "./context-contributor.js";

export interface IrisContextAssembly {
  ctx: Context;
  fiber: Fiber;
  contextService: ContextService;
  lineageId: string;
  /** 已注册的 P0–P2 contributors（[p0, p1, p2]）。 */
  contributors: readonly IrisSourceContributor[];
  close(): Promise<void>;
}

export interface AssembleIrisContextOptions {
  dataRoot: string;
  runtimeSessionId: string;
  providerProfileId: string;
  canonicalSystemPrompt: string;
  systemProjectionHash: string;
  preparedAt: string;
  /** 是否同时装配 Historian（默认 true）。 */
  withHistorian?: boolean;
  /** 时间注入（默认实时）。 */
  now?: () => string;
  /** P0–P2 contributor 的权威 source holder（BUST 时冻结）。 */
  getCurrentSource: () => CurrentContextSource;
}

/** 等待某 Cordis service 在 ctx 上 ACTIVE（inject 驱动的异步加载）。 */
export async function waitForServiceActive(
  ctx: Context,
  name: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (ctx.get(name, true) !== undefined) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`cordis service ${name} did not become ACTIVE within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 从 dataRoot 派生稳定 identity-level lineage id（与 @iris/context 同源规则）。 */
export function deriveIrisLineageId(dataRoot: string): string {
  return `lineage-${createHash("sha256").update(dataRoot, "utf8").digest("hex").slice(0, 24)}`;
}

export async function assembleIrisContext(
  options: AssembleIrisContextOptions,
): Promise<IrisContextAssembly> {
  const ctx = new Context();
  const nowFn = options.now;
  const nowMs = nowFn === undefined ? undefined : () => new Date(nowFn()).getTime();
  const fiber = await ctx.plugin(
    createIrisContextPlugin({
      dataRoot: options.dataRoot,
      lineageId: deriveIrisLineageId(options.dataRoot),
      withHistorian: options.withHistorian !== false,
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(nowMs !== undefined ? { nowMs } : {}),
    }),
  );
  const contextService = ctx.irisContext;
  await waitForServiceActive(ctx, "irisContext");
  if (options.withHistorian !== false) {
    await waitForServiceActive(ctx, "irisHistorian");
  }

  const lineageId = contextService.lineageId;
  // Identity→Session 绑定：Host 在 session 进入时调用（幂等锚点；rollover 只
  // 重新绑定，绝不创建新 lineage）。同一 dataRoot 重启（lineage 已存在）→
  // bindCurrentSession（与 host rollover 同源规则）；首建 → createLineage。
  const store = contextService.getStore();
  if (store.getLineageByLineageId(lineageId) !== undefined) {
    store.bindCurrentSession(lineageId, options.runtimeSessionId);
  } else {
    contextService.createLineage({
      lineageId,
      runtimeSessionId: options.runtimeSessionId,
      providerProfileId: options.providerProfileId,
      canonicalSystemPrompt: options.canonicalSystemPrompt,
      systemProjectionHash: options.systemProjectionHash,
      preparedAt: options.preparedAt,
    });
  }

  // P0–P2 contributors（fail-closed：同 sourceId 二次注册抛错）。
  const contributors = createIrisSourceContributors(options.getCurrentSource);
  for (const contributor of contributors) {
    contextService.registerContributor(contributor);
  }

  // 初始 canonical BUST 请求：第一个安全 provider 边界构建初始 generation。
  contextService.requestBust("system_changed", {
    schemaId: "iris.bust_evidence.v1",
    detail: "initial generation build at assembly",
  });

  let closed = false;
  return {
    ctx,
    fiber,
    contextService,
    lineageId,
    contributors,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await fiber.dispose();
    },
  };
}
