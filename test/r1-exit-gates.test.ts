import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { isDshMessageRef } from "@iris/context/contracts";

import { defaultAgentConfig } from "../src/config/load.js";
import { initializeDataRoot, resolveDataRootPaths } from "../src/host/data-root.js";
import { RuntimeEpochStore } from "../src/runtime/epoch-manager.js";
import { encodeInputFrames } from "../src/runtime/companion.js";
import { createIrisHarness } from "../src/runtime/harness-factory.js";
import { assembleIrisContext } from "../src/runtime/iris-context.js";
import { IrisContextBridge } from "../src/runtime/iris-bridge.js";
import {
  closeSessionStorage,
  composeProvider,
  makeReadOnlyTestTool,
  openOrCreateSession,
  prepareInvocation,
  sampleAgentInput,
} from "../src/runtime/vertical-slice.js";
import { runMinimalSlice } from "../src/runtime/vertical-slice-demo.js";

/**
 * R1 Exit Gate 契约测试（Roadmap v13 R1）。consume-iris-context 适配：
 * Context 语义经 @iris/context ContextService（admitRuntimeMessage →
 * 统一 ContextUnit v3）提交，本地 runtime-event-ledger / seam 已废止。
 *
 *  Gate 1: Iris 正常 Provider path 不从 Session.buildContext() 构造 Context；
 *  Gate 3: user/assistant/tool_result 顺序与 exactly-once attribution 可执行
 *    验证（统一 ContextUnit：unitId 唯一、DshMessageRef.messageId 唯一、
 *    首个单元是 user）；
 *  Gate 4: 不生成 synthetic assistant/ToolResult repair（contentSchemaId
 *    只来自真实消息语义，且每个单元都映射到已提交 DSH message）。
 *  Gate 2（默认 Pi native path 兼容）由 fork 的 runtime-seams 测试覆盖。
 */

const NOW = "2026-08-05T00:00:00.000Z";

test("r1 gate1: Iris provider path never calls Session.buildContext (spy throws)", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-r1-gate1-"));
  const config = defaultAgentConfig();
  try {
    initializeDataRoot(dataRoot, config);
    const paths = resolveDataRootPaths(dataRoot, config);
    const epochStore = new RuntimeEpochStore(
      paths.epochRegistryDb,
      config.runtime_sessions.session_id_prefix,
      config.runtime_sessions.timezone,
    );
    const epoch = epochStore.ensureActive(NOW);
    const { repo, session } = await openOrCreateSession(dataRoot, config, epoch.runtimeSessionId);

    // Gate 1 spy: any buildContext() call on the Iris path must fail the slice.
    session.buildContext = (async () => {
      throw new Error("Session.buildContext() called on the Iris provider path (Gate 1)");
    }) as typeof session.buildContext;

    const { models, model, providerProfileId } = await composeProvider("mock");
    const input = sampleAgentInput();
    const binding = prepareInvocation(
      input,
      epoch.runtimeSessionId,
      epoch.epochId,
      epoch.ordinalWithinDate,
      config,
      NOW,
    );
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
      now: () => NOW,
      getCurrentSource: () => ({
        canonicalSystemPrompt: binding.canonicalSystemPrompt,
        personaSnapshotId: "persona-default-v1",
        providerProfileId,
        toolDeclarations: ["test_read_tool"],
      }),
    });
    try {
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
      const bridge = new IrisContextBridge({
        runtimeSessionId: epoch.runtimeSessionId,
        instanceEpoch: epoch.ordinalWithinDate,
        contextService: assembly.contextService,
        getInput: () => binding.input,
        now: () => NOW,
      });
      bridge.attach(harness);

      // Prompt succeeds WITHOUT ever touching buildContext (controller path).
      const assistantMessage = await harness.prompt(encodeInputFrames(input.blocks));
      assert.ok(
        typeof assistantMessage.content === "string" || Array.isArray(assistantMessage.content),
      );
      // canonical units were committed via the bridge (not via buildContext).
      const units = assembly.contextService
        .getStore()
        .listContextUnits(assembly.lineageId, { disposition: "all" });
      assert.ok(units.length >= 2, "bridge must commit canonical user/assistant units");
      bridge.close();
    } finally {
      await assembly.close();
      await closeSessionStorage(repo);
      epochStore.close();
    }
  } finally {
    // OS tmpdir 管理（不清理，避免 Windows 文件锁干扰）。
  }
});

test("r1 gate3: mock slice commits canonical units in order, exactly-once", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-r1-gate3-"));
  try {
    const result = await runMinimalSlice({
      dataRoot,
      config: defaultAgentConfig(),
      input: sampleAgentInput(),
      provider: "mock",
    });
    const units = result.contextUnits;
    assert.ok(units.length >= 2, `expected >=2 canonical units, got ${units.length}`);

    // exactly-once: unitId 唯一（同一 contextId+sourceRef 派生确定性 unitId）。
    const unitIds = new Set(units.map((unit) => unit.unitId));
    assert.equal(unitIds.size, units.length, "unitId must be unique per unit");
    // runtime-origin 单元：DshMessageRef.messageId 唯一（每条消息恰好一个单元）。
    const messageIds = new Set(
      units.map((unit) => {
        assert.ok(
          isDshMessageRef(unit.sourceRef),
          `unit ${unit.unitId} must carry a DshMessageRef sourceRef`,
        );
        return unit.sourceRef.messageId;
      }),
    );
    assert.equal(messageIds.size, units.length, "messageId must be unique per unit");

    // 顺序：listContextUnits 按 context_seq 返回；首个单元是 user。
    const first = units[0];
    assert.ok(first !== undefined, "first unit must exist");
    assert.equal(
      first.contentSchemaId,
      "iris.semantic.context_message.user.v1",
      "first canonical unit must be the user request",
    );

    // Gate 4：不生成 synthetic 单元 —— contentSchemaId 只来自真实消息语义。
    for (const unit of units) {
      assert.ok(
        unit.contentSchemaId === "iris.semantic.context_message.user.v1" ||
          unit.contentSchemaId === "iris.semantic.context_message.assistant.v1" ||
          unit.contentSchemaId === "iris.semantic.context_message.tool_result.v1",
        `unexpected synthetic unit contentSchemaId ${unit.contentSchemaId}`,
      );
    }

    // 最近一次 provider 边界必须已发布 generation（Gate 1 的 controller 路径）。
    assert.match(result.generationSummary, /^layers=\[/, "generation must be published");
  } finally {
    // OS tmpdir 管理。
  }
});

test("r1 gate4: no synthetic repair — every unit maps to a committed DSH message", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-r1-gate4-"));
  try {
    const result = await runMinimalSlice({
      dataRoot,
      config: defaultAgentConfig(),
      input: sampleAgentInput(),
      provider: "mock",
    });
    const units = result.contextUnits;

    // 每个 runtime-origin 单元必须携带稳定 DshMessageRef（sessionId+messageId）；
    // 无 synthetic 单元（无凭空生成的 assistant/toolResult）。
    for (const unit of units) {
      assert.ok(
        isDshMessageRef(unit.sourceRef),
        `unit ${unit.unitId} must carry a DshMessageRef sourceRef, got ${JSON.stringify(unit.sourceRef)}`,
      );
      assert.ok(
        unit.sourceRef.sessionId.length > 0 && unit.sourceRef.messageId.length > 0,
        `unit ${unit.unitId} DshMessageRef must have non-empty sessionId/messageId`,
      );
    }

    // tool 循环：存在 tool_result 单元时，其后必须还有 assistant 单元
    // （final turn）—— 即没有把 tool_result 当成最终回复。
    const toolIndex = units.findIndex(
      (unit) => unit.contentSchemaId === "iris.semantic.context_message.tool_result.v1",
    );
    if (toolIndex >= 0) {
      const after = units.slice(toolIndex);
      assert.ok(
        after.some((unit) => unit.contentSchemaId === "iris.semantic.context_message.assistant.v1"),
        "a committed tool_result must be followed by a final assistant unit",
      );
    }
  } finally {
    // OS tmpdir 管理。
  }
});
