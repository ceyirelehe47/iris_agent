/**
 * Crash-boundary worker for the R1 crash-window suite.
 *
 * Runs inside a child process, advances a real data root to the named
 * boundary, then parks (sleeps) so the parent can SIGKILL it mid-state.
 * Every boundary writes a marker file before parking; the parent asserts the
 * marker and the resulting persisted state after a real process kill.
 *
 * Boundaries (matching the R1 Exit Gate crash windows):
 *  - before_any_write          : data root initialized, nothing persisted
 *  - after_user_append         : UserMessage committed, no companion yet
 *  - after_companion_append    : input pair (user + iris_input_meta) committed
 *  - after_settled             : full mock slice reached settled
 *  - after_epoch_created       : active Epoch row exists
 *  - after_tool_result_commit  : slice finished (tool result committed)
 *  - after_creating_epoch      : rollover began (creating Epoch + new Pi
 *                                Session row exist) but CAS not yet done
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNodeSqliteFactory, SqliteSessionRepository } from "@iris/pi-storage-sqlite-node";

import { defaultAgentConfig } from "../src/config/load.js";
import { initializeDataRoot, resolveDataRootPaths } from "../src/host/data-root.js";
import { acquireDataRootLock } from "../src/host/lock.js";
import { RuntimeEpochStore } from "../src/runtime/epoch-manager.js";
import { nodeSqliteRepoEnv } from "../src/runtime/pi-env.js";
import { sampleAgentInput } from "../src/runtime/vertical-slice.js";
import { runMinimalSlice } from "../src/runtime/vertical-slice-demo.js";
import { IRIS_INPUT_META_CONTENT, IRIS_INPUT_META_CUSTOM_TYPE } from "../src/contracts/context.js";

const boundaryIndex = process.argv.indexOf("--boundary");
const boundary = boundaryIndex >= 0 ? process.argv[boundaryIndex + 1] : "before_any_write";
const dataRootIndex = process.argv.indexOf("--data-root");
const rawDataRoot = dataRootIndex >= 0 ? process.argv[dataRootIndex + 1] : undefined;
const dataRoot = rawDataRoot ?? mkdtempSync(join(tmpdir(), "iris-crash-worker-"));

const marker = join(dataRoot, "crash-marker.json");
const config = defaultAgentConfig();
const paths = resolveDataRootPaths(dataRoot, config);

function park(): Promise<never> {
  writeFileSync(marker, JSON.stringify({ boundary, reachedAt: new Date().toISOString() }), "utf8");
  // Park forever; the parent kills this process at this exact state. The
  // periodic timer keeps the event loop (and the process) alive so the
  // parent's SIGKILL genuinely lands on a live process — a throw here would
  // crash the worker on its own and make the parent's kill a no-op.
  return new Promise<never>(() => {
    setInterval(() => undefined, 60_000);
  });
}

// settled boundary runs the full slice (which manages its own data-root
// lock); tool_result_commit parks INSIDE the slice, immediately after the
// tool result is committed to the Session but BEFORE the follow-up provider
// call (final assistant) happens — the exact crash window the Exit Gate
// requires. Do not hold the outer lock concurrently.
if (boundary === "after_settled") {
  await runMinimalSlice({
    dataRoot,
    config,
    input: sampleAgentInput(),
    provider: "mock",
  });
  await park();
}

if (boundary === "after_tool_result_commit") {
  await runMinimalSlice({
    dataRoot,
    config,
    input: sampleAgentInput(),
    provider: "mock",
    callbacks: {
      onAfterToolResultProviderCall: () => {
        // Fired after Pi flushed the tool-result Session writes and is about
        // to make the follow-up provider call. Write the marker, then park
        // (never resolve) so the slice stops here: the ToolResult is durably
        // committed, the final assistant turn has NOT started — the exact
        // Exit Gate crash window. The parent SIGKILLs this live process.
        writeFileSync(
          marker,
          JSON.stringify({ boundary, reachedAt: new Date().toISOString() }),
          "utf8",
        );
        return new Promise<void>(() => {
          setInterval(() => undefined, 60_000);
        });
      },
    },
  });
}

const lock = await acquireDataRootLock(dataRoot, paths.lockFile);
try {
  initializeDataRoot(dataRoot, config);

  if (boundary === "before_any_write") {
    await park();
  }

  if (boundary === "after_epoch_created") {
    const epochStore = new RuntimeEpochStore(
      paths.epochRegistryDb,
      config.runtime_sessions.session_id_prefix,
      config.runtime_sessions.timezone,
    );
    epochStore.ensureActive("2026-08-01T00:00:00.000Z");
    epochStore.close();
    await park();
  }

  if (boundary === "after_creating_epoch") {
    // Rollover began (creating Epoch row) AND the new Pi Session row was
    // created, but the active CAS has NOT happened. A kill here must leave
    // the old epoch active; startup recovery must remove the stale creating
    // Epoch AND the orphan Pi Session row.
    const epochStore = new RuntimeEpochStore(
      paths.epochRegistryDb,
      config.runtime_sessions.session_id_prefix,
      config.runtime_sessions.timezone,
    );
    epochStore.ensureActive("2026-08-01T00:00:00.000Z");
    const pending = epochStore.beginRollover("2026-08-01T00:00:00.000Z");
    const repo = new SqliteSessionRepository({
      env: nodeSqliteRepoEnv(dataRoot),
      sqlite: createNodeSqliteFactory(),
      databasePath: paths.sessionDb,
    });
    await repo.create({ id: pending.runtimeSessionId, cwd: dataRoot });
    epochStore.close();
    await park();
  }

  const repo = new SqliteSessionRepository({
    env: nodeSqliteRepoEnv(dataRoot),
    sqlite: createNodeSqliteFactory(),
    databasePath: paths.sessionDb,
  });
  const session = await repo.create({ id: "crash-session", cwd: dataRoot });

  if (boundary === "after_user_append") {
    await session.appendMessage({
      role: "user",
      content: "IRIS_INPUT_V1\ninline_text:14\ncrash boundary\n",
      timestamp: Date.now(),
    });
    await park();
  }

  if (boundary === "after_companion_append") {
    await session.appendMessage({
      role: "user",
      content: "IRIS_INPUT_V1\ninline_text:14\ncrash boundary\n",
      timestamp: Date.now(),
    });
    await session.appendCustomMessageEntry(
      IRIS_INPUT_META_CUSTOM_TYPE,
      IRIS_INPUT_META_CONTENT,
      false,
      {
        iris: {
          schemaVersion: 1,
          inputId: "crash-input-0001",
          pairKey: "crash-pair-key",
          contentLayoutHash: "crash-layout-hash",
          blocks: [],
        },
      },
    );
    await park();
  }

  throw new Error(`unknown boundary: ${boundary}`);
} finally {
  await lock.release();
}
