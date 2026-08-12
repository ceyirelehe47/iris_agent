// NOT PRODUCTION — Test/dev vertical slice. Imports context-renderer (MIGRATION ONLY per Notion v27).
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Type, type AssistantMessage } from "@iris/pi-ai";

import type { ContextMessageUnitV1 } from "../contracts/context-v27.js";
import type { RuntimeEvent } from "../contracts/runtime-events.js";
import { RuntimeEventLedger } from "./runtime-event-ledger.js";
import { ContextStore } from "../context/context-store.js";
import { ContextIngest } from "../context/context-ingest.js";
import {
  CONTEXT_CARRIER_SCHEMA_VERSION,
  CONTEXT_SERIALIZER_VERSION,
  ContextRenderer,
} from "../context/context-renderer.js";
import { attachRuntimeEventSeam } from "./runtime-event-seam.js";
import { createContextHistoryReadPort } from "../context/history-read-port.js";
import type { HistorianManager } from "../historian/historian-manager.js";

import {
  type AgentHarnessTool,
  type Session,
  type SessionTreeEntry,
} from "@iris/pi-agent-core";
import {
  createNodeSqliteFactory,
  SqliteSessionRepository,
  type SqliteSessionMetadata,
} from "@iris/pi-storage-sqlite-node";

import type { AgentConfigV3 } from "../config/schema.js";
import { defaultAgentConfig } from "../config/load.js";
import type { InvocationSourceBinding } from "../contracts/context.js";
import type { AgentInput } from "../contracts/origin.js";
import { directUserRequest } from "../contracts/origin.js";
import { acquireDataRootLock } from "../host/lock.js";
import { initializeDataRoot, resolveDataRootPaths } from "../host/data-root.js";
import { nodeSqliteRepoEnv } from "./pi-env.js";
import { RuntimeEpochStore } from "./epoch-manager.js";
import { encodeInputFrames } from "./companion.js";
import { createMockProvider } from "./mock-provider.js";
import { createOpenCodeGoProvider } from "./opencode-go-provider.js";
import {
  createIrisHarness,
  type HarnessObservers,
  type IrisHarnessCallbacks,
} from "./harness-factory.js";

export interface VerticalSliceResult {
  epochId: string;
  runtimeSessionId: string;
  observers: HarnessObservers;
  assistantMessage: AssistantMessage;
  entries: SessionTreeEntry[];
  /** R1-P1e：runtime-event ledger exactly-once 提交的不可变事件流。 */
  ledgerEvents: RuntimeEvent[];
  /** R2-P0：ContextMessageUnitV1 语义单元（ingest 折叠后）。 */
  contextUnits: ContextMessageUnitV1[];
  /** R2-P1：prompt 完成后 persistRender 提交的 m0/m1 字节与 context_seq
   * watermark（测试断言 golden parity 用；未发生 provider render 时为空串/0）。 */
  m0Body: string;
  m1Body: string;
  representedThroughContextSeq: number;
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
): Promise<ProviderComposition> {
  if (mode === "mock") {
    const { models, model } = createMockProvider(onContext === undefined ? {} : { onContext });
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
 * Feature B (goal.txt §5): prepare the MINIMAL Pi-runtime binding for one
 * invocation. Returns an InvocationSourceBinding — session binding + epoch +
 * source identity + canonical system prompt — and NOTHING else. Context
 * assembly state (m0/m1 materialization) is never carried on the binding;
 * it is owned by ContextRenderer + persistRender (context_lineages). The
 * v12-era `materializationIdentity: "mock-m0m1-v1"` marker was removed.
 */
export function prepareContextSources(
  input: AgentInput,
  runtimeSessionId: string,
  epochId: string,
  config: AgentConfigV3,
  now: string,
): InvocationSourceBinding {
  const personaSnapshotId = "persona-default-v1";
  const declarationVersion = "decl-v1";
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
    contextSourceSnapshotId: `snapshot-${createHash("sha256").update(canonicalSystemPrompt).digest("hex").slice(0, 12)}`,
    runtimeSessionId,
    epochId,
    personaSnapshotId,
    declarationVersion,
    providerProfileId,
    canonicalSystemPrompt,
    systemProjectionHash: createHash("sha256").update(canonicalSystemPrompt).digest("hex"),
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

/**
 * R2-P1 (iris_agent#9)：确保 identity 存在 context lineage（幂等锚点）。
 * lineage 是 identity-level：一个 data root 恰好一条，跨多个 bounded Pi
 * Runtime Session 持久。首次创建时绑定当前 session；rollover 的新 session
 * 只重新绑定（bindCurrentSession），绝不创建新 lineage、绝不继承重置 m0。
 *
 * Feature B：identity 全部取自 invocation 的 Pi-runtime binding
 * （InvocationSourceBinding）——不再接受 v12-era 的 mock 物化身份。
 * materialization_id 是 lineage 的物化方案标签：真实 m0/m1 物化由
 * ContextRenderer.persistRender 提交（materializeM0/M1ByContextSeq），
 * 绑定侧从不携带物化状态。
 */
function ensureLineage(
  contextStore: ContextStore,
  runtimeSessionId: string,
  epochId: string,
  prepared: InvocationSourceBinding,
  providerProfileId: string,
): void {
  const lineageId = contextStore.lineageId;
  const existing = contextStore.getLineageByLineageId(lineageId);
  if (existing !== undefined) {
    if (existing.currentRuntimeSessionId !== runtimeSessionId) {
      contextStore.bindCurrentSession(lineageId, runtimeSessionId);
    }
    return;
  }
  contextStore.createLineage({
    lineageId,
    runtimeSessionId,
    contextSourceSnapshotId: prepared.contextSourceSnapshotId,
    epochId,
    personaSnapshotId: prepared.personaSnapshotId,
    declarationVersion: prepared.declarationVersion,
    providerProfileId,
    canonicalSystemPrompt: prepared.canonicalSystemPrompt,
    systemProjectionHash: prepared.systemProjectionHash,
    preparedAt: prepared.preparedAt,
    // Feature B: the v12-era `materializationIdentity: "mock-m0m1-v1"`
    // marker is gone. The lineage's materialization scheme is the reviewed
    // R2-P1 ContextRenderer (persistRender), never a binding-side mock.
    materializationId: "context-renderer-v1",
    contextSerializerVersion: CONTEXT_SERIALIZER_VERSION,
    carrierSchemaVersion: CONTEXT_CARRIER_SCHEMA_VERSION,
  });
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
  /** Pi receipts replayed into the RuntimeEvent ledger. */
  replayed: number;
  /** The durable identity lineage resolved for the historical session. */
  lineageId: string;
  /** Context units created/paired by the recovery ingest (lineage view). */
  units: ContextMessageUnitV1[];
  runtimeSessionId: string;
}

/**
 * iris_agent#52 Recovery Reconciler：rollover 后把旧 Runtime Session 的
 * 未提交 crash 窗口（Pi durable append + pending receipt，Iris 未 commit）
 * 恢复到其 durable identity lineage。
 *
 * 流程：
 *  1. 读取 Session 的 pending receipts（Pi 恢复证据）；
 *  2. 用 verify 过的 receipt 经 ContextStore.resolveLineageForRecovery 解析
 *     lineage（binding ledger 存在性 + checksum 完整性，fail closed）；
 *  3. 以该 lineage 构造 recovery-mode ContextIngest（按 lineage 直查，绝不把
 *     旧 Session 重新变回 current）；
 *  4. harness.recoverPendingCommitReceipts() 重放事件 → seam → RuntimeEvent
 *     ledger → Context ingest（contextSeq 在 lineage 内全局连续）。
 *
 * 旧 Session 的 raw archive attribution（runtimeSessionId）保留在事件与
 * unit 上；identity lineage 与 Runtime Session id 是两个不同的概念，本
 * reconciler 不混用。
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
      if (pending.length === 0) {
        // iris_agent#63: no pending receipt window → the Session needs no
        // further recovery resolution; mark the binding reconciled so it
        // becomes eligible for bounded-ledger reclaim.
        const emptyStore = ContextStore.open(paths.contextDb, {
          lineageId: deriveLineageId(paths.dataRoot),
        });
        try {
          emptyStore.acknowledgeSessionReconciled(options.runtimeSessionId);
        } finally {
          emptyStore.close();
        }
        return {
          replayed: 0,
          lineageId: "",
          units: [],
          runtimeSessionId: options.runtimeSessionId,
        };
      }
      const contextStore = ContextStore.open(paths.contextDb, {
        lineageId: deriveLineageId(paths.dataRoot),
      });
      try {
        // 解析必须是"已验证的绑定"：binding ledger 行 + checksum + receipt
        // 身份。任一步失败 → throw（fail closed），不 ingest 任何事件。
        const firstPending = pending[0];
        if (firstPending === undefined) {
          throw new Error(
            `reconcileHistoricalSession: pending receipts vanished between read and resolve`,
          );
        }
        const lineageId = contextStore.resolveLineageForRecovery(
          options.runtimeSessionId,
          firstPending,
        );
        const ledger = RuntimeEventLedger.open(paths.runtimeLedgerDb);
        try {
          const recoveryIngest = new ContextIngest(ledger, contextStore, lineageId, true);
          const { models, model, providerProfileId } = await composeProvider("mock");
          const currentInvocation = {
            input: sampleAgentInput(),
            prepared: prepareContextSources(
              sampleAgentInput(),
              options.runtimeSessionId,
              "recovery",
              config,
              now,
            ),
            invocationId: `reconcile-${options.runtimeSessionId}`,
          };
          const { harness } = createIrisHarness({
            session,
            instanceEpoch: 1,
            models,
            model,
            tools: [makeReadOnlyTestTool()],
            currentInvocation,
            now,
            providerProfileId,
          });
          attachRuntimeEventSeam(harness, {
            ledger,
            runtimeSessionId: options.runtimeSessionId,
            piSessionId: options.runtimeSessionId,
            contextIngest: recoveryIngest,
          });
          const replayed = await harness.recoverPendingCommitReceipts();
          // ensureUnitsUpTo is idempotent (hasUnitForEvent skips built units);
          // in recovery mode it returns the LINEAGE view (session resolution
          // would fail closed for a historical session).
          const units = recoveryIngest.ensureUnitsUpTo(options.runtimeSessionId);
          // iris_agent#63: the pending receipt window is now fully consumed —
          // mark the binding reconciled (authoritative evidence) so the
          // bounded-ledger reclaim may prune it once outside the retain
          // window. Idempotent; a crash before this point leaves the binding
          // unacknowledged and therefore never pruned.
          contextStore.acknowledgeSessionReconciled(options.runtimeSessionId);
          return { replayed, lineageId, units, runtimeSessionId: options.runtimeSessionId };
        } finally {
          ledger.close();
          epochStore.close();
        }
      } finally {
        contextStore.close();
      }
    } finally {
      await closeSessionStorage(repo);
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

/**
 * R2 (iris_agent#9)：从 data root 派生 identity-level lineage id。
 * 一个 Iris identity/data root 恰好一条 durable Context lineage；任何
 * Runtime Session(含 rollover 后的新 session)都锚定到同一 lineage。
 * 稳定、可复现：仅依赖 data root 规范化路径。
 */
export function deriveLineageId(dataRoot: string): string {
  return `identity-${createHash("sha256").update(resolve(dataRoot)).digest("hex").slice(0, 16)}`;
}

export async function runMinimalSlice(options: {
  dataRoot: string;
  config?: AgentConfigV3;
  input?: AgentInput;
  now?: string;
  provider?: SliceProviderMode;
  callbacks?: IrisHarnessCallbacks;
  /** R2-P3：ContextStore 的每 session 软 cap（测试注入极小值以在少量单元内触发
   * cap / fail-closed 路径；缺省 = MAX_UNITS_PER_SESSION，硬 cap = 2× 软 cap）。 */
  maxUnitsPerSession?: number;
  /** R3-P1：可选的 HistorianManager（Host 集成前为 opt-in，完整接线在 R3-P4）。
   * 提供时，HARD fold 提交后经 ContextHistoryReadPort 读取 lineage 物化边界并
   * 触发 HistorianManager.enqueueIncremental（m0-clamp：只有已进入 m0/m1 的
   * compartment 才可被 raw 替换）。缺省 = 不接线，本 slice 行为与 R2 完全一致
   * （byte-identical）。 */
  historianManager?: HistorianManager;
}): Promise<VerticalSliceResult> {
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
    const prepared = prepareContextSources(
      input,
      epoch.runtimeSessionId,
      epoch.epochId,
      config,
      now,
    );
    const providerContextSnapshots: string[] = [];
    const { models, model, providerProfileId } = await composeProvider(providerMode, (messages) => {
      providerContextSnapshots.push(JSON.stringify(messages));
    });
    const currentInvocation = {
      input,
      prepared,
      invocationId: `invocation-${input.inputId}`,
    };
    // R1-P1e: runtime-event ledger exactly-once 记录 Pi seam 生命周期事件。
    const ledger = RuntimeEventLedger.open(paths.runtimeLedgerDb);
    // R2-P0: ContextMessageUnit 语义 ledger（context.db）——事件提交后
    // ensureUnitsUpTo 建单元；contextController 从单元投影（不再依赖 Session）。
    // R2-P3：cap 可注入（软 cap 超限 → disposition="exclude"；硬 cap 超限 →
    // ContextBoundsExceededError 传播使本 slice 大声失败，fail-closed）。
    const contextStore = ContextStore.open(paths.contextDb, {
      lineageId: deriveLineageId(paths.dataRoot),
      ...(options.maxUnitsPerSession === undefined
        ? {}
        : { maxUnitsPerSession: options.maxUnitsPerSession }),
    });
    // R2-P1：Provider Renderer 需要 persisted lineage（m0/m1/watermark）。
    // 幂等创建；rollover 的新 session 默认获得全新 lineage。
    ensureLineage(contextStore, epoch.runtimeSessionId, epoch.epochId, prepared, providerProfileId);
    const contextIngest = new ContextIngest(ledger, contextStore, contextStore.lineageId);
    const contextRenderer = new ContextRenderer(contextStore);
    // R3-P1：freeze-trigger 接线（opt-in）。flow：HARD fold 提交 →
    // onMaterialized → 经 ContextHistoryReadPort 读取 lineage 物化边界 →
    // HistorianManager.enqueueIncremental（freeze 时以该边界 clamp eligible
    // 范围）。historianManager 缺省 = 不接线（行为与 R2 完全一致）。
    if (options.historianManager !== undefined) {
      const historyPort = createContextHistoryReadPort(contextStore);
      const historianManager = options.historianManager;
      contextRenderer.onMaterialized = (runtimeSessionId) => {
        // 端口读取为权威物化边界（values-only，跨库安全）；enqueueIncremental
        // 把 representedThroughContextSeq 传给 freeze 作为 m0-clamp 上界。
        const boundary = historyPort.getMaterializedBoundary(runtimeSessionId);
        void historianManager.enqueueIncremental(runtimeSessionId, {
          representedThroughContextSeq: boundary.representedThroughContextSeq,
        });
      };
    }
    const { harness, observers } = createIrisHarness({
      session,
      instanceEpoch: epoch.ordinalWithinDate,
      models,
      model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation,
      now,
      providerProfileId,
      callbacks: options.callbacks,
      contextIngest,
      contextRenderer,
    });
    observers.providerContextSnapshots = providerContextSnapshots;
    attachRuntimeEventSeam(harness, {
      ledger,
      runtimeSessionId: epoch.runtimeSessionId,
      piSessionId: epoch.runtimeSessionId,
      contextIngest,
    });
    const assistantMessage = await harness.prompt(encodeInputFrames(input.blocks));
    // R2-P1：prompt 完成后提交最近一次 provider render 的物化决策
    // （HARD→m0 重建 / SOFT→m1 / SOFT+→仅对齐 watermark）。now 由调用方固定，
    // 保证确定性（测试传固定时间戳）。
    const persisted = contextRenderer.persistRender(new Date(now).getTime());
    const ledgerEvents = ledger.listBySession(epoch.runtimeSessionId);
    const contextUnits = contextIngest.listUnits(epoch.runtimeSessionId);
    ledger.close();
    contextStore.close();
    const entries = await session.getEntries();
    await closeSessionStorage(repo);
    epochStore.close();
    return {
      epochId: epoch.epochId,
      runtimeSessionId: epoch.runtimeSessionId,
      observers,
      assistantMessage,
      entries,
      ledgerEvents,
      contextUnits,
      m0Body: persisted?.m0Body ?? "",
      m1Body: persisted?.m1Body ?? "",
      representedThroughContextSeq: persisted?.representedThroughContextSeq ?? 0,
      dataRoot: options.dataRoot,
    };
  } finally {
    await lock.release();
  }
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
    const prepared = prepareContextSources(
      input,
      epoch.runtimeSessionId,
      epoch.epochId,
      config,
      now,
    );
    const providerContextSnapshots: string[] = [];
    const { models, model, providerProfileId } = await composeProvider(providerMode, (messages) => {
      providerContextSnapshots.push(JSON.stringify(messages));
    });
    const currentInvocation = {
      input,
      prepared,
      invocationId: `restart-${input.inputId}`,
    };
    const { observers } = createIrisHarness({
      session,
      instanceEpoch: epoch.ordinalWithinDate,
      models,
      model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation,
      now,
      providerProfileId,
    });
    observers.providerContextSnapshots = providerContextSnapshots;
    const entries = await session.getEntries();
    await closeSessionStorage(repo);
    epochStore.close();
    return {
      runtimeSessionId: epoch.runtimeSessionId,
      observers,
      entries,
    };
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
  /**
   * Settled authorization (review blocker #3): the epoch id that reached Pi
   * settled. rollover refuses to switch unless the currently active epoch is
   * exactly this one — an arbitrary caller cannot start a rollover while an
   * invocation is still active on a different epoch.
   */
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
    // Settled-only guard: the caller must prove the epoch that settled is the
    // one currently active. Without this, any caller could roll over while an
    // invocation is still running.
    if (previous.epochId !== options.settledEpochId) {
      epochStore.close();
      throw new Error(
        `rollover refused: active epoch ${previous.epochId} is not the settled epoch ${options.settledEpochId}`,
      );
    }
    const pending = epochStore.beginRollover(now);

    // Create the new Pi Session (actually materializes a row; a test asserting
    // "fresh empty session" must find a real session, not a missing one).
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

    // R2 (iris_agent#9): rollover rotates ONLY the Pi Session/Harness archive
    // segment. The identity-level Context lineage (m0/m1/watermarks/replay
    // state) survives; we just rebind it to the new session. No new lineage,
    // no reset, no copy. Missing context.db (fresh data root) is fine — the
    // lineage will be created on the next slice run.
    const contextStore = ContextStore.open(paths.contextDb, {
      lineageId: deriveLineageId(options.dataRoot),
    });
    try {
      if (contextStore.getLineageByLineageId(contextStore.lineageId) !== undefined) {
        contextStore.bindCurrentSession(contextStore.lineageId, next.runtimeSessionId);
      }
    } finally {
      contextStore.close();
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
