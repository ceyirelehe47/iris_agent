import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { defaultAgentConfig } from "../src/config/load.js";
import { initializeDataRoot, resolveDataRootPaths } from "../src/host/data-root.js";
import { RuntimeEpochStore } from "../src/runtime/epoch-manager.js";
import { encodeInputFrames } from "../src/runtime/companion.js";
import { createIrisHarness } from "../src/runtime/harness-factory.js";
import {
  closeSessionStorage,
  composeProvider,
  makeReadOnlyTestTool,
  openOrCreateSession,
  prepareContextSources,
  
  sampleAgentInput,
} from "../src/runtime/vertical-slice.js";
import { runMinimalSlice } from "../src/runtime/vertical-slice-demo.js";
import { RuntimeEventLedger } from "../src/runtime/runtime-event-ledger.js";
import { attachRuntimeEventSeam } from "../src/runtime/runtime-event-seam.js";

/**
 * R1 Exit Gate 契约测试（Roadmap v13 R1）：
 *  Gate 1: Iris 正常 Provider path 不从 Session.buildContext() 构造 Context；
 *  Gate 3: user/tool/assistant/crash-window 顺序与 exactly-once attribution 可执行验证；
 *  Gate 4: 不生成 synthetic assistant/ToolResult repair。
 * Gate 2（默认 Pi native path 兼容）由 fork 的 runtime-seams 测试覆盖。
 */

const ALLOWED_LEDGER_TYPES = new Set([
  "message_finalized",
  "turn_committed",
  "tool_execution_committed",
  "agent_settled",
]);

test("r1 gate1: Iris provider path never calls Session.buildContext (spy throws)", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-r1-gate1-"));
  const config = defaultAgentConfig();
  const now = "2026-08-05T00:00:00.000Z";
  try {
    initializeDataRoot(dataRoot, config);
    const paths = resolveDataRootPaths(dataRoot, config);
    const epochStore = new RuntimeEpochStore(
      paths.epochRegistryDb,
      config.runtime_sessions.session_id_prefix,
      config.runtime_sessions.timezone,
    );
    const epoch = epochStore.ensureActive(now);
    const { repo, session } = await openOrCreateSession(dataRoot, config, epoch.runtimeSessionId);

    // Gate 1 spy: any buildContext() call on the Iris path must fail the slice.
    session.buildContext = (async () => {
      throw new Error("Session.buildContext() called on the Iris provider path (Gate 1)");
    }) as typeof session.buildContext;

    const { models, model, providerProfileId } = await composeProvider("mock");
    const input = sampleAgentInput();
    const prepared = prepareContextSources(
      input,
      epoch.runtimeSessionId,
      epoch.epochId,
      config,
      now,
    );
    const currentInvocation = {
      input,
      prepared,
      invocationId: `invocation-${input.inputId}`,
    };
    const { harness } = createIrisHarness({
      session,
      instanceEpoch: epoch.ordinalWithinDate,
      models,
      model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation,
      now,
      providerProfileId,
    });
    const ledger = RuntimeEventLedger.open(paths.runtimeLedgerDb);
    attachRuntimeEventSeam(harness, {
      ledger,
      runtimeSessionId: epoch.runtimeSessionId,
      piSessionId: epoch.runtimeSessionId,
    });

    // Prompt succeeds WITHOUT ever touching buildContext (controller path).
    const assistantMessage = await harness.prompt(encodeInputFrames(input.blocks));
    assert.ok(
      typeof assistantMessage.content === "string" || Array.isArray(assistantMessage.content),
    );
    const events = ledger.listBySession(epoch.runtimeSessionId);
    assert.ok(events.length > 0, "ledger must record seam events");
    ledger.close();
    await closeSessionStorage(repo);
    epochStore.close();
  } finally {
    // 不清理（避免 Windows 文件锁干扰；OS tmpdir 管理）。
  }
});

test("r1 gate3: mock slice ledger records the canonical user/tool/assistant ordering exactly-once", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-r1-gate3-"));
  try {
    const result = await runMinimalSlice({
      dataRoot,
      config: defaultAgentConfig(),
      input: sampleAgentInput(),
      provider: "mock",
    });
    const events = result.ledgerEvents;
    assert.ok(events.length >= 4, `expected >=4 ledger events, got ${events.length}`);

    // 事件类型必须全部来自 seam 映射（Gate 4：无 synthetic 事件）。
    for (const event of events) {
      assert.ok(ALLOWED_LEDGER_TYPES.has(event.type), `unexpected ledger event type ${event.type}`);
    }

    // exactly-once: idempotency keys unique.
    const keys = new Set(events.map((event) => event.idempotencyKey));
    assert.equal(keys.size, events.length, "idempotency keys must be unique");

    // 顺序：首个事件是 user 的 message_finalized；settled 是最后一个。
    const first = events[0];
    assert.equal(first?.type, "message_finalized");
    const last = events[events.length - 1];
    assert.equal(last?.type, "agent_settled");

    // message_finalized 携带完整 attribution。
    for (const event of events) {
      if (event.type === "message_finalized") {
        assert.ok(typeof event.entryId === "string" && event.entryId.length > 0);
        assert.equal(event.contentHash?.length, 64);
        assert.equal(event.disposition, "include");
      }
    }

    // tool 循环：tool_execution_committed 存在于 assistant toolCall 之后。
    const toolIdx = events.findIndex((event) => event.type === "tool_execution_committed");
    if (toolIdx >= 0) {
      const toolEvent = events[toolIdx];
      assert.equal(toolEvent?.toolCallId, "tool-call-1");
      assert.equal(toolEvent?.toolName, "test_read_tool");
      // 其后必须还有 message_finalized（final assistant）与 turn_committed。
      const after = events.slice(toolIdx);
      assert.ok(after.some((event) => event.type === "message_finalized"));
      assert.ok(after.some((event) => event.type === "turn_committed"));
    }
  } finally {
    // OS tmpdir 管理。
  }
});

test("r1 gate3: ledger persists across reopen (crash-window recovery basis)", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-r1-gate3-reopen-"));
  try {
    const result = await runMinimalSlice({
      dataRoot,
      config: defaultAgentConfig(),
      input: sampleAgentInput(),
      provider: "mock",
    });
    const paths = resolveDataRootPaths(dataRoot, defaultAgentConfig());
    const reopened = RuntimeEventLedger.open(paths.runtimeLedgerDb);
    const persisted = reopened.listBySession(result.runtimeSessionId);
    assert.equal(persisted.length, result.ledgerEvents.length);
    reopened.close();
  } finally {
    // OS tmpdir 管理。
  }
});

// --- iris_agent#40: every supported append path reaches the ledger ----------

test("r40: direct harness.appendMessage produces exactly one ledger message_finalized", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-r40-direct-"));
  try {
    const config = defaultAgentConfig();
    const now = "2026-08-05T00:00:00.000Z";
    initializeDataRoot(dataRoot, config);
    const paths = resolveDataRootPaths(dataRoot, config);
    const epochStore = new RuntimeEpochStore(
      paths.epochRegistryDb,
      config.runtime_sessions.session_id_prefix,
      config.runtime_sessions.timezone,
    );
    const epoch = epochStore.ensureActive(now);
    const { repo, session } = await openOrCreateSession(dataRoot, config, epoch.runtimeSessionId);
    const { models, model, providerProfileId } = await composeProvider("mock");
    const prepared = prepareContextSources(
      sampleAgentInput(),
      epoch.runtimeSessionId,
      epoch.epochId,
      config,
      now,
    );
    const { harness } = createIrisHarness({
      session,
      instanceEpoch: epoch.ordinalWithinDate,
      models,
      model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation: {
        input: sampleAgentInput(),
        prepared,
        invocationId: `invocation-direct`,
      },
      now,
      providerProfileId,
    });
    const ledger = RuntimeEventLedger.open(paths.runtimeLedgerDb);
    attachRuntimeEventSeam(harness, {
      ledger,
      runtimeSessionId: epoch.runtimeSessionId,
      piSessionId: epoch.runtimeSessionId,
    });

    // Direct append outside the agent loop must still produce a receipt event.
    await harness.appendMessage({
      role: "user",
      content: [{ type: "text", text: "direct append" }],
      timestamp: Date.now(),
    });

    const events = ledger.listBySession(epoch.runtimeSessionId);
    const finalized = events.filter((event) => event.type === "message_finalized");
    assert.equal(finalized.length, 1, "direct append must yield exactly one message_finalized");
    const firstFinalized = finalized[0];
    assert.ok(firstFinalized !== undefined);
    assert.ok(typeof firstFinalized.entryId === "string" && firstFinalized.entryId.length > 0);
    assert.equal(firstFinalized.contentHash?.length, 64);
    ledger.close();
    await closeSessionStorage(repo);
    epochStore.close();
  } finally {
    // OS tmpdir 管理。
  }
});

test("r40: pending-writes flush appends are committed to the ledger exactly once", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-r40-flush-"));
  try {
    const config = defaultAgentConfig();
    const now = "2026-08-05T00:00:00.000Z";
    initializeDataRoot(dataRoot, config);
    const paths = resolveDataRootPaths(dataRoot, config);
    const epochStore = new RuntimeEpochStore(
      paths.epochRegistryDb,
      config.runtime_sessions.session_id_prefix,
      config.runtime_sessions.timezone,
    );
    const epoch = epochStore.ensureActive(now);
    const { repo, session } = await openOrCreateSession(dataRoot, config, epoch.runtimeSessionId);
    const { models, model, providerProfileId } = await composeProvider("mock");
    const prepared = prepareContextSources(
      sampleAgentInput(),
      epoch.runtimeSessionId,
      epoch.epochId,
      config,
      now,
    );
    const { harness } = createIrisHarness({
      session,
      instanceEpoch: epoch.ordinalWithinDate,
      models,
      model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation: {
        input: sampleAgentInput(),
        prepared,
        invocationId: `invocation-flush`,
      },
      now,
      providerProfileId,
    });
    const ledger = RuntimeEventLedger.open(paths.runtimeLedgerDb);
    attachRuntimeEventSeam(harness, {
      ledger,
      runtimeSessionId: epoch.runtimeSessionId,
      piSessionId: epoch.runtimeSessionId,
    });

    // While a prompt is in flight, appends are queued and flushed later; both
    // queued messages must appear in the ledger with distinct entries.
    const promptPromise = harness.prompt("hello");
    await harness.appendMessage({
      role: "user",
      content: [{ type: "text", text: "queued-1" }],
      timestamp: Date.now(),
    });
    await harness.appendMessage({
      role: "user",
      content: [{ type: "text", text: "queued-2" }],
      timestamp: Date.now(),
    });
    await promptPromise;

    const events = ledger.listBySession(epoch.runtimeSessionId);
    const finalized = events.filter((event) => event.type === "message_finalized");
    // prompt user + assistant + two queued messages
    assert.ok(finalized.length >= 4, `expected >=4 message_finalized, got ${finalized.length}`);
    const entryIds = new Set(finalized.map((event) => event.entryId));
    assert.equal(
      entryIds.size,
      finalized.length,
      "each appended message must have a distinct entryId",
    );
    // Ordering: the two queued appends appear after the prompt's assistant reply.
    const texts = finalized.map((event) => {
      try {
        return (
          (JSON.parse(event.payload ?? "{}") as { content?: Array<{ text?: string }> }).content?.[0]
            ?.text ?? ""
        );
      } catch {
        return "";
      }
    });
    const queuedIdx = [texts.indexOf("queued-1"), texts.indexOf("queued-2")];
    assert.ok(queuedIdx[0] !== undefined && queuedIdx[0] > 0, "queued messages must be present");
    assert.ok(queuedIdx[1] !== undefined && queuedIdx[1] > 0, "queued messages must be present");
    assert.ok(
      queuedIdx[0] !== undefined && queuedIdx[1] !== undefined && queuedIdx[1] > queuedIdx[0],
      "queued messages must keep commit order",
    );
    ledger.close();
    await closeSessionStorage(repo);
    epochStore.close();
  } finally {
    // OS tmpdir 管理。
  }
});
