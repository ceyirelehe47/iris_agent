/**
 * Feature B (goal.txt §4) — strict semantic schema validation.
 *
 * Proves, for every concrete schema in SEMANTIC_SCHEMA_REGISTRY:
 *  - unknown semanticSchemaId is rejected (fail closed);
 *  - iris.semantic.text_v1 accepts ONLY plain strings — arbitrary
 *    objects/arrays/primitives are rejected (it is NOT a generic escape
 *    hatch);
 *  - each concrete schema validates its payload shape (user/assistant/
 *    tool_result roles, message-shaped objects for tool_call/body_event/
 *    operational);
 *  - the shapes the ingest layer actually writes (user/assistant/tool_result
 *    AgentMessages) pass strict V2 validation end to end;
 *  - forbidden control metadata stays rejected.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  validateSemanticContentForSchema,
  validateUnitV2Strict,
  validateGenerationV2Strict,
  computeSemanticContentHash,
  computeContextGenerationHash,
  CONTEXT_GENERATION_V2_SCHEMA_ID,
  CONTEXT_GENERATION_HEADER_V1_SCHEMA_ID,
  CONTEXT_UNIT_V2_SCHEMA_ID,
  CONTEXT_UNIT_HEADER_V1_SCHEMA_ID,
  CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
  CONTEXT_MESSAGE_UNIT_V1_SCHEMA_ID,
  type ContextGenerationV2,
  type ContextUnitV2,
  type ContextUnitHeaderV1,
  type JsonValue,
} from "../src/contracts/context-v27.js";

const TEXT_V1 = "iris.semantic.text_v1";
const USER_V1 = "iris.semantic.context_message.user.v1";
const ASSISTANT_V1 = "iris.semantic.context_message.assistant.v1";
const TOOL_RESULT_V1 = "iris.semantic.context_message.tool_result.v1";
const TOOL_CALL_V1 = "iris.semantic.context_message.tool_call.v1";
const BODY_EVENT_V1 = "iris.semantic.context_message.body_event.v1";
const OPERATIONAL_V1 = "iris.semantic.context_message.operational.v1";
const UNKNOWN_V1 = "iris.semantic.context_message.does_not_exist.v999";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUnit(id: string, semanticSchemaId: string, content: JsonValue): ContextUnitV2 {
  const contentHash = computeSemanticContentHash(content);
  const header: ContextUnitHeaderV1 = {
    schemaId: CONTEXT_UNIT_HEADER_V1_SCHEMA_ID,
    contextUnitId: id,
    source: {
      schemaId: CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
      sourceSchemaId: CONTEXT_MESSAGE_UNIT_V1_SCHEMA_ID,
      sourceId: id,
      sourceHash: contentHash,
    },
    semanticSchemaId,
    contentHash,
  };
  return { schemaId: CONTEXT_UNIT_V2_SCHEMA_ID, header, semanticContent: content };
}

function makeGeneration(units: ContextUnitV2[]): ContextGenerationV2 {
  const layerEnds: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, units.length];
  const hash = computeContextGenerationHash({
    schemaId: CONTEXT_GENERATION_V2_SCHEMA_ID,
    contextLineageId: "test-lineage",
    sourceSnapshotHash: "test-snapshot",
    units,
    layerEnds,
  });
  return {
    schemaId: CONTEXT_GENERATION_V2_SCHEMA_ID,
    header: {
      schemaId: CONTEXT_GENERATION_HEADER_V1_SCHEMA_ID,
      contextGenerationId: "gen-1",
      contextLineageId: "test-lineage",
      sourceSnapshotHash: "test-snapshot",
      layerEnds,
      contextGenerationHash: hash,
      createdAt: "2026-08-11T00:00:00Z",
    },
    units,
  };
}

/** Build a unit the way the production ingest writes it (P5 source ref + durable hash chain). */
function makeProductionShapedUnit(
  id: string,
  semanticSchemaId: string,
  content: JsonValue,
): ContextUnitV2 {
  return makeUnit(id, semanticSchemaId, content);
}

// ---------------------------------------------------------------------------
// Unknown schema → reject
// ---------------------------------------------------------------------------

test("unknown semanticSchemaId is rejected by validateSemanticContentForSchema", () => {
  const err = validateSemanticContentForSchema(UNKNOWN_V1, { role: "user" });
  assert.ok(err?.includes("unknown semanticSchemaId"), `got: ${err}`);
  assert.ok(err?.includes(UNKNOWN_V1));
});

test("unknown semanticSchemaId is rejected through validateUnitV2Strict", () => {
  const unit = makeUnit("u1", UNKNOWN_V1, "hello");
  const result = validateUnitV2Strict(unit);
  assert.ok(!result.valid, "unknown schema must fail closed");
  assert.match(result.reason ?? "", /unknown semanticSchemaId/);
});

// ---------------------------------------------------------------------------
// text_v1: plain-string contract
// ---------------------------------------------------------------------------

test("text_v1 accepts a plain string", () => {
  assert.equal(validateSemanticContentForSchema(TEXT_V1, "hello world"), null);
  const unit = makeUnit("u1", TEXT_V1, "hello world");
  assert.ok(validateUnitV2Strict(unit).valid);
});

test("text_v1 rejects an object payload", () => {
  const err = validateSemanticContentForSchema(TEXT_V1, { text: "hello" });
  assert.match(err ?? "", /text_v1 semanticContent must be a plain string/);
});

test("text_v1 rejects array, number, boolean and null payloads", () => {
  for (const bad of [[1, 2], 42, true, null] as JsonValue[]) {
    const err = validateSemanticContentForSchema(TEXT_V1, bad);
    assert.match(
      err ?? "",
      /text_v1 semanticContent must be a plain string/,
      `payload: ${JSON.stringify(bad)}`,
    );
    const unit = makeUnit("u-bad", TEXT_V1, bad);
    assert.ok(!validateUnitV2Strict(unit).valid, `unit payload: ${JSON.stringify(bad)}`);
  }
});

test("text_v1 object payload fails the WHOLE generation strict validation", () => {
  const gen = makeGeneration([makeUnit("u1", TEXT_V1, { text: "world" })]);
  const result = validateGenerationV2Strict(gen);
  assert.ok(!result.valid);
  assert.match(
    result.reason ?? "",
    /semantic validation failed: text_v1 semanticContent must be a plain string/,
  );
});

// ---------------------------------------------------------------------------
// user.v1: object + role ∈ {user, custom}
// ---------------------------------------------------------------------------

test("user.v1 accepts role user and role custom", () => {
  assert.equal(validateSemanticContentForSchema(USER_V1, { role: "user", content: "hi" }), null);
  assert.equal(validateSemanticContentForSchema(USER_V1, { role: "custom", content: "x" }), null);
});

test("user.v1 rejects non-object payloads and wrong roles", () => {
  assert.match(validateSemanticContentForSchema(USER_V1, "hello") ?? "", /must be an object/);
  assert.match(validateSemanticContentForSchema(USER_V1, ["x"]) ?? "", /must be an object/);
  assert.match(
    validateSemanticContentForSchema(USER_V1, { role: "assistant" }) ?? "",
    /role must be 'user' or 'custom'/,
  );
  assert.match(
    validateSemanticContentForSchema(USER_V1, { content: "no role" }) ?? "",
    /role must be 'user' or 'custom'/,
  );
});

// ---------------------------------------------------------------------------
// assistant.v1: object + role === assistant
// ---------------------------------------------------------------------------

test("assistant.v1 accepts an assistant message payload", () => {
  assert.equal(
    validateSemanticContentForSchema(ASSISTANT_V1, {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
    }),
    null,
  );
});

test("assistant.v1 rejects wrong roles and non-objects", () => {
  assert.match(
    validateSemanticContentForSchema(ASSISTANT_V1, { role: "user" }) ?? "",
    /role must be 'assistant'/,
  );
  assert.match(validateSemanticContentForSchema(ASSISTANT_V1, "text") ?? "", /must be an object/);
});

// ---------------------------------------------------------------------------
// tool_result.v1: object + role === toolResult (production ingest shape)
// ---------------------------------------------------------------------------

test("tool_result.v1 accepts the production toolResult message shape", () => {
  const payload = {
    role: "toolResult",
    content: [{ type: "text", text: "done" }],
    toolName: "read",
  };
  assert.equal(validateSemanticContentForSchema(TOOL_RESULT_V1, payload), null);
  assert.ok(validateUnitV2Strict(makeUnit("u1", TOOL_RESULT_V1, payload)).valid);
});

test("tool_result.v1 rejects object without role toolResult and non-objects", () => {
  assert.match(
    validateSemanticContentForSchema(TOOL_RESULT_V1, { role: "user" }) ?? "",
    /role must be 'toolResult'/,
  );
  assert.match(
    validateSemanticContentForSchema(TOOL_RESULT_V1, "result") ?? "",
    /must be an object/,
  );
  assert.match(validateSemanticContentForSchema(TOOL_RESULT_V1, ["x"]) ?? "", /must be an object/);
});

// ---------------------------------------------------------------------------
// tool_call / body_event / operational: message-shaped objects
// ---------------------------------------------------------------------------

test("tool_call.v1 accepts an object and rejects bare strings/arrays", () => {
  assert.equal(
    validateSemanticContentForSchema(TOOL_CALL_V1, { role: "assistant", content: [] }),
    null,
  );
  assert.match(validateSemanticContentForSchema(TOOL_CALL_V1, "call") ?? "", /must be an object/);
  assert.match(validateSemanticContentForSchema(TOOL_CALL_V1, [1]) ?? "", /must be an object/);
});

test("body_event.v1 accepts an object and rejects bare strings/arrays", () => {
  assert.equal(
    validateSemanticContentForSchema(BODY_EVENT_V1, { type: "move", payload: {} }),
    null,
  );
  assert.match(validateSemanticContentForSchema(BODY_EVENT_V1, "event") ?? "", /must be an object/);
  assert.match(validateSemanticContentForSchema(BODY_EVENT_V1, [1]) ?? "", /must be an object/);
});

test("operational.v1 accepts an object and rejects bare strings/arrays", () => {
  assert.equal(validateSemanticContentForSchema(OPERATIONAL_V1, { op: "notice" }), null);
  assert.match(validateSemanticContentForSchema(OPERATIONAL_V1, "op") ?? "", /must be an object/);
  assert.match(validateSemanticContentForSchema(OPERATIONAL_V1, [1]) ?? "", /must be an object/);
});

// ---------------------------------------------------------------------------
// Production ingest shapes pass end to end (P5 projection chain)
// ---------------------------------------------------------------------------

test("production ingest payload shapes pass the whole generation strict validation", () => {
  // These are exactly the semanticContent shapes ContextIngest.buildUnit
  // writes for user / assistant / tool_result events.
  const units = [
    makeProductionShapedUnit("u-user", USER_V1, {
      role: "user",
      content: "[USER REQUEST | UNVERIFIED]",
      timestamp: 1,
    }),
    makeProductionShapedUnit("u-assistant", ASSISTANT_V1, {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    }),
    makeProductionShapedUnit("u-tool-result", TOOL_RESULT_V1, {
      role: "toolResult",
      content: [{ type: "text", text: "read-only result: iris" }],
      toolName: "test_read_tool",
    }),
  ];
  const gen = makeGeneration(units);
  const result = validateGenerationV2Strict(gen);
  assert.ok(result.valid, `production shapes must validate: ${result.reason}`);
});

// ---------------------------------------------------------------------------
// Forbidden control metadata stays rejected
// ---------------------------------------------------------------------------

test("forbidden control metadata in payload is rejected for every concrete schema", () => {
  const schemas = [
    TEXT_V1,
    USER_V1,
    ASSISTANT_V1,
    TOOL_RESULT_V1,
    TOOL_CALL_V1,
    BODY_EVENT_V1,
    OPERATIONAL_V1,
  ];
  for (const schema of schemas) {
    // A payload that carries control metadata under ANY schema must fail.
    const err = validateSemanticContentForSchema(schema, {
      role: "user",
      contextUnitId: "u-1",
      content: "x",
    });
    assert.match(err ?? "", /forbidden control metadata field: contextUnitId/, `schema: ${schema}`);
  }
});
