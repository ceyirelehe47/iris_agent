import { mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import assert from "node:assert/strict";

import type { AgentRuntimeEvent, AgentRuntimePort } from "../src/contracts/runtime-ports.js";

import { defaultAgentConfig } from "../src/config/load.js";
import { initializeDataRoot, resolveDataRootPaths } from "../src/host/data-root.js";
import { createIrisHarness, type InvocationBinding } from "../src/runtime/harness-factory.js";
import { assembleIrisContext } from "../src/runtime/iris-context.js";
import { IrisContextBridge } from "../src/runtime/iris-bridge.js";
import { RuntimeEpochStore } from "../src/runtime/epoch-manager.js";
import { createMockProvider } from "../src/runtime/mock-provider.js";
import { RuntimeCoordinator } from "../src/runtime/runtime-coordinator.js";
import { PiRuntimeAdapter } from "../src/runtime/pi-runtime-adapter.js";
import {
  ActiveRuntimeRegistry,
  activeRuntimeHandle,
} from "../src/runtime/active-runtime-registry.js";
import { directUserRequest } from "../src/contracts/origin.js";
import type { AgentInput } from "../src/contracts/origin.js";
import {
  makeReadOnlyTestTool,
  prepareInvocation,
  sampleAgentInput,
} from "../src/runtime/vertical-slice.js";
import { openOrCreateSessionHelper } from "./helpers/slice-helpers.js";

/** 本文件所有 @iris/context 装配的清理注册表（文件结束统一 close）。 */
const openAssemblies: Array<{ close(): Promise<void> }> = [];
after(async () => {
  for (const assembly of openAssemblies) {
    await assembly.close().catch(() => undefined);
  }
  openAssemblies.length = 0;
});

function buildCoordinator(options?: { maxQueuedInputs?: number }): Promise<{
  coordinator: RuntimeCoordinator;
  currentInvocation: InvocationBinding;
  dataRoot: string;
}> {
  return (async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "iris-coordinator-"));
    const config = defaultAgentConfig();
    const input = sampleAgentInput();
    const now = "2026-08-01T00:00:00.000Z";
    const paths = resolveDataRootPaths(dataRoot, config);
    initializeDataRoot(dataRoot, config);
    const epochStore = new RuntimeEpochStore(
      paths.epochRegistryDb,
      config.runtime_sessions.session_id_prefix,
      config.runtime_sessions.timezone,
    );
    const epoch = epochStore.ensureActive(now);
    const currentInvocation = prepareInvocation(
      input,
      epoch.runtimeSessionId,
      epoch.epochId,
      epoch.ordinalWithinDate,
      config,
      now,
    );
    const { models, model } = createMockProvider();
    const sessionHandle = await openOrCreateSessionHelper(dataRoot, config, epoch.runtimeSessionId);
    const session = sessionHandle.session;
    const assembly = await assembleIrisContext({
      dataRoot: paths.dataRoot,
      runtimeSessionId: epoch.runtimeSessionId,
      providerProfileId: "mock-iris-provider-v1",
      canonicalSystemPrompt: currentInvocation.canonicalSystemPrompt,
      systemProjectionHash: createHash("sha256")
        .update(currentInvocation.canonicalSystemPrompt)
        .digest("hex"),
      preparedAt: currentInvocation.preparedAt,
      withHistorian: false,
      now: () => now,
      getCurrentSource: () => ({
        canonicalSystemPrompt: currentInvocation.canonicalSystemPrompt,
        personaSnapshotId: "persona-default-v1",
        providerProfileId: "mock-iris-provider-v1",
        toolDeclarations: ["test_read_tool"],
      }),
    });
    openAssemblies.push(assembly);
    const { harness } = createIrisHarness({
      session,
      instanceEpoch: epoch.ordinalWithinDate,
      models,
      model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation,
      now,
      providerProfileId: "mock-iris-provider-v1",
      irisContext: assembly.contextService,
    });
    const bridge = new IrisContextBridge({
      runtimeSessionId: epoch.runtimeSessionId,
      instanceEpoch: epoch.ordinalWithinDate,
      contextService: assembly.contextService,
      getInput: () => currentInvocation.input,
      now: () => now,
    });
    bridge.attach(harness);
    const adapter = new PiRuntimeAdapter({
      harness,
      session,
      binding: currentInvocation,
      repo: sessionHandle.repo,
    });
    const registry = new ActiveRuntimeRegistry();
    registry.install(activeRuntimeHandle(epoch, adapter, currentInvocation));
    const coordinator = new RuntimeCoordinator({
      activeRuntime: registry,
      prepareInvocation: async (nextInput: AgentInput, runtimeSessionId: string, epochId: string) =>
        prepareInvocation(
          nextInput,
          runtimeSessionId,
          epochId,
          epoch.ordinalWithinDate,
          config,
          now,
        ),
      ...(options?.maxQueuedInputs !== undefined
        ? { maxQueuedInputs: options.maxQueuedInputs }
        : {}),
    });
    return { coordinator, currentInvocation, dataRoot };
  })();
}

/** Build a coordinator backed by a controllable fake AgentRuntimePort. */
function buildFakeCoordinator(runtime: AgentRuntimePort): RuntimeCoordinator {
  const epoch = {
    epochId: "iris-runtime-2026-08-01-1",
    runtimeSessionId: "iris-runtime-2026-08-01-1",
    localDate: "2026-08-01",
    ordinalWithinDate: 1,
    status: "active" as const,
    createdAt: "2026-08-01T00:00:00.000Z",
  };
  const input = sampleAgentInput();
  const currentInvocation: InvocationBinding = {
    input,
    invocationId: "invocation-input-0001",
    runtimeSessionId: epoch.runtimeSessionId,
    epochId: epoch.epochId,
    instanceEpoch: 1,
    canonicalSystemPrompt: "test canonical system prompt",
    providerProfileId: "mock-iris-provider-v1",
    preparedAt: "2026-08-01T00:00:00.000Z",
  };
  const registry = new ActiveRuntimeRegistry();
  registry.install(activeRuntimeHandle(epoch, runtime, currentInvocation));
  return new RuntimeCoordinator({
    activeRuntime: registry,
    prepareInvocation: async (nextInput: AgentInput) => {
      void nextInput;
      return currentInvocation;
    },
  });
}

test("coordinator runs one invocation to settled and releases the latch", async () => {
  const { coordinator } = await buildCoordinator();
  const input = sampleAgentInput();

  const events: string[] = [];
  for await (const event of coordinator.prompt(input)) {
    events.push(event.type);
  }

  assert.ok(events.includes("turn_start"));
  assert.ok(events.includes("settled"));
  assert.equal(coordinator.getPhase(), "idle");

  // Latch released: a second invocation may start.
  const events2: string[] = [];
  for await (const event of coordinator.prompt(input)) {
    events2.push(event.type);
  }
  assert.ok(events2.includes("settled"));
});

test("coordinator rejects a second prompt while an invocation is active", async () => {
  const { coordinator } = await buildCoordinator();
  const input = sampleAgentInput();

  const iterator = coordinator.prompt(input)[Symbol.asyncIterator]();
  await iterator.next(); // turn_start consumed; latch now held

  await assert.rejects(
    (async () => {
      for await (const event of coordinator.prompt(input)) {
        void event;
      }
    })(),
    /already active/,
  );

  // Drain the original invocation to release the latch.
  await iterator.return?.();
});

test("coordinator queues inputs and reports queued count", async () => {
  const { coordinator } = await buildCoordinator();
  coordinator.enqueue(sampleAgentInput());
  coordinator.enqueue(sampleAgentInput());
  assert.equal(coordinator.queuedCount(), 2);
});

test("coordinator dequeues queued inputs in FIFO order", async () => {
  const { coordinator } = await buildCoordinator();
  const first = sampleAgentInput();
  const second = { ...sampleAgentInput(), inputId: "input-0002" };
  coordinator.enqueue(first);
  coordinator.enqueue(second);
  assert.equal(coordinator.dequeue()?.inputId, first.inputId);
  assert.equal(coordinator.dequeue()?.inputId, second.inputId);
  assert.equal(coordinator.dequeue(), undefined);
  assert.equal(coordinator.queuedCount(), 0);
});

test("coordinator forwards native tool_call and tool_result events", async () => {
  // Review blocker #2 (event forwarding): the port stream must carry the
  // native tool_call/tool_result events, not only turn_start/settled.
  const { coordinator } = await buildCoordinator();
  const input = sampleAgentInput();

  const eventTypes: string[] = [];
  const toolEvents: string[] = [];
  for await (const event of coordinator.prompt(input)) {
    eventTypes.push(event.type);
    if (event.type === "tool_call" || event.type === "tool_result") {
      toolEvents.push(`${event.type}:${event.toolName}`);
    }
  }

  assert.ok(eventTypes.includes("settled"));
  assert.ok(
    toolEvents.some((entry) => entry === "tool_call:test_read_tool"),
    `expected a native tool_call event, got ${JSON.stringify(toolEvents)}`,
  );
  assert.ok(
    toolEvents.some((entry) => entry === "tool_result:test_read_tool"),
    `expected a native tool_result event, got ${JSON.stringify(toolEvents)}`,
  );
});

test("second prompt rebinds companion and context to the current input", async () => {
  // Review blocker #1: after A settled, prompting B must pair B's companion
  // and B's InvocationBinding — never A's. The canonical system prompt
  // embeds the inputId, and the session companion metadata carries it.
  const { coordinator, currentInvocation } = await buildCoordinator();
  const inputA = sampleAgentInput();
  const inputB: AgentInput = {
    ...sampleAgentInput(),
    inputId: "input-0002",
    blocks: [
      {
        blockId: "block-0002",
        sourceOrigin: directUserRequest(),
        content: { mode: "inline_text", text: "second invocation" },
        contentHash: createHash("sha256").update("second invocation").digest("hex"),
      },
    ],
  };

  for await (const event of coordinator.prompt(inputA)) {
    assert.notEqual(event.type, "failed");
  }
  assert.equal(currentInvocation.input.inputId, inputA.inputId);

  for await (const event of coordinator.prompt(inputB)) {
    assert.notEqual(event.type, "failed");
  }

  // The binding slot now reflects B, and B's canonical system prompt was used.
  assert.equal(currentInvocation.input.inputId, inputB.inputId);
  assert.equal(currentInvocation.invocationId, `invocation-${inputB.inputId}`);
  assert.ok(
    currentInvocation.canonicalSystemPrompt.includes(inputB.inputId),
    "canonical system prompt must embed the current invocation's inputId",
  );
});

test("coordinator queue rejects beyond capacity", async () => {
  const { coordinator } = await buildCoordinator({ maxQueuedInputs: 1 });
  coordinator.enqueue(sampleAgentInput());
  assert.throws(() => {
    coordinator.enqueue(sampleAgentInput());
  }, /queue full/);
});

test("coordinator forwards abort to the Pi harness and releases the latch", async () => {
  // A controllable fake runtime that parks its prompt() until abort() is
  // called, then emits native settled — matching the Pi abort contract
  // (abort -> native agent_end/settled -> release invocation).
  let abortCalled = false;
  let releasePrompt: (() => void) | undefined;
  const promptGate = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  const runtime: AgentRuntimePort = {
    async *prompt(): AsyncIterable<AgentRuntimeEvent> {
      await promptGate;
      yield { type: "settled", invocationId: "invocation-input-0001", nextTurnCount: 0 };
    },
    async abort(): Promise<void> {
      abortCalled = true;
      releasePrompt?.();
    },
    getPhase(): "idle" | "turn" | "retry" | "compaction" | "branch_summary" | "failed" {
      return "idle";
    },
  };

  const coordinator = buildFakeCoordinator(runtime);
  const input = sampleAgentInput();
  const invocationId = `invocation-${input.inputId}`;
  const events: string[] = [];
  const promptPromise = (async () => {
    for await (const event of coordinator.prompt(input)) {
      events.push(event.type);
    }
  })();

  // Wait until the invocation is active, then abort with the correct id.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(coordinator.getPhase(), "turn");
  await coordinator.abort(invocationId);
  assert.equal(abortCalled, true);

  await promptPromise;
  assert.equal(coordinator.getPhase(), "idle");
  assert.ok(events.includes("turn_start"));
  // The coordinator only released the latch after observing native settled
  // (review blocker #2): abort alone must not release the invocation.
  assert.ok(events.includes("settled"));
  assert.equal(events.includes("failed"), false);

  // Abort with a wrong invocation id is rejected after the latch released.
  await assert.rejects(coordinator.abort("invocation-nonexistent"), /no active invocation/);
});

test("failed invocation holds the latch until reset (settled-gated)", async () => {
  // Review blocker #2 (round 2): a runtime that resolves WITHOUT emitting
  // native settled must enter the explicit failed path and keep the
  // single-writer latch held — a second prompt is rejected until reset().
  const runtime: AgentRuntimePort = {
    async *prompt(): AsyncIterable<AgentRuntimeEvent> {
      // No settled is ever emitted: the run must fail with settled_not_observed.
      yield { type: "failed", invocationId: "invocation-input-0001", code: "settled_not_observed" };
      return;
    },
    async abort(): Promise<void> {
      return undefined;
    },
    getPhase(): "idle" | "turn" | "retry" | "compaction" | "branch_summary" | "failed" {
      return "idle";
    },
  };

  const coordinator = buildFakeCoordinator(runtime);

  const events: string[] = [];
  for await (const event of coordinator.prompt(sampleAgentInput())) {
    events.push(event.type);
  }
  assert.ok(events.includes("failed"), "no-settled run must emit failed");
  assert.equal(coordinator.getPhase(), "failed");

  // Latch still held: a new prompt is rejected until reset().
  await assert.rejects(
    (async () => {
      for await (const event of coordinator.prompt(sampleAgentInput())) {
        void event;
      }
    })(),
    /already active|failed state/,
  );

  coordinator.reset();
  assert.equal(coordinator.getPhase(), "idle");
});

test("harness throw marks failed and rejects the next prompt until reset", async () => {
  // Review blocker #2 (round 2): when the runtime throws (provider failure),
  // the run fails and the latch stays held; reset() recovers.
  const runtime: AgentRuntimePort = {
    async *prompt(): AsyncIterable<AgentRuntimeEvent> {
      // The throw happens on first iteration; yield nothing before it so the
      // coordinator sees the runtime fail before any event is produced.
      yield { type: "failed", invocationId: "invocation-input-0001", code: "harness_error" };
      throw new Error("provider exploded");
    },
    async abort(): Promise<void> {
      return undefined;
    },
    getPhase(): "idle" | "turn" | "retry" | "compaction" | "branch_summary" | "failed" {
      return "idle";
    },
  };

  const coordinator = buildFakeCoordinator(runtime);

  await assert.rejects(
    (async () => {
      for await (const event of coordinator.prompt(sampleAgentInput())) {
        void event;
      }
    })(),
    /provider exploded/,
  );
  assert.equal(coordinator.getPhase(), "failed");

  await assert.rejects(
    (async () => {
      for await (const event of coordinator.prompt(sampleAgentInput())) {
        void event;
      }
    })(),
    /already active|failed state/,
  );

  coordinator.reset();
  assert.equal(coordinator.getPhase(), "idle");
});

test("generator closed while parked WITHOUT settled fails closed and KEEPS the latch (C5 #114)", async () => {
  // iris_agent#114 (Feature C5): iter.return() on a generator that never
  // observed native settled must NOT release the single-writer latch — the
  // invocation may still be live. phase->"failed" and activeInvocation is
  // kept; only reset() (explicit recovery) or a successful dispatch releases.
  const runtime: AgentRuntimePort = {
    async *prompt(): AsyncIterable<AgentRuntimeEvent> {
      yield { type: "turn_start", invocationId: "invocation-input-0001" };
      // The provider never emits again (stalled) — the inner await never
      // settles, so the coordinator generator is parked at its OWN yield of
      // turn_start when the consumer calls iter.return().
      await new Promise<never>(() => {
        /* never settles */
      });
    },
    async abort(): Promise<void> {
      return undefined;
    },
    getPhase(): "idle" | "turn" | "retry" | "compaction" | "branch_summary" | "failed" {
      return "idle";
    },
  };

  const coordinator = buildFakeCoordinator(runtime);
  const invocationId = "invocation-input-0001";

  const iterator = coordinator.prompt(sampleAgentInput())[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value.type, "turn_start");
  assert.equal(coordinator.getPhase(), "turn");

  // Close the generator while parked — the C5 fail-closed path.
  await iterator.return?.();

  // Generator cleanup is NOT native settled: fail closed with the latch kept.
  assert.equal(coordinator.getPhase(), "failed", "parked close without settled -> failed");
  assert.equal(
    coordinator.getActiveInvocationId(),
    invocationId,
    "activeInvocation must be KEPT — the invocation may still be live",
  );

  // A new prompt is rejected while the latch is held.
  await assert.rejects(
    (async () => {
      for await (const event of coordinator.prompt(sampleAgentInput())) {
        void event;
      }
    })(),
    /already active|failed state/,
  );

  // Explicit recovery (reset) releases the latch.
  coordinator.reset();
  assert.equal(coordinator.getPhase(), "idle");
  assert.equal(coordinator.getActiveInvocationId(), null);
});

test("generator closed AFTER native settled releases the latch (C5 #114)", async () => {
  // iris_agent#114 (Feature C5): when iter.return() interrupts the generator
  // AFTER Pi native settled was positively observed (the abort unblocked the
  // run and the settled event was forwarded), the settled observation — not
  // the generator close — authorizes the release: phase->"idle",
  // activeInvocation=null.
  const runtime: AgentRuntimePort = {
    async *prompt(): AsyncIterable<AgentRuntimeEvent> {
      yield { type: "turn_start", invocationId: "invocation-input-0001" };
      yield {
        type: "settled",
        invocationId: "invocation-input-0001",
        nextTurnCount: 1,
      };
    },
    async abort(): Promise<void> {
      return undefined;
    },
    getPhase(): "idle" | "turn" | "retry" | "compaction" | "branch_summary" | "failed" {
      return "idle";
    },
  };

  const coordinator = buildFakeCoordinator(runtime);

  const iterator = coordinator.prompt(sampleAgentInput())[Symbol.asyncIterator]();
  await iterator.next(); // turn_start (coordinator's own)
  await iterator.next(); // turn_start (forwarded)
  const settled = await iterator.next(); // settled — generator now parked here
  assert.equal(settled.done, false);
  assert.equal(settled.value.type, "settled");

  // Close the generator while parked AT the settled yield.
  await iterator.return?.();

  // Native settled was validated -> normal release, not fail-closed.
  assert.equal(coordinator.getPhase(), "idle");
  assert.equal(coordinator.getActiveInvocationId(), null);

  // The latch is free: a fresh invocation may start and settle.
  const events: string[] = [];
  for await (const event of coordinator.prompt(sampleAgentInput())) {
    events.push(event.type);
  }
  assert.ok(events.includes("settled"));
  assert.equal(coordinator.getPhase(), "idle");
});
