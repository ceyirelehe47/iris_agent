/**
 * iris_agent#111: REAL Host-composition integration tests for qualified
 * fallback identity (Feature C).
 *
 * Composes the production dispatch path EXACTLY as IrisHost does
 * (src/host/host.ts): RecoverySupervisor → RuntimeCoordinator.promptWithModel
 * → ModelOverridePort → ActiveRuntimeRegistry → PiRuntimeAdapter → AgentHarness.
 *
 * The ONLY fake boundary is the AgentHarness itself (the "realistic fake
 * harness boundary"): a per-capsule scriptable harness that mirrors Pi's
 * event contract (message_update / tool_execution_start / tool_execution_end
 * / settled, abort → settled). Everything else is REAL production code:
 *
 *   - real pi-ai catalog (fauxProvider + createModels) with DUPLICATE model
 *     id "model-x" registered under provider-a AND provider-b
 *   - real defaultFallbackConfig(models.getModels().map(m => `${m.provider}/${m.id}`))
 *     exactly as host.ts:1071 — the fallback chain is QUALIFIED
 *   - real resolveFallbackModel (qualified, fail-closed on ambiguity)
 *   - real PiRuntimeAdapter.getCurrentModelId() — QUALIFIED identity (#111)
 *   - real RuntimeCoordinator.promptWithModel qualified comparison (#111)
 *   - real ActiveRuntimeRegistry.casSwap rollover + registry-routed
 *     applyModelOverride (rollover-safe: never a stale adapter closure)
 *   - real RecoverySupervisor loop — the full watchdog → abort → native
 *     settled → advance-chain → promptWithModel fallback cycle runs against
 *     the real coordinator (no test-injected dispatch)
 *   - real prepareContextSources / freshRecoveryState / sampleAgentInput
 *
 * Scenario coverage (#111 AC):
 *   1. duplicate model id across providers → fallback a/model-x → b/model-x
 *      calls setModel (qualified identity differs although model.id matches)
 *   2. rollover then fallback → new Capsule setModel exactly once, old
 *      Capsule zero times after rollover
 *   3. provider dispatch target → post-fallback dispatch handled by provider-b
 *   4. getActiveModelId switches "provider-a/model-x" → "provider-b/model-x"
 *   5. stale adapter setModel after rollover has zero effect on the active
 *      capsule
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createModels, fauxProvider, type Model } from "@iris/pi-ai";
import type { AgentHarness, Session } from "@iris/pi-agent-core";

import type { AgentRuntimeEvent } from "../src/contracts/ports.js";
import type { AgentInput } from "../src/contracts/origin.js";
import type { InvocationSourceBinding } from "../src/contracts/context.js";
import type { InvocationBinding } from "../src/runtime/harness-factory.js";
import {
  RuntimeCoordinator,
  resolveFallbackModel,
  type ModelOverridePort,
} from "../src/runtime/runtime-coordinator.js";
import { PiRuntimeAdapter } from "../src/runtime/pi-runtime-adapter.js";
import {
  ActiveRuntimeRegistry,
  activeRuntimeHandle,
  type ActiveRuntimeHandle,
} from "../src/runtime/active-runtime-registry.js";
import {
  RecoverySupervisor,
  type RecoveryEscalationEvent,
  type RecoverySupervisorEvent,
} from "../src/runtime/recovery-supervisor.js";
import { defaultFallbackConfig, freshRecoveryState } from "../src/runtime/recovery-state.js";
import { defaultAgentConfig } from "../src/config/load.js";
import { prepareContextSources, sampleAgentInput } from "../src/runtime/vertical-slice.js";

// ---------------------------------------------------------------------------
// Realistic fake harness boundary (per Capsule). Mirrors the Pi harness event
// contract the PiRuntimeAdapter bridges: message_update → tool events →
// settled; abort() resolves a parked prompt and emits native settled
// (abort → agent_end/settled contract the Coordinator relies on).
// ---------------------------------------------------------------------------

interface FakeHarnessEvent {
  type: string;
  assistantMessageEvent?: { type: string; delta?: string; text?: string };
  toolCallId?: string;
  toolName?: string;
  nextTurnCount?: number;
}

class FakeHarness {
  currentModel: Model<string>;
  /** Every setModel call this harness received (order preserved). */
  setModelCalls: Model<string>[] = [];
  /** Provider of the model that was active when each prompt() dispatched. */
  dispatchProviders: string[] = [];
  promptCalls = 0;
  /** When true, the next prompt() streams a delta then parks until abort(). */
  parkNextDispatch = false;

  private readonly listeners = new Set<(event: FakeHarnessEvent) => void>();
  private parkedPrompt: { resolve: () => void } | null = null;

  constructor(initialModel: Model<string>) {
    this.currentModel = initialModel;
  }

  getModel(): Model<string> {
    return this.currentModel;
  }

  async setModel(model: Model<string>): Promise<void> {
    this.setModelCalls.push(model);
    this.currentModel = model;
  }

  subscribe(listener: (event: FakeHarnessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: FakeHarnessEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  async prompt(text: string): Promise<unknown> {
    void text;
    this.promptCalls += 1;
    this.dispatchProviders.push(this.currentModel.provider);
    this.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: `reply-${this.promptCalls}` },
    });
    if (this.parkNextDispatch) {
      this.parkNextDispatch = false;
      // Simulate a provider that streamed one delta then stalled: the
      // supervisor's no-progress watchdog must abort this dispatch.
      await new Promise<void>((resolve) => {
        this.parkedPrompt = { resolve };
      });
    }
    // Real harness contract: agent_end then settled (C7 #124 binding).
    this.emit({ type: "agent_end" });
    this.emit({ type: "settled", nextTurnCount: this.promptCalls });
    return { role: "assistant", content: [{ type: "text", text: "ok" }] };
  }

  async abort(): Promise<unknown> {
    // Pi abort contract: abort → native agent_end/settled.
    this.parkedPrompt?.resolve();
    this.parkedPrompt = null;
    this.emit({ type: "agent_end" });
    this.emit({ type: "settled", nextTurnCount: this.promptCalls });
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// Composition: mirrors IrisHost's production wiring (host.ts:969-1089)
// ---------------------------------------------------------------------------

const EPOCH_A = {
  epochId: "iris-runtime-2026-08-01-1",
  runtimeSessionId: "iris-runtime-2026-08-01-1",
  localDate: "2026-08-01",
  ordinalWithinDate: 1,
  status: "active" as const,
  createdAt: "2026-08-01T00:00:00.000Z",
};

const EPOCH_B = {
  epochId: "iris-runtime-2026-08-01-2",
  runtimeSessionId: "iris-runtime-2026-08-01-2",
  localDate: "2026-08-01",
  ordinalWithinDate: 2,
  status: "active" as const,
  createdAt: "2026-08-01T00:00:00.000Z",
};

const NOW_ISO = "2026-08-01T12:00:00.000Z";

interface Capsule {
  harness: FakeHarness;
  adapter: PiRuntimeAdapter;
  binding: InvocationBinding;
}

function makeBinding(epoch: { epochId: string; runtimeSessionId: string }): InvocationBinding {
  const config = defaultAgentConfig();
  const placeholder = sampleAgentInput();
  return {
    input: placeholder,
    prepared: prepareContextSources(
      placeholder,
      epoch.runtimeSessionId,
      epoch.epochId,
      config,
      NOW_ISO,
    ),
    invocationId: `invocation-${epoch.epochId}`,
  };
}

/** Build one Capsule: REAL PiRuntimeAdapter over the scripted harness. */
function makeCapsule(
  epoch: { epochId: string; runtimeSessionId: string },
  initialModel: Model<string>,
): Capsule {
  const binding = makeBinding(epoch);
  const harness = new FakeHarness(initialModel);
  const adapter = new PiRuntimeAdapter({
    harness: harness as unknown as AgentHarness,
    session: { getEntries: async () => [] } as unknown as Session,
    binding,
    repo: {
      async [Symbol.asyncDispose](): Promise<void> {
        return undefined;
      },
    },
  });
  return { harness, adapter, binding };
}

interface HostComposition {
  registry: ActiveRuntimeRegistry;
  coordinator: RuntimeCoordinator;
  supervisor: RecoverySupervisor;
  modelOverride: ModelOverridePort;
  catalog: Model<string>[];
  modelA: Model<string>;
  modelB: Model<string>;
  capsuleA: Capsule;
  handleA: ActiveRuntimeHandle;
  capsuleB: Capsule;
  handleB: ActiveRuntimeHandle;
}

/**
 * REAL pi-ai catalog with a duplicate model id across two providers
 * (provider-a/model-x AND provider-b/model-x) — the #111 scenario.
 */
function buildComposition(): HostComposition {
  const fauxA = fauxProvider({ provider: "provider-a", models: [{ id: "model-x" }] });
  const fauxB = fauxProvider({ provider: "provider-b", models: [{ id: "model-x" }] });
  const models = createModels();
  models.setProvider(fauxA.provider);
  models.setProvider(fauxB.provider);
  const catalog = models.getModels() as Model<string>[];
  const modelA = fauxA.getModel("model-x");
  const modelB = fauxB.getModel("model-x");
  if (!modelA || !modelB) throw new Error("test setup: model-x not found");
  assert.equal(modelA.id, modelB.id, "fixture: duplicate model id across providers");
  assert.notEqual(modelA.provider, modelB.provider, "fixture: providers must differ");

  // host.ts:1071 — the fallback chain is QUALIFIED provider/model.
  const config = defaultFallbackConfig(catalog.map((m) => `${m.provider}/${m.id}`));
  assert.deepEqual(config.models, ["provider-a/model-x", "provider-b/model-x"]);
  // Shorten ONLY the watchdog window; everything else keeps production
  // defaults (same-model budget, cooldowns, overall budget, timeouts).
  config.fallbackNoProgressTimeoutMs = 40;

  const registry = new ActiveRuntimeRegistry();
  const capsuleA = makeCapsule(EPOCH_A, modelA);
  const handleA = activeRuntimeHandle(EPOCH_A, capsuleA.adapter, capsuleA.binding);
  registry.install(handleA);
  const capsuleB = makeCapsule(EPOCH_B, modelA);
  const handleB = activeRuntimeHandle(EPOCH_B, capsuleB.adapter, capsuleB.binding);

  // host.ts:1012-1039 — the production ModelOverridePort: resolve through
  // resolveFallbackModel over the live catalog, apply through the CURRENT
  // active Capsule via the registry (never a stale adapter closure), and
  // reflect the active adapter's QUALIFIED identity.
  const modelOverride: ModelOverridePort = {
    resolveModel(modelId: string) {
      return resolveFallbackModel(catalog, modelId);
    },
    async applyModelOverride(modelToApply) {
      const activeHandle = registry.getActiveOrNull();
      if (activeHandle === null) {
        throw new Error("cannot apply model override: no active runtime capsule");
      }
      const activeAdapter = activeHandle.runtime as PiRuntimeAdapter;
      await activeAdapter.setModel(modelToApply as Model<string>);
    },
    getActiveModelId() {
      const activeHandle = registry.getActiveOrNull();
      if (activeHandle === null) {
        return undefined;
      }
      const activeAdapter = activeHandle.runtime as PiRuntimeAdapter;
      return activeAdapter.getCurrentModelId?.();
    },
  };

  const coordinator = new RuntimeCoordinator({
    activeRuntime: registry,
    modelOverride,
    prepareInvocation: async (
      input: AgentInput,
      runtimeSessionId: string,
      epochId: string,
    ): Promise<InvocationSourceBinding> =>
      prepareContextSources(input, runtimeSessionId, epochId, defaultAgentConfig(), NOW_ISO),
  });

  const supervisor = new RecoverySupervisor({
    runtime: coordinator,
    config,
    // host.ts:1083-1088 — no operation-specific effect evidence: fail closed.
    reconcileOutcomeUnknown: async () => "ambiguous",
    sleep: async () => undefined,
  });

  return {
    registry,
    coordinator,
    supervisor,
    modelOverride,
    catalog,
    modelA,
    modelB,
    capsuleA,
    handleA,
    capsuleB,
    handleB,
  };
}

/** host.ts:467-477 — one logical execution through the REAL supervisor. */
async function runSupervised(
  supervisor: RecoverySupervisor,
  input: AgentInput,
  logicalExecutionId: string,
): Promise<RecoverySupervisorEvent[]> {
  const events: RecoverySupervisorEvent[] = [];
  for await (const event of supervisor.prompt(input, {
    logicalExecutionId,
    initialState: freshRecoveryState(logicalExecutionId, new Date().toISOString()),
  })) {
    events.push(event);
  }
  return events;
}

function fallbackEvents(events: RecoverySupervisorEvent[]): RecoveryEscalationEvent[] {
  return events.filter(
    (e): e is RecoveryEscalationEvent =>
      e.type === "recovery_escalation" && e.action === "fallback",
  );
}

function activeQualifiedId(c: HostComposition): string | undefined {
  return c.modelOverride.getActiveModelId?.();
}

function inputWithId(inputId: string): AgentInput {
  return { ...sampleAgentInput(), inputId };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

test("#111 AC1: duplicate model id across providers — fallback a/model-x → b/model-x calls setModel (qualified identity)", async () => {
  const c = buildComposition();

  // Attempt 1 through the REAL supervisor: the active model is already
  // provider-a/model-x, so the qualified comparison must SKIP setModel.
  const events1 = await runSupervised(
    c.supervisor,
    sampleAgentInput(),
    "logical-exec-1:input-0001",
  );
  assert.ok(events1.some((e) => e.type === "settled"));
  assert.equal(
    c.capsuleA.harness.setModelCalls.length,
    0,
    "same qualified model must not re-setModel on the initial dispatch",
  );
  // The supervisor tracked the QUALIFIED model that settled.
  assert.equal(c.supervisor.getState()?.currentModel, "provider-a/model-x");

  // Fallback dispatch to provider-b/model-x — same model.id ("model-x") as
  // the currently active model, DIFFERENT provider. #111 regression: the
  // old comparison (qualified id vs bare model.id) skipped setModel here.
  const events2: AgentRuntimeEvent[] = [];
  for await (const event of c.coordinator.promptWithModel(
    inputWithId("input-0002"),
    "provider-b/model-x",
  )) {
    events2.push(event);
  }
  assert.ok(events2.some((e) => e.type === "settled"));

  // setModel MUST be applied exactly once for the cross-provider fallback.
  assert.equal(
    c.capsuleA.harness.setModelCalls.length,
    1,
    "setModel must be called when the qualified identity differs",
  );
  const applied = c.capsuleA.harness.setModelCalls[0];
  assert.ok(applied !== undefined);
  assert.equal(applied.id, "model-x");
  assert.equal(applied.provider, "provider-b");
  // The harness model actually switched to the provider-b model.
  assert.equal(c.capsuleA.harness.getModel().provider, "provider-b");
});

test("#111 AC2: rollover then fallback — new Capsule setModel exactly once, old Capsule zero after rollover", async () => {
  const c = buildComposition();

  // Invocation 1 on Capsule A through the REAL supervisor: settles normally.
  const events1 = await runSupervised(
    c.supervisor,
    sampleAgentInput(),
    "logical-exec-1:input-0001",
  );
  assert.ok(events1.some((e) => e.type === "settled"));
  assert.equal(c.capsuleA.harness.setModelCalls.length, 0);

  // Rollover: REAL registry CAS swaps Capsule A for Capsule B.
  assert.equal(c.registry.casSwap(EPOCH_A.epochId, c.handleB), true);
  assert.equal(c.registry.getActiveRuntime().epochId, EPOCH_B.epochId);

  // Invocation 2 on the NEW active Capsule (B) through the supervisor.
  const events2 = await runSupervised(
    c.supervisor,
    inputWithId("input-0002"),
    "logical-exec-1:input-0002",
  );
  assert.ok(events2.some((e) => e.type === "settled"));
  assert.equal(c.capsuleB.harness.setModelCalls.length, 0, "no redundant setModel on Capsule B");

  // Fallback fires on Capsule B: the override port routes through the
  // registry to the CURRENT active Capsule — exactly once, on B.
  const events3: AgentRuntimeEvent[] = [];
  for await (const event of c.coordinator.promptWithModel(
    inputWithId("input-0003"),
    "provider-b/model-x",
  )) {
    events3.push(event);
  }
  assert.ok(events3.some((e) => e.type === "settled"));

  assert.equal(
    c.capsuleB.harness.setModelCalls.length,
    1,
    "fallback after rollover must setModel on the NEW active Capsule exactly once",
  );
  assert.equal(c.capsuleB.harness.setModelCalls[0]?.provider, "provider-b");
  assert.equal(
    c.capsuleA.harness.setModelCalls.length,
    0,
    "the rolled-over Capsule must receive ZERO setModel calls after rollover",
  );
  assert.equal(c.capsuleA.harness.getModel().provider, "provider-a", "old Capsule model untouched");
});

test("#111 AC3: provider dispatch target — post-fallback dispatch is handled by provider-b", async () => {
  const c = buildComposition();

  const events1 = await runSupervised(
    c.supervisor,
    sampleAgentInput(),
    "logical-exec-1:input-0001",
  );
  assert.ok(events1.some((e) => e.type === "settled"));
  const events2: AgentRuntimeEvent[] = [];
  for await (const event of c.coordinator.promptWithModel(
    inputWithId("input-0002"),
    "provider-b/model-x",
  )) {
    events2.push(event);
  }
  assert.ok(events2.some((e) => e.type === "settled"));

  // The harness records the provider of the model active at each dispatch:
  // attempt 1 went through provider-a (no setModel), the fallback dispatch
  // through provider-b (setModel applied before the dispatch).
  assert.deepEqual(
    c.capsuleA.harness.dispatchProviders,
    ["provider-a", "provider-b"],
    "attempt 1 dispatches through provider-a; the fallback dispatch must go through provider-b",
  );
});

test("#111 AC4: getActiveModelId switches across provider fallback (a/model-x → b/model-x)", async () => {
  const c = buildComposition();

  // Before any fallback: the ACTIVE capsule reports the qualified provider-a id.
  assert.equal(activeQualifiedId(c), "provider-a/model-x");
  assert.equal(
    (c.registry.getActiveRuntime().runtime as PiRuntimeAdapter).getCurrentModelId(),
    "provider-a/model-x",
  );

  await runSupervised(c.supervisor, sampleAgentInput(), "logical-exec-1:input-0001");
  assert.equal(activeQualifiedId(c), "provider-a/model-x", "settle does not change the model");

  for await (const _event of c.coordinator.promptWithModel(
    inputWithId("input-0002"),
    "provider-b/model-x",
  )) {
    void _event;
  }

  // After fallback + setModel: the SAME port reflects provider-b/model-x.
  assert.equal(activeQualifiedId(c), "provider-b/model-x");
  assert.equal(
    (c.registry.getActiveRuntime().runtime as PiRuntimeAdapter).getCurrentModelId(),
    "provider-b/model-x",
  );

  // Redundant-dispatch guard is stable: re-dispatching the now-active
  // qualified model must NOT call setModel again (the old #111 comparison —
  // qualified id vs bare model.id — would have re-set).
  const before = c.capsuleA.harness.setModelCalls.length;
  const events3: AgentRuntimeEvent[] = [];
  for await (const event of c.coordinator.promptWithModel(
    inputWithId("input-0003"),
    "provider-b/model-x",
  )) {
    events3.push(event);
  }
  assert.ok(events3.some((e) => e.type === "settled"));
  assert.equal(
    c.capsuleA.harness.setModelCalls.length,
    before,
    "re-dispatch of the active qualified model must skip setModel",
  );
  assert.deepEqual(c.capsuleA.harness.dispatchProviders, [
    "provider-a",
    "provider-b",
    "provider-b",
  ]);
});

test("#111 AC5: stale adapter setModel after rollover has zero effect on the current active capsule", async () => {
  const c = buildComposition();

  // Settle Capsule A, then roll over to Capsule B (no fallback yet).
  const events1 = await runSupervised(
    c.supervisor,
    sampleAgentInput(),
    "logical-exec-1:input-0001",
  );
  assert.ok(events1.some((e) => e.type === "settled"));
  assert.equal(c.registry.casSwap(EPOCH_A.epochId, c.handleB), true);

  // A stale path calls setModel on the OLD adapter (the rolled-over
  // Capsule A). It mutates only the old Capsule's harness — the registry
  // still routes all overrides to the CURRENT active Capsule.
  await c.capsuleA.adapter.setModel(c.modelB);
  assert.equal(c.capsuleA.harness.getModel().provider, "provider-b", "stale harness mutated");
  assert.equal(
    (c.registry.getActiveRuntime().runtime as PiRuntimeAdapter).getModel().provider,
    "provider-a",
    "active capsule model must be unaffected by the stale adapter call",
  );
  assert.equal(
    activeQualifiedId(c),
    "provider-a/model-x",
    "active qualified identity unchanged by the stale adapter call",
  );
  assert.equal(c.capsuleB.harness.setModelCalls.length, 0, "active harness untouched so far");

  // Now the production fallback fires on the active Capsule: the override
  // port routes through the registry to Capsule B — Capsule A's stale model
  // is never consulted.
  for await (const _event of c.coordinator.promptWithModel(
    inputWithId("input-0002"),
    "provider-b/model-x",
  )) {
    void _event;
  }

  assert.equal(c.capsuleB.harness.setModelCalls.length, 1, "fallback setModel lands on Capsule B");
  assert.equal(c.capsuleB.harness.setModelCalls[0]?.provider, "provider-b");
  assert.equal(
    activeQualifiedId(c),
    "provider-b/model-x",
    "active qualified identity now reflects the fallback on Capsule B",
  );
  // Capsule A received exactly ONE setModel — the stale direct call. The
  // production override path never reached it after rollover.
  assert.equal(
    c.capsuleA.harness.setModelCalls.length,
    1,
    "old Capsule receives zero override-path setModel calls after rollover",
  );
});

test("#111 AC6: watchdog-driven supervisor fallback runs end-to-end against the real coordinator (a/model-x → b/model-x)", async () => {
  const c = buildComposition();
  // The first dispatch stalls after one delta; the supervisor's no-progress
  // watchdog (40ms, shortened for the test) must abort it, observe native
  // settled, advance the QUALIFIED chain, and re-dispatch via promptWithModel
  // on provider-b/model-x.
  c.capsuleA.harness.parkNextDispatch = true;

  assert.equal(activeQualifiedId(c), "provider-a/model-x");

  const events = await runSupervised(c.supervisor, sampleAgentInput(), "logical-exec-1:input-0001");

  // The supervisor advanced the fallback chain to the QUALIFIED next target.
  const fallbacks = fallbackEvents(events);
  assert.equal(fallbacks.length, 1, "exactly one fallback escalation");
  assert.equal(fallbacks[0]?.nextModel, "provider-b/model-x");

  // #111 regression: resolved.id ("model-x") equals the harness's current
  // model id, but the QUALIFIED identity differs — setModel must still be
  // applied exactly once, on the fallback dispatch.
  assert.equal(c.capsuleA.harness.setModelCalls.length, 1);
  assert.equal(c.capsuleA.harness.setModelCalls[0]?.provider, "provider-b");
  assert.equal(c.capsuleA.harness.getModel().provider, "provider-b");

  // Dispatch order: attempt 1 (provider-a, stalled→aborted), fallback
  // (provider-b, settled).
  assert.deepEqual(c.capsuleA.harness.dispatchProviders, ["provider-a", "provider-b"]);

  // Settled outcome + durable state reflect the qualified fallback model.
  assert.ok(
    events.some((e) => e.type === "settled"),
    "supervisor stream must settle",
  );
  assert.equal(c.supervisor.getState()?.currentModel, "provider-b/model-x");
  assert.equal(activeQualifiedId(c), "provider-b/model-x");
});
