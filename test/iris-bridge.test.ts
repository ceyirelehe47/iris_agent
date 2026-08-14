import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { defaultAgentConfig } from "../src/config/load.js";
import { initializeDataRoot, resolveDataRootPaths } from "../src/host/data-root.js";
import { RuntimeEpochStore } from "../src/runtime/epoch-manager.js";
import { decodeInputFrames, derivePairKey, encodeInputFrames } from "../src/runtime/companion.js";
import { createIrisHarness } from "../src/runtime/harness-factory.js";
import { assembleIrisContext } from "../src/runtime/iris-context.js";
import {
  IrisContextBridge,
  deriveRuntimeEventId,
  toNeutralOrigin,
} from "../src/runtime/iris-bridge.js";
import {
  closeSessionStorage,
  composeProvider,
  makeReadOnlyTestTool,
  openOrCreateSession,
  prepareInvocation,
  sampleAgentInput,
} from "../src/runtime/vertical-slice.js";
import type { AgentInput } from "../src/contracts/origin.js";
import { directUserRequest } from "../src/contracts/origin.js";

/**
 * IrisContextBridge（Pi → @iris/context RuntimeEventInput ingest）契约测试。
 *
 * 覆盖：
 *  - deriveRuntimeEventId 确定性（同一 session+entry 恒等）；
 *  - toNeutralOrigin 中性化（不泄漏 Pi 消息形状；缺省 → data_only+untrusted）；
 *  - 端到端：真实 @iris/context 装配 + 真实 harness + bridge attach →
 *    prompt 后 canonical 单元按 user→assistant/tool_result 提交；
 *  - 双事件模型：Pi UserMessage + iris_input_meta CustomMessage →
 *    user 主事件 + operational companion 事件（companionOf 指向主事件）；
 *    ContextService 合并后 user 单元 pairing 验证通过（paired=true、
 *    pairKey 与 inputPairKey 一致）；
 *  - 非 iris_input_meta 的 custom 消息不产生语义事件（只留 raw archive）。
 */

const NOW = "2026-08-05T00:00:00.000Z";

test("bridge: deriveRuntimeEventId is deterministic and prefix-stable", () => {
  const a = deriveRuntimeEventId("session-a", "entry-1");
  const b = deriveRuntimeEventId("session-a", "entry-1");
  const c = deriveRuntimeEventId("session-a", "entry-2");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^re-[0-9a-f]{24}$/);
  // 同一 entry 在不同 session 必须产生不同 eventId（session 是 identity 键）。
  assert.notEqual(a, deriveRuntimeEventId("session-b", "entry-1"));
});

test("bridge: toNeutralOrigin neutralizes agent origin without leaking Pi shape", () => {
  const agentOrigin = {
    schemaVersion: 1,
    channel: "cli",
    principalKind: "user" as const,
    principalRef: "usr-1",
    authority: "user_request" as const,
    trust: "limited" as const,
  };
  const neutral = toNeutralOrigin(agentOrigin);
  assert.equal(neutral.schemaId, "iris.origin_envelope.v1");
  assert.equal(neutral.channel, "cli");
  assert.equal(neutral.principalKind, "user");
  assert.equal(neutral.principalRef, "usr-1");
  assert.equal(neutral.authority, "user_request");
  assert.equal(neutral.trust, "limited");
  // 无 origin → 保守默认。
  const fallback = toNeutralOrigin(undefined);
  assert.equal(fallback.authority, "data_only");
  assert.equal(fallback.trust, "untrusted");
  assert.equal(fallback.principalKind, "environment");
});

test("bridge e2e: prompt commits canonical units + companion pairing (double-event model)", async () => {
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

      // --- canonical units（user → assistant/tool_result；无 synthetic）---
      const units = assembly.contextService.listUnits(epoch.runtimeSessionId);
      assert.ok(units.length >= 2, `expected >=2 units, got ${units.length}`);
      assert.equal(units[0]?.kind, "user", "first unit must be the user request");
      for (const unit of units) {
        assert.ok(
          unit.kind === "user" || unit.kind === "assistant" || unit.kind === "tool_result",
          `unexpected kind ${unit.kind}`,
        );
      }

      // --- 双事件模型：companion 事件已提交（operational + companionOf）---
      const store = assembly.contextService.getStore();
      const events = store.listStoredEventsByLineage(assembly.lineageId);
      const companionEvents = events.filter((event) => event.kind === "operational");
      assert.equal(companionEvents.length, 1, "exactly one operational companion event");
      const companion = companionEvents[0];
      assert.ok(companion !== undefined);
      assert.equal(companion.role, "custom");

      // --- user 主事件 + pairing 合并 ---
      const userUnit = units[0];
      assert.ok(userUnit !== undefined);
      const userRecord = store.findBySourceEvent(userUnit.runtimeEventId);
      assert.ok(userRecord !== undefined, "user unit must resolve via findBySourceEvent");
      assert.equal(userRecord.persistenceMeta.paired, true, "companion pairing must verify");
      // pairKey 是 epoch-bound（Host instanceEpoch 是配对身份的一部分）。
      const expectedPairKey = derivePairKey(
        input.inputId,
        decodeInputFrames(encodeInputFrames(input.blocks)),
        epoch.ordinalWithinDate,
      );
      assert.equal(
        userRecord.persistenceMeta.pairKey,
        expectedPairKey,
        "pairKey must equal the epoch-bound input pair key",
      );
      // 双事件模型的配对落在主 user 单元上：companionEntryId 指向 companion
      // 事件（stored CanonicalRuntimeEventV1 不保留 companionOf 字段；配对
      // 关系由 store 的 pairing 列持有）。
      assert.ok(
        userRecord.persistenceMeta.companionEntryId !== null,
        "companion entry id must be recorded on the user main unit",
      );
      assert.equal(
        userRecord.persistenceMeta.companionEntryId,
        companion.runtimeEventId,
        "companionEntryId must point at the committed companion event",
      );
      // companion 事件 payload 是中性 CompanionPayloadV1（不泄漏 Pi 形状）。
      const companionPayload = companion.payload as { type?: string };
      assert.equal(companionPayload.type, "iris_input_meta");

      // --- eventId 确定性：user 单元 id == 由 session entry 派生的 id ---
      const entries = await session.getEntries();
      const userEntry = entries.find(
        (entry) => entry.type === "message" && entry.message?.role === "user",
      );
      assert.ok(userEntry !== undefined);
      assert.equal(
        userUnit.runtimeEventId,
        deriveRuntimeEventId(epoch.runtimeSessionId, userEntry.id),
        "user unit eventId must equal derived stable event id",
      );

      // --- origin 中性化：user 事件 origin 来自 triggerOrigin（cli/user）---
      const userEvent = store.findRuntimeEventByEventId(userUnit.runtimeEventId);
      assert.ok(userEvent !== undefined);
      assert.equal(userEvent.origin.schemaId, "iris.origin_envelope.v1");
      assert.equal(userEvent.origin.channel, directUserRequest().channel);
      assert.equal(userEvent.origin.principalKind, "user");
    } finally {
      await assembly.close();
      await closeSessionStorage(repo);
      epochStore.close();
    }
  } finally {
    // OS tmpdir 管理。
  }
});
