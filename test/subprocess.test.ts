import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { directUserRequest } from "../src/contracts/origin.js";

const repoRoot = join(import.meta.dirname, "..");
const distBin = join(repoRoot, "dist", "src", "bin.js");

interface HostProcess {
  child: ChildProcess;
  port: number;
  stdout: string[];
  stderr: string[];
}

/** Spawn `iris serve` and wait for the ready line on stdout. */
async function startServe(dataRoot: string, port = 0): Promise<HostProcess> {
  const child = spawn(
    process.execPath,
    [distBin, "serve", "--data-root", dataRoot, "--port", String(port)],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    },
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout.push(chunk.toString("utf8"));
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr.push(chunk.toString("utf8"));
  });

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const text = stdout.join("");
    const match = /"endpoint":\s*"http:\/\/127\.0\.0\.1:(\d+)"/.exec(text);
    if (match?.[1] !== undefined) {
      return { child, port: Number.parseInt(match[1], 10), stdout, stderr };
    }
    if (child.exitCode !== null) {
      throw new Error(`iris serve exited early (${child.exitCode}): ${stderr.join("")}`);
    }
    await sleep(50);
  }
  child.kill("SIGTERM");
  throw new Error(`iris serve did not become ready: ${stderr.join("")}`);
}

function makeInput(inputId: string, text = "hello from subprocess"): Record<string, unknown> {
  return {
    inputId,
    triggerOrigin: directUserRequest(),
    blocks: [
      {
        blockId: `block-${inputId}`,
        sourceOrigin: directUserRequest(),
        content: { mode: "inline_text", text },
        contentHash: "",
      },
    ],
  };
}

async function post(
  port: number,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const init: RequestInit = {};
  if (body !== undefined) {
    init.method = "POST";
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function killServe(host: HostProcess): Promise<void> {
  // Graceful shutdown: close stdin (EOF) so the Host runs its shutdown path
  // and releases iris.lock (Windows SIGTERM is a hard kill and would leak it).
  if (host.child.stdin !== null && !host.child.stdin.destroyed) {
    host.child.stdin.end();
  }
  await new Promise<void>((resolve) => {
    host.child.once("exit", () => {
      resolve();
    });
    setTimeout(resolve, 5000);
  });
  if (host.child.exitCode === null) {
    host.child.kill("SIGKILL");
  }
}

test("cross-process: long-lived Host accepts inputs via HTTP, dedupes retries, and rolls over", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-subproc-a-"));
  const host = await startServe(dataRoot, 0);
  try {
    const base = `http://127.0.0.1:${host.port}`;

    // Health reports ready.
    const health = await fetch(`${base}/v1/health`);
    assert.equal(health.status, 200);
    const healthJson = (await health.json()) as { ready: boolean };
    assert.equal(healthJson.ready, true);

    // Submit A over HTTP; accepted.
    const submitA = await post(host.port, "/v1/input", makeInput("proc-A"));
    assert.equal(submitA.status, 202);
    assert.equal(submitA.json["status"], "accepted");

    // Cross-process retry dedup: same identity + same payload returns the
    // existing acceptance result without a second prompt.
    const retryA = await post(host.port, "/v1/input", makeInput("proc-A"));
    assert.equal(retryA.status, 200);
    assert.equal(retryA.json["status"], "duplicate");

    // Same identity + different payload => typed idempotency conflict.
    const conflictA = await post(host.port, "/v1/input", makeInput("proc-A", "different body"));
    assert.equal(conflictA.status, 409);
    assert.equal(conflictA.json["error"], "idempotency_conflict");

    // Submit B while A is active (FIFO queued in the Host).
    const submitB = await post(host.port, "/v1/input", makeInput("proc-B"));
    assert.equal(submitB.status, 202);

    // Request rollover via admin.
    const rollover = await post(host.port, "/v1/admin/session/rollover", {
      reason: "subprocess-test",
    });
    assert.equal(rollover.status, 202);
    assert.equal(rollover.json["status"], "rollover_pending");

    // Wait for both inputs to reach session_committed (pump processes A, then
    // rollover, then B in the fresh Session).
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      void (await post(host.port, "/v1/admin/session/status"));
      const archives = await post(host.port, "/v1/admin/session/archives");
      const archiveList = archives.json["archives"] as Array<{ status: string; epochId: string }>;
      const closed = archiveList.filter((entry) => entry.status === "closed").length;
      if (closed >= 1) {
        break;
      }
      await sleep(200);
    }
    const archives = await post(host.port, "/v1/admin/session/archives");
    const archiveList = archives.json["archives"] as Array<{ status: string; epochId: string }>;
    assert.ok(
      archiveList.some((entry) => entry.status === "closed"),
      `expected at least one closed epoch after rollover, got ${JSON.stringify(archiveList)}`,
    );
  } finally {
    await killServe(host);
  }
});

test("cross-process: second Host against the same data root is rejected by the lock", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-subproc-lock-"));
  const host = await startServe(dataRoot, 0);
  try {
    // A second `iris serve` on the same data root must fail fast.
    const second = spawn(
      process.execPath,
      [distBin, "serve", "--data-root", dataRoot, "--port", "0"],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    second.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const exitCode = await new Promise<number | null>((resolve) => {
      second.once("exit", (code) => {
        resolve(code);
      });
      setTimeout(() => {
        second.kill("SIGKILL");
        resolve(null);
      }, 15000);
    });
    assert.ok(
      exitCode !== 0 && exitCode !== null,
      `second host must fail, got exit ${exitCode}: ${stderr}`,
    );
  } finally {
    await killServe(host);
  }
});

test("cross-process: graceful shutdown releases the lock for restart", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-subproc-restart-"));
  const host = await startServe(dataRoot, 0);
  await killServe(host);

  // After graceful shutdown the same data root can be re-opened (recovery).
  const restarted = await startServe(dataRoot, 0);
  try {
    const health = await fetch(`http://127.0.0.1:${restarted.port}/v1/health`);
    assert.equal(health.status, 200);
  } finally {
    await killServe(restarted);
  }
});
