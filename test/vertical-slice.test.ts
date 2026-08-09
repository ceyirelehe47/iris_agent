import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import type { CustomMessage, SessionTreeEntry } from "@earendil-works/pi-agent-core";

import { defaultAgentConfig } from "../src/config/load.js";
import { IRIS_INPUT_META_CONTENT, IRIS_INPUT_META_CUSTOM_TYPE } from "../src/contracts/context.js";
import {
  computeContentLayoutHash,
  decodeInputFrames,
  derivePairKey,
  encodeInputFrames,
} from "../src/runtime/companion.js";
import {
  reopenActiveSession,
  runMinimalSlice,
  sampleAgentInput,
} from "../src/runtime/vertical-slice.js";

function messageEntries(entries: SessionTreeEntry[]): Array<{
  type: string;
  message: {
    role: string;
    customType?: string;
    content: unknown;
    details?: unknown;
  };
}> {
  return entries
    .filter((entry) => entry.type === "message")
    .map(
      (entry) =>
        entry as SessionTreeEntry & {
          message: { role: string; customType?: string; content: unknown; details?: unknown };
        },
    );
}

test("R1-P0 mock vertical slice reaches settled with one sequential tool", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-slice-test-"));
  const config = defaultAgentConfig();
  const input = sampleAgentInput();

  const result = await runMinimalSlice({ dataRoot, config, input });
  const messages = messageEntries(result.entries);
  const users = messages.filter((entry) => entry.message.role === "user");
  const companions = messages.filter(
    (entry) =>
      entry.message.role === "custom" && entry.message.customType === IRIS_INPUT_META_CUSTOM_TYPE,
  );
  const assistants = messages.filter((entry) => entry.message.role === "assistant");
  const toolResults = messages.filter((entry) => entry.message.role === "toolResult");

  assert.equal(result.observers.settled, true);
  assert.ok(result.observers.contextPasses >= 2);
  assert.equal(result.observers.toolCallOrder.length, 1);
  assert.equal(result.observers.toolResultOrder.length, 1);
  assert.equal(result.observers.toolCallOrder[0]?.toolCallId, "tool-call-1");
  assert.equal(result.observers.toolResultOrder[0]?.toolCallId, "tool-call-1");
  assert.equal(new Set(result.observers.systemPromptValues).size, 1);
  assert.ok(result.observers.systemPromptValues[0]?.includes("IRIS SYSTEM PROMPT V1"));

  for (const snapshot of result.observers.providerContextSnapshots) {
    assert.ok(!snapshot.includes(IRIS_INPUT_META_CONTENT));
    assert.ok(!snapshot.includes("iris_input_meta"));
    assert.ok(!snapshot.includes("IRIS_INPUT_V1"));
  }

  assert.equal(users.length, 1);
  assert.equal(companions.length, 1);
  assert.equal(assistants.length, 2);
  assert.equal(toolResults.length, 1);

  const userIndex = result.entries.findIndex(
    (entry) => entry.type === "message" && entry.message.role === "user",
  );
  const companionEntry = result.entries[userIndex + 1];
  assert.ok(
    companionEntry?.type === "message" &&
      companionEntry.message.role === "custom" &&
      companionEntry.message.customType === IRIS_INPUT_META_CUSTOM_TYPE,
  );
  const companion = companionEntry.message as CustomMessage<{
    iris: { inputId: string; pairKey: string; contentLayoutHash: string };
  }>;
  assert.equal(companion.details?.iris.inputId, input.inputId);
  // pairKey now binds (instanceEpoch, inputId, wire); a fresh data root's
  // first Runtime Session Epoch has ordinalWithinDate = 1 (review-pass-7 #2).
  const frames = decodeInputFrames(encodeInputFrames(input.blocks));
  assert.equal(companion.details?.iris.pairKey, derivePairKey(input.inputId, frames, 1));
  assert.equal(
    companion.details?.iris.contentLayoutHash,
    computeContentLayoutHash(input, encodeInputFrames(input.blocks)),
  );

  const toolResult = toolResults[0]?.message as {
    details: { iris: { toolExecutionKey: string; assistantEntryId: string } };
  };
  assert.ok(toolResult.details.iris.toolExecutionKey.length === 64);
  const assistantToolEntry = result.entries.find(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      JSON.stringify(entry.message).includes("tool-call-1"),
  );
  assert.equal(toolResult.details.iris.assistantEntryId, assistantToolEntry?.id);
  assert.equal(result.assistantMessage.role, "assistant");
});

test("restart reopens the same active Session without synthetic entries", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-restart-test-"));
  const config = defaultAgentConfig();
  const input = sampleAgentInput();

  const first = await runMinimalSlice({ dataRoot, config, input });
  const firstEntryCount = first.entries.length;

  const reopened = await reopenActiveSession({ dataRoot, config, input });
  assert.equal(reopened.runtimeSessionId, first.runtimeSessionId);
  assert.equal(reopened.entries.length, firstEntryCount);

  assert.ok(!existsSync(join(dataRoot, "invocation.db")));
  assert.ok(!existsSync(join(dataRoot, "result.db")));
});

test("v27: slice produces a validated V2 generation covering P0-P2", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-slice-v2-"));
  const config = defaultAgentConfig();
  const input = sampleAgentInput();
  try {
    const result = await runMinimalSlice({ dataRoot, config, input });
    const generation = result.generation;
    assert.ok(generation, "slice must carry the last built V2 generation");
    assert.equal(generation.schemaId, "iris.context-generation.v2");
    assert.equal(generation.header.layerEnds[5], generation.units.length);
    assert.ok(generation.header.layerEnds[0] >= 1, "P0 system prompt present");
    assert.ok(generation.header.layerEnds[1] >= 2, "P1 persona present");
    assert.ok(generation.header.layerEnds[2] >= 3, "P2 declarations present");
    assert.equal(
      generation.units[0]?.header.semanticSchemaId,
      "iris.system.v1",
      "P0 unit is the system prompt unit",
    );
    assert.ok(
      generation.header.layerEnds[5] >= 3,
      "P5 covers the committed user/assistant/tool-result units",
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
