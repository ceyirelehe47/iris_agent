/**
 * D7 (#125) crash-recovery worker — runs in a REAL OS subprocess.
 *
 * Roles (env IRIS_ROLE):
 *  - "crash":       real IrisHost drives one dispatch into
 *                   pendingOutcomeUnknown (durable), then the outcome
 *                   reconciler CRASHES the process (process.exit) at the
 *                   exact window: pending persisted, resolution NOT
 *                   persisted. No test code touches recovery-state.db.
 *  - "restart":     NEW OS process, same dataRoot → IrisHost.open() →
 *                   production restart recovery (startup reconciliation for
 *                   the paired input / dispatch-path reconciliation). The
 *                   reconciler returns IRIS_OUTCOME and records every call.
 *  - "restart2":    a SECOND restart — for confirmed_applied must read the
 *                   durable resolution with ZERO reconciler calls and ZERO
 *                   provider dispatch (zero replay).
 *
 * Cross-process observability: every reconciler call appends to
 * IRIS_RECONCILER_FILE and every host event appends to IRIS_EVENT_FILE —
 * process restarts never reset these counters.
 */
import * as fs from "node:fs";

import { defaultAgentConfig } from "../src/config/load.js";
import { initializeDataRoot } from "../src/host/data-root.js";
import { IrisHost } from "../src/host/host.js";
import { sampleAgentInput } from "../src/runtime/vertical-slice.js";

const role = process.env["IRIS_ROLE"] ?? "crash";
const outcome = process.env["IRIS_OUTCOME"] ?? "ambiguous";
const dataRoot = process.env["IRIS_DATA_ROOT"];
const reconcilerFile = process.env["IRIS_RECONCILER_FILE"];
const eventFile = process.env["IRIS_EVENT_FILE"];
const dataRootPath = dataRoot ?? "";
const reconcilerPath = reconcilerFile ?? "";
const eventFilePath = eventFile ?? "";
if (dataRootPath === "" || reconcilerPath === "" || eventFilePath === "") {
  console.error("missing env: IRIS_DATA_ROOT / IRIS_RECONCILER_FILE / IRIS_EVENT_FILE");
  process.exit(2);
}

function append(file: string, line: string): void {
  fs.appendFileSync(file, `${line}\n`);
}

async function main(): Promise<void> {
  const config = defaultAgentConfig();
  initializeDataRoot(dataRootPath, config);

  if (role === "crash") {
    const host = await IrisHost.open({
      dataRoot: dataRootPath,
      config,
      provider: "mock",
      // The first provider call throws → real harness emitRunFailure →
      // supervisor classifies outcome_unknown → pendingOutcomeUnknown is
      // persisted durably BEFORE the reconciler runs.
      mockProviderError: new Error("provider dispatch outcome_unknown: ambiguous status"),
      outcomeReconciler: async (signal) => {
        append(reconcilerPath, `reconciler:${signal.dispatchId}`);
        // CRASH INJECTION (production crash window): the durable pending
        // record exists; NO durable resolution has been written. Kill the
        // process right here — exactly like a real crash between persist
        // and resolution.
        process.exit(42);
      },
    });
    const input = sampleAgentInput();
    host.onEvent((e) => {
      append(eventFilePath, `event:${e.type}`);
    });
    host.acceptInput(input, input.inputId);
    await host.run();
    // The reconciler should have exited the process; reaching here means the
    // crash point was NOT hit.
    console.error("crash worker reached end without crashing — exit(3)");
    process.exit(3);
  }

  if (role === "restart" || role === "restart2") {
    const reconciler = async (signal: {
      logicalExecutionId: string;
      inputId: string;
      dispatchId: string;
    }): Promise<"confirmed_applied" | "replay_safe" | "ambiguous"> => {
      append(reconcilerPath, `reconciler:${signal.dispatchId}`);
      return outcome as "confirmed_applied" | "replay_safe" | "ambiguous";
    };
    let host: IrisHost | undefined;
    try {
      host = await IrisHost.open({
        dataRoot: dataRootPath,
        config,
        provider: "mock",
        outcomeReconciler: reconciler,
      });
      host.onEvent((e) => {
      append(eventFilePath, `event:${e.type}`);
    });
      const pump = host.run();
      // Let the production recovery path run to completion (startup
      // reconciliation + any authorized replay) before shutdown.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await host.shutdown();
      await pump.catch(() => undefined);
      process.exit(0);
    } catch (error) {
      console.error(`restart worker failed: ${(error as Error).message}`);
      process.exit(4);
    }
  }

  console.error(`unknown role: ${role}`);
  process.exit(2);
}

void main();
