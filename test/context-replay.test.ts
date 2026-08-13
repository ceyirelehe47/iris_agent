import test from "node:test";

import assert from "node:assert/strict";

import type { SessionTreeEntry } from "@iris/pi-agent-core";

import { projectLogicalUnits, type ProjectedLogicalUnits } from "../src/context/projection.js";
import {
  advanceWatermarks,
  classifyReplayFailure,
  runReplay,
  type ReplayWatermarks,
} from "../src/context/replay.js";
import { IRIS_INPUT_META_CUSTOM_TYPE } from "../src/contracts/context.js";

function userEntry(id: string, parentId: string | null, text: string, ts = 1): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: { role: "user", content: text, timestamp: ts },
  };
}

function customCompanion(id: string, parentId: string, inputId: string, ts = 2): SessionTreeEntry {
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

function assistantEntry(
  id: string,
  parentId: string | null,
  parts: Array<
    | { type: "text"; text: string }
    | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
    | { type: "thinking"; thinking: string }
  >,
  ts = 3,
): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "assistant",
      content: parts,
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

function toolResultEntry(id: string, parentId: string, callId: string, ts = 4): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "read_only_test_tool",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: ts,
    },
  };
}

const baseWatermarks: ReplayWatermarks = {
  clearedReasoningThroughTag: 0,
  toolReclaimWatermark: 0,
  mutationReplayWatermark: 0,
};

test("replay: no watermarks → nothing suppressed, detect is empty", () => {
  const entries: SessionTreeEntry[] = [
    userEntry("u-1", null, "hello"),
    customCompanion("c-1", "u-1", "in-1"),
    assistantEntry("a-1", "c-1", [
      { type: "thinking", thinking: "let me think" },
      { type: "text", text: "answer" },
    ]),
  ];
  const projection = projectLogicalUnits("iris-runtime-2026-08-01-1", entries);
  const result = runReplay(projection, baseWatermarks);
  assert.equal(result.suppressedReasoningUnitIds.length, 0);
  assert.equal(result.reclaimedToolArcUnitIds.length, 0);
  assert.equal(result.newlyReclaimedToolArcUnitIds.length, 0);
  assert.equal(result.didSuppress, false);
});

test("replay: cleared-reasoning watermark suppresses reasoning units every pass (byte-identical)", () => {
  const entries: SessionTreeEntry[] = [
    userEntry("u-1", null, "hello"),
    customCompanion("c-1", "u-1", "in-1"),
    assistantEntry("a-1", "c-1", [
      { type: "thinking", thinking: "old thinking" },
      { type: "text", text: "answer" },
    ]),
    userEntry("u-2", "a-1", "again"),
    customCompanion("c-2", "u-2", "in-2"),
    assistantEntry("a-2", "c-2", [{ type: "text", text: "done" }]),
  ];
  const projection = projectLogicalUnits("iris-runtime-2026-08-01-1", entries);
  const reasoningUnits = projection.units.filter((u) => u.kind === "reasoning");
  assert.equal(reasoningUnits.length, 1);
  const reasoningSeq = reasoningUnits[0]?.entrySeq ?? 0;
  const wm = { ...baseWatermarks, clearedReasoningThroughTag: reasoningSeq };
  const first = runReplay(projection, wm);
  const second = runReplay(projection, wm);
  assert.deepEqual(first.suppressedReasoningUnitIds, second.suppressedReasoningUnitIds);
  assert.equal(first.suppressedReasoningUnitIds.length, 1);
  assert.equal(first.didSuppress, true);
  assert.equal(first.replayHash, second.replayHash, "defer passes must hash identically");
});

test("replay: tool-reclaim watermark suppresses sealed arcs every pass (frozen set)", () => {
  const entries: SessionTreeEntry[] = [
    userEntry("u-1", null, "hello"),
    customCompanion("c-1", "u-1", "in-1"),
    assistantEntry("a-1", "c-1", [
      { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "x" } },
    ]),
    toolResultEntry("tr-1", "a-1", "call-1"),
    userEntry("u-2", "tr-1", "more"),
    customCompanion("c-2", "u-2", "in-2"),
    assistantEntry("a-2", "c-2", [{ type: "text", text: "done" }]),
  ];
  const projection = projectLogicalUnits("iris-runtime-2026-08-01-1", entries);
  const arcs = projection.units.filter((u) => u.kind === "tool_arc");
  assert.equal(arcs.length, 1);
  const arc = arcs[0];
  assert.ok(arc?.kind === "tool_arc");
  const endSeq = arc.entryRange.endEntrySeq;
  const wm = { ...baseWatermarks, toolReclaimWatermark: endSeq };
  const result = runReplay(projection, wm);
  assert.deepEqual(result.reclaimedToolArcUnitIds, [arc.unitId]);
  assert.equal(result.didSuppress, true);
  // Frozen: a re-pass with the same watermark suppresses the same arcs.
  const again = runReplay(projection, wm);
  assert.deepEqual(again.reclaimedToolArcUnitIds, result.reclaimedToolArcUnitIds);
  assert.equal(again.replayHash, result.replayHash);
});

test("replay: detect finds arcs below the protected tail, never inside it", () => {
  // Session: turn 1 has a sealed arc (ends seq 4), then a newer turn whose
  // content forms the protected tail (starts seq 5).
  const entries: SessionTreeEntry[] = [
    userEntry("u-1", null, "hello"),
    customCompanion("c-1", "u-1", "in-1"),
    assistantEntry("a-1", "c-1", [
      { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "x" } },
    ]),
    toolResultEntry("tr-1", "a-1", "call-1"),
    userEntry("u-2", "tr-1", "newest turn"),
    customCompanion("c-2", "u-2", "in-2"),
    assistantEntry("a-2", "c-2", [{ type: "text", text: "live" }]),
  ];
  const projection = projectLogicalUnits("iris-runtime-2026-08-01-1", entries);
  const arcs = projection.units.filter((u) => u.kind === "tool_arc");
  assert.equal(arcs.length, 1);

  // Protected tail starts at seq 5 (the newest user turn). The arc ends at 4
  // (strictly below 5) → newly aged when detect=true.
  const detect = runReplay(projection, baseWatermarks, {
    detect: true,
    protectedTailStartEntrySeq: 5,
  });
  assert.equal(detect.newlyReclaimedToolArcUnitIds.length, 1);
  assert.equal(detect.newlyReclaimedMaxEndSeq, 4);

  // A defer pass (detect=false) never reports new reclaims.
  const defer = runReplay(projection, baseWatermarks, {
    detect: false,
    protectedTailStartEntrySeq: 5,
  });
  assert.equal(defer.newlyReclaimedToolArcUnitIds.length, 0);

  // An arc INSIDE the protected tail (protectedStart <= arc start) is never
  // detected.
  const inside = runReplay(projection, baseWatermarks, {
    detect: true,
    protectedTailStartEntrySeq: 2,
  });
  assert.equal(inside.newlyReclaimedToolArcUnitIds.length, 0);
});

test("replay: advanceWatermarks is monotonic and idempotent", () => {
  const advanced = advanceWatermarks(baseWatermarks, {
    newlyReclaimedMaxEndSeq: 12,
    clearedReasoningThroughTag: 8,
    mutationReplayWatermark: 3,
  });
  assert.deepEqual(advanced, {
    clearedReasoningThroughTag: 8,
    toolReclaimWatermark: 12,
    mutationReplayWatermark: 3,
  });
  // Re-advancing with smaller values never regresses.
  const again = advanceWatermarks(advanced, {
    newlyReclaimedMaxEndSeq: 5,
    clearedReasoningThroughTag: 2,
    mutationReplayWatermark: 1,
  });
  assert.deepEqual(again, advanced);
});

test("replay: classifyReplayFailure — defer pass with invalid LKG fails closed", () => {
  assert.equal(
    classifyReplayFailure({ lkgInvalid: true, deferPass: true, pendingDetect: false }),
    "emergency_fail_closed",
  );
  assert.equal(
    classifyReplayFailure({ lkgInvalid: true, deferPass: false, pendingDetect: false }),
    "transform_unavailable",
  );
  assert.equal(
    classifyReplayFailure({ lkgInvalid: false, deferPass: true, pendingDetect: true }),
    "defer_blocked",
  );
  assert.equal(
    classifyReplayFailure({ lkgInvalid: false, deferPass: true, pendingDetect: false }),
    "ok",
  );
  assert.equal(
    classifyReplayFailure({ lkgInvalid: false, deferPass: false, pendingDetect: true }),
    "ok",
    "detect on a cache-busting pass is legal",
  );
});

test("replay: empty projection is a no-op", () => {
  const projection: ProjectedLogicalUnits = {
    runtimeSessionId: "iris-runtime-2026-08-01-1",
    units: [],
    fromEntrySeq: 0,
    toEntrySeq: 0,
    projectionHash: "empty",
    lastSafeUserAnchor: null,
  };
  const result = runReplay(projection, baseWatermarks, {
    detect: true,
    protectedTailStartEntrySeq: 1,
  });
  assert.equal(result.didSuppress, false);
  assert.equal(result.newlyReclaimedToolArcUnitIds.length, 0);
  assert.equal(result.suppressedReasoningUnitIds.length, 0);
});
