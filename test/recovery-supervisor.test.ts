import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { AgentRuntimeEvent, AgentRuntimePort } from "../src/contracts/ports.js";
import type { AgentInput } from "../src/contracts/origin.js";

import {
  RecoveryExhaustedError,
  RecoverySupervisor,
  classifyNativeFailure,
  extractRetryAfterMs,
} from "../src/runtime/recovery-supervisor.js";
import {
  RecoveryStateSnapshot,
  RecoveryStateStore,
  defaultFallbackConfig,
  freshRecoveryState,
} from "../src/runtime/recovery-state.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A fake AgentRuntimePort whose prompt() is driven by the test. */
class FakeRuntime implements AgentRuntimePort {
  public promptHandler: (input: AgentInput) => AsyncIterable<AgentRuntimeEvent> = () => {
    throw new Error("no prompt handler set");
  };
  async *prompt(input: AgentInput): AsyncIterable<AgentRuntimeEvent> {
    yield* this.promptHandler(input);
  }
  async abort(): Promise<void> {
    /* no-op */
  }
  getPhase(): "idle" | "turn" | "retry" | "compaction" | "branch_summary" | "failed" {
    return "idle";
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

/** Emit a failed event with a given code, then end the generator. */
async function* failedWith(invocationId: string, code: string): AsyncIterable<AgentRuntimeEvent> {
  yield { type: "turn_start", invocationId };
  yield { type: "failed", invocationId, code };
}

/** Emit a settled event sequence (successful dispatch). */
async function* settledSequence(invocationId: string): AsyncIterable<AgentRuntimeEvent> {
  yield { type: "turn_start", invocationId };
  yield { type: "message_delta", invocationId, text: "hello" };
  yield { type: "settled", invocationId, nextTurnCount: 1 };
}

const INVOCATION_ID = "invocation-test-input-0001";

function testConfig(models: string[], overrides?: Partial<typeof DEFAULT_TEST_CONFIG>) {
  return { ...DEFAULT_TEST_CONFIG, models, ...(overrides ?? {}) };
}

const DEFAULT_TEST_CONFIG = defaultFallbackConfig(["model-a", "model-b", "model-c"]);

/** Shared test input instance. */
const input: AgentInput = testInput();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("429 transient retry succeeds within budget", async () => {
  // First attempt: 429 transient failure. Second attempt: settled.
  let attempt = 0;
  const runtime = new FakeRuntime();
  const supervisor = new RecoverySupervisor({
    runtime,
    config: testConfig(["model-a"]),
    sleep: async () => undefined,
  });

  const events: AgentRuntimeEvent[] = [];
  for await (const event of supervisor.prompt(input, {
    dispatch: () => {
      attempt += 1;
      if (attempt === 1) {
        return failedWith(INVOCATION_ID, "429 rate limit");
      }
      return settledSequence(INVOCATION_ID);
    },
  })) {
    events.push(event as AgentRuntimeEvent);
  }

  assert.equal(attempt, 2, "should have retried once then succeeded");
  const escalations = events.filter((e) => (e as { type: string }).type === "recovery_escalation");
  assert.equal(escalations.length, 1, "one same-model-retry escalation");
  const settled = events.filter((e) => (e as { type: string }).type === "settled");
  assert.equal(settled.length, 1, "eventually settled");
});

test("same-model exhaustion → fallback chain advances", async () => {
  // model-a always fails transiently (exceeds sameModelRetryBudget=3),
  // then model-b succeeds.
  let attempt = 0;
  const runtime = new FakeRuntime();
  const supervisor = new RecoverySupervisor({
    runtime,
    config: testConfig(["model-a", "model-b"]),
    sleep: async () => undefined,
  });

  const events: AgentRuntimeEvent[] = [];
  for await (const event of supervisor.prompt(input, {
    dispatch: (_input, model) => {
      attempt += 1;
      if (model === "model-a") {
        return failedWith(INVOCATION_ID, "503 service unavailable");
      }
      return settledSequence(INVOCATION_ID);
    },
  })) {
    events.push(event as AgentRuntimeEvent);
  }

  // model-a should have been retried sameModelRetryBudget (3) times, then
  // fallback to model-b which succeeds.
  assert.ok(attempt >= 4, `expected at least 4 attempts (3 retries + 1 fallback), got ${attempt}`);
  const fallbackEvents = events.filter(
    (e) =>
      (e as { type: string; action?: string }).type === "recovery_escalation" &&
      (e as { action?: string }).action === "fallback",
  );
  assert.ok(fallbackEvents.length >= 1, "fallback should have been triggered");
  const settled = events.filter((e) => (e as { type: string }).type === "settled");
  assert.equal(settled.length, 1, "eventually settled on model-b");
});

test("fallback model cooldown works", async () => {
  // model-a fails → fallback to model-b → model-b also fails → both in cooldown.
  // With only 2 models, the chain exhausts.
  const runtime = new FakeRuntime();
  const supervisor = new RecoverySupervisor({
    runtime,
    config: testConfig(["model-a", "model-b"], { sameModelRetryBudget: 1 }),
    sleep: async () => undefined,
  });

  await assert.rejects(
    (async () => {
      for await (const event of supervisor.prompt(input, {
        dispatch: () => {
          return failedWith(INVOCATION_ID, "502 bad gateway");
        },
      })) {
        void event;
      }
    })(),
    RecoveryExhaustedError,
  );

  const state = supervisor.getState();
  assert.ok(state, "state should exist");
  assert.ok(state.exhausted, "should be exhausted");
  // Both models should be in the failedModels cooldown map.
  assert.ok(state.failedModels["model-a"], "model-a should be in cooldown");
});

test("30s no-progress → abort + escalation (tiny timeout)", async () => {
  // The dispatch emits a progress event, then stalls forever (no more events).
  // With a tiny no-progress timeout, the watchdog should fire.
  const runtime = new FakeRuntime();
  const supervisor = new RecoverySupervisor({
    runtime,
    config: testConfig(["model-a", "model-b"], {
      fallbackNoProgressTimeoutMs: 50,
      sameModelRetryBudget: 1,
    }),
    sleep: async () => undefined,
  });

  const events: AgentRuntimeEvent[] = [];
  await assert.rejects(
    (async () => {
      for await (const event of supervisor.prompt(input, {
        dispatch: async function* (): AsyncIterable<AgentRuntimeEvent> {
          yield { type: "turn_start", invocationId: INVOCATION_ID };
          yield { type: "message_delta", invocationId: INVOCATION_ID, text: "partial" };
          // Stall: keep the generator alive (but not infinitely — an infinite
          // promise would block iter.return() in the supervisor's finally block
          // forever). The watchdog (50ms) fires well before this settles.
          await new Promise((resolve) => setTimeout(resolve, 5000));
        },
      })) {
        events.push(event as AgentRuntimeEvent);
      }
    })(),
    RecoveryExhaustedError,
  );

  // The supervisor should have detected the no-progress stall.
  const abortEvents = events.filter(
    (e) =>
      (e as { type: string; action?: string }).type === "recovery_escalation" &&
      (e as { action?: string }).action === "abort",
  );
  assert.ok(abortEvents.length >= 1, "watchdog abort should have been emitted");
});

test("90s subagent stall detection (tiny timeout)", async () => {
  // A tool_call starts (subagent), but never produces first progress.
  // The subagent-first-progress watchdog fires.
  const runtime = new FakeRuntime();
  const supervisor = new RecoverySupervisor({
    runtime,
    config: testConfig(["model-a", "model-b"], {
      subagentFirstProgressMs: 50,
      fallbackNoProgressTimeoutMs: 10000,
      sameModelRetryBudget: 1,
    }),
    sleep: async () => undefined,
  });

  const events: AgentRuntimeEvent[] = [];
  await assert.rejects(
    (async () => {
      for await (const event of supervisor.prompt(input, {
        dispatch: async function* (): AsyncIterable<AgentRuntimeEvent> {
          yield { type: "turn_start", invocationId: INVOCATION_ID };
          yield {
            type: "tool_call",
            invocationId: INVOCATION_ID,
            toolCallId: "tc-1",
            toolName: "stalled_tool",
          };
          // Subagent started but never produces first progress → watchdog.
          // Use a finite (but long) delay rather than an infinite promise: an
          // infinite promise would block iter.return() in the supervisor's
          // finally block forever. The watchdog (50ms) fires well before this.
          await new Promise((resolve) => setTimeout(resolve, 5000));
        },
      })) {
        events.push(event as AgentRuntimeEvent);
      }
    })(),
    RecoveryExhaustedError,
  );

  const abortEvents = events.filter(
    (e) =>
      (e as { type: string; action?: string }).type === "recovery_escalation" &&
      (e as { action?: string }).action === "abort",
  );
  assert.ok(abortEvents.length >= 1, "subagent stall abort should have been emitted");
});

test("context overflow → no retry (terminal)", async () => {
  const runtime = new FakeRuntime();
  const supervisor = new RecoverySupervisor({
    runtime,
    config: testConfig(["model-a"]),
    sleep: async () => undefined,
  });

  const events: AgentRuntimeEvent[] = [];
  await assert.rejects(
    (async () => {
      for await (const event of supervisor.prompt(input, {
        dispatch: () => failedWith(INVOCATION_ID, "context overflow"),
      })) {
        events.push(event as AgentRuntimeEvent);
      }
    })(),
    (error: unknown) => {
      assert.ok(error instanceof RecoveryExhaustedError);
      assert.equal(error.reason, "context_overflow");
      return true;
    },
  );

  // No same-model retry should have been attempted.
  const retryEvents = events.filter(
    (e) =>
      (e as { type: string; action?: string }).type === "recovery_escalation" &&
      (e as { action?: string }).action === "same_model_retry",
  );
  assert.equal(retryEvents.length, 0, "context overflow must not trigger retry");
});

test("reserved dispatch → bounded retry, doesn't consume fallback budget", async () => {
  let attempt = 0;
  const runtime = new FakeRuntime();
  const supervisor = new RecoverySupervisor({
    runtime,
    config: testConfig(["model-a", "model-b"], { reservedDispatchRetries: 3 }),
    sleep: async () => undefined,
  });

  const events: AgentRuntimeEvent[] = [];
  for await (const event of supervisor.prompt(input, {
    dispatch: () => {
      attempt += 1;
      if (attempt <= 3) {
        return failedWith(INVOCATION_ID, "reserved dispatch unavailable");
      }
      return settledSequence(INVOCATION_ID);
    },
  })) {
    events.push(event as AgentRuntimeEvent);
  }

  // Reserved dispatch should have retried without consuming fallback budget.
  const reservedRetries = events.filter(
    (e) =>
      (e as { type: string; action?: string }).type === "recovery_escalation" &&
      (e as { action?: string }).action === "reserved_dispatch_retry",
  );
  assert.ok(reservedRetries.length >= 1, "reserved dispatch retries should occur");

  const fallbackEvents = events.filter(
    (e) =>
      (e as { type: string; action?: string }).type === "recovery_escalation" &&
      (e as { action?: string }).action === "fallback",
  );
  assert.equal(fallbackEvents.length, 0, "reserved dispatch must NOT consume fallback budget");

  // Should eventually succeed.
  const settled = events.filter((e) => (e as { type: string }).type === "settled");
  assert.equal(settled.length, 1);
});

test("outcome_unknown → no replay without reconciliation", async () => {
  const runtime = new FakeRuntime();
  // Reconciler returns false → replay must be blocked.
  const supervisor = new RecoverySupervisor({
    runtime,
    config: testConfig(["model-a"]),
    reconcileOutcomeUnknown: async () => false,
    sleep: async () => undefined,
  });

  await assert.rejects(
    (async () => {
      for await (const event of supervisor.prompt(input, {
        dispatch: () => failedWith(INVOCATION_ID, "outcome_unknown ambiguous"),
      })) {
        void event;
      }
    })(),
    (error: unknown) => {
      assert.ok(error instanceof RecoveryExhaustedError);
      assert.equal(error.reason, "outcome_unknown_unreconciled");
      return true;
    },
  );

  const state = supervisor.getState();
  assert.ok(state);
  assert.ok(
    (state as { outcomeUnknown: number }).outcomeUnknown >= 1,
    "outcomeUnknown counter should increment",
  );
});

test("outcome_unknown → replay allowed when reconciler confirms safe", async () => {
  let attempt = 0;
  const runtime = new FakeRuntime();
  const supervisor = new RecoverySupervisor({
    runtime,
    config: testConfig(["model-a"]),
    reconcileOutcomeUnknown: async () => true, // safe to replay
    sleep: async () => undefined,
  });

  const events: AgentRuntimeEvent[] = [];
  for await (const event of supervisor.prompt(input, {
    dispatch: () => {
      attempt += 1;
      if (attempt === 1) {
        return failedWith(INVOCATION_ID, "outcome_unknown ambiguous");
      }
      return settledSequence(INVOCATION_ID);
    },
  })) {
    events.push(event as AgentRuntimeEvent);
  }

  assert.equal(attempt, 2, "should have replayed after reconciliation");
  const settled = events.filter((e) => (e as { type: string }).type === "settled");
  assert.equal(settled.length, 1);
});

test("restart preserves exhaustion state (durable)", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "iris-recovery-")), "recovery.db");
  const store = new RecoveryStateStore(dbPath);

  const logicalId = "exec-durable-0001";
  const now = "2026-08-09T00:00:00.000Z";
  const initial = freshRecoveryState(logicalId, now);
  // Simulate exhaustion after budget drain.
  const exhausted: typeof initial = {
    ...initial,
    sameModelAttempts: 3,
    fallbackIndex: 2,
    exhausted: true,
    currentModel: "model-c",
    failedModels: { "model-a": "2026-08-09T00:01:00.000Z" },
  };
  store.save(exhausted);

  // Simulate restart: new store instance reads the same DB.
  store.close();
  const restoredStore = new RecoveryStateStore(dbPath);
  const loaded = restoredStore.load(logicalId);

  assert.ok(loaded, "state should be loaded after restart");
  assert.equal(
    (loaded as RecoveryStateSnapshot).exhausted,
    true,
    "exhaustion flag must survive restart",
  );
  assert.equal(
    (loaded as RecoveryStateSnapshot).sameModelAttempts,
    3,
    "same_model_attempts must survive restart",
  );
  assert.equal(
    (loaded as RecoveryStateSnapshot).fallbackIndex,
    2,
    "fallback_index must survive restart",
  );
  assert.equal((loaded as RecoveryStateSnapshot).currentModel, "model-c");
  assert.deepEqual((loaded as RecoveryStateSnapshot).failedModels, {
    "model-a": "2026-08-09T00:01:00.000Z",
  });
  restoredStore.close();
});

test("restart exhaustion state blocks replay via initialState", async () => {
  const runtime = new FakeRuntime();
  const supervisor = new RecoverySupervisor({
    runtime,
    config: testConfig(["model-a"]),
    sleep: async () => undefined,
  });

  // Provide an already-exhausted initial state → the first iteration should
  // check budget/terminal and fail fast. Actually we need to verify the
  // supervisor respects a pre-exhausted state. Let's test that a supervisor
  // that starts exhausted and receives a transient failure goes terminal
  // immediately rather than retrying endlessly.
  const exhaustedState = {
    ...freshRecoveryState("exec-pre-exhausted", new Date().toISOString()),
    sameModelAttempts: 3, // at budget
    exhausted: false,
  };

  let dispatchCount = 0;
  await assert.rejects(
    (async () => {
      for await (const event of supervisor.prompt(input, {
        logicalExecutionId: "exec-pre-exhausted",
        initialState: exhaustedState,
        dispatch: () => {
          dispatchCount += 1;
          return failedWith(INVOCATION_ID, "429 rate limited");
        },
      })) {
        void event;
      }
    })(),
    RecoveryExhaustedError,
  );

  // With sameModelAttempts already at budget, the first transient failure
  // should skip to fallback (which exhausts since only model-a configured).
  assert.ok(dispatchCount >= 1, "at least one dispatch");
  const state = supervisor.getState();
  assert.ok(state?.exhausted, "should end exhausted");
});

test("overall budget exhaustion → terminal", async () => {
  const runtime = new FakeRuntime();
  // Use a tiny overall budget so the loop can never succeed.
  const supervisor = new RecoverySupervisor({
    runtime,
    config: testConfig(["model-a"], {
      overallBudgetMs: 1,
      sameModelRetryBudget: 100, // high so it keeps looping until budget hits
    }),
    // Inject a now() that advances time rapidly on each call to exhaust budget.
    now: (() => {
      let t = 1000;
      return () => {
        t += 10000;
        return t;
      };
    })(),
    sleep: async () => undefined,
  });

  await assert.rejects(
    (async () => {
      for await (const event of supervisor.prompt(input, {
        dispatch: () => failedWith(INVOCATION_ID, "503 service unavailable"),
      })) {
        void event;
      }
    })(),
    (error: unknown) => {
      assert.ok(error instanceof RecoveryExhaustedError);
      assert.equal(error.reason, "overall_budget_exceeded");
      return true;
    },
  );
});

test("classification heuristic maps common error signals", () => {
  assert.equal(classifyNativeFailure("429", undefined), "transient_retryable");
  assert.equal(classifyNativeFailure(undefined, "Rate limit exceeded"), "transient_retryable");
  assert.equal(classifyNativeFailure("500", undefined), "transient_retryable");
  assert.equal(classifyNativeFailure("503", undefined), "transient_retryable");
  assert.equal(classifyNativeFailure("ECONNRESET", undefined), "transient_retryable");
  assert.equal(classifyNativeFailure(undefined, "network error"), "transient_retryable");
  assert.equal(classifyNativeFailure("model_not_found", undefined), "model_not_found");
  assert.equal(classifyNativeFailure(undefined, "model not found"), "model_not_found");
  assert.equal(classifyNativeFailure(undefined, "quota exceeded"), "quota_exhausted");
  assert.equal(classifyNativeFailure(undefined, "provider unavailable"), "provider_unavailable");
  assert.equal(classifyNativeFailure(undefined, "context overflow"), "context_overflow");
  assert.equal(classifyNativeFailure(undefined, "semantic failure"), "semantic_failure");
  assert.equal(classifyNativeFailure(undefined, "test failure"), "semantic_failure");
  assert.equal(classifyNativeFailure(undefined, "schema error"), "semantic_failure");
  assert.equal(classifyNativeFailure(undefined, "aborted"), "abort");
  assert.equal(classifyNativeFailure(undefined, "outcome_unknown"), "outcome_unknown");
  assert.equal(classifyNativeFailure(undefined, "reserved dispatch"), "reserved_dispatch");
  assert.equal(classifyNativeFailure("unknown_error", undefined), "terminal");
});

test("single-flight: second concurrent prompt is rejected", async () => {
  const runtime = new FakeRuntime();
  const supervisor = new RecoverySupervisor({
    runtime,
    config: testConfig(["model-a"]),
    sleep: async () => undefined,
  });

  let releaseFirst: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const firstPromise = (async () => {
    for await (const event of supervisor.prompt(input, {
      dispatch: async function* (): AsyncIterable<AgentRuntimeEvent> {
        yield { type: "turn_start", invocationId: INVOCATION_ID };
        await gate; // hold the first dispatch open
        yield { type: "settled", invocationId: INVOCATION_ID, nextTurnCount: 1 };
      },
    })) {
      void event;
    }
  })();

  // Wait a tick for the first prompt to grab the single-flight lock.
  await new Promise((resolve) => setTimeout(resolve, 10));

  await assert.rejects(
    (async () => {
      for await (const event of supervisor.prompt(input)) {
        void event;
      }
    })(),
    /already in flight/,
  );

  releaseFirst?.();
  await firstPromise;
});

test("semantic failure (BLOCKING/review) is terminal, not retried", async () => {
  const runtime = new FakeRuntime();
  const supervisor = new RecoverySupervisor({
    runtime,
    config: testConfig(["model-a"]),
    sleep: async () => undefined,
  });

  const events: AgentRuntimeEvent[] = [];
  await assert.rejects(
    (async () => {
      for await (const event of supervisor.prompt(input, {
        dispatch: () => failedWith(INVOCATION_ID, "semantic failure: review BLOCKING"),
      })) {
        events.push(event as AgentRuntimeEvent);
      }
    })(),
    (error: unknown) => {
      assert.ok(error instanceof RecoveryExhaustedError);
      assert.equal(error.reason, "semantic_failure");
      return true;
    },
  );

  const retryEvents = events.filter(
    (e) =>
      (e as { type: string; action?: string }).type === "recovery_escalation" &&
      (e as { action?: string }).action === "same_model_retry",
  );
  assert.equal(retryEvents.length, 0, "semantic failure must not trigger retry");
});

// ---------------------------------------------------------------------------
// iris_agent#89 / #90 regression tests
// ---------------------------------------------------------------------------

test("production dispatch prefers promptWithModel when the runtime supports it", async () => {
  const calls: Array<{ model: string | null }> = [];
  const runtime: AgentRuntimePort = {
    prompt: () => settledSequence(INVOCATION_ID),
    abort: async () => undefined,
    getPhase: () => "idle",
    promptWithModel: (_input, model) => {
      calls.push({ model });
      return settledSequence(INVOCATION_ID);
    },
  };
  const supervisor = new RecoverySupervisor({
    runtime,
    config: testConfig(["model-a"]),
    sleep: async () => undefined,
  });

  const events: AgentRuntimeEvent[] = [];
  // No injected dispatch → the production default must honor the selected model.
  for await (const event of supervisor.prompt(input)) {
    events.push(event as AgentRuntimeEvent);
  }

  assert.equal(calls.length, 1, "promptWithModel should be used when available");
  assert.equal(calls[0]?.model, "model-a", "selected fallback model must be passed through");
  const settled = events.filter((e) => (e as { type: string }).type === "settled");
  assert.equal(settled.length, 1);
});

test("watchdog stall aborts the exact active invocation", async () => {
  const aborts: Array<{ invocationId: string; reason: string }> = [];
  const runtime = new FakeRuntime();
  (runtime as { abort: (id: string, reason?: string) => Promise<void> }).abort = async (
    invocationId: string,
    reason?: string,
  ) => {
    aborts.push({ invocationId, reason: reason ?? "" });
  };
  const supervisor = new RecoverySupervisor({
    runtime,
    config: testConfig(["model-a"], {
      fallbackNoProgressTimeoutMs: 30,
      sameModelRetryBudget: 1,
    }),
    sleep: async () => undefined,
  });

  await assert.rejects(
    (async () => {
      for await (const event of supervisor.prompt(input, {
        dispatch: async function* (): AsyncIterable<AgentRuntimeEvent> {
          yield { type: "turn_start", invocationId: INVOCATION_ID };
          yield { type: "message_delta", invocationId: INVOCATION_ID, text: "partial" };
          await new Promise((resolve) => setTimeout(resolve, 500));
        },
      })) {
        void event;
      }
    })(),
    RecoveryExhaustedError,
  );

  assert.ok(aborts.length >= 1, "watchdog must abort the active invocation");
  assert.equal(aborts[0]?.invocationId, INVOCATION_ID, "must abort the EXACT invocation");
  assert.equal(aborts[0]?.reason, "watchdog_no_progress");
});

test("subagent watchdog governs even when longer than the fallback timeout", async () => {
  // #89 Fix 3 regression: while a subagent runs without first progress, the
  // SUBAGENT timeout must govern. The fallback no-progress timer must NOT
  // fire spuriously inside the subagent window (previously Math.min always
  // picked the 50ms fallback window and aborted the slow subagent).
  const runtime = new FakeRuntime();
  const supervisor = new RecoverySupervisor({
    runtime,
    config: testConfig(["model-a", "model-b"], {
      fallbackNoProgressTimeoutMs: 50,
      subagentFirstProgressMs: 100000,
      sameModelRetryBudget: 1,
    }),
    sleep: async () => undefined,
  });

  const events: AgentRuntimeEvent[] = [];
  for await (const event of supervisor.prompt(input, {
    dispatch: async function* (): AsyncIterable<AgentRuntimeEvent> {
      yield { type: "turn_start", invocationId: INVOCATION_ID };
      yield {
        type: "tool_call",
        invocationId: INVOCATION_ID,
        toolCallId: "tc-1",
        toolName: "slow_tool",
      };
      // Subagent runs longer than the 50ms fallback window: only the 100s
      // subagent watchdog may fire, so this must settle normally.
      await new Promise((resolve) => setTimeout(resolve, 200));
      yield { type: "message_delta", invocationId: INVOCATION_ID, text: "subagent done" };
      yield { type: "settled", invocationId: INVOCATION_ID, nextTurnCount: 1 };
    },
  })) {
    events.push(event as AgentRuntimeEvent);
  }

  const abortEvents = events.filter(
    (e) =>
      (e as { type: string; action?: string }).type === "recovery_escalation" &&
      (e as { action?: string }).action === "abort",
  );
  assert.equal(abortEvents.length, 0, "fallback watchdog must not fire during the subagent window");
  const settled = events.filter((e) => (e as { type: string }).type === "settled");
  assert.equal(settled.length, 1, "subagent must be allowed to finish");
});

test("native retry_after hint overrides exponential backoff", async () => {
  const sleeps: number[] = [];
  let attempt = 0;
  const runtime = new FakeRuntime();
  const supervisor = new RecoverySupervisor({
    runtime,
    config: testConfig(["model-a"], { sameModelRetryBudget: 2 }),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  const events: AgentRuntimeEvent[] = [];
  for await (const event of supervisor.prompt(input, {
    dispatch: () => {
      attempt += 1;
      if (attempt === 1) {
        return failedWith(INVOCATION_ID, "429 rate limit retry_after:25");
      }
      return settledSequence(INVOCATION_ID);
    },
  })) {
    events.push(event as AgentRuntimeEvent);
  }

  assert.deepEqual(sleeps, [25], "retry_after hint must replace the 2s default backoff");
});

test("extractRetryAfterMs parses native Retry-After hints", () => {
  assert.equal(extractRetryAfterMs("429", "rate limit retry_after:1500"), 1500);
  assert.equal(extractRetryAfterMs("retry_after=2000", undefined), 2000);
  assert.equal(extractRetryAfterMs("429", "rate limit"), undefined);
  assert.equal(extractRetryAfterMs("429", "retry_after:0"), undefined);
  assert.equal(extractRetryAfterMs(undefined, undefined), undefined);
});

test("exhausted initial state fails closed with zero dispatch", async () => {
  const runtime = new FakeRuntime();
  const supervisor = new RecoverySupervisor({
    runtime,
    config: testConfig(["model-a"]),
    sleep: async () => undefined,
  });

  let dispatchCount = 0;
  await assert.rejects(
    (async () => {
      for await (const event of supervisor.prompt(input, {
        logicalExecutionId: "exec-already-exhausted",
        initialState: {
          ...freshRecoveryState("exec-already-exhausted", new Date().toISOString()),
          exhausted: true,
        },
        dispatch: () => {
          dispatchCount += 1;
          return settledSequence(INVOCATION_ID);
        },
      })) {
        void event;
      }
    })(),
    (error: unknown) => {
      assert.ok(error instanceof RecoveryExhaustedError);
      assert.equal(error.reason, "already_exhausted");
      return true;
    },
  );

  assert.equal(dispatchCount, 0, "exhausted state must not dispatch");
});

test("overall budget anchors to durable createdAt on restore", async () => {
  const runtime = new FakeRuntime();
  const supervisor = new RecoverySupervisor({
    runtime,
    config: testConfig(["model-a"]),
    sleep: async () => undefined,
  });

  let dispatchCount = 0;
  await assert.rejects(
    (async () => {
      for await (const event of supervisor.prompt(input, {
        logicalExecutionId: "exec-old-budget",
        initialState: {
          ...freshRecoveryState("exec-old-budget", "2020-01-01T00:00:00.000Z"),
          exhausted: false,
        },
        dispatch: () => {
          dispatchCount += 1;
          return settledSequence(INVOCATION_ID);
        },
      })) {
        void event;
      }
    })(),
    (error: unknown) => {
      assert.ok(error instanceof RecoveryExhaustedError);
      assert.equal(error.reason, "overall_budget_exceeded");
      return true;
    },
  );

  assert.equal(dispatchCount, 0, "restored state past budget must not dispatch");
});

test("reserved_retries survives restart via the store", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "iris-recovery-")), "recovery.db");
  const store = new RecoveryStateStore(dbPath);
  const logicalId = "exec-reserved-durable";
  const snapshot = {
    ...freshRecoveryState(logicalId, "2026-08-09T00:00:00.000Z"),
    reservedRetries: 4,
  };
  store.save(snapshot);
  store.close();

  const restoredStore = new RecoveryStateStore(dbPath);
  const loaded = restoredStore.load(logicalId);
  assert.ok(loaded, "state should be loaded after restart");
  assert.equal(loaded.reservedRetries, 4, "reserved_retries must survive restart");
  restoredStore.close();
});
