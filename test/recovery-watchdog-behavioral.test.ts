/**
 * iris_agent#100: Behavioral fault-injection tests for the RecoverySupervisor
 * watchdog → abort → settlement → fallback sequence.
 *
 * Unlike the older recovery-watchdog-fallback.test.ts (which greps source text
 * with readFileSync), every assertion here is based on RUNTIME BEHAVIOR:
 *   - mock runtime call counts and call order (abort, dispatch, iterator polls)
 *   - observed event stream (recovery_escalation fallback/terminal events)
 *   - durable recovery state (fallbackIndex, exhausted, failedModels cooldown)
 *   - typed errors (RecoveryExhaustedError reason/message)
 *   - concurrency tracking (at most one live provider invocation)
 *
 * The mock runtime is modeled on the production RuntimeCoordinator contract:
 *   - a stalled dispatch is an async iterator whose next() never resolves
 *     while return() completes immediately (the iris_agent#111 teardown
 *     order: the supervisor aborts BEFORE iter.return(), and abort drives
 *     settlement — not the iterator close);
 *   - abort() validates the active invocation and settles the run (resolves
 *     runCompletion, clears the active id); a second abort for an
 *     already-settled invocation is an idempotent success;
 *   - getActiveInvocationId() keeps returning the accepted invocation until
 *     abort settles it (coordinator phase stays "turn" through return()).
 *
 * The watchdog timer is a REAL setTimeout inside the supervisor
 * (raceNextWithWatchdog / makeWatchdogTimer), so stalls use a small
 * fallbackNoProgressTimeoutMs (25ms). The injected now() advances the clock
 * when an instant watchdog fire is needed (remaining <= 0 short-circuits
 * without waiting on the real timer).
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { AgentRuntimeEvent, AgentRuntimePort } from "../src/contracts/ports.js";
import type { AgentRuntimePhase } from "../src/contracts/runtime-ports.js";
import type { AgentInput } from "../src/contracts/origin.js";
import {
  RecoveryExhaustedError,
  RecoverySupervisor,
  type RecoveryEscalationEvent,
  type RecoverySupervisorEvent,
} from "../src/runtime/recovery-supervisor.js";
import { defaultFallbackConfig } from "../src/runtime/recovery-state.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A promise that never settles — used to stall a provider mid-invocation. */
const NEVER: Promise<never> = new Promise<never>(() => {
  /* never settles */
});

/** Injected wall clock. Start fixed; advance() simulates elapsed time. */
class TestClock {
  private t = 1_000_000;
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/** Make a minimal AgentInput for testing. */
function testInput(): AgentInput {
  return {
    inputId: "test-input-0001",
    triggerOrigin: {
      schemaVersion: 1,
      channel: "test",
      principalKind: "user",
      authority: "user_request",
      trust: "trusted",
    },
    blocks: [
      {
        blockId: "block-0001",
        sourceOrigin: {
          schemaVersion: 1,
          channel: "test",
          principalKind: "user",
          authority: "user_request",
          trust: "trusted",
        },
        content: { mode: "inline_text", text: "test prompt" },
        contentHash: "test-hash",
      },
    ],
  };
}

/** A clean settled sequence for a successful (fallback) dispatch. */
function settledEvents(invocationId: string): AgentRuntimeEvent[] {
  return [
    { type: "turn_start", invocationId },
    { type: "message_delta", invocationId, text: "ok" },
    { type: "settled", invocationId, nextTurnCount: 1 },
  ];
}

/**
 * Custom async iterator for one provider invocation.
 *
 * NOT a generator: `next()` can return a never-resolving promise (the
 * provider accepted the invocation but never emits again — the stall),
 * while `return()` completes immediately and reports closure — matching the
 * RuntimeCoordinator contract where iter.return() finishes the generator's
 * finally block without waiting on the stuck provider (with the #111
 * teardown order, settlement is driven by abort, not by the iterator close).
 */
class StallableIterator
  implements AsyncIterable<AgentRuntimeEvent>, AsyncIterator<AgentRuntimeEvent>
{
  readonly invocationId: string;
  /** Number of next() polls the supervisor made. Stays frozen after return. */
  nextCalls = 0;
  returned = false;
  private readonly events: AgentRuntimeEvent[];
  private readonly stallAfterEvents: boolean;
  private readonly onClose: () => void;

  constructor(
    invocationId: string,
    events: AgentRuntimeEvent[],
    stallAfterEvents: boolean,
    onClose: () => void,
  ) {
    this.invocationId = invocationId;
    this.events = events;
    this.stallAfterEvents = stallAfterEvents;
    this.onClose = onClose;
  }

  next(): Promise<IteratorResult<AgentRuntimeEvent>> {
    this.nextCalls += 1;
    if (this.events.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const value = this.events.shift()!;
      return Promise.resolve({ value, done: false });
    }
    if (this.stallAfterEvents) {
      return NEVER; // provider accepted the invocation but never emits again
    }
    return Promise.resolve({ value: undefined, done: true });
  }

  return(): Promise<IteratorResult<AgentRuntimeEvent>> {
    if (this.returned) {
      return Promise.resolve({ value: undefined, done: true });
    }
    this.returned = true;
    this.onClose();
    return Promise.resolve({ value: undefined, done: true });
  }

  throw(): Promise<IteratorResult<AgentRuntimeEvent>> {
    return this.return();
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentRuntimeEvent> {
    return this;
  }
}

type AbortMode = "settle" | "reject" | "hang";

interface MockRuntimeOptions {
  /** Events emitted by the FIRST dispatch before it stalls (may be empty). */
  firstEvents: AgentRuntimeEvent[];
  /** abort() behavior: settle (await runCompletion), reject, or hang. */
  abortMode?: AbortMode;
  /** Error thrown by abort() in "reject" mode. */
  abortError?: Error;
}

/**
 * Mock AgentRuntimePort driving the RecoverySupervisor's injected dispatch.
 *
 * Behavior modeled on RuntimeCoordinator, with the iris_agent#111 teardown
 * order (the supervisor aborts BEFORE iter.return()):
 *  - dispatch #1 emits firstEvents then stalls forever;
 *  - dispatch #N (N>=2) emits a settled sequence (fallback success);
 *  - abort() drives settlement: "settle" mode settles the run (resolves
 *    runCompletion, clears the active id) on the first call and is an
 *    idempotent success on a subsequent call for the same invocation;
 *    "reject" mode throws every time; "hang" mode accepts the first abort
 *    but never settles (subsequent aborts never resolve), so the
 *    supervisor's abortSettlementTimeoutMs governs;
 *  - iter.return() only closes the iterator — settlement is abort-driven.
 *
 * Observability: call log (dispatch/return/abort order), abort calls,
 * dispatched models, active-id seam calls, and max concurrent live
 * invocations.
 */
class MockRuntime implements AgentRuntimePort {
  readonly firstEvents: AgentRuntimeEvent[];
  abortMode: AbortMode;
  abortError: Error | undefined;

  abortCalls: Array<{ invocationId: string; reason: string | undefined }> = [];
  callLog: string[] = [];
  dispatchedModels: Array<string | null> = [];
  getActiveInvocationIdCalls = 0;
  /** Peak number of live (dispatched, not yet returned) invocations. */
  maxLive = 0;
  firstIterator: StallableIterator | null = null;

  private live = 0;
  private activeInvocationIdValue: string | null = null;
  private readonly runCompletions = new Map<string, Promise<void>>();
  private readonly resolveRunCompletions = new Map<string, () => void>();
  private readonly settledInvocations = new Set<string>();
  private readonly hangAccepted = new Set<string>();
  private invocationCounter = 0;

  constructor(options: MockRuntimeOptions) {
    this.firstEvents = options.firstEvents;
    this.abortMode = options.abortMode ?? "settle";
    this.abortError = options.abortError;
  }

  getPhase(): AgentRuntimePhase {
    return "idle";
  }

  prompt(): AsyncIterable<AgentRuntimeEvent> {
    throw new Error("MockRuntime.prompt must not be called — dispatch is injected");
  }

  /** #100 seam: the currently accepted invocation, until abort settles it. */
  getActiveInvocationId(): string | null {
    this.getActiveInvocationIdCalls += 1;
    return this.activeInvocationIdValue;
  }

  /**
   * Mirrors RuntimeCoordinator.abort() semantics: validate the active
   * invocation, then await the validated settled boundary. A second abort
   * for an already-settled invocation is an idempotent success — the
   * validated boundary already exists.
   */
  async abort(invocationId: string, reason?: string): Promise<void> {
    this.abortCalls.push({ invocationId, reason });
    this.callLog.push(`abort:${invocationId}`);
    if (this.abortMode === "reject") {
      throw this.abortError ?? new Error("mock runtime rejected abort");
    }
    if (this.abortMode === "hang") {
      // First abort is accepted (forwards to the harness), but the native
      // run never settles — subsequent aborts never resolve, so the
      // supervisor's abortSettlementTimeoutMs governs.
      if (this.hangAccepted.has(invocationId)) {
        await NEVER;
        return;
      }
      this.hangAccepted.add(invocationId);
      return;
    }
    if (this.settledInvocations.has(invocationId)) {
      // Idempotent: the invocation was already settled by an earlier abort.
      this.callLog.push(`abort-settled:${invocationId}`);
      return;
    }
    if (this.activeInvocationIdValue !== invocationId) {
      throw new Error(`no active invocation ${invocationId}`);
    }
    // Settle the run: the native settled boundary is reached.
    this.resolveRunCompletions.get(invocationId)?.();
    await (this.runCompletions.get(invocationId) ?? Promise.resolve());
    this.settledInvocations.add(invocationId);
    this.activeInvocationIdValue = null;
    this.callLog.push(`abort-settled:${invocationId}`);
  }

  /** Build the dispatch injected via RecoverySupervisorOptions.dispatch. */
  makeDispatch(): (
    input: AgentInput,
    model: string | null,
    attempt: number,
  ) => AsyncIterable<AgentRuntimeEvent> {
    return (_input, model) => {
      this.dispatchedModels.push(model);
      this.invocationCounter += 1;
      const invocationId = `inv-${this.invocationCounter}`;
      this.callLog.push(`dispatch:${model ?? "<null>"}`);

      const isFirst = this.firstIterator === null;
      this.activeInvocationIdValue = invocationId;
      this.live += 1;
      this.maxLive = Math.max(this.maxLive, this.live);

      const completion = new Promise<void>((resolve) => {
        this.resolveRunCompletions.set(invocationId, resolve);
      });
      this.runCompletions.set(invocationId, completion);

      const iterator = new StallableIterator(
        invocationId,
        isFirst ? this.firstEvents : settledEvents(invocationId),
        isFirst, // only the first dispatch stalls; fallbacks settle
        () => {
          this.live -= 1;
          this.callLog.push(`return:${invocationId}`);
        },
      );
      if (isFirst) {
        this.firstIterator = iterator;
      }
      return iterator;
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function watchdogConfig(overrides?: {
  abortSettlementTimeoutMs?: number;
}): ReturnType<typeof defaultFallbackConfig> {
  return {
    ...defaultFallbackConfig(["model-a", "model-b"]),
    sameModelRetryBudget: 1,
    fallbackNoProgressTimeoutMs: 25,
    subagentFirstProgressMs: 50000,
    abortSettlementTimeoutMs: overrides?.abortSettlementTimeoutMs ?? 1000,
  };
}

/** Collect the supervisor stream; returns events + the thrown error (if any). */
async function runPrompt(
  supervisor: RecoverySupervisor,
  runtime: MockRuntime,
): Promise<{
  events: RecoverySupervisorEvent[];
  error: unknown;
  /** Mock call log snapshot at the moment each event was received. */
  logsAtEvents: Array<{ event: RecoverySupervisorEvent; log: string[] }>;
}> {
  const events: RecoverySupervisorEvent[] = [];
  const logsAtEvents: Array<{ event: RecoverySupervisorEvent; log: string[] }> = [];
  let error: unknown = null;
  try {
    for await (const event of supervisor.prompt(testInput(), {
      dispatch: runtime.makeDispatch(),
    })) {
      events.push(event);
      logsAtEvents.push({ event, log: [...runtime.callLog] });
    }
  } catch (caught) {
    error = caught;
  }
  return { events, error, logsAtEvents };
}

function fallbackEscalations(events: RecoverySupervisorEvent[]): RecoveryEscalationEvent[] {
  return events.filter(
    (e): e is RecoveryEscalationEvent =>
      e.type === "recovery_escalation" && e.action === "fallback",
  );
}

function terminalEscalations(events: RecoverySupervisorEvent[]): RecoveryEscalationEvent[] {
  return events.filter(
    (e): e is RecoveryEscalationEvent =>
      e.type === "recovery_escalation" && e.action === "terminal",
  );
}

/**
 * Every abort the supervisor issued must target the EXACT stalled invocation
 * with the watchdog reason. The count is deliberately open-ended (>= 1): the
 * supervisor may abort once (pre-first-event stall, where the finally cannot
 * know the id yet) or twice (event-exposed id: the #111 teardown abort plus
 * the abortWithSettlementTimeout validation) — both are contract-legal.
 */
function assertAllAbortsTargetExactInvocation(
  runtime: MockRuntime,
  invocationId: string,
  reason: string,
): void {
  assert.ok(runtime.abortCalls.length >= 1, "abort must have been attempted");
  for (const call of runtime.abortCalls) {
    assert.equal(call.invocationId, invocationId, "every abort must target the exact invocation");
    assert.equal(call.reason, reason, "every abort must carry the watchdog reason");
  }
}

// ---------------------------------------------------------------------------
// Scenario 1: pre-first-event provider stall
// ---------------------------------------------------------------------------
test("pre-first-event stall: watchdog aborts via getActiveInvocationId seam, then fallback advances", async () => {
  const runtime = new MockRuntime({ firstEvents: [] }); // never emits ANY event
  const clock = new TestClock();
  const supervisor = new RecoverySupervisor({
    runtime,
    config: watchdogConfig(),
    now: () => clock.now(),
    sleep: async () => undefined,
  });

  const { events, error } = await runPrompt(supervisor, runtime);

  assert.equal(error, null, "fallback dispatch should settle — no exhaustion");
  const first = runtime.firstIterator;
  assert.ok(first !== null, "first dispatch must have been created");
  assert.equal(first.nextCalls, 1, "provider was polled exactly once, then the watchdog fired");
  assert.equal(first.returned, true, "stalled iterator must have been closed by iter.return()");

  // The watchdog fired BEFORE any event exposed an invocationId, so the
  // supervisor must have resolved the identity via the getActiveInvocationId
  // seam and aborted THAT exact invocation.
  assert.ok(
    runtime.getActiveInvocationIdCalls >= 1,
    "supervisor must consult getActiveInvocationId() when no event exposed the id",
  );
  assert.deepEqual(runtime.abortCalls, [{ invocationId: "inv-1", reason: "watchdog_no_progress" }]);

  // Fallback chain advanced to model-b which settles.
  assert.deepEqual(runtime.dispatchedModels, ["model-a", "model-b"]);
  const fallbacks = fallbackEscalations(events);
  assert.equal(fallbacks.length, 1, "exactly one fallback escalation");
  const fallback = fallbacks[0];
  assert.ok(fallback !== undefined);
  assert.equal(fallback.reason, "transient_retryable");
  assert.equal(fallback.detail, "watchdog_no_progress");
  assert.equal(fallback.nextModel, "model-b");
  assert.equal(terminalEscalations(events).length, 0, "no terminal escalation on the happy path");
  assert.ok(
    events.some((e) => e.type === "settled"),
    "fallback dispatch must settle",
  );

  // Durable state: chain advanced, stalled model marked failed, not exhausted.
  const state = supervisor.getState();
  assert.ok(state !== null);
  assert.equal(state.fallbackIndex, 1, "fallback index must advance");
  assert.equal(state.fallbackAttempts, 1);
  assert.equal(state.exhausted, false);
  assert.equal(state.currentModel, "model-b");
  assert.ok(
    state.failedModels["model-a"] !== undefined,
    "stalled model must be marked failed with cooldown",
  );
});

// ---------------------------------------------------------------------------
// Scenario 2: one event then stall — abort resolves + runCompletion settles
// ---------------------------------------------------------------------------
test("one-event-then-stall: watchdog abort settles, fallback advances, no zombie invocation", async () => {
  const runtime = new MockRuntime({
    firstEvents: [
      { type: "turn_start", invocationId: "inv-1" },
      { type: "message_delta", invocationId: "inv-1", text: "partial" },
    ],
  });
  const clock = new TestClock();
  const supervisor = new RecoverySupervisor({
    runtime,
    config: watchdogConfig(),
    now: () => clock.now(),
    sleep: async () => undefined,
  });

  const events: RecoverySupervisorEvent[] = [];
  const logsAtEvents: Array<{ event: RecoverySupervisorEvent; log: string[] }> = [];
  let error: unknown = null;
  try {
    for await (const event of supervisor.prompt(testInput(), {
      dispatch: runtime.makeDispatch(),
    })) {
      events.push(event);
      logsAtEvents.push({ event, log: [...runtime.callLog] });
      // After the last progress event of the FIRST (stalled) invocation, let
      // the no-progress window elapse so the NEXT watchdog race fires
      // instantly (remaining <= 0). Never advance for fallback dispatches —
      // they settle and must not be hit by an artificial watchdog.
      if (
        event.type === "message_delta" &&
        runtime.firstIterator !== null &&
        event.invocationId === runtime.firstIterator.invocationId
      ) {
        clock.advance(100_000);
      }
    }
  } catch (caught) {
    error = caught;
  }

  assert.equal(error, null, "fallback dispatch should settle — no exhaustion");
  const first = runtime.firstIterator;
  assert.ok(first !== null);
  // Polls: turn_start, message_delta, then the stall. After return() the
  // supervisor must NEVER poll the zombie iterator again.
  assert.equal(first.nextCalls, 2, "no next() poll after the watchdog fired");
  assert.equal(first.returned, true, "stalled iterator must be closed");

  // Abort targeted the EXACT invocation id observed from the stream.
  assertAllAbortsTargetExactInvocation(runtime, "inv-1", "watchdog_no_progress");

  // Fallback advanced and settled on model-b.
  assert.deepEqual(runtime.dispatchedModels, ["model-a", "model-b"]);
  const fallbacks = fallbackEscalations(events);
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0]?.detail, "watchdog_no_progress");
  assert.equal(fallbacks[0]?.nextModel, "model-b");
  assert.ok(
    events.some((e) => e.type === "settled"),
    "fallback dispatch must settle",
  );
  assert.equal(terminalEscalations(events).length, 0);

  const state = supervisor.getState();
  assert.ok(state !== null);
  assert.equal(state.fallbackIndex, 1);
  assert.equal(state.exhausted, false);
  assert.ok(state.failedModels["model-a"] !== undefined, "stalled model in cooldown");
});

// ---------------------------------------------------------------------------
// Scenario 3: watchdog abort REJECTED → fail closed, zero fallback dispatch
// ---------------------------------------------------------------------------
test("abort rejection: supervisor fails closed — no fallback dispatch over a live invocation", async () => {
  const runtime = new MockRuntime({
    firstEvents: [{ type: "turn_start", invocationId: "inv-1" }],
    abortMode: "reject",
    abortError: new Error("mock abort explosion"),
  });
  const supervisor = new RecoverySupervisor({
    runtime,
    config: watchdogConfig(),
    sleep: async () => undefined,
  });

  const events: RecoverySupervisorEvent[] = [];
  let error: unknown = null;
  try {
    for await (const event of supervisor.prompt(testInput(), {
      dispatch: runtime.makeDispatch(),
    })) {
      events.push(event);
    }
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof RecoveryExhaustedError, "must throw RecoveryExhaustedError");
  assert.equal(error.reason, "abort_settlement_failed");
  assert.match(error.message, /mock abort explosion/);

  // The abort was genuinely attempted on the exact invocation.
  assertAllAbortsTargetExactInvocation(runtime, "inv-1", "watchdog_no_progress");

  // ZERO fallback dispatch — never advance over a possibly-live invocation.
  assert.deepEqual(runtime.dispatchedModels, ["model-a"]);
  assert.equal(fallbackEscalations(events).length, 0, "no fallback escalation");

  // Typed terminal escalation precedes the throw.
  const terminals = terminalEscalations(events);
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.detail, "abort_settlement_failed");

  // Durable fail-closed state: exhausted, chain NOT advanced, nothing marked.
  const state = supervisor.getState();
  assert.ok(state !== null);
  assert.equal(state.exhausted, true, "abort rejection must persist exhausted=true");
  assert.equal(state.fallbackIndex, 0, "fallback index must NOT advance");
  assert.equal(state.fallbackAttempts, 0);
  assert.deepEqual(state.failedModels, {}, "no model may be marked failed");
});

// ---------------------------------------------------------------------------
// Scenario 4: abort accepted but runCompletion never settles → timeout
// ---------------------------------------------------------------------------
test("abort settlement timeout: supervisor fails closed with abort_settlement_failed", async () => {
  const runtime = new MockRuntime({
    firstEvents: [{ type: "turn_start", invocationId: "inv-1" }],
    abortMode: "hang", // abort() succeeds at forwarding, runCompletion never resolves
  });
  const supervisor = new RecoverySupervisor({
    runtime,
    config: watchdogConfig({ abortSettlementTimeoutMs: 40 }),
    sleep: async () => undefined,
  });

  const events: RecoverySupervisorEvent[] = [];
  let error: unknown = null;
  try {
    for await (const event of supervisor.prompt(testInput(), {
      dispatch: runtime.makeDispatch(),
    })) {
      events.push(event);
    }
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof RecoveryExhaustedError, "must throw RecoveryExhaustedError");
  assert.equal(error.reason, "abort_settlement_failed");
  assert.match(error.message, /abort settlement timeout/);

  // Abort was attempted and never settled.
  assertAllAbortsTargetExactInvocation(runtime, "inv-1", "watchdog_no_progress");

  // ZERO fallback dispatch over the unsettled invocation.
  assert.deepEqual(runtime.dispatchedModels, ["model-a"]);
  assert.equal(fallbackEscalations(events).length, 0, "no fallback escalation");

  const terminals = terminalEscalations(events);
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.detail, "abort_settlement_failed");

  const state = supervisor.getState();
  assert.ok(state !== null);
  assert.equal(state.exhausted, true, "settlement timeout must persist exhausted=true");
  assert.equal(state.fallbackIndex, 0, "fallback index must NOT advance");
  assert.deepEqual(state.failedModels, {});
});

// ---------------------------------------------------------------------------
// Scenario 5: at most one live provider invocation (all watchdog paths)
// ---------------------------------------------------------------------------
test("at most one live provider invocation across abort/settlement sequences", async () => {
  // Exercise BOTH watchdog paths sequentially on one mock: a settled
  // watchdog abort (model-a → model-b) — the single-flight invariant must
  // hold for every dispatch.
  const runtime = new MockRuntime({
    firstEvents: [{ type: "turn_start", invocationId: "inv-1" }],
  });
  const clock = new TestClock();
  const supervisor = new RecoverySupervisor({
    runtime,
    config: watchdogConfig(),
    now: () => clock.now(),
    sleep: async () => undefined,
  });

  let error: unknown = null;
  try {
    for await (const event of supervisor.prompt(testInput(), {
      dispatch: runtime.makeDispatch(),
    })) {
      if (
        event.type === "message_delta" &&
        runtime.firstIterator !== null &&
        event.invocationId === runtime.firstIterator.invocationId
      ) {
        clock.advance(100_000); // instant watchdog on the next race
      }
    }
  } catch (caught) {
    error = caught;
  }

  assert.equal(error, null);
  assert.equal(runtime.maxLive, 1, "provider must never be invoked concurrently");
  assert.deepEqual(runtime.dispatchedModels, ["model-a", "model-b"]);
  const first = runtime.firstIterator;
  assert.ok(first !== null);
  assert.equal(first.returned, true);
  // The second dispatch may only start after the first iterator was closed.
  const dispatchIndex = runtime.callLog.indexOf("dispatch:model-b");
  const returnIndex = runtime.callLog.indexOf("return:inv-1");
  assert.ok(dispatchIndex > returnIndex, "fallback dispatch must start after the stall is closed");
  assert.ok(dispatchIndex > -1 && returnIndex > -1);
});

// ---------------------------------------------------------------------------
// Scenario 6: fallback only after safe abort + settlement
// ---------------------------------------------------------------------------
test("fallback dispatch happens only after the exact abort is settled", async () => {
  const runtime = new MockRuntime({
    firstEvents: [
      { type: "turn_start", invocationId: "inv-1" },
      { type: "message_delta", invocationId: "inv-1", text: "partial" },
    ],
  });
  const clock = new TestClock();
  const supervisor = new RecoverySupervisor({
    runtime,
    config: watchdogConfig(),
    now: () => clock.now(),
    sleep: async () => undefined,
  });

  const logsAtEvents: Array<{ event: RecoverySupervisorEvent; log: string[] }> = [];
  let error: unknown = null;
  try {
    for await (const event of supervisor.prompt(testInput(), {
      dispatch: runtime.makeDispatch(),
    })) {
      logsAtEvents.push({ event, log: [...runtime.callLog] });
      if (
        event.type === "message_delta" &&
        runtime.firstIterator !== null &&
        event.invocationId === runtime.firstIterator.invocationId
      ) {
        clock.advance(100_000);
      }
    }
  } catch (caught) {
    error = caught;
  }
  assert.equal(error, null);

  const fallbackReceipt = logsAtEvents.find(
    (entry): entry is { event: RecoverySupervisorEvent & { action: "fallback" }; log: string[] } =>
      entry.event.type === "recovery_escalation" && entry.event.action === "fallback",
  );
  assert.ok(fallbackReceipt !== undefined, "fallback escalation must be observed");

  // At the moment the fallback escalation is emitted, the stalled iterator
  // was already returned AND the exact abort had settled — but the next
  // dispatch had NOT started yet.
  assert.ok(
    fallbackReceipt.log.includes("return:inv-1"),
    "fallback escalation must follow the stalled iterator's return",
  );
  assert.ok(
    fallbackReceipt.log.includes("abort:inv-1"),
    "fallback escalation must follow the exact abort call",
  );
  assert.ok(
    fallbackReceipt.log.includes("abort-settled:inv-1"),
    "fallback escalation must follow the validated abort settlement",
  );
  assert.ok(
    !fallbackReceipt.log.includes("dispatch:model-b"),
    "next provider dispatch must NOT start before the fallback escalation",
  );

  // End-to-end ordering: abort settled strictly before the fallback dispatch.
  assert.ok(
    runtime.callLog.indexOf("abort-settled:inv-1") < runtime.callLog.indexOf("dispatch:model-b"),
    "abort settlement must strictly precede the fallback dispatch",
  );
  assert.ok(
    runtime.callLog.indexOf("abort:inv-1") < runtime.callLog.indexOf("dispatch:model-b"),
    "abort must strictly precede the fallback dispatch",
  );

  // And the fail-closed paths (scenarios 3/4) never dispatch a fallback at
  // all — verified by their dispatchedModels assertions above.
});
