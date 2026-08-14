import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import type { CustomMessage, SessionTreeEntry } from "@iris/pi-agent-core";

import { defaultAgentConfig } from "../src/config/load.js";
import { IRIS_INPUT_META_CONTENT, IRIS_INPUT_META_CUSTOM_TYPE } from "../src/contracts/context.js";
import { ContextStore } from "../src/context/context-store.js";
import {
  createContextHistoryReadPort,
  type ContextHistoryReadPort,
} from "../src/context/history-read-port.js";
import { historianBatchHash } from "../src/contracts/historian.js";
import type { LineageBoundaryInput } from "../src/historian/historian-boundary.js";
import { HistorianManager } from "../src/historian/historian-manager.js";
import { HistorianStore } from "../src/historian/historian-store.js";
import { resolveDataRootPaths } from "../src/host/data-root.js";
import {
  computeContentLayoutHash,
  decodeInputFrames,
  derivePairKey,
  encodeInputFrames,
} from "../src/runtime/companion.js";
import { reopenActiveSession, sampleAgentInput } from "../src/runtime/vertical-slice.js";
import { runMinimalSlice } from "../src/runtime/vertical-slice-demo.js";

/** R3-P1：记录 enqueueIncremental 调用的 mock manager（不触碰真实 freeze/runner）。 */
class RecordingHistorianManager extends HistorianManager {
  readonly enqueueCalls: Array<{
    runtimeSessionId: string;
    lineageBoundary: LineageBoundaryInput | undefined;
  }> = [];

  override async enqueueIncremental(
    runtimeSessionId: string,
    lineageBoundary?: LineageBoundaryInput,
  ): Promise<boolean> {
    this.enqueueCalls.push({ runtimeSessionId, lineageBoundary });
    return true;
  }
}

/** iris_agent#66: minimal Context claim port for the recording manager
 * (construction requires it; the recording manager never runs jobs). */
function emptyHistoryPort(): ContextHistoryReadPort {
  return {
    getMaterializedBoundary() {
      return {
        representedThroughContextSeq: 0,
        representedThroughEntrySeq: 0,
        m0ContentHash: null,
        lineageStatus: "ok",
        providerProfileId: "mock",
      };
    },
    listUnitsForHistorian() {
      return [];
    },
    listUnitsWithPayload() {
      return [];
    },
    claimHistorianBatch: ({ afterContextSeqExclusive }) => {
      const batch: import("../src/contracts/historian.js").HistorianBatchV1 = {
        schemaVersion: "historian-batch-v1",
        lineageId: "identity-slice",
        afterContextSeqExclusive,
        throughContextSeqInclusive: afterContextSeqExclusive,
        units: [],
        batchHash: "",
        frozenAt: new Date().toISOString(),
      };
      batch.batchHash = historianBatchHash(batch);
      return batch;
    },
    lineageId() {
      return "identity-slice";
    },
  };
}

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

test("R3-P1 vertical slice: wired historianManager triggers enqueueIncremental on the HARD fold with the lineage boundary", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-slice-historian-"));
  const historianDir = mkdtempSync(join(tmpdir(), "iris-slice-historian-db-"));
  const config = defaultAgentConfig();
  const input = sampleAgentInput();
  const historianStore = HistorianStore.open({ databasePath: join(historianDir, "historian.db") });
  try {
    const manager = new RecordingHistorianManager({
      store: historianStore,
      modelProviderProfile: "mock-iris-provider-v1",
      nowMs: () => 1_785_000_000_000,
      historyPort: emptyHistoryPort(),
    });
    const result = await runMinimalSlice({
      dataRoot,
      config,
      input,
      historianManager: manager,
    });
    // 一次 prompt → 结束时一次 persistRender → HARD（first_render）→ 一次触发。
    assert.equal(manager.enqueueCalls.length, 1, "HARD fold at prompt completion triggers once");
    const call = manager.enqueueCalls[0];
    assert.ok(call, "enqueueIncremental was called");
    assert.equal(call.runtimeSessionId, result.runtimeSessionId);
    assert.ok(call.lineageBoundary !== undefined, "lineage boundary is passed to the freeze");
    // 交叉验证：传入 freeze 的物化边界与 context.db 中持久化的 lineage 一致
    // （端口读取为权威值）。
    const paths = resolveDataRootPaths(dataRoot, config);
    const reopened = ContextStore.open(paths.contextDb);
    try {
      const boundary = createContextHistoryReadPort(reopened).getMaterializedBoundary(
        result.runtimeSessionId,
      );
      assert.equal(
        call.lineageBoundary?.representedThroughContextSeq,
        boundary.representedThroughContextSeq,
        "wired boundary matches the durable lineage boundary",
      );
    } finally {
      reopened.close();
    }
  } finally {
    historianStore.close();
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(historianDir, { recursive: true, force: true });
  }
});
