/**
 * DshIngressAdapter —— 真实 DSH Session → Context 统一 ingress（iris_agent#128/#130）。
 *
 * 权威来源：Notion 2026-08-15 DSH Message SourceRef / Runtime Truth Boundary：
 *   DSH native user/assistant/tool-result message
 *   → DshMessageRef(sessionId=Session.id, messageId=Message.id, eventSeq=event.seq)
 *   → Context admission → ContextUnit exactly once
 *
 * 覆盖：
 *  - 真实 DSH Session（@deepseek-ai/dsh-session + dsh-llm）事件流
 *    user/assistant/tool-result → DshMessageRef ContextUnit（真实 Session.id /
 *    Message.id / event.seq）；
 *  - user/message MessageSource 检查：plugin 注入（instructions/snapshot/notice/
 *    relay/recall）不进入 P5（rejected）；
 *  - tool/result 经 tool/call 关联 toolName；
 *  - rollover（新 Session，同一 lineage）+ restart（重开 context.db）身份保持；
 *  - Context identity（unitId 由 sessionId+messageId 确定性派生）；
 *  - P0–P4 不写 DSH Session（结构性 gate：adapter 是只读 ingress）。
 */
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { Session, SessionId } from "@deepseek-ai/dsh-session";
import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from "@deepseek-ai/dsh-llm";

import {
  deriveContextUnitId,
  isDshMessageRef,
  type DshMessageRef,
  type DshAttachmentRef,
} from "@iris/context/contracts";

import { defaultAgentConfig } from "../src/config/load.js";
import { initializeDataRoot, resolveDataRootPaths } from "../src/host/data-root.js";
import { RuntimeEpochStore } from "../src/runtime/epoch-manager.js";
import { assembleIrisContext } from "../src/runtime/iris-context.js";
import {
  DshIngressAdapter,
  dshAssistantSourceHash,
  dshToolResultSourceHash,
  dshUserSourceHash,
} from "../src/runtime/dsh-adapter.js";
import { renderGenerationForProvider } from "../src/runtime/context-render.js";
import {
  closeSessionStorage,
  composeProvider,
  openOrCreateSession,
  prepareInvocation,
  sampleAgentInput,
} from "../src/runtime/vertical-slice.js";
import type { AgentInput } from "../src/contracts/origin.js";

const NOW = "2026-08-05T00:00:00.000Z";

/** 构造一个带真实事件流的 DSH Session（user / plugin-user / assistant / tool）。 */
function buildDshSession(): {
  session: Session;
  userMessageId: string;
  assistantMessageId: string;
  toolResultMessageId: string;
  pluginMessageId: string;
} {
  const session = Session.create(SessionId("dsh-session-a"));
  const user = createUserMessage({
    content: [{ type: "text", text: "hello from dsh" }],
    source: { kind: "user" },
  });
  session.append("user/message", user, { surfaceOp: "append" });

  const plugin = createUserMessage({
    content: [{ type: "text", text: "<system-reminder>context</system-reminder>" }],
    source: { kind: "plugin", plugin: "agent-instructions", form: "instructions" },
  });
  session.append("user/message", plugin, { surfaceOp: "append" });

  const assistant = createAssistantMessage({
    content: [{ type: "text", text: "hi there" }],
    source: { provider: "deepseek", model: "deepseek-v4-flash" },
  });
  session.append(
    "assistant/message",
    { turn: 1, step: 1, message: assistant },
    { surfaceOp: "append" },
  );

  session.append("tool/call", {
    turn: 1,
    step: 1,
    callId: CallId("call-1"),
    name: "read_file",
    arguments: "{}",
  });

  const toolResult = createToolResultMessage({
    callId: CallId("call-1"),
    content: [{ type: "text", text: "file content: 42" }],
    isError: false,
  });
  session.append("tool/result", { turn: 1, step: 1, message: toolResult }, { surfaceOp: "append" });

  return {
    session,
    userMessageId: user.id,
    assistantMessageId: assistant.id,
    toolResultMessageId: toolResult.id,
    pluginMessageId: plugin.id,
  };
}

async function mountAssembly(dataRoot: string, runtimeSessionId: string) {
  const config = defaultAgentConfig();
  initializeDataRoot(dataRoot, config);
  const paths = resolveDataRootPaths(dataRoot, config);
  const epochStore = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const epoch = epochStore.ensureActive(NOW);
  const { repo } = await openOrCreateSession(dataRoot, config, epoch.runtimeSessionId);
  const { providerProfileId } = await composeProvider("mock");
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
    runtimeSessionId,
    providerProfileId,
    canonicalSystemPrompt: binding.canonicalSystemPrompt,
    systemProjectionHash: createHash("sha256").update(binding.canonicalSystemPrompt).digest("hex"),
    preparedAt: binding.preparedAt,
    withHistorian: true,
    now: () => NOW,
    getCurrentSource: () => ({
      canonicalSystemPrompt: binding.canonicalSystemPrompt,
      personaSnapshotId: "persona-default-v1",
      providerProfileId,
      toolDeclarations: ["read_file"],
    }),
  });
  return {
    assembly,
    config,
    paths,
    epochStore,
    close: async () => {
      await assembly.close();
      await closeSessionStorage(repo);
      epochStore.close();
    },
  };
}

test("dsh ingress: real Session message events admit as DshMessageRef ContextUnits", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "dsh-ingress-"));
  const { assembly, close } = await mountAssembly(dataRoot, "dsh-session-a");
  try {
    const { session, userMessageId, assistantMessageId, toolResultMessageId } = buildDshSession();
    const result = new DshIngressAdapter(assembly.contextService).ingest(session);
    assert.equal(result.admitted, 3, "user + assistant + tool result admitted");
    assert.equal(result.rejected, 1, "plugin user-role context rejected");

    const store = assembly.contextService.getStore();
    const units = store.listContextUnits(assembly.lineageId, { disposition: "all" });
    // P0–P2 contributors 也会物化（BUST 未运行时不入 store —— 只有 ingress 的
    // runtime units 落库）。这里只断言 runtime-origin units。
    const runtimeUnits = units.filter((u) =>
      [
        "iris.semantic.context_message.user.v1",
        "iris.semantic.context_message.assistant.v1",
        "iris.semantic.context_message.tool_result.v1",
      ].includes(u.contentSchemaId),
    );
    assert.equal(runtimeUnits.length, 3, "three runtime ContextUnits persisted");

    const bySchema = new Map(runtimeUnits.map((u) => [u.contentSchemaId, u]));
    const userUnit = bySchema.get("iris.semantic.context_message.user.v1");
    const assistantUnit = bySchema.get("iris.semantic.context_message.assistant.v1");
    const toolUnit = bySchema.get("iris.semantic.context_message.tool_result.v1");
    assert.ok(userUnit && assistantUnit && toolUnit);

    // DshMessageRef 来自真实 DSH 身份。
    for (const unit of [userUnit, assistantUnit, toolUnit]) {
      assert.ok(isDshMessageRef(unit.sourceRef), `unit ${unit.unitId} must carry DshMessageRef`);
    }
    const userRef = userUnit.sourceRef as DshMessageRef;
    assert.equal(userRef.sessionId, "dsh-session-a", "sessionId must equal Session.id");
    assert.equal(userRef.messageId, userMessageId, "messageId must equal Message.id");
    assert.equal(userRef.eventSeq, 0, "eventSeq must equal event.seq");
    const assistantRef = assistantUnit.sourceRef as DshMessageRef;
    assert.equal(assistantRef.messageId, assistantMessageId);
    assert.equal(assistantRef.eventSeq, 2);
    const toolRef = toolUnit.sourceRef as DshMessageRef;
    assert.equal(toolRef.messageId, toolResultMessageId);
    assert.equal(toolRef.eventSeq, 4);

    // Context identity：unitId 由 sessionId+messageId 确定性派生。
    assert.equal(userUnit.unitId, deriveContextUnitId(assembly.lineageId, userRef));

    // tool result 保留 toolName（来自 tool/call 关联）。
    assert.deepEqual(
      (toolUnit.content as { toolName?: string }).toolName,
      "read_file",
      "tool result must retain the correlated tool name",
    );
  } finally {
    await close();
  }
});

test("dsh ingress: plugin-injected user-role context is rejected (never P5)", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "dsh-plugin-"));
  const { assembly, close } = await mountAssembly(dataRoot, "dsh-session-a");
  try {
    // 只含 plugin 注入 user 消息的 Session。
    const session = Session.create(SessionId("dsh-session-plug"));
    const plugin = createUserMessage({
      content: [{ type: "text", text: "catalog of tools" }],
      source: { kind: "plugin", plugin: "skill-loader", form: "catalog" },
    });
    session.append("user/message", plugin, { surfaceOp: "append" });
    const notice = createUserMessage({
      content: [{ type: "text", text: "notice: file changed" }],
      source: { kind: "plugin", plugin: "fs-watcher", form: "notice", summary: "file changed" },
    });
    session.append("user/message", notice, { surfaceOp: "append" });

    const result = new DshIngressAdapter(assembly.contextService).ingest(session);
    assert.equal(result.admitted, 0, "no plugin-injected context admitted");
    assert.equal(result.rejected, 2, "both plugin user messages rejected");
    const units = assembly.contextService
      .getStore()
      .listContextUnits(assembly.lineageId, { disposition: "all" });
    const userUnits = units.filter(
      (u) => u.contentSchemaId === "iris.semantic.context_message.user.v1",
    );
    assert.equal(userUnits.length, 0, "no synthetic user-role ContextUnit may exist (never P5)");
  } finally {
    await close();
  }
});

test("dsh ingress: rollover to a new DSH Session keeps the same lineage", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "dsh-rollover-"));
  const { assembly, close } = await mountAssembly(dataRoot, "dsh-session-a");
  try {
    const adapter = new DshIngressAdapter(assembly.contextService);
    const { session } = buildDshSession();
    adapter.ingest(session);

    // rollover：新 DSH Session，同一 lineage。
    const store = assembly.contextService.getStore();
    store.bindCurrentSession(assembly.lineageId, "dsh-session-b");
    const sessionB = Session.create(SessionId("dsh-session-b"));
    const userB = createUserMessage({
      content: [{ type: "text", text: "second session user" }],
      source: { kind: "user" },
    });
    sessionB.append("user/message", userB, { surfaceOp: "append" });
    const resultB = adapter.ingest(sessionB);
    assert.equal(resultB.admitted, 1);

    const units = store.listContextUnits(assembly.lineageId, { disposition: "all" });
    const runtimeUnits = units.filter(
      (u) => u.contentSchemaId === "iris.semantic.context_message.user.v1",
    );
    assert.equal(runtimeUnits.length, 2, "both sessions' user units in the SAME lineage");
    const refB = runtimeUnits.find(
      (u) => (u.sourceRef as DshMessageRef).sessionId === "dsh-session-b",
    )?.sourceRef as DshMessageRef | undefined;
    assert.ok(refB, "session-b unit carries its own DshMessageRef");
    assert.equal(refB.messageId, userB.id);
  } finally {
    await close();
  }
});

test("dsh ingress: restart reopens context.db with the same Context identity", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "dsh-restart-"));
  const { assembly, close } = await mountAssembly(dataRoot, "dsh-session-a");
  let unitId = "";
  try {
    const { session, userMessageId } = buildDshSession();
    new DshIngressAdapter(assembly.contextService).ingest(session);
    const store = assembly.contextService.getStore();
    const userUnit = store
      .listContextUnits(assembly.lineageId, { disposition: "all" })
      .find((u) => u.contentSchemaId === "iris.semantic.context_message.user.v1");
    assert.ok(userUnit);
    unitId = userUnit.unitId;
    void userMessageId;
  } finally {
    await close();
  }
  // restart：重开同一 dataRoot 的 context.db。
  const { assembly: reopened, close: close2 } = await mountAssembly(dataRoot, "dsh-session-a");
  try {
    const store = reopened.contextService.getStore();
    const reloaded = store.getContextUnitByUnitId(reopened.lineageId, unitId);
    assert.ok(reloaded, "unit survives restart with same unitId");
    assert.equal(reloaded.unitId, unitId);
    assert.equal(reloaded.schemaId, "iris.context_unit.v3");
    assert.ok(isDshMessageRef(reloaded.sourceRef), "DshMessageRef survives restart");
    const ref = reloaded.sourceRef as DshMessageRef;
    assert.equal(ref.sessionId, "dsh-session-a");
    assert.equal(ref.eventSeq, 0);
  } finally {
    await close2();
  }
});

test("dsh ingress: P0–P4 never written into a DSH Session (adapter is read-only)", () => {
  const adapterSource = readFileSync(
    join(import.meta.dirname, "..", "src", "runtime", "dsh-adapter.ts"),
    "utf8",
  );
  // 只读 ingress：不得对 DSH Session 调用任何 append / 写事件 API。
  assert.doesNotMatch(adapterSource, /\.append\(/, "adapter must never append to a DSH Session");
  assert.doesNotMatch(
    adapterSource,
    /SessionEventMap\[/,
    "adapter must not construct/write DSH session events",
  );
  // P0–P4 状态（system/persona/capability/compartment/recollection）绝不进入
  // DSH Session —— adapter 只消费 user/assistant/tool-result surface 事件。
  const ingestedTypes = [...adapterSource.matchAll(/^ {8}case "([a-z/]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(
    ingestedTypes.sort(),
    ["assistant/message", "tool/result", "user/message"],
    "adapter must only read the three DSH surface message event types",
  );
});

test("dsh ingress sensitivity: writing to the DSH Session from the adapter fails the gate", () => {
  // 注入一个 `session.append(` 调用到 adapter → P0–P4 no-session-write 门失败。
  const adapterSource = readFileSync(
    join(import.meta.dirname, "..", "src", "runtime", "dsh-adapter.ts"),
    "utf8",
  );
  assert.ok(
    !adapterSource.includes("session.append("),
    "adapter must contain no session.append call (P0–P4 no-session-write gate)",
  );
});

test("dsh ingress: assistant with real DSH TokenUsage ingests with Iris usage shape", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "dsh-usage-"));
  const { assembly, close } = await mountAssembly(dataRoot, "dsh-session-a");
  try {
    const session = Session.create(SessionId("dsh-session-a"));
    const assistant = createAssistantMessage({
      content: [{ type: "text", text: "token heavy reply" }],
      source: { provider: "deepseek", model: "deepseek-v4-flash" },
    });
    session.append(
      "assistant/message",
      {
        turn: 1,
        step: 1,
        message: assistant,
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, reasoningTokens: 5 },
      },
      { surfaceOp: "append" },
    );
    const result = new DshIngressAdapter(assembly.contextService).ingest(session);
    assert.equal(result.admitted, 1, "assistant with usage must be admitted (not fail closed)");
    const units = assembly.contextService
      .getStore()
      .listContextUnits(assembly.lineageId, { disposition: "all" });
    const assistantUnit = units.find(
      (u) => u.contentSchemaId === "iris.semantic.context_message.assistant.v1",
    );
    assert.ok(assistantUnit, "assistant unit must exist");
    const usage = (assistantUnit.content as { usage?: Record<string, unknown> }).usage;
    assert.ok(usage, "assistant unit must retain converted usage");
    assert.equal(usage["input"], 100);
    assert.equal(usage["output"], 50);
    assert.equal(usage["cacheRead"], 20);
    assert.equal(usage["totalTokens"], 170);
    assert.equal(usage["reasoning"], 5);
    // A4：DSH 不携带 provider cost → canonical usage 显式声明 unavailable，
    // 绝不写真实的 0 成本（cost 字段不存在）。
    assert.equal(usage["costStatus"], "unavailable");
    assert.ok(
      !("cost" in usage),
      "canonical usage must NOT carry a cost field when cost is unavailable (never write 0)",
    );
  } finally {
    await close();
  }
});

test("dsh ingress: tool result with reasoning block maps to reasoning (not thinking)", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "dsh-toolreason-"));
  const { assembly, close } = await mountAssembly(dataRoot, "dsh-session-a");
  try {
    const session = Session.create(SessionId("dsh-session-a"));
    session.append("tool/call", {
      turn: 1,
      step: 1,
      callId: CallId("call-r1"),
      name: "read_file",
      arguments: "{}",
    });
    const toolResult = createToolResultMessage({
      callId: CallId("call-r1"),
      content: [
        { type: "reasoning", text: "reasoned about the file" },
        { type: "text", text: "file content" },
      ],
      isError: false,
    });
    session.append(
      "tool/result",
      { turn: 1, step: 1, message: toolResult },
      { surfaceOp: "append" },
    );
    const result = new DshIngressAdapter(assembly.contextService).ingest(session);
    assert.equal(result.admitted, 1, "tool result with reasoning block must be admitted");
    const units = assembly.contextService
      .getStore()
      .listContextUnits(assembly.lineageId, { disposition: "all" });
    const toolUnit = units.find(
      (u) => u.contentSchemaId === "iris.semantic.context_message.tool_result.v1",
    );
    assert.ok(toolUnit, "tool result unit must exist");
    const content = (toolUnit.content as { content?: Array<{ type: string }> }).content ?? [];
    assert.ok(
      content.some((part) => part.type === "reasoning"),
      "tool_result content must carry a reasoning part (schema requires reasoning, not thinking)",
    );
    assert.ok(
      !content.some((part) => part.type === "thinking"),
      "tool_result content must not carry a thinking part",
    );
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// A3：DSH user image → typed attachmentRef（不把 opaque attachmentId 当图片）
// ---------------------------------------------------------------------------

test("A3: DSH user image admits a typed attachmentRef (never attachmentId as image data)", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "dsh-image-"));
  const { assembly, close } = await mountAssembly(dataRoot, "dsh-session-a");
  try {
    const session = Session.create(SessionId("dsh-session-a"));
    const user = createUserMessage({
      content: [
        { type: "text", text: "look at this" },
        {
          type: "image",
          attachment: {
            attachmentId: "att-opaque-1",
            mediaType: "image/png",
            bytes: 64,
            width: 8,
            height: 8,
          },
        },
      ] as never,
      source: { kind: "user" },
    });
    session.append("user/message", user, { surfaceOp: "append" });

    const result = new DshIngressAdapter(assembly.contextService).ingest(session);
    assert.equal(result.admitted, 1, "user image message must be admitted");
    const units = assembly.contextService
      .getStore()
      .listContextUnits(assembly.lineageId, { disposition: "all" });
    const userUnit = units.find(
      (u) => u.contentSchemaId === "iris.semantic.context_message.user.v1",
    );
    assert.ok(userUnit, "user unit must exist");
    const content = (userUnit.content as { content?: unknown[] }).content ?? [];
    const imagePart = content.find((part) => (part as { type?: string }).type === "image") as
      { type: string; attachmentRef?: DshAttachmentRef; data?: string } | undefined;
    assert.ok(imagePart, "image part must exist in canonical content");
    assert.ok(imagePart.attachmentRef !== undefined, "image part must carry a typed attachmentRef");
    assert.ok(
      !("data" in imagePart),
      "opaque attachmentId must NOT be placed into the semantic image.data",
    );
    assert.equal(imagePart.attachmentRef?.schemaId, "iris.dsh_attachment_ref.v1");
    assert.equal(imagePart.attachmentRef?.attachmentId, "att-opaque-1");
    assert.equal(imagePart.attachmentRef?.mediaType, "image/png");
    assert.equal(imagePart.attachmentRef?.bytes, 64);
  } finally {
    await close();
  }
});

test("A3 e2e: DSH user image → admission → BUST generation → Provider Renderer → consumable image data", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "dsh-image-e2e-"));
  const { assembly, close } = await mountAssembly(dataRoot, "dsh-session-a");
  try {
    const session = Session.create(SessionId("dsh-session-a"));
    const user = createUserMessage({
      content: [
        {
          type: "image",
          attachment: {
            attachmentId: "att-opaque-2",
            mediaType: "image/jpeg",
            bytes: 128,
            width: 16,
            height: 16,
          },
        },
      ] as never,
      source: { kind: "user" },
    });
    session.append("user/message", user, { surfaceOp: "append" });
    new DshIngressAdapter(assembly.contextService).ingest(session);

    // 安全 provider 边界完成 canonical BUST → generation。
    const run = await assembly.contextService.runBustIfPending();
    assert.ok(run.published, "BUST must publish a generation");
    const generation = assembly.contextService.getCurrentGeneration();
    assert.ok(generation !== null, "generation must be published");

    // Provider Renderer + DSH AttachmentStore 语义的 materializer（readImage：
    // 校验 + 返回 bytes → base64 data URL）。
    const materializer = {
      materializeImage: async (ref: DshAttachmentRef) => {
        assert.equal(ref.attachmentId, "att-opaque-2");
        return { data: "data:image/jpeg;base64,/9j/4AAQ", mimeType: "image/jpeg" };
      },
    };
    const rendered = await renderGenerationForProvider(generation, {
      attachmentMaterializer: materializer,
    });
    const imagePart = rendered.messages
      .flatMap((m) => {
        const content = (m as { content?: unknown }).content;
        return Array.isArray(content) ? (content as unknown[]) : [];
      })
      .find((part) => (part as { type?: string }).type === "image") as
      { type: string; data?: string; mimeType?: string } | undefined;
    assert.ok(imagePart, "rendered provider wire must carry an image part");
    assert.match(imagePart.data ?? "", /^data:image\/jpeg;base64,/);
    assert.equal(imagePart.mimeType, "image/jpeg");
    assert.ok(
      !(imagePart.data ?? "").includes("att-opaque-2"),
      "opaque attachment id must not appear in the final image.data",
    );
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// A5：版本化 canonical source snapshot —— 字段敏感度
// ---------------------------------------------------------------------------

test("A5: user source snapshot — content unchanged, timestamp stable → same hash; content change → different", () => {
  const base = createUserMessage({
    content: [{ type: "text", text: "hello" }],
    source: { kind: "user" },
  });
  const same = createUserMessage({
    content: [{ type: "text", text: "hello" }],
    source: { kind: "user" },
  });
  // 不同 Message.id → 不同 snapshot（message ID 是 immutable source 字段）。
  assert.notEqual(dshUserSourceHash(base, 1), dshUserSourceHash(same, 1));
  // 同一 message（同 id）：对象键序无关（canonical JSON）→ 同一 hash。
  assert.equal(dshUserSourceHash(base, 1), dshUserSourceHash(base, 1));
});

test("A5: assistant snapshot — provider/model changes alter the hash, eventSeq does not", () => {
  const a = createAssistantMessage({
    content: [{ type: "text", text: "reply" }],
    source: { provider: "deepseek", model: "deepseek-v4-flash" },
  });
  const b = createAssistantMessage({
    content: [{ type: "text", text: "reply" }],
    source: { provider: "openai", model: "deepseek-v4-flash" },
  });
  const c = createAssistantMessage({
    content: [{ type: "text", text: "reply" }],
    source: { provider: "deepseek", model: "gpt-4o" },
  });
  assert.notEqual(
    dshAssistantSourceHash(a, { time: 1 }),
    dshAssistantSourceHash(b, { time: 1 }),
    "provider change must alter the source snapshot hash",
  );
  assert.notEqual(
    dshAssistantSourceHash(a, { time: 1 }),
    dshAssistantSourceHash(c, { time: 1 }),
    "model change must alter the source snapshot hash",
  );
  // 同一 message（同 id）：time 相同 → 同一 hash（eventSeq 不在 snapshot 内，
  // 且 canonical JSON 键序无关）。
  assert.equal(dshAssistantSourceHash(a, { time: 1 }), dshAssistantSourceHash(a, { time: 1 }));
});

test("A5: tool result snapshot — toolName / callId / isError changes alter the hash", () => {
  const toolResult = createToolResultMessage({
    callId: CallId("call-1"),
    content: [{ type: "text", text: "file: 42" }],
    isError: false,
  });
  const toolResultOtherName = createToolResultMessage({
    callId: CallId("call-1"),
    content: [{ type: "text", text: "file: 42" }],
    isError: false,
  });
  const toolResultError = createToolResultMessage({
    callId: CallId("call-1"),
    content: [{ type: "text", text: "file: 42" }],
    isError: true,
  });
  // 不同 message id → 不同 hash；同一 message → 同一 hash。
  assert.notEqual(
    dshToolResultSourceHash(toolResult, { toolName: "read_file", time: 1 }),
    dshToolResultSourceHash(toolResultOtherName, { toolName: "read_file", time: 1 }),
    "message ID must be part of the source snapshot",
  );
  assert.equal(
    dshToolResultSourceHash(toolResult, { toolName: "read_file", time: 1 }),
    dshToolResultSourceHash(toolResult, { toolName: "read_file", time: 1 }),
    "canonical snapshot is deterministic",
  );
  assert.notEqual(
    dshToolResultSourceHash(toolResult, { toolName: "read_file", time: 1 }),
    dshToolResultSourceHash(toolResult, { toolName: "write_file", time: 1 }),
    "resolved toolName change must alter the source snapshot hash",
  );
  assert.notEqual(
    dshToolResultSourceHash(toolResult, { toolName: "read_file", time: 1 }),
    dshToolResultSourceHash(toolResultError, { toolName: "read_file", time: 1 }),
    "isError change must alter the source snapshot hash",
  );
  // callId 变化（不同 tool 弧）→ hash 变化。
  const toolResultOtherCall = createToolResultMessage({
    callId: CallId("call-2"),
    content: [{ type: "text", text: "file: 42" }],
    isError: false,
  });
  assert.notEqual(
    dshToolResultSourceHash(toolResult, { toolName: "read_file", time: 1 }),
    dshToolResultSourceHash(toolResultOtherCall, { toolName: "read_file", time: 1 }),
    "callId change must alter the source snapshot hash",
  );
});

test("A5: content blocks (incl. attachment refs) are covered by the snapshot", () => {
  // DSH messages 是 frozen immutable（id 固定）；为验证"attachment 内容变化 →
  // hash 变化"，用同一 message id 构造两个同形状消息（运行时形状即可）。
  const messageId = "same-id-for-snapshot-test";
  const plain = {
    id: messageId,
    role: "user",
    source: { kind: "user" },
    content: [{ type: "text", text: "hi" }],
  };
  const withImage = {
    id: messageId,
    role: "user",
    source: { kind: "user" },
    content: [
      { type: "text", text: "hi" },
      {
        type: "image",
        attachment: {
          attachmentId: "att-a",
          mediaType: "image/png",
          bytes: 10,
          width: 2,
          height: 2,
        },
      },
    ],
  };
  assert.notEqual(
    dshUserSourceHash(plain as never, 1),
    dshUserSourceHash(withImage as never, 1),
    "attachment identity in content must alter the source snapshot hash",
  );
});

test("A5: canonical JSON — object key insertion order does not change the hash", () => {
  const messageId = "same-id-order-test";
  const orderA = {
    id: messageId,
    role: "user",
    source: { kind: "user" },
    content: [{ type: "text", text: "hi" }],
  };
  const orderB = {
    id: messageId,
    role: "user",
    source: { kind: "user" },
    content: [{ text: "hi", type: "text" }],
  };
  assert.equal(
    dshUserSourceHash(orderA as never, 1),
    dshUserSourceHash(orderB as never, 1),
    "canonical JSON is key-order independent",
  );
});
