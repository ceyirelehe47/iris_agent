/**
 * P0–P2 source holder per-invocation regression test（final review finding A）。
 *
 * `contextSourceHolder.current` 必须随每次 invocation 更新：BUST 重建的
 * generation P0–P2（provider 可见 system prompt）必须反映当前 input 的身份，
 * 而不是装配时的占位版本。本测试在同一 assembly 上连续两次 invocation，
 * 断言第二次 provider 调用的 system prompt 反映第二个 input 的 inputId
 * （且第一次反映第一个 input）。
 */
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import assert from "node:assert/strict";

import { defaultAgentConfig } from "../src/config/load.js";
import { initializeDataRoot, resolveDataRootPaths } from "../src/host/data-root.js";
import { RuntimeEpochStore } from "../src/runtime/epoch-manager.js";
import { prepareInvocation, openOrCreateSession } from "../src/runtime/vertical-slice.js";
import { assembleIrisContext, type CurrentContextSource } from "../src/runtime/iris-context.js";
import { createIrisHarness } from "../src/runtime/harness-factory.js";
import { IrisContextBridge } from "../src/runtime/iris-bridge.js";
import { PiRuntimeAdapter } from "../src/runtime/pi-runtime-adapter.js";
import {
  ActiveRuntimeRegistry,
  activeRuntimeHandle,
} from "../src/runtime/active-runtime-registry.js";
import { RuntimeCoordinator } from "../src/runtime/runtime-coordinator.js";
import { createMockProvider } from "../src/runtime/mock-provider.js";
import { makeReadOnlyTestTool } from "../src/runtime/vertical-slice.js";
import { directUserRequest } from "../src/contracts/origin.js";
import type { AgentInput } from "../src/contracts/origin.js";

function makeInput(inputId: string): AgentInput {
  return {
    inputId,
    triggerOrigin: directUserRequest(),
    blocks: [
      {
        blockId: `block-${inputId}`,
        sourceOrigin: directUserRequest(),
        content: { mode: "inline_text", text: `hello ${inputId}` },
        contentHash: "",
      },
    ],
  };
}

const openAssemblies: Array<{ close(): Promise<void> }> = [];
after(async () => {
  for (const assembly of openAssemblies) {
    await assembly.close().catch(() => undefined);
  }
  openAssemblies.length = 0;
});

test("P0-P2 source holder updates per invocation: system prompt reflects each input identity", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-p0-invocation-"));
  const config = defaultAgentConfig();
  const now = "2026-08-01T00:00:00.000Z";
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);
  const epochStore = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const epoch = epochStore.ensureActive(now);

  // Mutable P0–P2 source holder (mirrors host.ts wiring + the final-review fix).
  const contextSourceHolder: { current: CurrentContextSource } = {
    current: {
      canonicalSystemPrompt: "placeholder",
      personaSnapshotId: "persona-default-v1",
      providerProfileId: "mock-iris-provider-v1",
      toolDeclarations: ["test_read_tool"],
    },
  };

  const sessionHandle = await openOrCreateSession(dataRoot, config, epoch.runtimeSessionId);
  const assembly = await assembleIrisContext({
    dataRoot: paths.dataRoot,
    runtimeSessionId: epoch.runtimeSessionId,
    providerProfileId: "mock-iris-provider-v1",
    canonicalSystemPrompt: contextSourceHolder.current.canonicalSystemPrompt,
    systemProjectionHash: createHash("sha256")
      .update(contextSourceHolder.current.canonicalSystemPrompt)
      .digest("hex"),
    preparedAt: now,
    withHistorian: false,
    now: () => now,
    getCurrentSource: () => contextSourceHolder.current,
  });
  openAssemblies.push(assembly);

  const { models, model } = createMockProvider();
  const first = prepareInvocation(
    makeInput("inv-A"),
    epoch.runtimeSessionId,
    epoch.epochId,
    epoch.ordinalWithinDate,
    config,
    now,
  );
  contextSourceHolder.current = {
    canonicalSystemPrompt: first.canonicalSystemPrompt,
    personaSnapshotId: "persona-default-v1",
    providerProfileId: first.providerProfileId,
    toolDeclarations: ["test_read_tool"],
  };
  const currentInvocation = { ...first };
  const { harness, observers } = createIrisHarness({
    session: sessionHandle.session,
    instanceEpoch: epoch.ordinalWithinDate,
    models,
    model,
    tools: [makeReadOnlyTestTool()],
    currentInvocation,
    now,
    providerProfileId: "mock-iris-provider-v1",
    irisContext: assembly.contextService,
  });
  const bridge = new IrisContextBridge({
    runtimeSessionId: epoch.runtimeSessionId,
    instanceEpoch: epoch.ordinalWithinDate,
    contextService: assembly.contextService,
    getInput: () => currentInvocation.input,
    now: () => now,
  });
  bridge.attach(harness);
  const adapter = new PiRuntimeAdapter({
    harness,
    session: sessionHandle.session,
    binding: currentInvocation,
    repo: sessionHandle.repo,
  });
  const registry = new ActiveRuntimeRegistry();
  registry.install(activeRuntimeHandle(epoch, adapter, currentInvocation));

  // Coordinator whose prepareInvocation ALSO refreshes the holder (host fix).
  const coordinator = new RuntimeCoordinator({
    activeRuntime: registry,
    prepareInvocation: async (input: AgentInput, runtimeSessionId: string, epochId: string) => {
      const binding = prepareInvocation(
        input,
        runtimeSessionId,
        epochId,
        epoch.ordinalWithinDate,
        config,
        now,
      );
      contextSourceHolder.current = {
        canonicalSystemPrompt: binding.canonicalSystemPrompt,
        personaSnapshotId: "persona-default-v1",
        providerProfileId: binding.providerProfileId,
        toolDeclarations: ["test_read_tool"],
      };
      // Also keep the harness binding in sync (same object the bridge reads).
      currentInvocation.input = input;
      currentInvocation.invocationId = `invocation-${input.inputId}`;
      currentInvocation.canonicalSystemPrompt = binding.canonicalSystemPrompt;
      currentInvocation.providerProfileId = binding.providerProfileId;
      currentInvocation.preparedAt = binding.preparedAt;
      return binding;
    },
  });

  // First invocation: input "inv-A".
  for await (const event of coordinator.prompt(makeInput("inv-A"))) {
    void event;
  }
  const promptsAfterFirst = [...observers.systemPromptValues];
  assert.ok(
    promptsAfterFirst.some((p) => p.includes("inputId: inv-A")),
    "first invocation system prompt must reflect input inv-A (got: " +
      JSON.stringify(promptsAfterFirst) +
      ")",
  );

  // Second invocation: input "inv-B" — the system prompt MUST change.
  for await (const event of coordinator.prompt(makeInput("inv-B"))) {
    void event;
  }
  const promptsAfterSecond = [...observers.systemPromptValues];
  assert.ok(
    promptsAfterSecond.some((p) => p.includes("inputId: inv-B")),
    "second invocation system prompt must reflect input inv-B (got: " +
      JSON.stringify(promptsAfterSecond) +
      ")",
  );
  // The holder must now carry inv-B's identity.
  assert.ok(
    contextSourceHolder.current.canonicalSystemPrompt.includes("inputId: inv-B"),
    "holder.current must be refreshed per invocation",
  );

  await sessionHandle.repo[Symbol.asyncDispose]();
  epochStore.close();
});
