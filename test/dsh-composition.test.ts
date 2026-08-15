/**
 * Phase B（iris_agent#128）：DSH/Cordis production composition 最小真实纵切。
 *
 * 覆盖（B4 验收）：
 *  真实 DSH user/message → DshMessageRef → ContextUnit admission → canonical
 *  BUST → validated ContextGeneration → Provider Renderer → 受控 provider 调用
 *  （只接收 rendered context）→ assistant/message committed 到 DSH Session →
 *  assistant ContextUnit admission → 下一 generation 重建。
 *
 * 同时证明：
 *  - plugin-injected user-role message → 不进入 P5；
 *  - P0–P4 state → 不写入 DSH Session（Session 只含 user/assistant surface
 *    事件，无 Iris custom event）；
 *  - Session rollover/restart → Context identity/order 不重置；
 *  - Pi compatibility path 不被 production profile 误选（组合不加载 Pi
 *    harness；结构性门）。
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { createAssistantMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { isDshMessageRef, type DshMessageRef } from "@iris/context/contracts";

import { createIrisDshRuntime } from "../src/runtime/dsh-composition.js";
import { assertNoConflictingDshFeatures } from "../src/runtime/dsh-authority-fence.js";
import { DshIngressAdapter } from "../src/runtime/dsh-adapter.js";
import { generationLayerSummary } from "../src/runtime/context-render.js";

const NOW = "2026-08-05T00:00:00.000Z";
const REPO_ROOT = resolve(import.meta.dirname, "..");

function userMessage(text: string) {
  return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
}

function pluginMessage(text: string) {
  return createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: "agent-instructions", form: "instructions" },
  });
}

async function mount(
  dataRoot: string,
  sessionId: string,
  onGenerate?: (rendered: { systemPrompt: string; messages: unknown[] }) => void,
) {
  return createIrisDshRuntime({
    dataRoot,
    sessionId: SessionId(sessionId),
    providerProfileId: "mock-iris",
    canonicalSystemPrompt: "IRIS SYSTEM PROMPT",
    systemProjectionHash: createHash("sha256").update("IRIS SYSTEM PROMPT").digest("hex"),
    preparedAt: NOW,
    withHistorian: false,
    now: () => NOW,
    nowMs: () => 1,
    generate: async ({ rendered }) => {
      if (onGenerate !== undefined) {
        onGenerate(rendered as never);
      }
      return {
        assistant: createAssistantMessage({
          content: [{ type: "text", text: "hello from the iris dsh loop" }],
          source: { provider: "mock", model: "mock-deepseek-v4-flash" },
        }),
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  });
}

test("B4 e2e: real DSH user message → admission → BUST → render → provider call → assistant committed → assistant admission → next generation", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-dsh-comp-"));
  const received: Array<{ systemPrompt: string; messages: unknown[] }> = [];
  const runtime = await mount(dataRoot, "iris-dsh-session-1", (r) => received.push(r));
  try {
    // 1. 真实 DSH user/message（真人输入）。
    const user = userMessage("hello dsh");
    runtime.session.append("user/message", user, { surfaceOp: "append" });

    // 2. DshMessageRef → ContextUnit admission（exactly-once）。
    const ingest = new DshIngressAdapter(runtime.contextService).ingest(runtime.session);
    assert.equal(ingest.admitted, 1);
    const userUnit = runtime.contextService
      .getStore()
      .listContextUnits(runtime.lineageId, { disposition: "all" })
      .find((u) => u.contentSchemaId === "iris.semantic.context_message.user.v1");
    assert.ok(userUnit, "user ContextUnit must be admitted");
    assert.ok(isDshMessageRef(userUnit.sourceRef), "source must be a real DshMessageRef");
    const ref = userUnit.sourceRef as DshMessageRef;
    assert.equal(ref.sessionId, "iris-dsh-session-1");
    assert.equal(ref.messageId, user.id);

    // 3. 经 Iris AgentFactory（ctx.agents.setFactory 注册的真实 seam）创建 agent。
    const handle = await runtime.agents.create({
      sessionId: SessionId("iris-agent-1"),
      agentOptions: { provider: "mock", model: "mock-deepseek-v4-flash" },
    });

    // 4. followup 驱动一个完整 turn。
    handle.agent.followup(user);
    await handle.agent.whenIdle();

    // 5. assistant/message committed 到 DSH Session（raw archive）。
    const assistantEvents = runtime.session.events.filter((e) => e.type === "assistant/message");
    assert.equal(
      assistantEvents.length,
      1,
      "exactly one assistant/message committed to the Session",
    );
    const assistantMessage = (assistantEvents[0] as { data?: { message?: { id?: string } } }).data
      ?.message?.id;
    assert.ok(assistantMessage !== undefined, "assistant message has an id");

    // 6. assistant ContextUnit admission（同一 ContextUnit 模型）。
    const assistantUnit = runtime.contextService
      .getStore()
      .listContextUnits(runtime.lineageId, { disposition: "all" })
      .find((u) => u.contentSchemaId === "iris.semantic.context_message.assistant.v1");
    assert.ok(assistantUnit, "assistant ContextUnit must be admitted");
    const assistantRef = assistantUnit.sourceRef as DshMessageRef;
    assert.equal(
      assistantRef.messageId,
      assistantMessage,
      "assistant unit maps to the committed message",
    );

    // 7. 下一 generation 重建（BUST）→ generation 包含 user + assistant。
    await runtime.contextService.runBustIfPending();
    const generation = runtime.contextService.getCurrentGeneration();
    assert.ok(generation !== null, "generation must be published");
    assert.ok(
      generation.units.some((u) => u.contentSchemaId === "iris.semantic.context_message.user.v1"),
      "generation includes the user unit",
    );
    assert.ok(
      generation.units.some(
        (u) => u.contentSchemaId === "iris.semantic.context_message.assistant.v1",
      ),
      "generation includes the assistant unit",
    );

    // 8. provider 调用只接收 rendered context（canonical 投影，不是 raw Session）。
    assert.equal(received.length, 1, "provider called exactly once");
    const renderedSystem = received[0]?.systemPrompt ?? "";
    assert.match(
      renderedSystem,
      /IRIS SYSTEM PROMPT/,
      "rendered context is the canonical system prompt",
    );
    // 投影结构：messages 是 provider-native 形状（role + content parts），
    // 不是 DSH SessionEvent 原文。
    const messages = received[0]?.messages ?? [];
    assert.ok(Array.isArray(messages) && messages.length >= 1, "rendered messages array present");
    const firstMessage = messages[0] as { role?: unknown; content?: unknown };
    assert.equal(
      firstMessage.role,
      "user",
      "provider input is the canonical user message projection (role+content), not a raw session event",
    );
    assert.ok(
      firstMessage.content !== undefined,
      "provider input message carries canonical content",
    );
    // raw Session event 形状（type/data/source）不得直接进入 provider。
    const allRenderedText = JSON.stringify(messages);
    assert.ok(
      !allRenderedText.includes('"type":"user/message"') &&
        !allRenderedText.includes('"type":"assistant/message"'),
      "provider input must NOT be a raw DSH session event dump",
    );

    await handle.dispose();
  } finally {
    await runtime.close();
  }
});

test("B4: plugin-injected user-role message never enters P5", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-dsh-plugin-"));
  const runtime = await mount(dataRoot, "iris-dsh-session-p");
  try {
    const plugin = pluginMessage("catalog of tools");
    runtime.session.append("user/message", plugin, { surfaceOp: "append" });
    const result = new DshIngressAdapter(runtime.contextService).ingest(runtime.session);
    assert.equal(result.admitted, 0, "plugin-injected context must be rejected");
    assert.equal(result.rejected, 1);
    const userUnits = runtime.contextService
      .getStore()
      .listContextUnits(runtime.lineageId, { disposition: "all" })
      .filter((u) => u.contentSchemaId === "iris.semantic.context_message.user.v1");
    assert.equal(userUnits.length, 0, "no synthetic user-role ContextUnit (never P5)");
  } finally {
    await runtime.close();
  }
});

test("B4: P0-P4 state is never written into the DSH Session (raw archive only)", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-dsh-nop04-"));
  const runtime = await mount(dataRoot, "iris-dsh-session-x");
  try {
    const user = userMessage("hello");
    runtime.session.append("user/message", user, { surfaceOp: "append" });
    new DshIngressAdapter(runtime.contextService).ingest(runtime.session);
    // 触发 BUST（P0-P2 声明层会物化）—— 之后 Session 仍只能有 surface 事件。
    await runtime.contextService.runBustIfPending();
    const eventTypes = new Set<string>(runtime.session.events.map((e) => e.type));
    for (const allowed of ["user/message", "assistant/message", "tool/call", "tool/result"]) {
      eventTypes.delete(allowed);
    }
    // 非 surface 事件（boundary/turn 等 DSH 自生事件）允许；Iris custom event 禁止。
    for (const type of eventTypes) {
      assert.ok(
        !type.startsWith("iris/"),
        `no Iris custom event (P0-P4/BUST state) may be written into the DSH Session, got ${type}`,
      );
    }
  } finally {
    await runtime.close();
  }
});

test("B4: Session rollover → Context identity/order not reset", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-dsh-roll-"));
  const runtime = await mount(dataRoot, "iris-dsh-session-r1");
  try {
    const user1 = userMessage("first session");
    runtime.session.append("user/message", user1, { surfaceOp: "append" });
    new DshIngressAdapter(runtime.contextService).ingest(runtime.session);
    const firstUnits = runtime.contextService
      .getStore()
      .listContextUnits(runtime.lineageId, { disposition: "all" });
    const firstUser = firstUnits.find(
      (u) => u.contentSchemaId === "iris.semantic.context_message.user.v1",
    );
    assert.ok(firstUser);
    const firstUnitId = firstUser.unitId;

    // rollover：新 DSH Session，同一 lineage。
    runtime.contextService.getStore().bindCurrentSession(runtime.lineageId, "iris-dsh-session-r2");
    const session2 = Session.create(SessionId("iris-dsh-session-r2"));
    const user2 = userMessage("second session");
    session2.append("user/message", user2, { surfaceOp: "append" });
    new DshIngressAdapter(runtime.contextService).ingest(session2);

    const allUnits = runtime.contextService
      .getStore()
      .listContextUnits(runtime.lineageId, { disposition: "all" });
    const userUnits = allUnits.filter(
      (u) => u.contentSchemaId === "iris.semantic.context_message.user.v1",
    );
    assert.equal(userUnits.length, 2, "both sessions' user units in the SAME lineage");
    assert.ok(
      userUnits.some((u) => u.unitId === firstUnitId),
      "first session's Context identity is not reset by rollover",
    );
  } finally {
    await runtime.close();
  }
});

test("B3: authority fence fails closed on conflicting DSH services", () => {
  const fakeCtx = {
    services: new Set(["agents", "compaction"]),
    get(name: string) {
      return this.services.has(name) ? {} : undefined;
    },
  };
  assert.throws(
    () => {
      assertNoConflictingDshFeatures(fakeCtx as never);
    },
    /conflicting DSH\/Cordis services/,
    "mounting DSH compaction must fail closed",
  );
});

test("B4: Pi compatibility path is not mis-selected by the production profile (structural)", () => {
  // production composition 不得加载 Pi harness / Pi bridge。
  const composition = readFileSync(join(REPO_ROOT, "src", "runtime", "dsh-composition.ts"), "utf8");
  assert.doesNotMatch(
    composition,
    /@iris\/pi-|@earendil-works|IrisContextBridge|createIrisHarness/,
    "production composition must not load the Pi harness (Pi stays a separate baseline)",
  );
  // 不 monkey-patch DSH 默认 ReactLoopAgent（不导入 dsh-agent-loop）。
  // 注释/文档中提及历史名称是允许的；扫描剥离注释后检查真实代码引用。
  const stripComments = (code: string) =>
    code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  const loop = stripComments(
    readFileSync(join(REPO_ROOT, "src", "runtime", "iris-dsh-agent.ts"), "utf8"),
  );
  assert.doesNotMatch(
    loop,
    /@deepseek-ai\/dsh-agent-loop|ReactLoopAgent|new ReactLoop/,
    "Iris must register its own AgentFactory, not the default ReactLoopAgent",
  );
});

test("B4: generation rebuild is deterministic after a turn (layer summary)", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-dsh-gen-"));
  const runtime = await mount(dataRoot, "iris-dsh-session-g");
  try {
    const user = userMessage("hello");
    runtime.session.append("user/message", user, { surfaceOp: "append" });
    new DshIngressAdapter(runtime.contextService).ingest(runtime.session);
    const handle = await runtime.agents.create({
      sessionId: SessionId("iris-agent-g"),
      agentOptions: { provider: "mock", model: "mock-model" },
    });
    handle.agent.followup(user);
    await handle.agent.whenIdle();
    await runtime.contextService.runBustIfPending();
    const gen1 = runtime.contextService.getCurrentGeneration();
    assert.ok(gen1 !== null);
    const summary1 = generationLayerSummary(gen1);
    // 再次 rebuild（无新输入）→ 等价 generation。
    await runtime.contextService.runBustIfPending();
    const gen2 = runtime.contextService.getCurrentGeneration();
    assert.ok(gen2 !== null);
    assert.equal(
      generationLayerSummary(gen2),
      summary1,
      "equivalent rebuild produces the same generation",
    );
    await handle.dispose();
  } finally {
    await runtime.close();
  }
});
