import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import type { SessionTreeEntry } from "@iris/pi-agent-core";
import type { TextContent, ThinkingContent, ToolCall } from "@iris/pi-ai";

import {
  LKG_SLOT_KEY,
  buildLkgPrefix,
  captureLkgSlot,
  findLkgAnchor,
  lkgContentDigest,
  noteLkgEntry,
  projectLkgEntries,
  replayLkg,
  validateAnthropicReasoningRuns,
  validateLkgSeam,
  validateLkgSeamBoundary,
} from "../src/context/lkg.js";
import { ContextStore } from "../src/context/context-store.js";
import { IRIS_INPUT_META_CUSTOM_TYPE } from "../src/contracts/context.js";
import { projectSessionMessages } from "../src/runtime/session-projection.js";

function userEntry(id: string, parentId: string | null, text: string, ts = 1): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: { role: "user", content: text, timestamp: ts },
  };
}

function companionEntry(id: string, parentId: string, inputId: string, ts = 2): SessionTreeEntry {
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

function assistantMessage(
  id: string,
  parentId: string | null,
  content: Array<TextContent | ThinkingContent | ToolCall>,
  ts = 3,
  stopReason: "stop" | "toolUse" = "stop",
): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "assistant",
      content,
      timestamp: ts,
      stopReason,
      api: "opencode" as const,
      provider: "opencode",
      model: "model-a",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
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
      toolName: "read_file",
      content: [{ type: "text", text: "file contents" }],
      isError: false,
      timestamp: ts,
    },
  };
}

function storeFixture(): { store: ContextStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "iris-lkg-"));
  const path = join(dir, "context.db");
  return { store: ContextStore.open(path), path };
}

test("lkg: capture then replay on unchanged input returns prefix + pristine tail", () => {
  const { store, path } = storeFixture();
  try {
    // Session: u-1(1) c-1(2) a-1(3) [stop] — one complete turn.
    const entries: SessionTreeEntry[] = [
      userEntry("u-1", null, "hello"),
      companionEntry("c-1", "u-1", "in-1"),
      assistantMessage("a-1", "c-1", [{ type: "text", text: "hi back" }]),
    ];
    const projected = projectSessionMessages(entries);
    // Capture with the same window as both input and output (no reshape).
    const captured = captureLkgSlot(store, {
      runtimeSessionId: "iris-runtime-2026-08-01-1",
      input: projected,
      output: projected,
      modelKey: "model-a",
      providerKey: "opencode",
    });
    assert.equal(captured, true);
    const slot = store.getLkgSlot("iris-runtime-2026-08-01-1", LKG_SLOT_KEY);
    assert.ok(slot);
    const replayed = replayLkg(store, {
      runtimeSessionId: "iris-runtime-2026-08-01-1",
      messages: projected,
      modelKey: "model-a",
      providerKey: "opencode",
    });
    assert.equal(replayed.ok, true);
    if (replayed.ok) {
      assert.equal(replayed.messages.length, 3);
      assert.equal(replayed.messages[0]?.entryId, "u-1");
    }
  } finally {
    store.close();
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("lkg: anchor is the newest real-user input (companion is synthetic, skipped)", () => {
  const entries: SessionTreeEntry[] = [
    userEntry("u-1", null, "first"),
    companionEntry("c-1", "u-1", "in-1"),
    assistantMessage("a-1", "c-1", [{ type: "text", text: "reply" }]),
    userEntry("u-2", "a-1", "second"),
    companionEntry("c-2", "u-2", "in-2"),
  ];
  const projected = projectSessionMessages(entries);
  const lkgEntries = projectLkgEntries(projected);
  const anchor = findLkgAnchor(lkgEntries);
  assert.equal(anchor, 3, "anchor = newest real-user input u-2 (index 3)");
  assert.equal(lkgEntries[1]?.synthetic, true, "companion c-1 is synthetic");
});

test("lkg: active assistant excludes a user message created before the invocation", () => {
  // u-1(1) c-1(2) a-1(3)[toolUse, incomplete] u-2(4) — a-1 is ACTIVE
  // (finish tool-calls + incomplete call). u-2 created at ts 4 > assistant ts 3
  // → still the anchor.
  const entries: SessionTreeEntry[] = [
    userEntry("u-1", null, "run it", 1),
    companionEntry("c-1", "u-1", "in-1", 2),
    assistantMessage(
      "a-1",
      "c-1",
      [{ type: "toolCall", id: "call-1", name: "run", arguments: {} }],
      3,
      "toolUse",
    ),
    userEntry("u-2", "a-1", "actually stop", 4),
  ];
  const projected = projectSessionMessages(entries);
  const lkgEntries = projectLkgEntries(projected);
  assert.equal(lkgEntries[2]?.hasIncompleteTool, true);
  const anchor = findLkgAnchor(lkgEntries);
  assert.equal(anchor, 3, "u-2 created after active assistant remains the anchor");
});

test("lkg: model/provider mismatch fails closed with lkg_model_mismatch", () => {
  const { store, path } = storeFixture();
  try {
    const entries: SessionTreeEntry[] = [
      userEntry("u-1", null, "hello"),
      companionEntry("c-1", "u-1", "in-1"),
      assistantMessage("a-1", "c-1", [{ type: "text", text: "hi" }]),
    ];
    const projected = projectSessionMessages(entries);
    assert.equal(
      captureLkgSlot(store, {
        runtimeSessionId: "s1",
        input: projected,
        output: projected,
        modelKey: "model-a",
        providerKey: "opencode",
      }),
      true,
    );
    const replayed = replayLkg(store, {
      runtimeSessionId: "s1",
      messages: projected,
      modelKey: "model-b",
      providerKey: "opencode",
    });
    assert.deepEqual(replayed, { ok: false, reason: "lkg_model_mismatch" });
  } finally {
    store.close();
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("lkg: reshaped id sequence fails closed with lkg_invalidated_reshape", () => {
  const { store, path } = storeFixture();
  try {
    const entries: SessionTreeEntry[] = [
      userEntry("u-1", null, "hello"),
      companionEntry("c-1", "u-1", "in-1"),
      assistantMessage("a-1", "c-1", [{ type: "text", text: "hi" }]),
    ];
    const projected = projectSessionMessages(entries);
    assert.equal(
      captureLkgSlot(store, {
        runtimeSessionId: "s2",
        input: projected,
        output: projected,
        modelKey: "model-a",
        providerKey: "opencode",
      }),
      true,
    );
    // A reshaped session: an extra entry inserted between u-1 and c-1 shifts
    // every id forward in the entry id sequence.
    const reshaped: SessionTreeEntry[] = [
      userEntry("u-0", null, "boot"),
      userEntry("u-1", "u-0", "hello"),
      companionEntry("c-1", "u-1", "in-1"),
      assistantMessage("a-1", "c-1", [{ type: "text", text: "hi" }]),
    ];
    const reshapedProjected = projectSessionMessages(reshaped);
    const replayed = replayLkg(store, {
      runtimeSessionId: "s2",
      messages: reshapedProjected,
      modelKey: "model-a",
      providerKey: "opencode",
    });
    assert.equal(replayed.ok, false);
    if (!replayed.ok) {
      assert.equal(replayed.reason, "lkg_invalidated_reshape");
    }
  } finally {
    store.close();
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("lkg: changed content fails closed with lkg_content_mismatch", () => {
  const { store, path } = storeFixture();
  try {
    const entries: SessionTreeEntry[] = [
      userEntry("u-1", null, "hello"),
      companionEntry("c-1", "u-1", "in-1"),
      assistantMessage("a-1", "c-1", [{ type: "text", text: "hi" }]),
    ];
    const projected = projectSessionMessages(entries);
    assert.equal(
      captureLkgSlot(store, {
        runtimeSessionId: "s3",
        input: projected,
        output: projected,
        modelKey: "model-a",
        providerKey: "opencode",
      }),
      true,
    );
    // Same ids, but the user message content changed (mutation).
    const mutated: SessionTreeEntry[] = [
      userEntry("u-1", null, "hello CHANGED"),
      companionEntry("c-1", "u-1", "in-1"),
      assistantMessage("a-1", "c-1", [{ type: "text", text: "hi" }]),
    ];
    const mutatedProjected = projectSessionMessages(mutated);
    const replayed = replayLkg(store, {
      runtimeSessionId: "s3",
      messages: mutatedProjected,
      modelKey: "model-a",
      providerKey: "opencode",
    });
    assert.equal(replayed.ok, false);
    if (!replayed.ok) {
      assert.equal(replayed.reason, "lkg_content_mismatch");
    }
  } finally {
    store.close();
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("lkg: unsafe seam (prefix ends with unresolved tool call, tail starts with its result) is rejected", () => {
  const prefix: SessionTreeEntry[] = [
    userEntry("u-1", null, "hello"),
    companionEntry("c-1", "u-1", "in-1"),
    assistantMessage(
      "a-1",
      "c-1",
      [{ type: "toolCall", id: "call-1", name: "run", arguments: {} }],
      3,
      "toolUse",
    ),
  ];
  const tail: SessionTreeEntry[] = [toolResultEntry("tr-1", "a-1", "call-1")];
  const prefixProjected = projectSessionMessages(prefix);
  const tailProjected = projectSessionMessages(tail);
  // Boundary: prefix's last message has toolCall call-1; tail's first message
  // is the toolResult for call-1 → the seam would orphan the call → unsafe.
  assert.equal(validateLkgSeamBoundary(prefixProjected, tailProjected), false);
  assert.equal(validateLkgSeam(prefixProjected, tailProjected), false);
});

test("lkg: safe seam passes when prefix ends with a completed assistant", () => {
  const prefix: SessionTreeEntry[] = [
    userEntry("u-1", null, "hello"),
    companionEntry("c-1", "u-1", "in-1"),
    assistantMessage("a-1", "c-1", [{ type: "text", text: "done" }]),
  ];
  const tail: SessionTreeEntry[] = [
    userEntry("u-2", "a-1", "next"),
    companionEntry("c-2", "u-2", "in-2"),
  ];
  assert.equal(
    validateLkgSeamBoundary(projectSessionMessages(prefix), projectSessionMessages(tail)),
    true,
  );
  assert.equal(validateLkgSeam(projectSessionMessages(prefix), projectSessionMessages(tail)), true);
});

test("lkg: unsafe seam — prefix ends with an incomplete tool call with no result anywhere in tail (reviewer F3)", () => {
  const prefix: SessionTreeEntry[] = [
    userEntry("u-1", null, "hello"),
    companionEntry("c-1", "u-1", "in-1"),
    assistantMessage(
      "a-1",
      "c-1",
      [{ type: "toolCall", id: "call-1", name: "run", arguments: {} }],
      3,
      "toolUse",
    ),
  ];
  // Tail starts with a user message; the call-1 result never appears anywhere
  // in the tail → a dangling tool_use would reach the wire → unsafe.
  const tail: SessionTreeEntry[] = [
    userEntry("u-2", "a-1", "continue"),
    companionEntry("c-2", "u-2", "in-2"),
  ];
  assert.equal(
    validateLkgSeamBoundary(projectSessionMessages(prefix), projectSessionMessages(tail)),
    false,
  );
});

test("lkg: reasoning part on a non-assistant message is rejected (reviewer F2)", () => {
  // A user message whose content carries a reasoning part is a corrupt seam.
  const prefix: SessionTreeEntry[] = [
    userEntry("u-1", null, "hello"),
    companionEntry("c-1", "u-1", "in-1"),
    assistantMessage("a-1", "c-1", [{ type: "text", text: "done" }]),
  ];
  const tail: SessionTreeEntry[] = [
    {
      type: "message",
      id: "u-2",
      parentId: "a-1",
      timestamp: "2026-08-01T00:00:00.000Z",
      // Deliberately corrupt: a "reasoning" part in a user message would
      // break the seam (non-assistant messages must not carry reasoning).
      message: {
        role: "user",
        content: [{ type: "reasoning", text: "leaked" }],
        timestamp: 5,
      } as unknown as import("@iris/pi-agent-core").AgentMessage,
    },
  ];
  assert.equal(
    validateLkgSeam(projectSessionMessages(prefix), projectSessionMessages(tail)),
    false,
  );
});

test("lkg: anthropic reasoning runs — multiple thinking blocks in one merged run are rejected", () => {
  const bad: SessionTreeEntry[] = [
    assistantMessage("a-1", null, [
      { type: "thinking", thinking: "first block" },
      { type: "thinking", thinking: "second block" },
    ]),
  ];
  assert.equal(validateAnthropicReasoningRuns(projectSessionMessages(bad)), false);

  const good: SessionTreeEntry[] = [
    assistantMessage("a-1", null, [{ type: "thinking", thinking: "one block" }]),
    assistantMessage("a-2", "a-1", [{ type: "text", text: "answer" }]),
  ];
  assert.equal(validateAnthropicReasoningRuns(projectSessionMessages(good)), true);
});

test("lkg: digest is deterministic and content-sensitive", () => {
  const digestOf = (entry: SessionTreeEntry): string | null => {
    const projected = projectSessionMessages([entry])[0];
    if (projected === undefined) return null;
    return lkgContentDigest(projected.message);
  };
  const da = digestOf(userEntry("u-1", null, "hello"));
  const db = digestOf(userEntry("u-1", null, "hello"));
  const dc = digestOf(userEntry("u-1", null, "hello CHANGED"));
  assert.ok(da);
  assert.equal(da, db, "same content → same digest");
  assert.notEqual(da, dc, "changed content → different digest");
});

test("lkg: noteLkgEntry derives entryInputIds + pristineTail from the window", () => {
  const entries: SessionTreeEntry[] = [
    userEntry("u-1", null, "hello"),
    companionEntry("c-1", "u-1", "in-1"),
    assistantMessage("a-1", "c-1", [{ type: "text", text: "hi" }]),
    userEntry("u-2", "a-1", "more"),
    companionEntry("c-2", "u-2", "in-2"),
    assistantMessage("a-2", "c-2", [{ type: "text", text: "done" }]),
  ];
  const projected = projectSessionMessages(entries);
  const note = noteLkgEntry(projected);
  assert.ok(note);
  assert.equal(note.anchorIndex, 3, "anchor = u-2");
  assert.deepEqual(note.entryInputIds, ["u-1", "c-1", "a-1", "u-2", "c-2", "a-2"]);
  assert.equal(note.pristineTail.length, 2);
  assert.equal(note.pristineTail[0]?.entryId, "c-2");
});

test("lkg: capture on a window without a safe anchor returns false", () => {
  const { store, path } = storeFixture();
  try {
    // Only a user message with no companion and no assistant — no completed
    // anchor can be derived (latest assistant missing → anchor scan may still
    // find u-1; but with no companion the pairing is incomplete). Use an empty
    // window to guarantee failure.
    const captured = captureLkgSlot(store, {
      runtimeSessionId: "s-empty",
      input: [],
      output: [],
      modelKey: "model-a",
      providerKey: "opencode",
    });
    assert.equal(captured, false);
    assert.equal(store.getLkgSlot("s-empty", LKG_SLOT_KEY), undefined);
  } finally {
    store.close();
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("lkg: buildLkgPrefix returns null on duplicate ids", () => {
  const entries: SessionTreeEntry[] = [
    userEntry("u-1", null, "hello"),
    companionEntry("c-1", "u-1", "in-1"),
    userEntry("u-1", "c-1", "duplicate id"), // duplicate
  ];
  const projected = projectSessionMessages(entries);
  assert.equal(buildLkgPrefix(projected, projected), null);
});

test("lkg: replay without a stored slot fails closed with lkg_invalidated_reshape", () => {
  const { store, path } = storeFixture();
  try {
    const entries: SessionTreeEntry[] = [
      userEntry("u-1", null, "hello"),
      companionEntry("c-1", "u-1", "in-1"),
    ];
    const projected = projectSessionMessages(entries);
    const replayed = replayLkg(store, {
      runtimeSessionId: "s-none",
      messages: projected,
      modelKey: "model-a",
      providerKey: "opencode",
    });
    assert.deepEqual(replayed, { ok: false, reason: "lkg_invalidated_reshape" });
  } finally {
    store.close();
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("lkg: corrupt payload shape fails closed with a typed reason, not a throw (reviewer F5)", () => {
  const { store, path } = storeFixture();
  try {
    // Manually write a parseable-but-shape-corrupt slot (missing inputIdSeq).
    store.captureLkgSlot({
      lineageId: "s-corrupt",
      slotKey: LKG_SLOT_KEY,
      lkgJson: JSON.stringify({ jsonPrefix: "[]", modelKey: "model-a", providerKey: "opencode" }),
      capturedAt: "2026-08-01T00:00:00.000Z",
    });
    const entries: SessionTreeEntry[] = [
      userEntry("u-1", null, "hello"),
      companionEntry("c-1", "u-1", "in-1"),
    ];
    const projected = projectSessionMessages(entries);
    let result: ReturnType<typeof replayLkg> | undefined;
    assert.doesNotThrow(() => {
      result = replayLkg(store, {
        runtimeSessionId: "s-corrupt",
        messages: projected,
        modelKey: "model-a",
        providerKey: "opencode",
      });
    });
    assert.ok(result, "replayLkg must return a result");
    assert.deepEqual(result, { ok: false, reason: "lkg_seam_invalid" });
  } finally {
    store.close();
    rmSync(dirname(path), { recursive: true, force: true });
  }
});
