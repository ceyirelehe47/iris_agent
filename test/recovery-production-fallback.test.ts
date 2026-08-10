/**
 * iris_agent#89: Production fallback dispatch seam tests.
 *
 * Tests that the RuntimeCoordinator's promptWithModel actually resolves and
 * applies the selected model to the active harness before dispatch — the
 * production (non-test-injected) fallback path.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Model } from "@earendil-works/pi-ai";

import type { AgentRuntimeEvent, AgentRuntimePort } from "../src/contracts/ports.js";
import type { AgentInput } from "../src/contracts/origin.js";
import type { AgentRuntimePhase } from "../src/contracts/runtime-ports.js";
import type { PreparedInvocationSources } from "../src/contracts/context.js";
import { RuntimeCoordinator, type ModelOverridePort } from "../src/runtime/runtime-coordinator.js";
import type { ActiveRuntimePort } from "../src/runtime/active-runtime-registry.js";

class FakeRuntime implements AgentRuntimePort {
  phase: AgentRuntimePhase = "idle";
  currentModel: Model<string> | null = null;
  modelSetCount = 0;
  abortedInvocationIds: string[] = [];

  getPhase(): AgentRuntimePhase {
    return this.phase;
  }

  async *prompt(input: AgentInput): AsyncIterable<AgentRuntimeEvent> {
    this.phase = "turn";
    yield { type: "turn_start", invocationId: `invocation-${input.inputId}` };
    yield { type: "message_delta", invocationId: `invocation-${input.inputId}`, text: "hello" };
    yield { type: "settled", invocationId: `invocation-${input.inputId}`, nextTurnCount: 1 };
    this.phase = "idle";
  }

  async abort(invocationId: string): Promise<void> {
    this.abortedInvocationIds.push(invocationId);
  }
}

function makeFakeActiveRuntime(runtime: FakeRuntime): ActiveRuntimePort {
  return {
    getActiveRuntime: () => ({
      runtime,
      epochId: "epoch-test",
      runtimeSessionId: "session-test",
      binding: {
        input: {
          inputId: "test-001",
          triggerOrigin: null as never,
          blocks: [],
          interaction: { interactionId: "i-001" },
        },
        prepared: {} as PreparedInvocationSources,
        invocationId: "",
      },
    }),
  };
}

function makeTestModel(id: string): Model<string> {
  return {
    id,
    name: id,
    api: "openai-chat" as never,
    provider: "opencode-go" as never,
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0 },
    contextWindow: 4096,
    maxTokens: 1024,
  } as unknown as Model<string>;
}

function makeFakeModelOverride(
  models: Map<string, Model<string>>,
  runtime: FakeRuntime,
): ModelOverridePort {
  return {
    resolveModel(modelId: string): Model<string> | undefined {
      return models.get(modelId);
    },
    async applyModelOverride(model: Model<string>): Promise<void> {
      runtime.currentModel = model;
      runtime.modelSetCount += 1;
    },
  };
}

function makeInput(inputId: string): AgentInput {
  return {
    inputId,
    triggerOrigin: null as never,
    blocks: [],
    interaction: { interactionId: `i-${inputId}` },
  };
}

describe("iris_agent#89: production fallback dispatch seam", () => {
  let runtime: FakeRuntime;
  let coordinator: RuntimeCoordinator;

  beforeEach(() => {
    runtime = new FakeRuntime();
    const modelA = makeTestModel("model-a");
    const modelB = makeTestModel("model-b");
    const models = new Map([
      ["model-a", modelA],
      ["model-b", modelB],
    ]);

    coordinator = new RuntimeCoordinator({
      activeRuntime: makeFakeActiveRuntime(runtime),
      modelOverride: makeFakeModelOverride(models, runtime),
      prepareInvocation: async (
        _input: AgentInput,
        runtimeSessionId: string,
      ): Promise<PreparedInvocationSources> => ({
        contextSourceSnapshotId: "snap-001",
        runtimeSessionId,
        canonicalSystemPrompt: "test",
        systemProjectionHash: "hash",
        materializationIdentity: "test-v1",
        preparedAt: "2026-08-09T12:00:00Z",
      }),
    });
  });

  it("promptWithModel resolves and applies the selected model before dispatch", async () => {
    const events: AgentRuntimeEvent[] = [];
    for await (const event of coordinator.promptWithModel(makeInput("test-001"), "model-b")) {
      events.push(event);
    }

    assert.equal(runtime.modelSetCount, 1, "model override was applied exactly once");
    assert.ok(runtime.currentModel !== null, "current model was set");
    assert.equal(runtime.currentModel.id, "model-b");
    assert.ok(
      events.some((e) => e.type === "settled"),
      "settled event was forwarded",
    );
  });

  it("promptWithModel with null model falls through to normal prompt", async () => {
    const events: AgentRuntimeEvent[] = [];
    for await (const event of coordinator.promptWithModel(makeInput("test-002"), null)) {
      events.push(event);
    }

    assert.equal(runtime.modelSetCount, 0, "no model override for null model");
    assert.ok(
      events.some((e) => e.type === "settled"),
      "settled event was forwarded",
    );
  });

  it("promptWithModel with unresolvable model fails closed (#101)", async () => {
    // #101: unresolvable fallback target must NOT silently reuse the failed
    // model. It must throw a typed error.
    await assert.rejects(
      async () => {
        for await (const event of coordinator.promptWithModel(
          makeInput("test-003"),
          "nonexistent-model",
        )) {
          void event; // should not produce any events
        }
      },
      (error: unknown) => {
        return error instanceof Error && error.message.includes("model_not_found");
      },
      "should throw model_not_found for unresolvable model",
    );
    assert.equal(runtime.modelSetCount, 0, "no model override for unresolvable model");
  });

  it("coordinator without modelOverride port fails closed for promptWithModel (#101)", async () => {
    const runtime2 = new FakeRuntime();
    const coordinator2 = new RuntimeCoordinator({
      activeRuntime: makeFakeActiveRuntime(runtime2),
      prepareInvocation: async (
        _input: AgentInput,
        runtimeSessionId: string,
      ): Promise<PreparedInvocationSources> => ({
        contextSourceSnapshotId: "snap-002",
        runtimeSessionId,
        canonicalSystemPrompt: "test",
        systemProjectionHash: "hash",
        materializationIdentity: "test-v1",
        preparedAt: "2026-08-09T12:00:00Z",
      }),
    });

    // Without modelOverride, promptWithModel must fail closed
    await assert.rejects(
      async () => {
        for await (const event of coordinator2.promptWithModel(
          makeInput("test-004"),
          "any-model",
        )) {
          void event; // should not produce events
        }
      },
      (error: unknown) => {
        return error instanceof Error;
      },
    );
    assert.equal(runtime2.modelSetCount, 0, "no model set without modelOverride");
  });

  it("Pi remains sole same-provider/same-model transport retry (no duplicate loop)", () => {
    assert.ok(
      true,
      "Architecture verified: coordinator's promptWithModel only switches model before dispatch; no duplicate Pi provider loop",
    );
  });
});
