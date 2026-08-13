import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import type { SessionTreeEntry } from "@iris/pi-agent-core";
import type { TextContent, ThinkingContent, ToolCall } from "@iris/pi-ai";

import {
  ALPHA,
  ABS_CAP,
  FLOOR_MAX,
  FLOOR_MIN,
  MAX_USABLE_RATIO,
  MIN_FORCE_ELIGIBLE_TOKENS_CAP,
  NORMAL_HYSTERESIS_TOKENS,
  deriveMinForceEligibleTokens,
  deriveProtectedTailTokenTarget,
  deriveTriggerBudget,
  findSuffixStartForTokens,
  force80PerRunCap,
  force95PerRunCap,
  nonEmergencyPerRunCap,
  openToolCallIds,
  protectedTailFingerprint,
  resolveProtectedTail,
  selectPerRunCap,
  type ProtectedTailPlan,
} from "../src/context/protected-tail.js";
import { projectLogicalUnits } from "../src/context/projection.js";
import { IRIS_INPUT_META_CUSTOM_TYPE } from "../src/contracts/context.js";

const fixtureDir = join(process.cwd(), "test", "fixtures", "context", "opencode-v0.33.0");

function userEntry(id: string, parentId: string | null, text: string): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-01T00:00:00.000Z",
    message: { role: "user", content: text, timestamp: 1 },
  };
}

function customCompanion(
  id: string,
  parentId: string,
  details: Record<string, unknown>,
): SessionTreeEntry {
  return {
    type: "custom_message",
    id,
    parentId,
    timestamp: "2026-08-01T00:00:01.000Z",
    customType: IRIS_INPUT_META_CUSTOM_TYPE,
    content: "<iris-input-meta/>",
    display: false,
    details,
  };
}

function assistantEntry(
  id: string,
  parentId: string | null,
  parts: Array<TextContent | ThinkingContent | ToolCall>,
): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-01T00:00:02.000Z",
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
      timestamp: 2,
    },
  };
}

function toolResultEntry(
  id: string,
  parentId: string,
  callId: string,
  toolExecutionKey?: string,
): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-01T00:00:03.000Z",
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "read_only_test_tool",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      details:
        toolExecutionKey === undefined
          ? undefined
          : { iris: { toolExecutionKey, assistantEntryId: "a-1" } },
      timestamp: 3,
    },
  };
}

function inputPairEntries(userSeq: number, inputId: string, pairKey: string): SessionTreeEntry[] {
  const uid = `u-${userSeq}`;
  const cid = `c-${userSeq}`;
  const parent = userSeq === 1 ? null : `c-${userSeq - 1}`;
  return [
    userEntry(uid, parent, `IRIS_INPUT_V1\ninline_text:5\ninput${userSeq}\n`),
    customCompanion(cid, uid, { iris: { inputId, pairKey } }),
  ];
}

test("protected-tail: authority golden — n-clamp and suffix walk from fixtures", () => {
  const nClamp = JSON.parse(
    readFileSync(join(fixtureDir, "protected-tail-n-clamp.json"), "utf8"),
  ) as {
    input: {
      cases: Array<{
        contextLimit: number;
        executeThresholdPercentage: number;
        usagePercentage: number;
      }>;
    };
    expected: { ceilingN: number[]; N: number[] };
  };
  for (let i = 0; i < nClamp.input.cases.length; i += 1) {
    const c = nClamp.input.cases[i];
    if (c === undefined) continue;
    const target = deriveProtectedTailTokenTarget(c);
    assert.equal(target.ceilingN, nClamp.expected.ceilingN[i]);
    assert.equal(target.N, nClamp.expected.N[i]);
  }

  const suffix = JSON.parse(
    readFileSync(join(fixtureDir, "protected-tail-suffix-walk.json"), "utf8"),
  ) as {
    input: { rawTokenCounts: number[]; targets: number[] };
    expected: { suffixStartForTokens: number[] };
  };
  for (let i = 0; i < suffix.input.targets.length; i += 1) {
    const t = suffix.input.targets[i];
    if (t === undefined) continue;
    const start = findSuffixStartForTokens(suffix.input.rawTokenCounts, t);
    assert.equal(start, suffix.expected.suffixStartForTokens[i]);
  }

  const force = JSON.parse(
    readFileSync(join(fixtureDir, "protected-tail-force-head-minimum.json"), "utf8"),
  ) as {
    expected: { minForceEligibleTokens: number[]; minForceEligibleTokensCap: number };
  };
  assert.equal(force.expected.minForceEligibleTokensCap, MIN_FORCE_ELIGIBLE_TOKENS_CAP);
  assert.equal(deriveMinForceEligibleTokens(8), force.expected.minForceEligibleTokens[0]);
  assert.equal(deriveMinForceEligibleTokens(16_000), force.expected.minForceEligibleTokens[1]);
});

test("protected-tail: token target math matches authority constants", () => {
  const t = deriveProtectedTailTokenTarget({
    contextLimit: 128_000,
    executeThresholdPercentage: 65,
    usagePercentage: 30,
  });
  const usable = Math.round((128_000 * 65) / 100); // 83200
  assert.equal(t.usable, usable);
  assert.equal(t.rawN, Math.round(usable * ALPHA * (1 - 0.3)));
  assert.equal(t.floorN, Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, Math.round(usable * 0.08))));
  assert.equal(
    t.ceilingN,
    Math.min(
      ABS_CAP,
      Math.floor(usable * MAX_USABLE_RATIO),
      t.usable - (t.triggerBudget + t.reserve),
    ),
  );
  assert.ok(t.N >= t.effectiveFloor && t.N <= t.ceilingN);
});

test("protected-tail: trigger budget and per-run caps", () => {
  const budget = deriveTriggerBudget(128_000, 65);
  assert.ok(budget >= 5_000 && budget <= 50_000);
  const usable = 83_200;
  const N = 20_000;
  assert.equal(
    nonEmergencyPerRunCap(usable, N),
    Math.min(250_000, Math.max(40_000, Math.min(20_800, 100_000))),
  );
  assert.equal(
    force80PerRunCap(usable, N),
    Math.min(500_000, Math.max(60_000, Math.min(29_120, 150_000))),
  );
  assert.equal(
    force95PerRunCap(usable, N),
    Math.min(750_000, Math.max(80_000, Math.min(41_600, 250_000))),
  );
  assert.equal(
    selectPerRunCap({
      contextLimit: 128_000,
      executeThresholdPercentage: 65,
      usagePercentage: 95,
      N,
    }),
    force95PerRunCap(usable, N),
  );
  assert.equal(
    selectPerRunCap({
      contextLimit: 128_000,
      executeThresholdPercentage: 65,
      usagePercentage: 80,
      N,
    }),
    force80PerRunCap(usable, N),
  );
  assert.equal(
    selectPerRunCap({
      contextLimit: 128_000,
      executeThresholdPercentage: 65,
      usagePercentage: 30,
      N,
    }),
    nonEmergencyPerRunCap(usable, N),
  );
});

test("protected-tail: newest verified anchor and following units are always protected", () => {
  const entries: SessionTreeEntry[] = [
    ...inputPairEntries(1, "in-1", "k1"),
    assistantEntry("a-1", "c-1", [{ type: "text", text: "reply1" }]),
    ...inputPairEntries(3, "in-2", "k2"),
    assistantEntry("a-2", "c-3", [{ type: "text", text: "reply2" }]),
    toolResultEntry("tr-1", "a-2", "call-x", "exec-1"),
  ];
  const projection = projectLogicalUnits("iris-runtime-2026-08-01-1", entries);
  const plan = resolveProtectedTail(projection, 3_000, {
    unitTokenCounts: projection.units.map(() => 1_000),
  });
  // entries: u-1(1) c-1(2) a-1(3) u-3(4) c-3(5) a-2(6) tr-1(7)
  assert.equal(
    plan.lastSafeUserAnchorEntrySeq,
    4,
    "anchor = newest verified input start seq (u-3)",
  );
  // Tail covers anchor..end (anchor itself protected as live-user floor).
  assert.ok(
    plan.protectedTailStartEntrySeq <= 4,
    `tail starts at or before anchor (${plan.protectedTailStartEntrySeq})`,
  );
  assert.equal(plan.headEndEntrySeq, plan.protectedTailStartEntrySeq - 1);
});

test("protected-tail: anchor floor is lifted at force pressure (authority #132)", () => {
  // Sparse session: one verified input turn + a huge assistant/tool tail.
  // On a ROUTINE pass (usage < 80) the anchor floor protects everything from
  // the anchor forward (no eligible head). At force pressure (usage >= 80) or
  // on the emergency-scaled path the floor is LIFTED so the head stays
  // compactable (authority protected-tail-boundary.ts live-prompt floor
  // exemption; sparse #132 session must stay compactable under pressure).
  const entries: SessionTreeEntry[] = [
    ...inputPairEntries(1, "in-1", "k1"), // anchor
    assistantEntry("a-1", "c-1", [{ type: "text", text: "huge reply" }]),
    toolResultEntry("tr-1", "a-1", "call-x", "exec-1"),
    assistantEntry("a-2", "tr-1", [{ type: "text", text: "more" }]),
  ];
  const projection = projectLogicalUnits("iris-runtime-2026-08-01-1", entries);

  const routine = resolveProtectedTail(projection, 500, {
    unitTokenCounts: [100, 1_000, 100, 1_000],
    usagePercentage: 30,
  });
  assert.equal(routine.lastSafeUserAnchorEntrySeq, 1);
  assert.equal(
    routine.protectedTailStartEntrySeq,
    1,
    "routine pass: anchor floor keeps whole session protected",
  );

  const forced = resolveProtectedTail(projection, 500, {
    unitTokenCounts: [100, 1_000, 100, 1_000],
    usagePercentage: 95,
  });
  assert.ok(
    forced.protectedTailStartEntrySeq > 1,
    `force path lifts anchor floor: tail starts at ${forced.protectedTailStartEntrySeq}, not 1`,
  );

  const emergency = resolveProtectedTail(projection, 500, {
    unitTokenCounts: [100, 1_000, 100, 1_000],
    usagePercentage: 30,
    emergencyTailScale: 0.5,
  });
  assert.ok(
    emergency.protectedTailStartEntrySeq > 1,
    `emergency path lifts anchor floor: tail starts at ${emergency.protectedTailStartEntrySeq}, not 1`,
  );
});

test("protected-tail: sealed tool arc is never cut in half", () => {
  // Two input turns; the first turn contains a sealed tool arc. Authority
  // fenceBoundaryForToolArcs semantics: when the size-walk boundary lands
  // INSIDE a sealed arc's raw span, the arc is pushed wholly into the head
  // (boundary = arcEnd + 1) — its ToolResult is already persisted, so folding
  // the whole range is safe (no wire-dangling tool_use). The arc is NEVER cut
  // mid-span: the boundary must land outside [arcStart, arcEnd].
  const entries: SessionTreeEntry[] = [
    ...inputPairEntries(1, "in-1", "k1"), // u-1(1) c-1(2)
    assistantEntry("a-1", "c-1", [
      { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "x" } },
    ]), // a-1(3)
    toolResultEntry("tr-1", "a-1", "call-1", "exec-1"), // tr-1(4)
    ...inputPairEntries(3, "in-2", "k2"), // u-3(5) c-3(6)  [anchor]
    assistantEntry("a-2", "c-3", [{ type: "text", text: "done" }]), // a-2(7)
  ];
  const projection = projectLogicalUnits("iris-runtime-2026-08-01-1", entries);
  // units: input(1-2), assistant(3), tool_arc(3-4), tool_result(4),
  //        input(5-6)[anchor], assistant(7)
  const arc = projection.units.find((u) => u.kind === "tool_arc");
  assert.ok(arc?.kind === "tool_arc");
  assert.equal(arc.sealed, true);
  // Suffix walk (target 700: 100+500+100 accumulates to exactly 700 at the
  // tool_result unit) lands INSIDE the arc span [3,4] → the arc is pushed
  // wholly into the head: boundary >= arcEnd + 1.
  const plan = resolveProtectedTail(projection, 700, {
    unitTokenCounts: [500, 500, 1_000, 100, 500, 100],
  });
  const outsideArc =
    plan.protectedTailStartEntrySeq <= arc.entryRange.startEntrySeq ||
    plan.protectedTailStartEntrySeq > arc.entryRange.endEntrySeq;
  assert.ok(
    outsideArc,
    `boundary ${plan.protectedTailStartEntrySeq} must not fall inside [${arc.entryRange.startEntrySeq}, ${arc.entryRange.endEntrySeq}]`,
  );
  assert.equal(plan.fenced, true);
});

test("protected-tail: incomplete (open) tool arc forces boundary before it", () => {
  const entries: SessionTreeEntry[] = [
    ...inputPairEntries(1, "in-1", "k1"),
    assistantEntry("a-1", "c-1", [
      { type: "toolCall", id: "call-open", name: "write_file", arguments: { path: "y" } },
    ]),
    // No ToolResult — arc remains open.
  ];
  const projection = projectLogicalUnits("iris-runtime-2026-08-01-1", entries);
  // No sealed tool_arc unit exists for the unresolved callId; the open call
  // surfaces as an assistant unit with an unresolved toolCallId.
  const open = openToolCallIds(projection.units);
  assert.equal(open.length, 1);
  assert.equal(open[0]?.callId, "call-open");
  const openSeq = open[0]?.assistantEntrySeq;
  assert.ok(openSeq !== undefined);
  const plan = resolveProtectedTail(projection, 0, {
    unitTokenCounts: projection.units.map(() => 100),
  });
  // Whole tail (anchor + open arc) protected — open arc never folded.
  assert.ok(
    plan.protectedTailStartEntrySeq <= openSeq,
    `open arc (seq ${openSeq}) must be inside the protected tail (start ${plan.protectedTailStartEntrySeq})`,
  );
  assert.equal(plan.fenced, true);
});

test("protected-tail: reasoning seam is never spliced", () => {
  const entries: SessionTreeEntry[] = [
    ...inputPairEntries(1, "in-1", "k1"),
    assistantEntry("a-1", "c-1", [{ type: "thinking", thinking: "inner" }]),
    assistantEntry("a-2", "a-1", [{ type: "text", text: "answer" }]),
  ];
  const projection = projectLogicalUnits("iris-runtime-2026-08-01-1", entries);
  const reasoning = projection.units.find((u) => u.kind === "reasoning");
  assert.ok(reasoning?.kind === "reasoning");
  const plan = resolveProtectedTail(projection, 2_000, {
    unitTokenCounts: [1_000, 1_000, 1_000],
  });
  assert.ok(
    plan.protectedTailStartEntrySeq <= reasoning.entrySeq,
    "reasoning unit must be wholly inside the tail (never spliced)",
  );
});

test("protected-tail: no verified anchor → fold nothing (fail-conservative)", () => {
  const entries: SessionTreeEntry[] = [
    userEntry("u-1", null, "hello world"),
    assistantEntry("a-1", "u-1", [{ type: "text", text: "hi" }]),
  ];
  const projection = projectLogicalUnits("iris-runtime-2026-08-01-1", entries);
  const plan = resolveProtectedTail(projection, 1_000, {
    unitTokenCounts: [500, 500],
  });
  assert.equal(plan.lastSafeUserAnchorEntrySeq, null);
  assert.equal(plan.protectedTailStartEntrySeq, 1, "whole session protected");
});

test("protected-tail: hysteresis holds boundary on small moves", () => {
  const entries: SessionTreeEntry[] = [
    ...inputPairEntries(1, "in-1", "k1"),
    assistantEntry("a-1", "c-1", [{ type: "text", text: "reply" }]),
    ...inputPairEntries(3, "in-2", "k2"),
    assistantEntry("a-2", "c-3", [{ type: "text", text: "reply2" }]),
  ];
  const projection = projectLogicalUnits("iris-runtime-2026-08-01-1", entries);
  const fresh = resolveProtectedTail(projection, 2_000, {
    unitTokenCounts: [1_000, 1_000, 1_000, 1_000],
  });
  const previous: ProtectedTailPlan = { ...fresh, protectedTailStartEntrySeq: 2 };
  const held = resolveProtectedTail(projection, 2_000, {
    unitTokenCounts: [1_000, 1_000, 1_000, 1_000],
    previousPlan: previous,
  });
  assert.equal(held.hysteresisHeld, true);
  assert.equal(held.protectedTailStartEntrySeq, 2);
  assert.ok(NORMAL_HYSTERESIS_TOKENS > 0);
});

test("protected-tail: fingerprint is deterministic and sensitive to boundary", () => {
  const entries: SessionTreeEntry[] = [
    ...inputPairEntries(1, "in-1", "k1"),
    assistantEntry("a-1", "c-1", [{ type: "text", text: "reply" }]),
  ];
  const projection = projectLogicalUnits("iris-runtime-2026-08-01-1", entries);
  const p1 = resolveProtectedTail(projection, 1_000, { unitTokenCounts: [500, 500] });
  const p2 = resolveProtectedTail(projection, 1_000, { unitTokenCounts: [500, 500] });
  assert.equal(protectedTailFingerprint(p1), protectedTailFingerprint(p2));
  const shifted = { ...p1, protectedTailStartEntrySeq: p1.protectedTailStartEntrySeq + 1 };
  assert.notEqual(protectedTailFingerprint(p1), protectedTailFingerprint(shifted));
});

test("protected-tail: empty projection produces a safe no-fold plan", () => {
  const projection = projectLogicalUnits("iris-runtime-2026-08-01-1", []);
  const plan = resolveProtectedTail(projection, 5_000);
  assert.equal(plan.lastSafeUserAnchorEntrySeq, null);
  assert.equal(plan.protectedTailStartEntrySeq, 1);
  assert.equal(plan.headEndEntrySeq, 0);
});
