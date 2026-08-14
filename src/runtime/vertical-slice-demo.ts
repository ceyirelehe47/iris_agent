// TEST/DEV vertical slice —— 消费 @iris/context 的 ContextService（Cordis）。
// 与 Host 相同的装配根（assembleIrisContext）；Pi 事件经 IrisContextBridge →
// ContextService.ingestRuntimeEvent；contextController 从 generation 渲染。
// 本文件不是生产根（生产根是 src/host + src/bin）。
import { createHash } from "node:crypto";

import type { AgentInput } from "../contracts/origin.js";
import type { AgentConfigV3 } from "../config/schema.js";
import { defaultAgentConfig } from "../config/load.js";
import { acquireDataRootLock } from "../host/lock.js";
import { initializeDataRoot, resolveDataRootPaths } from "../host/data-root.js";
import { RuntimeEpochStore } from "./epoch-manager.js";
import {
  closeSessionStorage,
  composeProvider,
  makeReadOnlyTestTool,
  openOrCreateSession,
  prepareInvocation,
  sampleAgentInput,
  type SliceProviderMode,
  type VerticalSliceResult,
} from "./vertical-slice.js";
import { assembleIrisContext } from "./iris-context.js";
import { IrisContextBridge } from "./iris-bridge.js";
import { createIrisHarness, type IrisHarnessCallbacks } from "./harness-factory.js";
import { encodeInputFrames } from "./companion.js";

export async function runMinimalSlice(options: {
  dataRoot: string;
  config?: AgentConfigV3;
  input?: AgentInput;
  now?: string;
  provider?: SliceProviderMode;
  callbacks?: IrisHarnessCallbacks;
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
      withHistorian: true,
      now: () => now,
      getCurrentSource: () => ({
        canonicalSystemPrompt: binding.canonicalSystemPrompt,
        personaSnapshotId: "persona-default-v1",
        providerProfileId,
        toolDeclarations: ["test_read_tool"],
      }),
    });
    try {
      const { harness, observers } = createIrisHarness({
        session,
        instanceEpoch: epoch.ordinalWithinDate,
        models,
        model,
        tools: [makeReadOnlyTestTool()],
        currentInvocation: binding,
        now,
        providerProfileId,
        callbacks: options.callbacks,
        irisContext: assembly.contextService,
      });
      observers.providerContextSnapshots = providerContextSnapshots;
      const bridge = new IrisContextBridge({
        runtimeSessionId: epoch.runtimeSessionId,
        instanceEpoch: epoch.ordinalWithinDate,
        contextService: assembly.contextService,
        getInput: () => binding.input,
        now: () => now,
      });
      bridge.attach(harness);
      const assistantMessage = await harness.prompt(encodeInputFrames(input.blocks));
      const contextUnits = assembly.contextService.listUnits(epoch.runtimeSessionId);
      const generation = assembly.contextService.getCurrentGeneration();
      const generationSummary =
        generation === null
          ? "no-generation"
          : `layers=[${generation.header.layerEnds.join(",")}] units=${generation.units.length}`;
      const entries = await session.getEntries();
      return {
        epochId: epoch.epochId,
        runtimeSessionId: epoch.runtimeSessionId,
        observers,
        assistantMessage,
        entries,
        contextUnits,
        generationSummary,
        dataRoot: options.dataRoot,
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
