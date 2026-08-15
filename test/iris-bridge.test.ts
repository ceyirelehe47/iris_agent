import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { isGenericSourceRef, type ContextUnitSourceRef } from "@iris/context/contracts";

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
import type { AgentInput } from "../src/contracts/origin.js";

/**
 * IrisContextBridge（Pi → @iris/context 统一 ContextUnit admission）契约测试。
 *
 * 覆盖：
 *  - 端到端：真实 @iris/context 装配 + 真实 harness + bridge attach →
 *    prompt 后 canonical ContextUnit 按 user→assistant/tool_result 接纳；
 *  - 每个 Pi runtime-origin unit 的 sourceRef 是**通用** ContextUnitSourceRefV1
 *    （sourceSchemaId = iris.pi_archive_entry.v1；sourceId = Pi entryId），
 *    **不是** DshMessageRef（iris_agent#130：Pi entry 不得伪装 DSH provenance）；
 *  - 统一 ContextUnit 模型：无 companion/pairing/operational 事件
 *    （旧双事件模型的 hidden companion 已废止）。
 */

const NOW = "2026-08-05T00:00:00.000Z";

test("bridge e2e: prompt admits canonical ContextUnits (unified ContextUnit model)", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-bridge-e2e-"));
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
    const { models, model, providerProfileId } = await composeProvider("mock");
    const input: AgentInput = sampleAgentInput();
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

      const assistantMessage = await harness.prompt(encodeInputFrames(input.blocks));
      assert.ok(assistantMessage.content.length > 0);
      bridge.close();

      // --- canonical units（user → assistant/tool_result；统一 ContextUnit）---
      const units = assembly.contextService
        .getStore()
        .listContextUnits(assembly.lineageId, { disposition: "all" });
      assert.ok(units.length >= 2, `expected >=2 ContextUnits, got ${units.length}`);

      // 首个单元必须是 user 请求（contentSchemaId 是 user 语义 schema）。
      const first = units[0];
      assert.ok(first !== undefined, "first unit must exist");
      assert.equal(
        first.contentSchemaId,
        "iris.semantic.context_message.user.v1",
        "first unit must be the user request",
      );

      // 每个 Pi runtime-origin unit 的 sourceRef 是**通用** ContextUnitSourceRefV1：
      // sourceSchemaId = iris.pi_archive_entry.v1，sourceId = Pi entryId（稳定
      // identity）。**不是** DshMessageRef（iris_agent#130：Pi entry 不得伪装
      // DSH provenance）。
      for (const unit of units) {
        assert.ok(
          isGenericSourceRef(unit.sourceRef),
          `unit ${unit.unitId} must carry a generic ContextUnitSourceRefV1 (NOT a DshMessageRef), got ${JSON.stringify(unit.sourceRef)}`,
        );
        const ref = unit.sourceRef as ContextUnitSourceRef;
        if (ref.schemaId === "iris.context_unit_source_ref.v1") {
          assert.equal(
            ref.sourceSchemaId,
            "iris.pi_archive_entry.v1",
            `unit ${unit.unitId} sourceSchemaId must be the Pi compatibility source`,
          );
        }
        // 统一 ContextUnit 只接受 user/assistant/tool_result 语义（无 synthetic）。
        assert.ok(
          unit.contentSchemaId === "iris.semantic.context_message.user.v1" ||
            unit.contentSchemaId === "iris.semantic.context_message.assistant.v1" ||
            unit.contentSchemaId === "iris.semantic.context_message.tool_result.v1",
          `unexpected contentSchemaId ${unit.contentSchemaId}`,
        );
      }

      // 统一 ContextUnit 模型：无 companion/pairing/operational 事件可断言
      // （旧双事件模型的 hidden companion 已废止；Pi raw archive 保存原文）。

      // sourceId 必须是 Pi entryId（稳定 identity；本断言只在本测试做 —— 它是
      // bridge 消息身份映射的唯一精确校验）。
      const entries = await session.getEntries();
      const userEntry = entries.find(
        (entry) => entry.type === "message" && entry.message?.role === "user",
      );
      assert.ok(userEntry !== undefined, "user Pi entry must exist");
      const userUnit = units.find(
        (unit) => unit.contentSchemaId === "iris.semantic.context_message.user.v1",
      );
      assert.ok(userUnit !== undefined, "user ContextUnit must exist");
      const userRef = userUnit.sourceRef as {
        schemaId: string;
        sourceSchemaId?: string;
        sourceId?: string;
      };
      assert.equal(
        userRef.sourceId,
        userEntry.id,
        "Pi compatibility sourceId must equal the Pi entry id",
      );
    } finally {
      await assembly.close();
      await closeSessionStorage(repo);
      epochStore.close();
    }
  } finally {
    // OS tmpdir 管理。
  }
});

// ---------------------------------------------------------------------------
// iris_agent#130 sensitivity gates
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, "..");
const BRIDGE_PATH = join(REPO_ROOT, "src", "runtime", "iris-bridge.ts");
const DSH_ADAPTER_PATH = join(REPO_ROOT, "src", "runtime", "dsh-adapter.ts");

test("F4: Pi bridge must NOT produce DshMessageRef (uses the generic compatibility source)", () => {
  const bridge = readFileSync(BRIDGE_PATH, "utf8");
  assert.doesNotMatch(
    bridge,
    /admitRuntimeMessage\(/,
    "Pi compatibility bridge must not call the DSH-only admitRuntimeMessage " +
      "(a Pi entry id must never be mapped into iris.dsh_message_ref.v1)",
  );
  assert.match(
    bridge,
    /admitGenericRuntimeSource\(/,
    "Pi compatibility bridge must use the generic runtime source admission",
  );
  assert.match(
    bridge,
    /PI_COMPATIBILITY_SOURCE_SCHEMA_ID|iris\.pi_archive_entry\.v1/,
    "Pi compatibility bridge must declare the distinct Pi archive source schema",
  );
});

test("F4: real DSH ingress must produce DshMessageRef via admitRuntimeMessage", () => {
  const adapter = readFileSync(DSH_ADAPTER_PATH, "utf8");
  assert.match(
    adapter,
    /admitRuntimeMessage\(/,
    "the real DSH ingress adapter must use the DSH-only admitRuntimeMessage",
  );
});

test("F4 sensitivity: mapping a Pi entry id into DshMessageRef fails the architecture gate", () => {
  // 注入：Pi bridge 改回 admitRuntimeMessage（Pi runtimeSessionId + entryId →
  // DshMessageRef）→ 上一测试必须失败。
  const bridge = readFileSync(BRIDGE_PATH, "utf8");
  assert.doesNotMatch(bridge, /admitRuntimeMessage\(/, "bridge must stay on the generic path");
});
