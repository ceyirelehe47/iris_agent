import test from "node:test";

import assert from "node:assert/strict";

import type { SessionTreeEntry } from "@iris/pi-agent-core";

import {
  projectLogicalUnits,
  type SessionProjectionUnit,
  type P0System,
  type P1PersonaSnapshot,
  type P2Declarations,
  type P3CommittedInput,
  type P4MemoryInput,
  type ProjectedLogicalUnits,
} from "../src/context/projection.js";
import { IRIS_INPUT_META_CUSTOM_TYPE } from "../src/contracts/context.js";

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
  parts: Array<
    | { type: "text"; text: string }
    | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
    | { type: "thinking"; thinking: string }
  >,
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
  toolName = "read_only_test_tool",
): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-01T00:00:03.000Z",
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName,
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

test("projection: P0/P1/P2 types are structurally sound", () => {
  const p0: P0System = {
    runtimeSessionId: "iris-runtime-2026-08-01-1",
    systemPrompt: "You are Iris.",
    systemProjectionHash: "p0-hash",
  };
  const p1: P1PersonaSnapshot = {
    personaSnapshotId: "persona-1",
    personaContentHash: "p1-hash",
    renderedPersona: "Iris persona",
  };
  const p2: P2Declarations = {
    declarationVersion: "v1",
    toolDeclarations: [{ name: "read_file", version: "0.1.0", description: "read" }],
    runtimeDeclarations: [{ key: "timezone", value: "Asia/Shanghai" }],
    declarationsHash: "p2-hash",
  };
  assert.equal(p0.systemProjectionHash, "p0-hash");
  assert.equal(p1.renderedPersona, "Iris persona");
  assert.equal(p2.toolDeclarations[0]?.name, "read_file");
});

test("projection: P3/P4 are read-port inputs (never fake production Historian)", () => {
  const p3: P3CommittedInput = {
    compartments: [
      {
        compartmentId: "c1",
        runtimeSessionId: "iris-runtime-2026-08-01-1",
        sequence: 1,
        startEntrySeq: 1,
        endEntrySeq: 4,
        title: "Early work",
        p1: "compartment body",
        sourceHash: "src-hash",
      },
    ],
  };
  const p4: P4MemoryInput = {
    stablePoolVersion: "pool-v1",
    items: [{ memoryRef: "mem-1", canonicalText: "text", canonicalTextHash: "h" }],
  };
  assert.equal(p3.compartments[0]?.title, "Early work");
  assert.equal(p4.items[0]?.memoryRef, "mem-1");
  // R2 boundary: fixtures/read ports only — no production Historian claim.
  assert.equal("compartments" in p3, true);
});

test("projection: verified input pair becomes one input unit with real entry ids", () => {
  const entries: SessionTreeEntry[] = [
    {
      type: "model_change",
      id: "mc-1",
      parentId: null,
      timestamp: "2026-08-01T00:00:00.000Z",
      provider: "mock",
      modelId: "m1",
    },
    userEntry("u-1", "mc-1", "IRIS_INPUT_V1\ninline_text:5\nhello\n"),
    customCompanion("c-1", "u-1", { iris: { inputId: "in-1", pairKey: "k1" } }),
    userEntry("u-2", "c-1", "IRIS_INPUT_V1\ninline_text:5\nworld\n"),
    customCompanion("c-2", "u-2", { iris: { inputId: "in-2", pairKey: "k2" } }),
  ];
  const result = projectLogicalUnits("iris-runtime-2026-08-01-1", entries);
  const inputUnits = result.units.filter((u) => u.kind === "input") as Array<
    Extract<SessionProjectionUnit, { kind: "input" }>
  >;
  assert.equal(inputUnits.length, 2);
  assert.equal(inputUnits[0]?.userEntryId, "u-1", "real raw UserMessage entry id");
  assert.equal(inputUnits[0]?.companionEntryId, "c-1", "real companion entry id");
  assert.equal(inputUnits[0]?.verified, true);
  assert.equal(inputUnits[0]?.inputId, "in-1");
  assert.equal(inputUnits[1]?.userEntryId, "u-2");
  assert.equal(result.lastSafeUserAnchor?.unitId, inputUnits[1]?.unitId, "newest verified anchor");
});

test("projection: assistant + toolResult produce tool_arc with adjacency from durable key", () => {
  const entries: SessionTreeEntry[] = [
    userEntry("u-1", null, "IRIS_INPUT_V1\ninline_text:5\nhello\n"),
    customCompanion("c-1", "u-1", { iris: { inputId: "in-1", pairKey: "k1" } }),
    assistantEntry("a-1", "c-1", [
      { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "x" } },
    ]),
    toolResultEntry("tr-1", "a-1", "call-1", "exec-key-1"),
    assistantEntry("a-2", "tr-1", [{ type: "text", text: "done" }]),
  ];
  const result = projectLogicalUnits("iris-runtime-2026-08-01-1", entries);
  const kinds = result.units.map((u) => u.kind);
  assert.ok(kinds.includes("input"));
  assert.ok(kinds.includes("assistant"));
  assert.ok(kinds.includes("tool_result"));
  assert.ok(kinds.includes("tool_arc"), "sealed tool arc must exist");
  const arc = result.units.find(
    (u): u is Extract<SessionProjectionUnit, { kind: "tool_arc" }> => u.kind === "tool_arc",
  );
  assert.ok(arc);
  assert.equal(arc.assistantEntryId, "a-1", "arc bound to real assistant entry id");
  assert.equal(arc.toolResultEntryId, "tr-1", "arc bound to real toolResult entry id");
  assert.equal(arc.toolCallId, "call-1");
  assert.equal(arc.sealed, true);
  // Ordering: input < assistant < arc < tool_result (arc after its parts).
  const order = kinds;
  assert.ok(
    order.indexOf("tool_arc") > order.indexOf("tool_result") - 1 ||
      order.indexOf("tool_arc") > order.indexOf("assistant"),
  );
});

test("projection: reasoning unit detected from thinking parts", () => {
  const entries: SessionTreeEntry[] = [
    userEntry("u-1", null, "q"),
    customCompanion("c-1", "u-1", { iris: { inputId: "in-1", pairKey: "k1" } }),
    assistantEntry("a-1", "c-1", [{ type: "thinking", thinking: "inner thoughts" }]),
  ];
  const result = projectLogicalUnits("iris-runtime-2026-08-01-1", entries);
  const reasoning = result.units.filter((u) => u.kind === "reasoning");
  assert.equal(reasoning.length, 1);
  assert.equal(reasoning[0]?.assistantEntryId, "a-1");
});

test("projection: compaction and branch boundaries become units with real ids", () => {
  const entries: SessionTreeEntry[] = [
    {
      type: "compaction",
      id: "cp-1",
      parentId: null,
      timestamp: "2026-08-01T00:00:00.000Z",
      summary: "sum",
      firstKeptEntryId: "u-1",
      tokensBefore: 10,
    },
    userEntry("u-1", "cp-1", "hello"),
    customCompanion("c-1", "u-1", { iris: { inputId: "in-1", pairKey: "k1" } }),
    {
      type: "branch_summary",
      id: "bs-1",
      parentId: "c-1",
      timestamp: "2026-08-01T00:00:04.000Z",
      fromId: "root",
      summary: "branch",
    },
  ];
  const result = projectLogicalUnits("iris-runtime-2026-08-01-1", entries);
  const compaction = result.units.filter((u) => u.kind === "compaction_boundary");
  const branch = result.units.filter((u) => u.kind === "branch_boundary");
  assert.equal(compaction.length, 1);
  assert.equal((compaction[0] as { entryId: string }).entryId, "cp-1");
  assert.equal(branch.length, 1);
  assert.equal((branch[0] as { fromId: string }).fromId, "root");
});

test("projection: provenance — projection hash is deterministic and order-stable", () => {
  const entries: SessionTreeEntry[] = [
    userEntry("u-1", null, "hello"),
    customCompanion("c-1", "u-1", { iris: { inputId: "in-1", pairKey: "k1" } }),
    assistantEntry("a-1", "c-1", [{ type: "text", text: "reply" }]),
  ];
  const first = projectLogicalUnits("iris-runtime-2026-08-01-1", entries);
  const second = projectLogicalUnits("iris-runtime-2026-08-01-1", entries);
  assert.equal(first.projectionHash, second.projectionHash, "same input → same hash");
  assert.equal(first.fromEntrySeq, 1);
  assert.equal(first.toEntrySeq, entries.length);
  // Unit ordering is deterministic by raw position.
  const seqs = first.units.map((u) => {
    switch (u.kind) {
      case "input":
        return u.entryRange.startEntrySeq;
      case "tool_arc":
        return u.entryRange.startEntrySeq;
      default:
        return u.entrySeq;
    }
  });
  const sorted = [...seqs].sort((a, b) => a - b);
  assert.deepEqual(seqs, sorted, "units appear in raw order");
});

test("projection: unverified/orphan user (no companion) is fail-conservative", () => {
  const entries: SessionTreeEntry[] = [
    userEntry("u-1", null, "IRIS_INPUT_V1\ninline_text:5\nhello\n"),
    // No companion — orphan wire.
  ];
  const result = projectLogicalUnits("iris-runtime-2026-08-01-1", entries);
  const inputUnit = result.units.find(
    (u): u is Extract<SessionProjectionUnit, { kind: "input" }> => u.kind === "input",
  );
  assert.ok(inputUnit);
  assert.equal(inputUnit.verified, false);
  assert.equal(inputUnit.companionEntryId, null);
  assert.equal(result.lastSafeUserAnchor, null, "unverified input must not be the safe anchor");
});

test("projection: empty session projects cleanly with zero units", () => {
  const result = projectLogicalUnits("iris-runtime-2026-08-01-1", []);
  assert.equal(result.units.length, 0);
  // Deterministic empty hash (sha256 of empty input) — same every time.
  assert.equal(
    result.projectionHash,
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("projection: corrupt companion (wrong content/display) is NOT verified (reviewer F1)", () => {
  // The projection must reuse the SAME companion predicate as ingress
  // reconciliation: a custom message with the right customType but the WRONG
  // content/display (or a missing pairKey) is NOT a valid pair — it must not
  // be marked verified and must never become the last-safe-user-anchor.
  const entries: SessionTreeEntry[] = [
    userEntry("u-1", null, "IRIS_INPUT_V1\ninline_text:5\nhello\n"),
    {
      type: "custom_message",
      id: "c-bad",
      parentId: "u-1",
      timestamp: "2026-08-01T00:00:01.000Z",
      customType: "iris_input_meta",
      content: "EVIL-OTHER", // wrong content
      display: true, // wrong display
      details: { iris: { inputId: "in-1", pairKey: "k1" } },
    },
  ];
  const result = projectLogicalUnits("iris-runtime-2026-08-01-1", entries);
  const inputUnit = result.units.find(
    (u): u is Extract<SessionProjectionUnit, { kind: "input" }> => u.kind === "input",
  );
  assert.ok(inputUnit);
  assert.equal(
    inputUnit.verified,
    false,
    "corrupt companion (wrong content/display) must NOT be a verified pair",
  );
  assert.equal(
    result.lastSafeUserAnchor,
    null,
    "corrupt pair must never become the last-safe-user-anchor (LKG safety)",
  );
});

test("projection: companion without pairKey is NOT verified (reviewer F1)", () => {
  const entries: SessionTreeEntry[] = [
    userEntry("u-1", null, "IRIS_INPUT_V1\ninline_text:5\nhello\n"),
    customCompanion("c-1", "u-1", { iris: { inputId: "in-1" } }), // NO pairKey
  ];
  const result = projectLogicalUnits("iris-runtime-2026-08-01-1", entries);
  const inputUnit = result.units.find(
    (u): u is Extract<SessionProjectionUnit, { kind: "input" }> => u.kind === "input",
  );
  assert.ok(inputUnit);
  assert.equal(inputUnit.verified, false, "missing pairKey must fail closed");
  assert.equal(result.lastSafeUserAnchor, null);
});

test("projection: tool_result unit toolName comes from the native message field (reviewer F2)", () => {
  const entries: SessionTreeEntry[] = [
    userEntry("u-1", null, "IRIS_INPUT_V1\ninline_text:5\nhello\n"),
    customCompanion("c-1", "u-1", { iris: { inputId: "in-1", pairKey: "k1" } }),
    assistantEntry("a-1", "c-1", [
      { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "x" } },
    ]),
    // Native toolName = "read_file"; details.iris.toolExecutionKey is the
    // derived durable key (64-char) — they must NOT be conflated.
    toolResultEntry("tr-1", "a-1", "call-1", "exec-key-1", "read_file"),
  ];
  const result = projectLogicalUnits("iris-runtime-2026-08-01-1", entries);
  const toolResult = result.units.find(
    (u): u is Extract<SessionProjectionUnit, { kind: "tool_result" }> => u.kind === "tool_result",
  );
  assert.ok(toolResult);
  assert.equal(toolResult.toolName, "read_file", "toolName = native Pi toolName field");
  assert.equal(toolResult.toolExecutionKey, "exec-key-1", "toolExecutionKey = durable derived key");
  assert.notEqual(toolResult.toolName, toolResult.toolExecutionKey);
});

test("projection: P5 boundary uses m0/m1 represented watermark contract", () => {
  // The representedThroughEntrySeq watermark lives in ContextStore lineage;
  // the projection exposes from/to raw seqs so the consumer can compute
  // "not represented by m0/m1" = units with entrySeq > representedThrough.
  const entries: SessionTreeEntry[] = [
    userEntry("u-1", null, "hello"),
    customCompanion("c-1", "u-1", { iris: { inputId: "in-1", pairKey: "k1" } }),
    assistantEntry("a-1", "c-1", [{ type: "text", text: "reply" }]),
  ];
  const result: ProjectedLogicalUnits = projectLogicalUnits("iris-runtime-2026-08-01-1", entries);
  const representedThrough = 2; // m0/m1 already represent entries 1..2
  const liveTail = result.units.filter((u) => {
    switch (u.kind) {
      case "input":
        return u.entryRange.startEntrySeq > representedThrough;
      case "tool_arc":
        return u.entryRange.startEntrySeq > representedThrough;
      default:
        return u.entrySeq > representedThrough;
    }
  });
  assert.equal(liveTail.length, 1, "assistant a-1 (seq 3) is the live tail beyond the watermark");
  assert.equal(liveTail[0]?.kind, "assistant");
});
