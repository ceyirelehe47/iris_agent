/**
 * Context pipeline capacity benchmark (R2 Feature 10 gate).
 *
 * Measures the provider-visible transform pass cost of the Host product-path
 * Context pipeline (runContextPass) on a synthetic session of N turns, and the
 * ContextStore materialization round-trip. Produces the first round of
 * provisional capacity evidence for the Roadmap R2 Exit Gate.
 *
 * Deterministic: same input → same unit counts; timing is wall-clock but the
 * pipeline decision itself is pure (timing measures the composed layers).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { SessionTreeEntry } from "@iris/pi-agent-core";

import { runContextPass, applyContextPass } from "../src/context/pipeline.js";
import { ContextStore } from "../src/context/context-store.js";
import { IRIS_INPUT_META_CUSTOM_TYPE } from "../src/contracts/context.js";

const TURNS = 200;

function userEntry(
  id: string,
  parentId: string | null,
  text: string,
  ts: number,
): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: { role: "user", content: text, timestamp: ts },
  };
}

function companionEntry(
  id: string,
  parentId: string,
  inputId: string,
  ts: number,
): SessionTreeEntry {
  return {
    type: "custom_message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    customType: IRIS_INPUT_META_CUSTOM_TYPE,
    content: "<iris-input-meta/>",
    display: false,
    details: { iris: { inputId, pairKey: `k-${inputId}` } },
  };
}

function assistantEntry(id: string, parentId: string, text: string, ts: number): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "anthropic-messages",
      provider: "mock",
      model: "model-v1",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        totalTokens: 0,
      },
      stopReason: "stop",
      timestamp: ts,
    },
  };
}

function buildSession(turns: number): SessionTreeEntry[] {
  const entries: SessionTreeEntry[] = [];
  for (let index = 0; index < turns; index += 1) {
    const seq = index * 3 + 1;
    entries.push(
      userEntry(`u-${index}`, index === 0 ? null : `a-${index - 1}`, `user turn ${index}`, seq),
    );
    entries.push(companionEntry(`c-${index}`, `u-${index}`, `in-${index}`, seq + 1));
    entries.push(assistantEntry(`a-${index}`, `c-${index}`, `assistant reply ${index}`, seq + 2));
  }
  return entries;
}

const runtimeSessionId = "iris-bench-2026-08-01-1";

const entries = buildSession(TURNS);

// 1. Pure pipeline decision cost.
const decisionStart = performance.now();
let decision: ReturnType<typeof runContextPass> | undefined;
for (let pass = 0; pass < 5; pass += 1) {
  decision = runContextPass({
    runtimeSessionId,
    entries,
    lineage: undefined,
    source: {
      contextSourceSnapshotId: "src-bench",
      personaSnapshotId: "persona-bench",
      declarationVersion: "v1",
      providerProfileId: "mock",
      canonicalSystemPrompt: "system prompt",
      systemProjectionHash: "sys-hash-bench",
    },
    model: { provider: "opencode", modelId: "model-a" },
    usagePercentage: 30,
    contextLimit: 128_000,
    executeThresholdPercentage: 65,
  });
}
const decisionElapsedMs = (performance.now() - decisionStart) / 5;

// 2. Store materialization round-trip (first pass HARD → materializeM0).
const dir = mkdtempSync(join(tmpdir(), "iris-context-bench-"));
const path = join(dir, "context.db");
const store = ContextStore.open(path);
store.createLineage({
  runtimeSessionId,
  contextSourceSnapshotId: "src-bench",
  epochId: runtimeSessionId,
  personaSnapshotId: "persona-bench",
  declarationVersion: "v1",
  providerProfileId: "mock",
  canonicalSystemPrompt: "system prompt",
  systemProjectionHash: "sys-hash-bench",
  preparedAt: "2026-08-01T12:00:00.000Z",
  materializationId: "mat-bench",
  contextSerializerVersion: "iris-context-golden-v1",
  carrierSchemaVersion: "1",
});
if (decision === undefined) throw new Error("benchmark decision missing");
const materializeStart = performance.now();
applyContextPass(store, runtimeSessionId, decision, 1);
const materializeElapsedMs = performance.now() - materializeStart;
const persisted = store.getLineage(runtimeSessionId);
store.close();
rmSync(dirname(path), { recursive: true, force: true });

if (persisted?.m0Body === undefined || persisted.m0Body === null) {
  throw new Error("benchmark materialization did not persist m0");
}

console.log(
  JSON.stringify(
    {
      turns: TURNS,
      rawEntries: entries.length,
      units: decision.projection.units.length,
      classification: decision.classification,
      decisionMsPerPass: Number(decisionElapsedMs.toFixed(3)),
      materializeMs: Number(materializeElapsedMs.toFixed(3)),
      m0BodyBytes: Buffer.byteLength(persisted.m0Body, "utf8"),
      status: "ok",
    },
    null,
    2,
  ),
);
