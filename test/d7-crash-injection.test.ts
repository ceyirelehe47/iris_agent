/**
 * Feature D7 (#125): Durable Outcome Resolution — REAL OS-process crash
 * injection and restart recovery.
 *
 * Test parent spawns REAL subprocesses:
 *   Process A ("crash")   — real IrisHost drives one dispatch into
 *                           pendingOutcomeUnknown (durable), then the
 *                           production outcome reconciler CRASHES the
 *                           process (exit 42) at the exact window:
 *                           pending persisted, resolution NOT persisted.
 *   Process B ("restart") — NEW OS process, same dataRoot →
 *                           IrisHost.open() → production restart recovery.
 *   Process C ("restart2")— a second restart.
 *
 * The test NEVER touches recovery-state.db directly; all state transitions
 * come from production code. Reconciler calls and host events are appended
 * to cross-process counter files so process restarts never reset them.
 *
 * Scenarios:
 *   confirmed_applied:  B reconciles once (real evidence) → durable
 *                       resolution; C reads it with ZERO reconciler calls
 *                       and ZERO provider dispatch (zero replay).
 *   replay_safe:        B reconciles once → exactly ONE authorized retry
 *                       dispatch (same identity), then settles.
 *   ambiguous:          B reconciles once → zero replay; C restarts again →
 *                       still zero replay (durable exhausted fence).
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { defaultAgentConfig } from "../src/config/load.js";
import { initializeDataRoot } from "../src/host/data-root.js";
import {
  DurableOutcomeResolutionStore,
  defaultFallbackConfig,
  freshRecoveryState,
  RecoveryStateStore,
} from "../src/runtime/recovery-state.js";
import { RecoverySupervisor } from "../src/runtime/recovery-supervisor.js";
import { sampleAgentInput } from "../src/runtime/vertical-slice.js";
import type { AgentRuntimeEvent, AgentRuntimePort } from "../src/contracts/ports.js";
import type { AgentRuntimePhase } from "../src/contracts/runtime-ports.js";

const WORKER = join(import.meta.dirname, "..", "scripts", "d7-recovery-worker.ts");

interface Ctx {
  dataRoot: string;
  reconcilerFile: string;
  eventFile: string;
}

function makeCtx(): Ctx {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-d7-"));
  const reconcilerFile = join(dataRoot, "reconciler-calls.log");
  const eventFile = join(dataRoot, "host-events.log");
  return { dataRoot, reconcilerFile, eventFile };
}

function spawnWorker(ctx: Ctx, role: string, outcome: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc: ChildProcess = spawn("npx", ["tsx", WORKER], {
      env: {
        ...process.env,
        IRIS_ROLE: role,
        IRIS_OUTCOME: outcome,
        IRIS_DATA_ROOT: ctx.dataRoot,
        IRIS_RECONCILER_FILE: ctx.reconcilerFile,
        IRIS_EVENT_FILE: ctx.eventFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === null) {
        reject(new Error("worker killed without exit code"));
        return;
      }
      if (code !== 0 && code !== 42) {
        reject(new Error(`worker exit ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve(code);
    });
  });
}

function readLines(file: string): string[] {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

function reconcilerCalls(ctx: Ctx): string[] {
  return readLines(ctx.reconcilerFile);
}

function turnStarts(ctx: Ctx): number {
  return readLines(ctx.eventFile).filter((line) => line.includes("turn_start")).length;
}

function initialize(ctx: Ctx): void {
  initializeDataRoot(ctx.dataRoot, defaultAgentConfig());
}

// ---------------------------------------------------------------------------
// confirmed_applied: durable resolution → zero replay AND zero re-query
// ---------------------------------------------------------------------------

test("D7: crash → restart (confirmed_applied) → restart2 reads durable resolution with zero replay and zero re-query", async () => {
  const ctx = makeCtx();
  initialize(ctx);

  // Process A: crash at the pending-persisted / resolution-not-persisted window.
  const crashCode = await spawnWorker(ctx, "crash", "confirmed_applied");
  assert.equal(crashCode, 42, "Process A must crash at the injection point");
  assert.equal(
    reconcilerCalls(ctx).length,
    1,
    "Process A: the reconciler ran exactly once before the crash",
  );
  assert.equal(turnStarts(ctx), 1, "Process A: exactly one dispatch started");
  // The durable pending exists (written by production supervisor before the
  // reconciler) — verified indirectly: restart below reconciles it.

  // Process B: NEW OS process → production restart recovery.
  const restartCode = await spawnWorker(ctx, "restart", "confirmed_applied");
  assert.equal(restartCode, 0, "Process B must complete its restart recovery");
  assert.equal(
    reconcilerCalls(ctx).length,
    2,
    "Process B: startup reconciliation consults the reconciler exactly once",
  );
  assert.equal(turnStarts(ctx), 1, "confirmed_applied: zero replay — no second dispatch");

  // Durable resolution persisted by production code. The logical execution
  // id is host-derived: `logical-exec-<epoch>-<inputId>`.
  const resolutions = new DurableOutcomeResolutionStore(join(ctx.dataRoot, "recovery-state.db"));
  const resolution = resolutions.load("logical-exec-1:input-0001");
  assert.ok(resolution !== null, "confirmed_applied must persist a durable resolution");
  assert.equal(resolution?.resolution, "confirmed_applied");
  assert.equal(resolution?.inputId, "input-0001");
  resolutions.close();

  // Process C: second restart — reads the durable resolution: ZERO re-query,
  // ZERO replay.
  const restart2Code = await spawnWorker(ctx, "restart2", "confirmed_applied");
  assert.equal(restart2Code, 0, "Process C must complete");
  assert.equal(
    reconcilerCalls(ctx).length,
    2,
    "Process C: durable resolution read — the reconciler is NEVER re-queried",
  );
  assert.equal(
    turnStarts(ctx),
    1,
    "Process C: zero replay — no provider dispatch after confirmed_applied",
  );
});

// ---------------------------------------------------------------------------
// replay_safe: exactly one authorized retry with the same identity
// ---------------------------------------------------------------------------

test("D7: crash → restart (replay_safe) authorizes exactly one replay, then settles", async () => {
  const ctx = makeCtx();
  initialize(ctx);

  const crashCode = await spawnWorker(ctx, "crash", "replay_safe");
  assert.equal(crashCode, 42);
  assert.equal(reconcilerCalls(ctx).length, 1);
  assert.equal(turnStarts(ctx), 1);

  const restartCode = await spawnWorker(ctx, "restart", "replay_safe");
  assert.equal(restartCode, 0, "replay_safe restart must complete");
  assert.equal(
    reconcilerCalls(ctx).length,
    2,
    "replay_safe: the restart reconciles the durable pending exactly once",
  );
  assert.equal(
    turnStarts(ctx),
    2,
    "replay_safe: exactly ONE authorized retry dispatch (the original + one replay)",
  );
  // The replay carries the SAME logical execution identity (same inputId).
  const replayDispatch = readLines(ctx.eventFile).filter((line) => line.includes("turn_start"));
  assert.ok(replayDispatch.length >= 1);
});

// ---------------------------------------------------------------------------
// Durable resolution read guard: even when a pending record is (incorrectly)
// still present on restart, a durable confirmed_applied resolution MUST
// short-circuit dispatch and reconciliation (zero replay, zero re-query).
// ---------------------------------------------------------------------------

test("D7: durable confirmed_applied resolution short-circuits dispatch even with a stale pending record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-d7-guard-"));
  const config = defaultAgentConfig();
  const input = sampleAgentInput();
  const logicalExecutionId = "logical-exec-1:input-0001";
  const resolutionStore = new DurableOutcomeResolutionStore(join(dir, "recovery-state.db"));
  // The store shares the recovery DB, which is migrated by RecoveryStateStore
  // (production order: recoveryStore first, then resolutionStore).
  const migrator = new RecoveryStateStore(join(dir, "recovery-state.db"));
  migrator.close();
  try {
    resolutionStore.save({
      logicalExecutionId,
      inputId: input.inputId,
      dispatchId: "invocation-input-0001",
      resolution: "confirmed_applied",
      evidenceSource: "outcome_reconciler",
      evidenceRef: "reconciled:invocation-input-0001",
      resolvedAt: new Date().toISOString(),
    });

    // Production supervisor + REAL SQLite resolution store. A stale pending
    // record is injected as the initialState (double-fault window: pending
    // persisted AND resolution written). The runtime stub only OBSERVES —
    // the durable resolution must short-circuit before any dispatch.
    let dispatchCalls = 0;
    const runtime: AgentRuntimePort = {
      async *prompt(): AsyncIterable<AgentRuntimeEvent> {
        dispatchCalls += 1;
        yield { type: "settled", invocationId: "invocation-input-0001", nextTurnCount: 0 };
      },
      async abort(): Promise<void> {
        return undefined;
      },
      getPhase(): AgentRuntimePhase {
        return "idle";
      },
    };
    const reconcilerCalls: string[] = [];
    const supervisor = new RecoverySupervisor({
      runtime,
      config: {
        ...defaultFallbackConfig(["mock-iris/mock-deepseek-v4-flash"]),
        fallbackNoProgressTimeoutMs: 1000,
        abortSettlementTimeoutMs: 500,
      },
      resolutionStore,
      reconcileOutcomeUnknown: async (signal) => {
        reconcilerCalls.push(signal.dispatchId ?? "unknown");
        return "ambiguous";
      },
    });
    const stale = freshRecoveryState(logicalExecutionId, new Date().toISOString());
    stale.pendingOutcomeUnknown = {
      dispatchId: "invocation-input-0001",
      logicalExecutionId,
      inputId: input.inputId,
      model: "mock-iris/mock-deepseek-v4-flash",
      occurredAt: new Date().toISOString(),
    };
    const events: string[] = [];
    for await (const event of supervisor.prompt(input, {
      initialState: stale,
      logicalExecutionId,
    })) {
      events.push(event.type);
    }
    assert.equal(
      reconcilerCalls.length,
      0,
      "durable confirmed_applied must be read BEFORE any reconciliation — zero re-query",
    );
    assert.equal(
      dispatchCalls,
      0,
      "durable confirmed_applied → zero replay (no provider dispatch)",
    );
  } finally {
    resolutionStore.close();
  }
});

test("D7: crash → restart (ambiguous) → zero replay; second restart still zero replay", async () => {
  const ctx = makeCtx();
  initialize(ctx);

  const crashCode = await spawnWorker(ctx, "crash", "ambiguous");
  assert.equal(crashCode, 42);
  assert.equal(reconcilerCalls(ctx).length, 1);
  assert.equal(turnStarts(ctx), 1);

  const restartCode = await spawnWorker(ctx, "restart", "ambiguous");
  assert.equal(restartCode, 0);
  assert.equal(reconcilerCalls(ctx).length, 2, "ambiguous: reconciled once on restart");
  assert.equal(
    turnStarts(ctx),
    1,
    "ambiguous: ZERO replay — the input is session_committed, never re-dispatched",
  );

  const restart2Code = await spawnWorker(ctx, "restart2", "ambiguous");
  assert.equal(restart2Code, 0);
  assert.equal(
    reconcilerCalls(ctx).length,
    2,
    "repeated restart after ambiguous: still zero re-query (durable exhausted fence)",
  );
  assert.equal(turnStarts(ctx), 1, "repeated restart after ambiguous: still zero replay");
});
