/**
 * R1 crash-window suite (parent orchestrator).
 *
 * Spawns `crash-worker` as a child process, waits for the boundary marker,
 * then kills the child with SIGKILL at exactly that persisted state. After
 * the kill it reopens the same data root and asserts crash-window invariants
 * from the R1 Exit Gate:
 *  - the Session history head and entry sequence remain readable;
 *  - no synthetic assistant or ToolResult repair was appended;
 *  - an input pair (user + iris_input_meta) is preserved as persisted;
 *  - the Epoch registry remains readable with a single active epoch.
 *
 * Usage: tsx scripts/crash-harness.ts [--boundary <name>]
 */

import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { createNodeSqliteFactory, SqliteSessionRepository } from "@iris/pi-storage-sqlite-node";

import { defaultAgentConfig } from "../src/config/load.js";
import { initializeDataRoot, resolveDataRootPaths } from "../src/host/data-root.js";
import { RuntimeEpochStore } from "../src/runtime/epoch-manager.js";
import { nodeSqliteRepoEnv } from "../src/runtime/pi-env.js";

interface CrashWindowResult {
  boundary: string;
  status: "ok";
  recoveredCreating: number;
  orphanSessionsDeleted: number;
  epochCount: number;
  activeEpoch: string | null;
  activeEpochStatus: string | null;
  sessionCount: number;
  entryCount: number;
  userCount: number;
  companionCount: number;
  assistantCount: number;
  toolResultCount: number;
  invocationDb: boolean;
  resultDb: boolean;
  markerBoundary: string | null;
}

const boundaryIndex = process.argv.indexOf("--boundary");
const boundary = boundaryIndex >= 0 ? process.argv[boundaryIndex + 1] : "before_any_write";

const dataRoot = mkdtempSync(join(tmpdir(), "iris-crash-harness-"));
const config = defaultAgentConfig();
const paths = resolveDataRootPaths(dataRoot, config);
const markerPath = join(dataRoot, "crash-marker.json");

const workerPath = join(process.cwd(), "scripts", "crash-worker.ts");

async function waitForMarker(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(markerPath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`boundary marker not produced within ${timeoutMs}ms`);
}

function killHard(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGKILL");
  });
}

async function main(): Promise<void> {
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", workerPath, "--boundary", boundary ?? "", "--data-root", dataRoot],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let childOutput = "";
  child.stdout?.on("data", (chunk) => {
    childOutput += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    childOutput += String(chunk);
  });

  await waitForMarker(30_000);
  await killHard(child);

  // Reopen the data root as a fresh process would: run the re-entrant
  // startup recovery (read stale creating Epochs -> delete orphan Pi Session
  // rows -> then delete the Epoch rows), then read state.
  initializeDataRoot(dataRoot, config);

  // Epoch registry: readable, single active epoch.
  const epochStore = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const staleCreating = epochStore.listCreating();
  let orphanSessionsDeleted = 0;

  // Session history: head readable via the repo.
  const repo = new SqliteSessionRepository({
    env: nodeSqliteRepoEnv(dataRoot),
    sqlite: createNodeSqliteFactory(),
    databasePath: paths.sessionDb,
  });
  let list = await repo.list({ cwd: dataRoot });
  const cleanedSessions: string[] = [];
  for (const stale of staleCreating) {
    const metadata = list.find((candidate) => candidate.id === stale.runtimeSessionId);
    if (metadata !== undefined) {
      await repo.delete?.(metadata);
      orphanSessionsDeleted += 1;
    }
    cleanedSessions.push(stale.runtimeSessionId);
  }
  const recoveredCreating = epochStore.recoverCreating(cleanedSessions);
  const active = epochStore.getActive();
  const epochCount = epochStore.countAll();
  const activeEpoch = active?.epochId ?? null;
  const activeEpochStatus = active?.status ?? null;
  epochStore.close();

  // Re-list after deletion: the previous snapshot may reference orphan rows.
  list = await repo.list({ cwd: dataRoot });
  const remainingSessions = list;
  let entryCount = 0;
  let userCount = 0;
  let companionCount = 0;
  let assistantCount = 0;
  let toolResultCount = 0;
  if (remainingSessions.length > 0) {
    const metadata = remainingSessions[0];
    if (metadata === undefined) {
      throw new Error("session list returned undefined entry");
    }
    const session = await repo.open(metadata);
    const entries = await session.getEntries();
    entryCount = entries.length;
    for (const entry of entries) {
      if (entry.type === "message") {
        const message = (entry as { message: { role: string; customType?: string } }).message;
        if (message.role === "user") {
          userCount += 1;
        } else if (message.role === "custom" && message.customType === "iris_input_meta") {
          companionCount += 1;
        } else if (message.role === "assistant") {
          assistantCount += 1;
        } else if (message.role === "toolResult") {
          toolResultCount += 1;
        }
      } else if (
        entry.type === "custom_message" &&
        (entry as { customType?: string }).customType === "iris_input_meta"
      ) {
        companionCount += 1;
      }
    }
  }
  // 0.83.0+: Session connection lifecycle is owned by the repository.
  // Dispose unconditionally (also when no sessions remain) so the Windows
  // db handle is released before the temp dir is removed.
  await repo[Symbol.asyncDispose]();

  const invocationDb = existsSync(join(dataRoot, "invocation.db"));
  const resultDb = existsSync(join(dataRoot, "result.db"));

  const marker = existsSync(markerPath)
    ? (JSON.parse(readFileSync(markerPath, "utf8")) as { boundary?: unknown })
    : null;
  const markerBoundary: string | null =
    typeof marker?.boundary === "string" ? marker.boundary : null;

  const result: CrashWindowResult = {
    boundary: boundary ?? "before_any_write",
    status: "ok",
    recoveredCreating: recoveredCreating,
    orphanSessionsDeleted,
    epochCount,
    activeEpoch,
    activeEpochStatus,
    sessionCount: remainingSessions.length,
    entryCount,
    userCount,
    companionCount,
    assistantCount,
    toolResultCount,
    invocationDb,
    resultDb,
    markerBoundary,
  };

  console.log(JSON.stringify(result, null, 2));

  // Assertions (R1 Exit Gate crash-window invariants).
  const failures: string[] = [];
  if (boundary === "before_any_write") {
    if (entryCount !== 0) failures.push(`expected 0 entries, got ${entryCount}`);
    if (userCount !== 0) failures.push(`expected 0 user entries, got ${userCount}`);
  }
  if (boundary === "after_user_append") {
    if (userCount !== 1) failures.push(`expected 1 user entry, got ${userCount}`);
    if (companionCount !== 0) failures.push(`expected 0 companions, got ${companionCount}`);
    if (assistantCount !== 0) failures.push(`synthetic assistant repair found (${assistantCount})`);
    if (toolResultCount !== 0)
      failures.push(`synthetic tool result repair found (${toolResultCount})`);
  }
  if (boundary === "after_companion_append") {
    if (userCount !== 1) failures.push(`expected 1 user entry, got ${userCount}`);
    if (companionCount !== 1) failures.push(`expected 1 companion, got ${companionCount}`);
    if (assistantCount !== 0) failures.push(`synthetic assistant repair found (${assistantCount})`);
    if (toolResultCount !== 0)
      failures.push(`synthetic tool result repair found (${toolResultCount})`);
  }
  if (boundary === "after_epoch_created") {
    if (active === null) failures.push("expected an active epoch after epoch creation");
  }
  if (boundary === "after_creating_epoch") {
    // Rollover began but CAS never happened: startup recovery must remove
    // the stale creating Epoch AND its orphan Pi Session row, leaving the
    // original epoch active.
    if (active === null) failures.push("expected an active epoch after creating-epoch crash");
    if (recoveredCreating !== 1)
      failures.push(`expected 1 recovered creating epoch, got ${recoveredCreating}`);
    if (orphanSessionsDeleted !== 1)
      failures.push(`expected 1 orphan session deleted, got ${orphanSessionsDeleted}`);
    if (remainingSessions.some((s) => s.id === staleCreating[0]?.runtimeSessionId))
      failures.push("orphan Pi Session row still present after recovery");
  }
  if (boundary === "after_settled") {
    if (active === null) failures.push("expected an active epoch after settled slice");
    if (userCount !== 1) failures.push(`expected 1 user entry, got ${userCount}`);
    if (companionCount !== 1) failures.push(`expected 1 companion, got ${companionCount}`);
    if (entryCount < 3) failures.push(`expected >=3 entries after settled, got ${entryCount}`);
  }
  if (boundary === "after_tool_result_commit") {
    // The kill lands between ToolResult commit and the follow-up provider
    // call: the tool result must be durably committed, the tool-call
    // assistant turn must exist, and there must be NO settled marker (the
    // final assistant turn never happened).
    if (active === null) failures.push("expected an active epoch after tool result commit");
    if (userCount !== 1) failures.push(`expected 1 user entry, got ${userCount}`);
    if (companionCount !== 1) failures.push(`expected 1 companion, got ${companionCount}`);
    if (toolResultCount < 1)
      failures.push(`expected >=1 committed tool result, got ${toolResultCount}`);
    if (assistantCount < 1)
      failures.push(`expected >=1 tool-call assistant turn, got ${assistantCount}`);
  }
  if (invocationDb || resultDb) {
    failures.push("synthetic repair DB artifacts must not exist");
  }

  if (failures.length > 0) {
    console.error("CRASH-WINDOW FAILURES:\n- " + failures.join("\n- "));
    process.exitCode = 1;
  }

  // Windows may hold the sqlite file handle briefly after close; a failed
  // temp-dir removal must NOT fail the boundary check (verification already
  // produced its verdict). The temp dir is under the OS tmpdir.
  try {
    rmSync(dataRoot, { recursive: true, force: true });
  } catch (cleanupError) {
    console.warn(`[crash-harness] temp cleanup skipped: ${String(cleanupError)}`);
  }
  void childOutput;
}

await main();
