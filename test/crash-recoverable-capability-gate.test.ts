import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { Session } from "@iris/pi-agent-core";
import type { ContextService } from "@iris/context";

import { defaultAgentConfig } from "../src/config/load.js";
import { initializeDataRoot, resolveDataRootPaths } from "../src/host/data-root.js";
import { RuntimeEpochStore } from "../src/runtime/epoch-manager.js";
import { createIrisHarness } from "../src/runtime/harness-factory.js";
import { assembleIrisContext } from "../src/runtime/iris-context.js";
import {
  closeSessionStorage,
  composeProvider,
  makeReadOnlyTestTool,
  openOrCreateSession,
  prepareInvocation,
  sampleAgentInput,
} from "../src/runtime/vertical-slice.js";

/**
 * iris_agent#51 production capability gate: the Iris harness requires a
 * session storage with crash-recoverable commit receipts (the production lock
 * mandates the SQLite session repository). A session without the durability
 * capability must fail closed at harness construction.
 *
 * 适配说明（consume-iris-context）：`CreateIrisHarnessOptions` 现在要求
 * `irisContext: ContextService`（@iris/context）。门禁检查发生在 harness
 * 构造的最前面（不依赖 irisContext），但测试仍装配真实 @iris/context 装配，
 * 保证该选项在真实路径下可用。
 */

const NOW = "2026-08-05T00:00:00.000Z";

test("capability gate: the production SQLite session satisfies crash-recoverable receipts", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-gate-ok-"));
  initializeDataRoot(dataRoot, defaultAgentConfig());
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  const epochStore = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const epoch = epochStore.ensureActive(NOW);
  const { repo, session } = await openOrCreateSession(dataRoot, config, epoch.runtimeSessionId);
  let assembly: Awaited<ReturnType<typeof assembleIrisContext>> | null = null;
  try {
    const { models, model, providerProfileId } = await composeProvider("mock");
    const binding = prepareInvocation(
      sampleAgentInput(),
      epoch.runtimeSessionId,
      epoch.epochId,
      epoch.ordinalWithinDate,
      config,
      NOW,
    );
    assembly = await assembleIrisContext({
      dataRoot: paths.dataRoot,
      runtimeSessionId: epoch.runtimeSessionId,
      providerProfileId,
      canonicalSystemPrompt: binding.canonicalSystemPrompt,
      systemProjectionHash: binding.canonicalSystemPrompt,
      preparedAt: binding.preparedAt,
      withHistorian: true,
      now: () => NOW,
      getCurrentSource: () => ({
        canonicalSystemPrompt: binding.canonicalSystemPrompt,
        personaSnapshotId: "persona-default-v1",
        providerProfileId,
        toolDeclarations: ["test_read_tool"],
      }),
    });
    // Must NOT throw: SQLite journal is crash-recoverable.
    const { harness } = createIrisHarness({
      session,
      instanceEpoch: epoch.ordinalWithinDate,
      models,
      model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation: binding,
      now: NOW,
      providerProfileId,
      irisContext: assembly.contextService,
    });
    assert.ok(harness);
  } finally {
    await assembly?.close();
    epochStore.close();
    await closeSessionStorage(repo);
  }
});

test("capability gate: a session without the durability capability fails closed", () => {
  const withoutCapability = {
    supportsCrashRecoverableReceipts: () => false,
  } as unknown as Session;
  // 门禁检查先于 irisContext 使用即抛错；此处的 irisContext 是 stub（mock），
  // 不会被触达（harness 构造在 capability gate 处失败）。
  const irisContextStub = {} as ContextService;
  assert.throws(
    () =>
      createIrisHarness({
        session: withoutCapability,
        instanceEpoch: 1,
        models: undefined as never,
        model: undefined as never,
        tools: [],
        currentInvocation: undefined as never,
        now: NOW,
        providerProfileId: "test",
        irisContext: irisContextStub,
      }),
    /crash-recoverable commit receipts/,
  );
});
