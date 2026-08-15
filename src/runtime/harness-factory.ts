// Production harness composition for IrisHost (pure projection path). The
// provider-visible Context comes ONLY from @iris/context's validated
// ContextGenerationV3 via the Provider Renderer; the m0/m1 ContextRenderer is
// gone (Notion 01 Context Assembly｜Provider Wire Terminology Override).
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
} from "@iris/pi-agent-core";
import type { ContextService } from "@iris/context";
import type { Model, Models, ToolCall } from "@iris/pi-ai";

import type { AgentInput } from "../contracts/origin.js";
import { computeToolExecutionKey, canonicalJson } from "../contracts/tool.js";
import {
  computeContentLayoutHash,
  createInputMetaCompanion,
  encodeInputFrames,
} from "./companion.js";
import { transformContextMessages } from "./context-adapter.js";
import { renderGenerationForProvider } from "./context-render.js";

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
 * Per-invocation binding（简化版）。Pi seam 需要的只有 input / invocationId /
 * runtimeSessionId / epochId / instanceEpoch / canonicalSystemPrompt /
 * providerProfileId —— 不再携带任何 v27 废止的 PreparedInvocationSources /
 * ContextSourceSnapshot 语义（removed legacy assembly contract；Notion v27
 * Legacy Assembly Contract Cleanup）。
 * Context 组装状态完全由 @iris/context 持有。
 */
export interface InvocationBinding {
  input: AgentInput;
  invocationId: string;
  runtimeSessionId: string;
  epochId: string;
  instanceEpoch: number;
  canonicalSystemPrompt: string;
  providerProfileId: string;
  preparedAt: string;
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
  /**
   * @iris/context ContextService（已 open + createLineage + contributor 注册）。
   * contextController 只在安全 provider 边界渲染已验证 generation；
   * generation 缺失/失效 → fail closed（不 dispatch）。
   */
  irisContext: ContextService;
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

  const harness = new AgentHarness({
    session: options.session,
    models: options.models,
    model: options.model,
    tools: options.tools,
    thinkingLevel: "off",
    // Provider Context Controller（PI-015）：只把当前已验证 P0–P5 generation
    // 渲染为 provider-native wire。generation 缺失/失效 → fail closed（不
    // dispatch）。BUST pending 时在安全边界先完成 canonical full rebuild。
    contextController: async () => {
      const irisContext = options.irisContext;
      await irisContext.runBustIfPending();
      const generation = irisContext.getCurrentGeneration();
      if (generation === null) {
        throw new Error(
          "IRIS_CONTEXT_TRANSFORM_UNAVAILABLE: no validated ContextGenerationV3 at provider boundary",
        );
      }
      const rendered = renderGenerationForProvider(generation);
      observers.systemPromptValues.push(rendered.systemPrompt);
      options.callbacks?.onSystemPrompt?.(rendered.systemPrompt);
      return {
        systemPrompt: rendered.systemPrompt,
        messages: rendered.messages,
      };
    },
  });

  harness.on("before_agent_start", async (event: BeforeAgentStartEvent) => {
    void event;
    const { input, instanceEpoch } = options.currentInvocation;
    const layoutHash = computeContentLayoutHash(input, encodeInputFrames(input.blocks));
    const companion = createInputMetaCompanion(input, layoutHash, options.now, instanceEpoch);
    return { messages: [companion] };
  });

  harness.on("context", async (event: ContextEvent) => {
    observers.contextPasses += 1;
    options.callbacks?.onContext?.(event.messages);
    const { invocationId, runtimeSessionId } = options.currentInvocation;
    const result = transformContextMessages({
      invocationId,
      runtimeSessionId,
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
      instanceEpoch: options.currentInvocation.instanceEpoch,
      runtimeSessionId: options.currentInvocation.runtimeSessionId,
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
      options.callbacks?.onSettled?.(event as SettledEvent);
    }
  });

  return { harness, observers };
}
