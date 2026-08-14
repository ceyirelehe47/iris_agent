// NOT PRODUCTION — Test/dev vertical slice. Imports context-renderer
// (MIGRATION ONLY per Notion v27). NOT imported by any production root; the
// architecture gate proves this file is unreachable from src/host + src/bin.
import {
  CONTEXT_CARRIER_SCHEMA_VERSION,
  CONTEXT_SERIALIZER_VERSION,
  ContextRenderer,
} from "../context/context-renderer.js";
import { ContextStore } from "../context/context-store.js";
import { ContextIngest } from "../context/context-ingest.js";
import { createContextHistoryReadPort } from "../context/history-read-port.js";
import { RuntimeEventLedger } from "./runtime-event-ledger.js";
import { attachRuntimeEventSeam } from "./runtime-event-seam.js";
import { encodeInputFrames } from "./companion.js";
import { createIrisHarness } from "./harness-factory.js";
import type { HistorianManager } from "../historian/historian-manager.js";
import type { AgentInput } from "../contracts/origin.js";
import type { InvocationSourceBinding } from "../contracts/context.js";
import type { AgentConfigV3 } from "../config/schema.js";
import { defaultAgentConfig } from "../config/load.js";
import { acquireDataRootLock } from "../host/lock.js";
import { initializeDataRoot, resolveDataRootPaths } from "../host/data-root.js";
import { RuntimeEpochStore } from "./epoch-manager.js";
import {
  closeSessionStorage,
  composeProvider,
  deriveLineageId,
  makeReadOnlyTestTool,
  openOrCreateSession,
  prepareContextSources,
  sampleAgentInput,
  type SliceProviderMode,
  type VerticalSliceResult,
} from "./vertical-slice.js";

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

export async function runMinimalSlice(options: {
  dataRoot: string;
  config?: AgentConfigV3;
  input?: AgentInput;
  now?: string;
  provider?: SliceProviderMode;
  callbacks?: import("./harness-factory.js").IrisHarnessCallbacks;
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
