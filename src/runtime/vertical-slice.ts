import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Type, type AssistantMessage } from "@iris/pi-ai";
import type { ContextMessageUnitV1 } from "@iris/context/contracts";

import { type AgentHarnessTool, type Session, type SessionTreeEntry } from "@iris/pi-agent-core";
import {
  createNodeSqliteFactory,
  SqliteSessionRepository,
  type SqliteSessionMetadata,
} from "@iris/pi-storage-sqlite-node";

import type { AgentConfigV3 } from "../config/schema.js";
import { defaultAgentConfig } from "../config/load.js";
import type { AgentInput } from "../contracts/origin.js";
import { directUserRequest } from "../contracts/origin.js";
import { acquireDataRootLock } from "../host/lock.js";
import { initializeDataRoot, resolveDataRootPaths } from "../host/data-root.js";
import { nodeSqliteRepoEnv } from "./pi-env.js";
import { RuntimeEpochStore } from "./epoch-manager.js";
import { createMockProvider } from "./mock-provider.js";
import { createOpenCodeGoProvider } from "./opencode-go-provider.js";
import {
  createIrisHarness,
  type HarnessObservers,
  type InvocationBinding,
} from "./harness-factory.js";
import { assembleIrisContext, deriveIrisLineageId } from "./iris-context.js";
import { IrisContextBridge } from "./iris-bridge.js";
import { HistoricalSessionRecoveryIngest } from "./recovery-ingest.js";

export interface VerticalSliceResult {
  epochId: string;
  runtimeSessionId: string;
  observers: HarnessObservers;
  assistantMessage: AssistantMessage;
  entries: SessionTreeEntry[];
  /** @iris/context 已提交的 ContextMessageUnitV1（会话视图）。 */
  contextUnits: ContextMessageUnitV1[];
  /** 最近一次 provider 边界的 generation 分层摘要（测试/诊断）。 */
  generationSummary: string;
  dataRoot: string;
}

export type SliceProviderMode = "mock" | "live";

export interface ProviderComposition {
  models: Parameters<typeof createIrisHarness>[0]["models"];
  model: Parameters<typeof createIrisHarness>[0]["model"];
  providerProfileId: string;
}

export async function composeProvider(
  mode: SliceProviderMode,
  onContext?: (messages: unknown[]) => void,
  failWith?: Error,
): Promise<ProviderComposition> {
  if (mode === "mock") {
    const { models, model } = createMockProvider({
      ...(onContext === undefined ? {} : { onContext }),
      ...(failWith === undefined ? {} : { failWith }),
    });
    return { models, model, providerProfileId: "mock-iris-provider-v1" };
  }
  const { models, model } = await createOpenCodeGoProvider();
  return {
    models,
    model,
    providerProfileId: "opencode-go-deepseek-v4-flash-dev-nonthinking-v1",
  };
}

/**
 * 0.83.0+：Session 不再暴露 storage 访问器；连接生命周期由
 * SqliteSessionRepository 管理。关闭 = repo[Symbol.asyncDispose]()。
 */
export async function closeSessionStorage(repo: {
  [Symbol.asyncDispose](): Promise<void>;
}): Promise<void> {
  await repo[Symbol.asyncDispose]();
}

/**
 * 为一次 invocation 准备最小 Pi-runtime binding（InvocationBinding）。
 * 只含 input / invocationId / runtimeSessionId / epochId / instanceEpoch /
 * canonicalSystemPrompt / providerProfileId —— 不再携带 v27 废止的
 * ContextSourceSnapshot/PreparedInvocationSources 语义（removed legacy
 * assembly contract）；Context 组装状态
 * 完全由 @iris/context 持有（Notion v27 Legacy Assembly Contract Cleanup）。
 */
export function prepareInvocation(
  input: AgentInput,
  runtimeSessionId: string,
  epochId: string,
  instanceEpoch: number,
  config: AgentConfigV3,
  now: string,
): InvocationBinding {
  const providerProfileId = config.model.main_agent.active_profile;
  const canonicalSystemPrompt =
    `IRIS SYSTEM PROMPT V1\n` +
    `instance: ${config.instance_name}\n` +
    `runtimeSessionId: ${runtimeSessionId}\n` +
    `epochId: ${epochId}\n` +
    `inputId: ${input.inputId}\n` +
    `providerProfileId: ${providerProfileId}\n` +
    `binding: immutable-for-invocation\n`;
  return {
    input,
    invocationId: `invocation-${input.inputId}`,
    runtimeSessionId,
    epochId,
    instanceEpoch,
    canonicalSystemPrompt,
    providerProfileId,
    preparedAt: new Date(now).toISOString(),
  };
}

export function sampleAgentInput(): AgentInput {
  return {
    inputId: "input-0001",
    triggerOrigin: directUserRequest(),
    blocks: [
      {
        blockId: "block-0001",
        sourceOrigin: directUserRequest(),
        content: { mode: "inline_text", text: "hello iris, run the read tool" },
        contentHash: createHash("sha256").update("hello iris, run the read tool").digest("hex"),
      },
    ],
    interaction: { interactionId: "interaction-0001" },
  };
}

export async function openOrCreateSession(
  dataRoot: string,
  config: AgentConfigV3,
  runtimeSessionId: string,
): Promise<{ repo: SqliteSessionRepository; session: Session<SqliteSessionMetadata> }> {
  const paths = resolveDataRootPaths(dataRoot, config);
  const repo = new SqliteSessionRepository({
    env: nodeSqliteRepoEnv(dataRoot),
    sqlite: createNodeSqliteFactory(),
    databasePath: paths.sessionDb,
  });
  const list = await repo.list({ cwd: dataRoot });
  const metadata = list.find((candidate) => candidate.id === runtimeSessionId);
  if (metadata !== undefined) {
    return { repo, session: await repo.open(metadata) };
  }
  return { repo, session: await repo.create({ id: runtimeSessionId, cwd: dataRoot }) };
}

export interface ReconcileHistoricalSessionResult {
  /** Pi receipts replayed into the Context ingest. */
  replayed: number;
  /** The durable identity lineage resolved for the historical session. */
  lineageId: string;
  /** Context units created/paired by the recovery ingest (lineage view). */
  units: ContextMessageUnitV1[];
  runtimeSessionId: string;
}

/**
 * Recovery Reconciler：rollover 后把旧 Runtime Session 的未提交 crash 窗口
 * （Pi durable append + pending receipt，Iris 未 commit）恢复到其 durable
 * identity lineage。
 *
 * 流程：
 *  1. 读取 Session 的 pending receipts（Pi 恢复证据）；
 *  2. 用 verify 过的 receipt 经 @iris/context 的 resolveLineageForRecovery
 *     解析 lineage（binding ledger 存在性 + checksum 完整性，fail closed）；
 *  3. harness.recoverPendingCommitReceipts() 重放事件 → IrisContextBridge →
 *     recovery ingest（按 lineage 直查，绝不把旧 Session 重新变回 current）；
 *  4. ensureUnitsUpTo 幂等补建；acknowledgeSessionReconciled 标记对账完成。
 *
 * 旧 Session 的 raw archive attribution（runtimeSessionId）保留在事件与
 * unit 上；identity lineage 与 Runtime Session id 是两个不同的概念。
 */
export async function reconcileHistoricalSession(options: {
  dataRoot: string;
  config?: AgentConfigV3;
  runtimeSessionId: string;
  now?: string;
}): Promise<ReconcileHistoricalSessionResult> {
  const config = options.config ?? defaultAgentConfig();
  const now = options.now ?? "2026-08-01T00:00:00.000Z";
  const paths = resolveDataRootPaths(options.dataRoot, config);
  const lock = await acquireDataRootLock(options.dataRoot, paths.lockFile);
  try {
    initializeDataRoot(options.dataRoot, config);
    const epochStore = new RuntimeEpochStore(
      paths.epochRegistryDb,
      config.runtime_sessions.session_id_prefix,
      config.runtime_sessions.timezone,
    );
    const { repo, session } = await openOrCreateSession(
      options.dataRoot,
      config,
      options.runtimeSessionId,
    );
    try {
      const pending = await session.readPendingCommitReceipts();
      const lineageId = deriveIrisLineageId(paths.dataRoot);
      const assembly = await assembleIrisContext({
        dataRoot: paths.dataRoot,
        runtimeSessionId: options.runtimeSessionId,
        providerProfileId: config.model.main_agent.active_profile,
        canonicalSystemPrompt: "",
        systemProjectionHash: "",
        preparedAt: new Date(now).toISOString(),
        withHistorian: false,
        now: () => now,
        getCurrentSource: () => ({
          canonicalSystemPrompt: "",
          personaSnapshotId: "persona-default-v1",
          providerProfileId: config.model.main_agent.active_profile,
          toolDeclarations: [],
        }),
      });
      try {
        if (pending.length === 0) {
          // 无 pending receipt 窗口 → Session 无需进一步恢复；标记 binding
          // 对账完成（幂等），使其可被 bounded-ledger reclaim 回收。
          assembly.contextService.getStore().acknowledgeSessionReconciled(options.runtimeSessionId);
          return {
            replayed: 0,
            lineageId: "",
            units: [],
            runtimeSessionId: options.runtimeSessionId,
          };
        }
        // 解析必须是"已验证的绑定"：binding ledger 行 + checksum + receipt
        // 身份。任一步失败 → throw（fail closed），不 ingest 任何事件。
        const firstPending = pending[0];
        if (firstPending === undefined) {
          throw new Error(
            `reconcileHistoricalSession: pending receipts vanished between read and resolve`,
          );
        }
        const recoveryIngest = new HistoricalSessionRecoveryIngest(
          assembly.contextService,
          lineageId,
        );
        const resolvedLineage = recoveryIngest.resolveLineageForRecovery(
          options.runtimeSessionId,
          firstPending,
        );
        const { models, model, providerProfileId } = await composeProvider("mock");
        const binding = prepareInvocation(
          sampleAgentInput(),
          options.runtimeSessionId,
          "recovery",
          1,
          config,
          now,
        );
        const { harness } = createIrisHarness({
          session,
          instanceEpoch: 1,
          models,
          model,
          tools: [makeReadOnlyTestTool()],
          currentInvocation: binding,
          now,
          providerProfileId,
          // 恢复路径：contextController 使用当前 generation 渲染；若无
          // generation 则 fail-closed —— 恢复重放不依赖 provider dispatch。
          irisContext: assembly.contextService,
        });
        const bridge = new IrisContextBridge({
          runtimeSessionId: options.runtimeSessionId,
          instanceEpoch: 1,
          contextService: assembly.contextService,
          getInput: () => binding.input,
          now: () => now,
        });
        bridge.attach(harness);
        const replayed = await harness.recoverPendingCommitReceipts();
        // ensureUnitsUpTo 幂等（hasUnitForEvent 跳过已建单元）；恢复模式返回
        // LINEAGE 视图（历史 Session 不按 session 解析）。
        const units = recoveryIngest.ensureUnitsUpTo();
        // 对账完成（权威证据）——binding 可被 bounded-ledger reclaim 回收。
        recoveryIngest.acknowledgeSessionReconciled(options.runtimeSessionId);
        return {
          replayed,
          lineageId: resolvedLineage,
          units,
          runtimeSessionId: options.runtimeSessionId,
        };
      } finally {
        await assembly.close();
      }
    } finally {
      await closeSessionStorage(repo);
      epochStore.close();
    }
  } finally {
    await lock.release();
  }
}

export function makeReadOnlyTestTool(): AgentHarnessTool<undefined> {
  return {
    name: "test_read_tool",
    label: "Test read tool",
    description: "Deterministic read-only test tool used by the R1-P0 vertical slice.",
    parameters: Type.Object({ query: Type.String() }),
    executionMode: "sequential",
    async execute() {
      return {
        content: [{ type: "text", text: "read-only result: iris" }],
        details: { source: "mock-read-tool", query: "iris" },
      };
    },
  };
}

/** 从 dataRoot 派生稳定 identity-level lineage id（兼容导出）。 */
export function deriveLineageId(dataRoot: string): string {
  return deriveIrisLineageId(resolve(dataRoot));
}

export async function reopenActiveSession(options: {
  dataRoot: string;
  config?: AgentConfigV3;
  input?: AgentInput;
  now?: string;
  provider?: SliceProviderMode;
}): Promise<{
  runtimeSessionId: string;
  observers: HarnessObservers;
  entries: SessionTreeEntry[];
}> {
  const config = options.config ?? defaultAgentConfig();
  const input = options.input ?? sampleAgentInput();
  const now = options.now ?? "2026-08-01T00:00:00.000Z";
  const providerMode = options.provider ?? "mock";
  const paths = resolveDataRootPaths(options.dataRoot, config);
  const lock = await acquireDataRootLock(options.dataRoot, paths.lockFile);
  try {
    initializeDataRoot(options.dataRoot, config);
    const epochStore = new RuntimeEpochStore(
      paths.epochRegistryDb,
      config.runtime_sessions.session_id_prefix,
      config.runtime_sessions.timezone,
    );
    const epoch = epochStore.ensureActive(now);
    const { repo, session } = await openOrCreateSession(
      options.dataRoot,
      config,
      epoch.runtimeSessionId,
    );
    const binding = prepareInvocation(
      input,
      epoch.runtimeSessionId,
      epoch.epochId,
      epoch.ordinalWithinDate,
      config,
      now,
    );
    const providerContextSnapshots: string[] = [];
    const { models, model, providerProfileId } = await composeProvider(providerMode, (messages) => {
      providerContextSnapshots.push(JSON.stringify(messages));
    });
    const assembly = await assembleIrisContext({
      dataRoot: paths.dataRoot,
      runtimeSessionId: epoch.runtimeSessionId,
      providerProfileId,
      canonicalSystemPrompt: binding.canonicalSystemPrompt,
      systemProjectionHash: createHash("sha256")
        .update(binding.canonicalSystemPrompt)
        .digest("hex"),
      preparedAt: binding.preparedAt,
      withHistorian: false,
      now: () => now,
      getCurrentSource: () => ({
        canonicalSystemPrompt: binding.canonicalSystemPrompt,
        personaSnapshotId: "persona-default-v1",
        providerProfileId,
        toolDeclarations: ["test_read_tool"],
      }),
    });
    try {
      const { observers } = createIrisHarness({
        session,
        instanceEpoch: epoch.ordinalWithinDate,
        models,
        model,
        tools: [makeReadOnlyTestTool()],
        currentInvocation: binding,
        now,
        providerProfileId,
        irisContext: assembly.contextService,
      });
      observers.providerContextSnapshots = providerContextSnapshots;
      const entries = await session.getEntries();
      return {
        runtimeSessionId: epoch.runtimeSessionId,
        observers,
        entries,
      };
    } finally {
      await assembly.close();
      await closeSessionStorage(repo);
      epochStore.close();
    }
  } finally {
    await lock.release();
  }
}

export interface RolloverResult {
  previousEpochId: string;
  previousSessionId: string;
  newEpochId: string;
  newSessionId: string;
  previousStatus: string;
  entries: SessionTreeEntry[];
}

/**
 * Settled-only rollover (02 Runtime Sessions, Rollover Boundary).
 *
 * Implements the recoverable two-phase switch:
 *  1. beginRollover(now)   -> new Epoch row in 'creating' (old stays active)
 *  2. createPiSession(...) -> actually create the new Pi Session row
 *  3. close old Session storage (flush pending writes)
 *  4. activateRollover(now) -> single-transaction CAS: old -> closed,
 *                              new -> active (previous_epoch_id linked at creation)
 *
 * A crash between 1 and 4 leaves the old epoch active + a 'creating' row,
 * which `recoverCreating()` (startup) cleans up — the active-epoch invariant
 * is never durably violated and no zero-active window exists.
 */
export async function rolloverActiveSession(options: {
  dataRoot: string;
  config?: AgentConfigV3;
  now?: string;
  settledEpochId: string;
}): Promise<RolloverResult> {
  const config = options.config ?? defaultAgentConfig();
  const now = options.now ?? "2026-08-01T00:00:00.000Z";
  const paths = resolveDataRootPaths(options.dataRoot, config);
  const lock = await acquireDataRootLock(options.dataRoot, paths.lockFile);
  try {
    initializeDataRoot(options.dataRoot, config);
    const epochStore = new RuntimeEpochStore(
      paths.epochRegistryDb,
      config.runtime_sessions.session_id_prefix,
      config.runtime_sessions.timezone,
    );
    const previous = epochStore.ensureActive(now);
    if (previous.epochId !== options.settledEpochId) {
      epochStore.close();
      throw new Error(
        `rollover refused: active epoch ${previous.epochId} is not the settled epoch ${options.settledEpochId}`,
      );
    }
    const pending = epochStore.beginRollover(now);

    // Create the new Pi Session (actually materializes a row).
    const newSessionHandle = await openOrCreateSession(
      options.dataRoot,
      config,
      pending.runtimeSessionId,
    );
    await closeSessionStorage(newSessionHandle.repo);

    // Close the old Pi Session storage (flush pending writes) before the CAS.
    const oldSessionHandle = await openOrCreateSession(
      options.dataRoot,
      config,
      previous.runtimeSessionId,
    );
    await closeSessionStorage(oldSessionHandle.repo);

    const next = epochStore.activateRollover(now);

    // Rollover rotates ONLY the Pi Session/Harness archive segment. The
    // identity-level Context lineage survives; we just rebind it to the new
    // session. No new lineage, no reset, no copy. Missing context.db (fresh
    // data root) is fine — the lineage will be created on the next slice run.
    const lineageId = deriveIrisLineageId(paths.dataRoot);
    const assembly = await assembleIrisContext({
      dataRoot: paths.dataRoot,
      runtimeSessionId: next.runtimeSessionId,
      providerProfileId: config.model.main_agent.active_profile,
      canonicalSystemPrompt: "",
      systemProjectionHash: "",
      preparedAt: new Date(now).toISOString(),
      withHistorian: false,
      now: () => now,
      getCurrentSource: () => ({
        canonicalSystemPrompt: "",
        personaSnapshotId: "persona-default-v1",
        providerProfileId: config.model.main_agent.active_profile,
        toolDeclarations: [],
      }),
    });
    try {
      if (assembly.contextService.getStore().getLineageByLineageId(lineageId) !== undefined) {
        assembly.contextService.getStore().bindCurrentSession(lineageId, next.runtimeSessionId);
      }
    } finally {
      await assembly.close();
    }

    const entries = await sessionEntriesFor(options.dataRoot, config, next.runtimeSessionId);
    epochStore.close();
    return {
      previousEpochId: previous.epochId,
      previousSessionId: previous.runtimeSessionId,
      newEpochId: next.epochId,
      newSessionId: next.runtimeSessionId,
      previousStatus: previous.status,
      entries,
    };
  } finally {
    await lock.release();
  }
}

async function sessionEntriesFor(
  dataRoot: string,
  config: AgentConfigV3,
  runtimeSessionId: string,
): Promise<SessionTreeEntry[]> {
  const paths = resolveDataRootPaths(dataRoot, config);
  const repo = new SqliteSessionRepository({
    env: nodeSqliteRepoEnv(dataRoot),
    sqlite: createNodeSqliteFactory(),
    databasePath: paths.sessionDb,
  });
  const list = await repo.list({ cwd: dataRoot });
  const metadata = list.find((candidate) => candidate.id === runtimeSessionId);
  if (metadata === undefined) {
    return [];
  }
  const session = await repo.open(metadata);
  const entries = await session.getEntries();
  await closeSessionStorage(repo);
  return entries;
}
