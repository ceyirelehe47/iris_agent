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

import type { PreparedV2Sources } from "../contracts/context-v27.js";
import type { AgentInput } from "../contracts/origin.js";
import { computeToolExecutionKey, canonicalJson } from "../contracts/tool.js";
import {
  computeContentLayoutHash,
  createInputMetaCompanion,
  encodeInputFrames,
} from "./companion.js";
import { foldLiveTurnMessages } from "./context-adapter.js";
import type { ContextIngestPort } from "../contracts/context-units.js";
import {
  buildGenerationV2,
  payloadAsJsonValue,
  projectStoreUnitToV1,
} from "../context/v2-generation.js";
import { renderGenerationV2 } from "../context/v2-renderer.js";

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
  /** v27: the most recent validated ContextGenerationV2 built by the
   * contextController (undefined until the first provider call). */
  lastGenerationV2: import("../contracts/context-v27.js").ContextGenerationV2 | undefined;
}

/**
 * Per-invocation binding. The harness is stateful (it owns the Pi Session and
 * the transcript), so it is created once per runtime Session; each prompt()
 * invocation updates this binding so companion pairing and the context hook
 * reflect the CURRENT input, not the first one.
 */
export interface InvocationBinding {
  input: AgentInput;
  prepared: PreparedV2Sources;
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
    lastGenerationV2: undefined,
  };

  const harness = new AgentHarness({
    session: options.session,
    models: options.models,
    model: options.model,
    tools: options.tools,
    thinkingLevel: "off",
    // R2-P0（Roadmap v27）：Iris 正常 Provider path 从 ContextMessageUnit
    // 语义 ledger 投影（contextIngest.listUnits），不再调用 Session
    // buildContext 也不再依赖 session.getEntries 投影。companion 折叠已在
    // ingest 完成；当前 turn 的 live pair 由 context hook 折叠。
    // v27：正常 assembly 走 V2 pipeline —— P0-P2 来自 prepared 冻结源，
    // P3/P4 通过稳定 read ports（R2 为空），P5 为已提交 durable 单元的
    // 1:1 确定性投影；渲染只消费 validated ContextGenerationV2。
    contextController: async () => {
      const { prepared } = options.currentInvocation;
      const runtimeSessionId = prepared.runtimeSessionId;
      const units = options.contextIngest?.listUnits(runtimeSessionId) ?? [];
      const generation = buildGenerationV2({
        lineageId: prepared.lineageId,
        runtimeSessionId,
        generationSourceId: prepared.contextSourceSnapshotId,
        sourceSnapshotHash: prepared.sourceSnapshotHash,
        p0: {
          systemPromptId: prepared.systemPromptId,
          text: prepared.canonicalSystemPrompt,
          sourceHash: prepared.systemProjectionHash,
        },
        p1: {
          personaSnapshotId: prepared.personaSnapshotId,
          text: prepared.renderedPersona,
          sourceHash: prepared.personaContentHash,
        },
        p2: {
          declarationVersion: prepared.declarationVersion,
          text: prepared.declarationsSerialized,
          sourceHash: prepared.declarationsHash,
        },
        p3: [],
        p4: [],
        p5: units.map((unit) => ({
          unit: projectStoreUnitToV1(unit),
          semanticContent: payloadAsJsonValue(unit.payload),
        })),
      });
      observers.lastGenerationV2 = generation;
      const rendered = renderGenerationV2(generation);
      // P0 unit 的 semanticContent 即 canonical system prompt（与
      // prepared.canonicalSystemPrompt 同源同字节）。
      observers.systemPromptValues.push(rendered.systemPrompt);
      options.callbacks?.onSystemPrompt?.(rendered.systemPrompt);
      return {
        systemPrompt: rendered.systemPrompt,
        messages: rendered.messages,
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
    // v27: live steer-pair fold（companion 剥离 + provenance 标注）。V2 渲染
    // 产生的 synthetic P1–P4 消息与 P5 payload 原样透传，绝不二次折叠。
    return { messages: foldLiveTurnMessages(event.messages) };
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
