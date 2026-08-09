import { createHash } from "node:crypto";

import {
  AgentHarness,
  type AgentHarnessTool,
  type AgentMessage,
  type BeforeAgentStartEvent,
  type ContextEvent,
  type Session,
  type SessionTreeEntry,
  type SettledEvent,
  type ToolCallEvent,
  type ToolResultEvent,
} from "@earendil-works/pi-agent-core";
import type { Model, Models, ToolCall } from "@earendil-works/pi-ai";

import type { PreparedInvocationSources } from "../contracts/context.js";
import type { AgentInput } from "../contracts/origin.js";
import { computeToolExecutionKey, canonicalJson } from "../contracts/tool.js";
import {
  computeContentLayoutHash,
  createInputMetaCompanion,
  encodeInputFrames,
} from "./companion.js";
import { transformContextMessages } from "./context-adapter.js";
import type { ContextIngestPort } from "../contracts/context-units.js";
import type { ContextRenderer } from "../context/context-renderer.js";
import type { HardSignals } from "../context/pass-taxonomy.js";

export interface IrisHarnessCallbacks {
  onSystemPrompt?(systemPrompt: string): void;
  onContext?(messages: AgentMessage[]): void;
  onToolCall?(event: ToolCallEvent): void;
  onToolResult?(event: ToolResultEvent): void;
  onSettled?(event: SettledEvent): void;
  /**
   * Fired when Pi is about to make a provider call AFTER at least one tool
   * result has been processed — i.e. the Session writes are flushed and the
   * follow-up provider call has not started yet. This is the exact
   * ToolResult-commit-to-next-provider-call crash window (R1 Exit Gate).
   * Return a never-resolving promise to park the slice at this boundary.
   */
  onAfterToolResultProviderCall?(attempt: number): Promise<void> | void;
}

export interface HarnessObservers {
  systemPromptValues: string[];
  contextPasses: number;
  toolCallOrder: Array<{ toolCallId: string; toolName: string }>;
  toolResultOrder: Array<{ toolCallId: string; toolName: string }>;
  providerContextSnapshots: string[];
  settled: boolean;
  settledNextTurnCount: number | undefined;
}

/**
 * Per-invocation binding. The harness is stateful (it owns the Pi Session and
 * the transcript), so it is created once per runtime Session; each prompt()
 * invocation updates this binding so companion pairing and the context hook
 * reflect the CURRENT input, not the first one.
 */
export interface InvocationBinding {
  input: AgentInput;
  prepared: PreparedInvocationSources;
  invocationId: string;
}

export interface CreateIrisHarnessOptions {
  session: Session;
  instanceEpoch: number;
  models: Models;
  model: Model<string>;
  tools: AgentHarnessTool<undefined>[];
  /** Read on every turn; caller updates it per invocation. */
  currentInvocation: InvocationBinding;
  now: string;
  providerProfileId: string;
  callbacks?: IrisHarnessCallbacks | undefined;
  /** R2-P0：ContextMessageUnit 语义源（替代 session.getEntries 投影）。 */
  contextIngest?: ContextIngestPort;
  /** R2-P1：Provider Renderer（m0/m1/p5Tail 投影 + persistRender）。提供时
   * contextController 走 m0/m1 状态机；缺省时回退到纯 unit payload 投影
   * （reopenActiveSession 等非 prompt 路径保持原行为）。 */
  contextRenderer?: ContextRenderer;
}

export function createIrisHarness(options: CreateIrisHarnessOptions): {
  harness: AgentHarness;
  observers: HarnessObservers;
} {
  for (const tool of options.tools) {
    if (tool.executionMode !== "sequential") {
      throw new Error(`tool ${tool.name} must declare executionMode='sequential'`);
    }
  }

  // iris_agent#51 production capability gate: the RuntimeEvent ledger and the
  // Recovery Reconciler depend on crash-recoverable commit receipts. A
  // session storage that cannot draw an explicit durability boundary (e.g.
  // JSONL without fsync) must fail closed here instead of silently running
  // with a crash window.
  if (!options.session.supportsCrashRecoverableReceipts()) {
    throw new Error(
      "iris harness requires crash-recoverable commit receipts (iris_agent#51): " +
        "session storage does not support the durable entry+receipt journal; " +
        "the production lock mandates the SQLite session repository",
    );
  }

  const observers: HarnessObservers = {
    systemPromptValues: [],
    contextPasses: 0,
    toolCallOrder: [],
    toolResultOrder: [],
    providerContextSnapshots: [],
    settled: false,
    settledNextTurnCount: undefined,
  };

  const systemPromptResolver = (): string => {
    const { prepared } = options.currentInvocation;
    observers.systemPromptValues.push(prepared.canonicalSystemPrompt);
    options.callbacks?.onSystemPrompt?.(prepared.canonicalSystemPrompt);
    return prepared.canonicalSystemPrompt;
  };

  const harness = new AgentHarness({
    session: options.session,
    models: options.models,
    model: options.model,
    tools: options.tools,
    thinkingLevel: "off",
    // R2-P0（Roadmap v13）：Iris 正常 Provider path 从 ContextMessageUnit
    // 语义 ledger 投影（contextIngest.listUnits），不再调用 Session
    // buildContext 也不再依赖 session.getEntries 投影。companion 折叠已在
    // ingest 完成；当前 turn 的 live pair 由 context hook 处理。
    contextController: async () => {
      const runtimeSessionId = options.currentInvocation.prepared.runtimeSessionId;
      const units = options.contextIngest?.listUnits(runtimeSessionId) ?? [];
      if (options.contextRenderer === undefined) {
        return {
          systemPrompt: systemPromptResolver(),
          messages: units.map((unit) => unit.payload),
        };
      }
      // R2-P1：Provider Renderer 渲染 [m0, m1, ...p5Tail]。
      // liveDelta 恒为 []：控制器运行在当前 turn 消息被 append 之前（fork
      // agent-harness createTurnState 先于 executeTurn 的 prompts 合并），
      // steer user + companion 由 runAgentLoop prompts 追加、context hook 折叠。
      // 渲染是纯投影：物化写入由 vertical-slice 在 prompt 完成后调用
      // persistRender 提交（本模块保持纯）。
      const { messages } = options.contextRenderer.renderForProviderCall({
        runtimeSessionId,
        units,
        liveDelta: [],
        hardSignals: hardSignalsFor(options),
      });
      return {
        systemPrompt: systemPromptResolver(),
        messages,
      };
    },
  });

  harness.on("before_agent_start", async (event: BeforeAgentStartEvent) => {
    options.callbacks?.onSystemPrompt?.(event.systemPrompt);
    const { input, prepared, invocationId } = options.currentInvocation;
    void prepared;
    void invocationId;
    const layoutHash = computeContentLayoutHash(input, encodeInputFrames(input.blocks));
    const companion = createInputMetaCompanion(
      input,
      layoutHash,
      options.now,
      options.instanceEpoch,
    );
    return { messages: [companion] };
  });

  harness.on("context", async (event: ContextEvent) => {
    observers.contextPasses += 1;
    options.callbacks?.onContext?.(event.messages);
    const { input, prepared, invocationId } = options.currentInvocation;
    void input;
    const result = transformContextMessages({
      invocationId,
      runtimeSessionId: prepared.runtimeSessionId,
      messages: event.messages,
      model: { provider: options.model.provider, modelId: options.model.id },
      providerProfileId: options.providerProfileId,
    });
    return { messages: result.messages };
  });

  harness.on("tool_call", async (event: ToolCallEvent) => {
    observers.toolCallOrder.push({ toolCallId: event.toolCallId, toolName: event.toolName });
    options.callbacks?.onToolCall?.(event);
    return undefined;
  });

  harness.on("tool_result", async (event: ToolResultEvent) => {
    observers.toolResultOrder.push({ toolCallId: event.toolCallId, toolName: event.toolName });
    options.callbacks?.onToolResult?.(event);

    const entries = await options.session.getEntries();
    let assistantEntryId = "";
    let toolCallOrdinal = 0;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.type !== "message") {
        continue;
      }
      const message = (entry as SessionTreeEntry & { message: AgentMessage }).message;
      if (message.role !== "assistant") {
        continue;
      }
      const toolCalls = message.content.filter(
        (part): part is ToolCall => part.type === "toolCall",
      );
      const ordinal = toolCalls.findIndex((call) => call.id === event.toolCallId);
      if (ordinal >= 0) {
        assistantEntryId = entry.id;
        toolCallOrdinal = ordinal + 1;
        break;
      }
    }
    if (assistantEntryId === "" || toolCallOrdinal === 0) {
      throw new Error("tool result has no committed assistant entry");
    }

    const toolExecutionKey = computeToolExecutionKey({
      instanceEpoch: options.instanceEpoch,
      runtimeSessionId: options.currentInvocation.prepared.runtimeSessionId,
      assistantEntryId,
      toolCallOrdinal,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      toolVersion: "0.1.0",
      canonicalArgsHash: createHash("sha256").update(canonicalJson(event.input)).digest("hex"),
    });
    const iris = {
      schemaVersion: 1,
      toolExecutionKey,
      assistantEntryId,
      entryOrigin: {
        schemaVersion: 1,
        channel: "tool",
        principalKind: "tool" as const,
        authority: "data_only" as const,
        trust: "limited" as const,
      },
      layoutVersion: "iris_content_layout_v1" as const,
      blocks: [],
      contentLayoutHash: createHash("sha256").update(JSON.stringify(event.content)).digest("hex"),
    };
    return {
      details: event.details === undefined ? { iris } : { iris, adapter: event.details },
    };
  });

  let toolResultSeen = false;
  let providerCallAfterToolResult = 0;
  harness.on("tool_result", async () => {
    toolResultSeen = true;
    return undefined;
  });
  harness.on("before_provider_request", async () => {
    // before_provider_request fires right before a provider call, AFTER the
    // preceding tool-result Session writes were flushed (agent-harness
    // prepareNextTurn -> flushPendingSessionWrites -> provider call). So the
    // first such event following a tool result is the exact
    // ToolResult-commit-to-next-provider-call crash window.
    if (toolResultSeen) {
      providerCallAfterToolResult += 1;
      await options.callbacks?.onAfterToolResultProviderCall?.(providerCallAfterToolResult);
    }
    return undefined;
  });
  harness.subscribe(async (event) => {
    if (event.type === "settled") {
      observers.settled = true;
      observers.settledNextTurnCount = event.nextTurnCount;
      options.callbacks?.onSettled?.(event);
    }
  });

  return { harness, observers };
}

/**
 * R2-P1：当前 invocation 的 HARD 信号（provider-side cache 身份）。modelKey
 * 与 HARD 物化时写入的 cachedM0ModelKey 同构（provider:id）；systemHash 来自
 * 当前 invocation 的 system projection hash；providerProfileId 是当前 provider
 * profile。空信号（""/undefined）按 pass-taxonomy 语义永不当成变更。
 */
function hardSignalsFor(options: CreateIrisHarnessOptions): HardSignals {
  const { prepared } = options.currentInvocation;
  return {
    modelKey: `${options.model.provider}:${options.model.id}`,
    systemHash: prepared.systemProjectionHash,
    providerProfileId: options.providerProfileId,
  };
}
