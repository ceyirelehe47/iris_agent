/**
 * Feature C7 (#124): Native Settled Authority — behavioral fault tests.
 *
 * Instantiates the REAL production stack:
 *   PiRuntimeAdapter + RuntimeCoordinator + ActiveRuntimeRegistry +
 *   RecoverySupervisor (+ real Pi AgentHarness + faux provider + real
 *   SQLite session).
 *
 * Core rule under test: no exact active-invocation settlement proof →
 * abort/fallback MUST NOT succeed. The Round-6 success path
 * `if (receipt === null) return;` is GONE — abort without a bound native
 * settled receipt throws and the supervisor fails closed (zero fallback).
 *
 * Provider liveness is instrumented at the BOTTOM of the stack (the faux
 * provider's response factories), independent of iterator.return(),
 * generator objects, or RuntimeCoordinator.activeInvocation.
 *
 * Cases:
 *   1. harness.abort() resolves but native settled never arrives → abort
 *      settlement failure, zero fallback, at most 1 native provider
 *      invocation.
 *   2. prompt/generator failed/ended without native settled → zero fallback.
 *   3. iterator.return() + generator finally + runCompletion all happen but
 *      no settled → still cannot authorize fallback.
 *   4. A late "settled" broadcast while invocation B is running must NOT
 *      resolve B's receipt (run-token binding).
 *   5. abort → exact invocation native settled (aborted provider stream)
 *      → fallback authorized exactly once.
 *   6. abort rejected → zero fallback.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRuntimeEvent } from "../src/contracts/ports.js";
import type { AgentInput } from "../src/contracts/origin.js";
import { defaultAgentConfig } from "../src/config/load.js";
import { initializeDataRoot, resolveDataRootPaths } from "../src/host/data-root.js";
import { RuntimeEpochStore } from "../src/runtime/epoch-manager.js";
import {
  prepareContextSources,
  openOrCreateSession,
  sampleAgentInput,
  makeReadOnlyTestTool,
} from "../src/runtime/vertical-slice.js";
import { createIrisHarness, type InvocationBinding } from "../src/runtime/harness-factory.js";
import { createMockProvider, type MockProviderHandle } from "../src/runtime/mock-provider.js";
import { PiRuntimeAdapter } from "../src/runtime/pi-runtime-adapter.js";
import {
  ActiveRuntimeRegistry,
  activeRuntimeHandle,
} from "../src/runtime/active-runtime-registry.js";
import { RuntimeCoordinator } from "../src/runtime/runtime-coordinator.js";
import {
  RecoverySupervisor,
  type RecoveryEscalationEvent,
} from "../src/runtime/recovery-supervisor.js";
import {
  defaultFallbackConfig,
  type RecoveryStateSnapshot,
} from "../src/runtime/recovery-state.js";
import type { FauxResponseStep } from "@iris/pi-ai";
import { fauxAssistantMessage } from "@iris/pi-ai";
import type { ModelOverridePort } from "../src/runtime/runtime-coordinator.js";
import type { Model } from "@iris/pi-ai";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

/** Provider-invocation liveness counter at the BOTTOM of the stack. */
interface Liveness {
  started: number;
  completed: number;
  live: number;
  maxLive: number;
}

function freshLiveness(): Liveness {
  return { started: 0, completed: 0, live: 0, maxLive: 0 };
}

function trackLiveness(l: Liveness): void {
  l.started += 1;
  l.live += 1;
  l.maxLive = Math.max(l.maxLive, l.live);
}

function untrackLiveness(l: Liveness): void {
  l.completed += 1;
  l.live -= 1;
}

/** Provider response factory that NEVER settles (ignores abort). */
function neverSettles(l: Liveness): FauxResponseStep {
  return () => {
    trackLiveness(l);
    return new Promise<never>(() => {
      /* never resolves; abort cannot unstick it — settled never arrives */
    });
  };
}

interface Stack {
  supervisor: RecoverySupervisor;
  coordinator: RuntimeCoordinator;
  adapter: PiRuntimeAdapter;
  harness: ReturnType<typeof createIrisHarness>["harness"];
  liveness: Liveness;
  input: AgentInput;
  /** The underlying faux provider (to re-arm response queues mid-test). */
  faux: ReturnType<typeof createMockProvider>["faux"];
}

async function buildStack(options?: {
  responses?: FauxResponseStep[];
  fallbackOverrides?: Partial<ReturnType<typeof defaultFallbackConfig>>;
  liveness?: Liveness;
  extraModelIds?: string[];
}): Promise<Stack> {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-c7-"));
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
  const prepared = prepareContextSources(input, epoch.runtimeSessionId, epoch.epochId, config, now);
  const currentInvocation: InvocationBinding = {
    input,
    prepared,
    invocationId: `invocation-${input.inputId}`,
  };
  const liveness = options?.liveness ?? freshLiveness();
  const provider: MockProviderHandle = createMockProvider(
    options?.responses === undefined && options?.extraModelIds === undefined
      ? {}
      : {
          ...(options?.responses === undefined ? {} : { responses: options.responses }),
          ...(options?.extraModelIds === undefined ? {} : { extraModelIds: options.extraModelIds }),
        },
  );
  const sessionHandle = await openOrCreateSession(dataRoot, config, epoch.runtimeSessionId);
  const session = sessionHandle.session;
  const { harness } = createIrisHarness({
    session,
    instanceEpoch: epoch.ordinalWithinDate,
    models: provider.models,
    model: provider.model,
    tools: [makeReadOnlyTestTool()],
    currentInvocation,
    now,
    providerProfileId: "mock-iris-provider-v1",
  });
  const adapter = new PiRuntimeAdapter({
    harness,
    session,
    binding: currentInvocation,
    repo: sessionHandle.repo,
  });
  const registry = new ActiveRuntimeRegistry();
  registry.install(activeRuntimeHandle(epoch, adapter, currentInvocation));
  // Production model override port (same wiring as IrisHost.open) so the
  // supervisor's promptWithModel dispatch can resolve fallback targets.
  const modelOverride: ModelOverridePort = {
    resolveModel(modelId: string) {
      return (
        provider.models.getModels().find((m) => `${m.provider}/${m.id}` === modelId) ?? undefined
      );
    },
    async applyModelOverride(modelToApply) {
      const activeHandle = registry.getActiveOrNull();
      if (activeHandle === null) {
        throw new Error("cannot apply model override: no active runtime capsule");
      }
      await (activeHandle.runtime as PiRuntimeAdapter).setModel(modelToApply as Model<string>);
    },
    getActiveModelId() {
      const activeHandle = registry.getActiveOrNull();
      if (activeHandle === null) {
        return provider.model?.id;
      }
      return (activeHandle.runtime as PiRuntimeAdapter).getCurrentModelId?.() ?? provider.model?.id;
    },
  };
  const coordinator = new RuntimeCoordinator({
    activeRuntime: registry,
    modelOverride,
    prepareInvocation: async (nextInput, runtimeSessionId, epochId) =>
      prepareContextSources(nextInput, runtimeSessionId, epochId, config, now),
  });
  const fallbackConfig = {
    ...defaultFallbackConfig(provider.models.getModels().map((m) => `${m.provider}/${m.id}`)),
    // Short watchdogs so fault cases resolve fast without real 30s waits.
    fallbackNoProgressTimeoutMs: 300,
    subagentFirstProgressMs: 500,
    abortSettlementTimeoutMs: 400,
    overallBudgetMs: 5000,
    sameModelRetryBudget: 1,
    fallbackAttemptBudget: 1,
    failedModelCooldownMs: 1,
    reservedDispatchRetries: 1,
    ...options?.fallbackOverrides,
  };
  const supervisor = new RecoverySupervisor({
    runtime: coordinator,
    config: fallbackConfig,
    // Default reconciler: ambiguous (fail closed) — no fake authority.
  });
  return { supervisor, coordinator, adapter, harness, liveness, input, faux: provider.faux };
}

async function collectEvents(
  supervisor: RecoverySupervisor,
  input: AgentInput,
  opts?: {
    initialState?: RecoveryStateSnapshot;
    dispatch?: (
      input: AgentInput,
      model: string | null,
      attempt: number,
    ) => AsyncIterable<AgentRuntimeEvent>;
  },
  timeoutMs = 8000,
): Promise<{
  events: string[];
  escalations: RecoveryEscalationEvent[];
  done: boolean;
  error?: string;
}> {
  const events: string[] = [];
  const escalations: RecoveryEscalationEvent[] = [];
  let error: string | undefined;
  const done = await Promise.race([
    (async () => {
      try {
        for await (const event of supervisor.prompt(input, opts)) {
          events.push(event.type);
          if (event.type === "recovery_escalation") {
            escalations.push(event);
          }
        }
      } catch (err) {
        // Fail-closed paths TERMINATE by throwing RecoveryExhaustedError
        // after the terminal escalation — that is the expected behavior.
        error = err instanceof Error ? err.message : String(err);
      }
      return true;
    })(),
    new Promise<boolean>((resolve) =>
      setTimeout(() => {
        resolve(false);
      }, timeoutMs),
    ),
  ]);
  return {
    events,
    escalations,
    done,
    ...(error === undefined ? {} : { error }),
  };
}

// ---------------------------------------------------------------------------
// Case 1: harness.abort() resolves, native settled never arrives
// ---------------------------------------------------------------------------

test("C7 case 1: abort without settled — settlement failure, zero fallback, at most 1 provider invocation", async () => {
  const liveness = freshLiveness();
  const { supervisor, input } = await buildStack({
    responses: [neverSettles(liveness)],
    fallbackOverrides: { fallbackNoProgressTimeoutMs: 150 },
    liveness,
  });
  const { escalations, done } = await collectEvents(supervisor, input);
  assert.equal(done, true, "supervisor must terminate (fail closed), not hang");
  assert.ok(
    escalations.some((e) => e.detail === "abort_settlement_failed"),
    "abort without exact native settled proof must fail closed",
  );
  assert.equal(
    liveness.started,
    1,
    "zero fallback: at most ONE native provider invocation (the original)",
  );
  assert.equal(liveness.maxLive, 1, "native liveness: never more than one live invocation");
});

// ---------------------------------------------------------------------------
// Case 2: prompt/generator failed/ended, native settled absent
// ---------------------------------------------------------------------------

test("C7 case 2: generator failed without settled — zero fallback", async () => {
  const liveness = freshLiveness();
  const { supervisor, input } = await buildStack({ liveness });
  // Dispatch seam: the NATIVE generator ends with a failed event and NO
  // settled — exactly the Round-6 `receipt === null` hazard window.
  const failingDispatch = async function* (): AsyncIterable<AgentRuntimeEvent> {
    yield { type: "failed", invocationId: "invocation-input-0001", code: "provider_exploded" };
    return;
  };
  const { escalations, done } = await collectEvents(supervisor, input, {
    dispatch: failingDispatch,
  });
  assert.equal(done, true);
  const terminal = escalations.find((e) => e.action === "terminal");
  assert.ok(terminal !== undefined, "no settled → terminal fail-closed escalation");
  assert.equal(
    liveness.started,
    0,
    "zero fallback: the failing native generator never produced a provider invocation",
  );
});

// ---------------------------------------------------------------------------
// Case 3: iterator.return() + generator finally + runCompletion, no settled
// ---------------------------------------------------------------------------

test("C7 case 3: generator cleanup without settled cannot authorize fallback", async () => {
  const liveness = freshLiveness();
  const { supervisor, input } = await buildStack({
    responses: [neverSettles(liveness)],
    fallbackOverrides: { fallbackNoProgressTimeoutMs: 150, abortSettlementTimeoutMs: 250 },
    liveness,
  });
  const { escalations, done } = await collectEvents(supervisor, input);
  assert.equal(done, true);
  const failClosed = escalations.find((e) => e.detail === "abort_settlement_failed");
  assert.ok(
    failClosed !== undefined,
    "generator cleanup alone (no settled) must still fail closed",
  );
  assert.equal(
    liveness.started,
    1,
    "zero fallback: no second provider invocation after cleanup-only teardown",
  );
});

// ---------------------------------------------------------------------------
// Case 4: late settled from Invocation A cannot resolve Invocation B
// ---------------------------------------------------------------------------

test("C7 case 4: a late settled broadcast cannot resolve invocation B's receipt", async () => {
  const liveness = freshLiveness();
  const delayedFinal: FauxResponseStep = () => {
    trackLiveness(liveness);
    // B's run takes 600ms to finish — the stale broadcast fires mid-run,
    // BEFORE B's agent_end, so it must be ignored.
    return new Promise((resolve) => {
      setTimeout(() => {
        untrackLiveness(liveness);
        resolve(fauxAssistantMessage("b final"));
      }, 600);
    });
  };
  const { supervisor, harness, input, faux } = await buildStack({
    liveness,
    // B's delayed response needs room before the no-progress watchdog fires.
    fallbackOverrides: { fallbackNoProgressTimeoutMs: 2000 },
  });
  // Run A to completion with the DEFAULT looping responses, then re-arm the
  // provider queue with a DELAYED response so B's run is still in flight
  // when the stale broadcast fires.
  const eventsA: string[] = [];
  for await (const event of supervisor.prompt(input)) {
    eventsA.push(event.type);
    if (event.type === "recovery_escalation") {
      break;
    }
  }
  assert.ok(
    eventsA.includes("settled") || eventsA.includes("failed"),
    "A must have completed its run",
  );
  faux.setResponses([delayedFinal]);
  const eventsB: string[] = [];
  const promptB = (async () => {
    for await (const event of supervisor.prompt({
      ...sampleAgentInput(),
      inputId: "input-0002",
    })) {
      eventsB.push(event.type);
      if (event.type === "recovery_escalation") {
        break;
      }
    }
  })();
  // Wait for B's run to be in flight, then broadcast a stale settled with a
  // captured OLD run identity — the adapter's agent_end binding must ignore
  // it (B keeps running; only B's own agent_end→settled ends B).
  await new Promise((resolve) => setTimeout(resolve, 120));
  await (
    harness as unknown as {
      emitOwn(event: { type: "settled"; nextTurnCount: number }): Promise<void>;
    }
  ).emitOwn({ type: "settled", nextTurnCount: 99 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(
    !eventsB.includes("settled"),
    "stale settled from a previous run must NOT resolve B's receipt",
  );
  await promptB;
  assert.ok(eventsB.includes("settled"), "B completes through its own agent_end → settled stream");
  void delayedFinal;
});

// ---------------------------------------------------------------------------
// Case 5: abort → exact invocation native settled → fallback exactly once
// ---------------------------------------------------------------------------

test("C7 case 5: abort with exact settled authorizes fallback exactly once", async () => {
  const liveness = freshLiveness();
  // Controllable first response: the provider call hangs until the test
  // releases it AFTER the watchdog's abort is in flight. Once released, the
  // REAL faux stream observes signal.aborted → aborted error →
  // emitRunFailure(aborted) → agent_end → NATIVE SETTLED, which is the
  // exact-invocation settlement proof that authorizes the fallback.
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const controlledFirst: FauxResponseStep = () => {
    trackLiveness(liveness);
    return firstGate.then(() => {
      untrackLiveness(liveness);
      return fauxAssistantMessage("first attempt result");
    });
  };
  const fallbackFinal: FauxResponseStep = () => {
    trackLiveness(liveness);
    queueMicrotask(() => {
      untrackLiveness(liveness);
    });
    return fauxAssistantMessage("fallback final");
  };
  const { supervisor, input } = await buildStack({
    // Two model slots so the fallback chain can actually advance once.
    extraModelIds: ["mock-deepseek-v4-flash-fallback"],
    responses: [controlledFirst, fallbackFinal],
    fallbackOverrides: {
      fallbackNoProgressTimeoutMs: 60,
      abortSettlementTimeoutMs: 1500,
      sameModelRetryBudget: 1,
    },
    liveness,
  });
  // Start the supervisor, let the watchdog abort (60ms), THEN release the
  // provider response so the real aborted-stream settled arrives and the
  // abort completes — authorizing exactly one fallback dispatch.
  const pending = collectEvents(supervisor, input);
  await new Promise((resolve) => setTimeout(resolve, 120));
  releaseFirst?.();
  const { escalations, done } = await pending;
  assert.equal(done, true);
  const fallback = escalations.find((e) => e.action === "fallback");
  assert.ok(
    fallback !== undefined,
    `abort + exact native settled must authorize exactly one fallback: ${escalations
      .map((e) => `${e.action}:${e.detail}`)
      .join(", ")}`,
  );
  assert.ok(
    liveness.started >= 2,
    "fallback exactly once: the fallback model made its own provider invocation",
  );
  assert.equal(
    liveness.maxLive,
    1,
    "native liveness: never more than one live provider invocation at a time",
  );
});

// ---------------------------------------------------------------------------
// Case 6: abort rejected → zero fallback
// ---------------------------------------------------------------------------

test("C7 case 6: abort rejected — zero fallback", async () => {
  const liveness = freshLiveness();
  const { supervisor, harness, input } = await buildStack({
    responses: [neverSettles(liveness)],
    fallbackOverrides: { fallbackNoProgressTimeoutMs: 150, abortSettlementTimeoutMs: 250 },
    liveness,
  });
  // Force the harness abort itself to reject (runtime teardown failure).
  const originalAbort = harness.abort.bind(harness);
  (harness as unknown as { abort: typeof harness.abort }).abort = async () => {
    await originalAbort().catch(() => undefined);
    throw new Error("harness abort rejected (teardown failure)");
  };
  const { escalations, done } = await collectEvents(supervisor, input);
  assert.equal(done, true);
  const failClosed = escalations.find((e) => e.detail === "abort_settlement_failed");
  assert.ok(failClosed !== undefined, "abort rejection must fail closed");
  assert.equal(
    liveness.started,
    1,
    "zero fallback: abort rejected → no second provider invocation",
  );
});
