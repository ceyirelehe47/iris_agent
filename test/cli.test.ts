import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

const repoRoot = join(import.meta.dirname, "..");
const distBin = join(repoRoot, "dist", "src", "bin.js");

interface CliRunOutput {
  status: string;
  settled: boolean;
  provider: string;
  epochId: string;
  runtimeSessionId: string;
  toolCalls: Array<{ toolCallId: string; toolName: string }>;
  eventCount: number;
}

async function startServeCli(dataRoot: string): Promise<{
  child: ReturnType<typeof spawn>;
  port: number;
}> {
  const child = spawn(
    process.execPath,
    [distBin, "serve", "--data-root", dataRoot, "--port", "0"],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: "0" } },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const match = /"endpoint":\s*"http:\/\/127\.0\.0\.1:(\d+)"/.exec(stdout);
    if (match?.[1] !== undefined) {
      return { child, port: Number.parseInt(match[1], 10) };
    }
    if (child.exitCode !== null) {
      throw new Error(`iris serve exited early (${child.exitCode}): ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill("SIGKILL");
  throw new Error(`iris serve did not become ready: ${stderr}`);
}

async function stopServeCli(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.stdin !== null && !child.stdin.destroyed) {
    child.stdin.end();
  }
  await new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
    setTimeout(resolve, 5000);
  });
  if (child.exitCode === null) {
    child.kill("SIGKILL");
  }
}

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync(process.execPath, [distBin, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.status ?? 1 };
  }
}

test("iris bin is built and executable", () => {
  assert.ok(existsSync(distBin), "dist/src/bin.js must exist (run npm run build first)");
});

test("iris run executes a real subprocess vertical slice to settled", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-cli-run-"));
  const inputFile = join(dataRoot, "input.json");
  writeFileSync(
    inputFile,
    JSON.stringify({
      inputId: "cli-input-0001",
      triggerOrigin: {
        schemaVersion: 1,
        channel: "cli",
        principalKind: "user",
        authority: "user_request",
        trust: "trusted",
      },
      blocks: [
        {
          blockId: "cli-block-0001",
          sourceOrigin: {
            schemaVersion: 1,
            channel: "cli",
            principalKind: "user",
            authority: "user_request",
            trust: "trusted",
          },
          content: { mode: "inline_text", text: "hello iris, run the read tool" },
          contentHash: "",
        },
      ],
      interaction: { interactionId: "cli-interaction-0001" },
    }),
    "utf8",
  );

  const { stdout, exitCode } = runCli([
    "run",
    "--data-root",
    dataRoot,
    "--input-file",
    inputFile,
    "--provider",
    "mock",
  ]);

  assert.equal(exitCode, 0, `cli exited ${exitCode}: ${stdout}`);
  const output = JSON.parse(stdout) as CliRunOutput;
  assert.equal(output.status, "ok");
  assert.equal(output.settled, true);
  assert.equal(output.provider, "mock");
  assert.ok(output.epochId.startsWith("iris-runtime-"));
  assert.ok(output.runtimeSessionId.startsWith("iris-runtime-"));
  assert.ok(output.toolCalls.length >= 1, "vertical slice must execute the read tool");
  assert.ok(output.eventCount >= 3);
});

test("iris run rejects an input with a mismatched content hash", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-cli-badhash-"));
  const inputFile = join(dataRoot, "input.json");
  writeFileSync(
    inputFile,
    JSON.stringify({
      inputId: "cli-input-bad",
      triggerOrigin: {
        schemaVersion: 1,
        channel: "cli",
        principalKind: "user",
        authority: "user_request",
        trust: "trusted",
      },
      blocks: [
        {
          blockId: "block-1",
          sourceOrigin: {
            schemaVersion: 1,
            channel: "cli",
            principalKind: "user",
            authority: "user_request",
            trust: "trusted",
          },
          content: { mode: "inline_text", text: "hello" },
          contentHash: "deadbeef",
        },
      ],
    }),
    "utf8",
  );

  const { stderr, exitCode } = runCli([
    "run",
    "--data-root",
    dataRoot,
    "--input-file",
    inputFile,
    "--provider",
    "mock",
  ]);

  assert.equal(exitCode, 1);
  assert.match(stderr, /contentHash does not match/i);
});

test("iris run rejects malformed input structure", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-cli-badshape-"));
  const inputFile = join(dataRoot, "input.json");
  writeFileSync(inputFile, JSON.stringify({ inputId: "x", blocks: [] }), "utf8");

  const { stderr, exitCode } = runCli([
    "run",
    "--data-root",
    dataRoot,
    "--input-file",
    inputFile,
    "--provider",
    "mock",
  ]);

  assert.equal(exitCode, 1);
  assert.match(stderr, /non-empty blocks/i);
});

test("iris serve starts the long-lived Host and reports ready with a loopback endpoint", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-cli-serve-"));
  const { child, port } = await startServeCli(dataRoot);
  try {
    // The Host is alive and serving on loopback.
    const response = await fetch(`http://127.0.0.1:${port}/v1/health`);
    assert.equal(response.status, 200);
    const health = (await response.json()) as { ready: boolean; coordinatorPhase: string };
    assert.equal(health.ready, true);
    assert.equal(health.coordinatorPhase, "idle");
    assert.ok(existsSync(join(dataRoot, "runtime-epochs.db")));
  } finally {
    await stopServeCli(child);
  }
});

test("iris run fails closed on a missing or invalid triggerOrigin", () => {
  // Review blocker #4: provenance must fail closed — a missing triggerOrigin
  // is an error, never a silent fallback to a block origin.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-cli-noorigin-"));
  const inputFile = join(dataRoot, "input.json");
  writeFileSync(
    inputFile,
    JSON.stringify({
      inputId: "cli-input-noorigin",
      blocks: [
        {
          blockId: "block-1",
          sourceOrigin: {
            schemaVersion: 1,
            channel: "cli",
            principalKind: "user",
            authority: "user_request",
            trust: "trusted",
          },
          content: { mode: "inline_text", text: "hello" },
          contentHash: "",
        },
      ],
    }),
    "utf8",
  );

  const { stderr, exitCode } = runCli([
    "run",
    "--data-root",
    dataRoot,
    "--input-file",
    inputFile,
    "--provider",
    "mock",
  ]);

  assert.equal(exitCode, 1);
  assert.match(stderr, /triggerOrigin/);
});
