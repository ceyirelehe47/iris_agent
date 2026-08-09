import { createHash } from "node:crypto";
import test from "node:test";

import assert from "node:assert/strict";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type { ContextMessageUnit } from "../src/contracts/context-units.js";
import type {
  ContextGenerationV2,
  ContextMessageUnitV1,
  ContextUnitV2,
  JsonValue,
} from "../src/contracts/context-v27.js";
import { canonicalJson } from "../src/contracts/tool.js";
import {
  buildGenerationV2,
  payloadAsJsonValue,
  projectStoreUnitToV1,
  verifyGenerationHashesV2,
  type V2GenerationInput,
  type V2P5Source,
} from "../src/context/v2-generation.js";
import { renderGenerationV2, SYNTHETIC_MESSAGE_TIMESTAMP } from "../src/context/v2-renderer.js";

/**
 * Roadmap v27 V2 Context generation — exact-shape and invariant tests.
 *
 * Covers: exact generation shape, layerEnds validation, empty layers,
 * deterministic ordering, hash stability, identity-stable/index-movable,
 * rebuild determinism, the V1→V2 rejection fence, and the sensitivity case
 * (a renamed legacy flat DTO must still be rejected).
 */

const SESSION = "iris-runtime-2026-08-01-1";
const LINEAGE = "identity-test";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function durableUnit(overrides: Partial<ContextMessageUnitV1> = {}): ContextMessageUnitV1 {
  return {
    contextUnitId: "input-1",
    contextSeq: 1,
    runtimeEventId: "evt-1",
    unitType: "input",
    disposition: "include",
    contentHash: sha256("payload-1"),
    lifecycleState: "committed",
    ...overrides,
  };
}

function p5Source(
  unit: ContextMessageUnitV1,
  payload: JsonValue = { role: "user", content: "hello" },
): V2P5Source {
  return { unit, semanticContent: payload };
}

function makeInput(overrides: Partial<V2GenerationInput> = {}): V2GenerationInput {
  return {
    lineageId: LINEAGE,
    runtimeSessionId: SESSION,
    generationSourceId: "snapshot-abc",
    sourceSnapshotHash: "d".repeat(64),
    createdAt: "2026-08-01T00:00:00.000Z",
    p0: {
      systemPromptId: "system-1",
      text: "IRIS SYSTEM PROMPT V1",
      sourceHash: "a".repeat(64),
    },
    p1: {
      personaSnapshotId: "persona-default-v1",
      text: "IRIS PERSONA SNAPSHOT V1",
      sourceHash: "b".repeat(64),
    },
    p2: {
      declarationVersion: "decl-v1",
      text: "IRIS DECLARATIONS V1",
      sourceHash: "c".repeat(64),
    },
    p3: [],
    p4: [],
    p5: [],
    ...overrides,
  };
}

function expectUnit(units: readonly ContextUnitV2[], index: number): ContextUnitV2 {
  const unit = units[index];
  if (unit === undefined) {
    throw new Error(`expected unit at index ${index}`);
  }
  return unit;
}

function expectMessage(messages: AgentMessage[], index: number): AgentMessage {
  const message = messages[index];
  if (message === undefined) {
    throw new Error(`expected message at index ${index}`);
  }
  return message;
}

function contentOf(message: AgentMessage): unknown {
  return (message as { content?: unknown }).content;
}

test("v2: exact generation shape — P0/P1/P2 units, layerEnds, header", () => {
  const generation = buildGenerationV2(makeInput());
  assert.equal(generation.schemaId, "iris.context_generation.v2");
  assert.equal(generation.header.schemaId, "iris.context_generation_header.v1");
  assert.deepEqual(
    [...generation.header.layerEnds],
    [1, 2, 3, 3, 3, 3],
    "one unit per P0/P1/P2; empty P3/P4/P5",
  );
  assert.equal(generation.header.contextLineageId, LINEAGE);
  assert.equal(generation.header.sourceSnapshotHash, "d".repeat(64));
  assert.equal(generation.header.createdAt, "2026-08-01T00:00:00.000Z");
  assert.match(generation.header.contextGenerationId, /^gen-[0-9a-f]{64}$/);
  assert.equal(generation.header.contextGenerationHash.length, 64);

  const p0 = expectUnit(generation.units, 0);
  assert.equal(p0.schemaId, "iris.context_unit.v2");
  assert.equal(p0.header.schemaId, "iris.context_unit_header.v1");
  assert.equal(p0.header.semanticSchemaId, "iris.system.v1");
  assert.equal(p0.header.contextUnitId, "system-system-1");
  assert.equal(p0.header.source.schemaId, "iris.context_unit_source_ref.v1");
  assert.equal(p0.header.source.sourceSchemaId, "iris.system_prompt.v1");
  assert.equal(p0.header.source.sourceId, "system-1");
  assert.equal(typeof p0.header.source.sourceHash, "string", "sourceHash is required");
  assert.equal(p0.header.source.sourceHash, "a".repeat(64));
  assert.equal(p0.header.contentHash, sha256(canonicalJson(p0.semanticContent)));
  assert.equal(p0.semanticContent, "IRIS SYSTEM PROMPT V1");

  const p1 = expectUnit(generation.units, 1);
  assert.equal(p1.header.semanticSchemaId, "iris.persona.v1");
  assert.equal(p1.header.contextUnitId, "persona-persona-default-v1");
  assert.equal(p1.header.source.sourceSchemaId, "iris.persona_snapshot.v1");

  const p2 = expectUnit(generation.units, 2);
  assert.equal(p2.header.semanticSchemaId, "iris.declarations.v1");
  assert.equal(p2.header.contextUnitId, "declarations-decl-v1");
  assert.equal(p2.header.source.sourceSchemaId, "iris.declarations_snapshot.v1");
});

test("v2: P3/P4/P5 units are appended in layer order with per-layer schema ids", () => {
  const generation = buildGenerationV2(
    makeInput({
      p3: [
        { compartmentId: "comp-a", text: "compartment A" },
        { compartmentId: "comp-b", text: "compartment B" },
      ],
      p4: [{ memoryRef: "mem-1", text: "memory 1" }],
      p5: [
        p5Source(durableUnit({ contextUnitId: "input-9", contextSeq: 9, unitType: "input" })),
        p5Source(
          durableUnit({
            contextUnitId: "output-8",
            contextSeq: 8,
            unitType: "output",
          }),
        ),
      ],
    }),
  );
  assert.deepEqual([...generation.header.layerEnds], [1, 2, 3, 5, 6, 8]);
  const compA = expectUnit(generation.units, 3);
  assert.equal(compA.header.semanticSchemaId, "iris.compartment.v1");
  assert.equal(compA.header.contextUnitId, "compartment-comp-a");
  const compB = expectUnit(generation.units, 4);
  assert.equal(compB.header.semanticSchemaId, "iris.compartment.v1");
  const mem = expectUnit(generation.units, 5);
  assert.equal(mem.header.semanticSchemaId, "iris.memory.v1");
  assert.equal(mem.header.contextUnitId, "memory-mem-1");
  const p5First = expectUnit(generation.units, 6);
  const p5Second = expectUnit(generation.units, 7);
  // P5 ordered by contextSeq, identity preserved from the durable unit.
  assert.equal(p5First.header.contextUnitId, "output-8");
  assert.equal(p5First.header.semanticSchemaId, "iris.message.output.v1");
  assert.equal(p5First.header.source.sourceSchemaId, "iris.context_message_unit.v1");
  assert.equal(p5Second.header.contextUnitId, "input-9");
  assert.equal(p5Second.header.semanticSchemaId, "iris.message.input.v1");
  assert.equal(
    p5First.header.source.sourceHash,
    sha256("payload-1"),
    "P5 source hash = durable hash",
  );
});

test("v2: every layer may be empty — empty P3/P4/P5 collapses to the P0-P2 prefix", () => {
  for (const overrides of [
    {},
    { p3: [], p4: [], p5: [] },
    { p3: [{ compartmentId: "c", text: "x" }], p4: [], p5: [] },
    { p3: [], p4: [{ memoryRef: "m", text: "x" }], p5: [] },
    { p3: [], p4: [], p5: [p5Source(durableUnit())] },
  ]) {
    const generation = buildGenerationV2(makeInput(overrides));
    const [e0, e1, e2, e3, e4, e5] = generation.header.layerEnds;
    assert.ok(0 <= e0 && e0 <= e1 && e1 <= e2 && e2 <= e3 && e3 <= e4 && e4 <= e5);
    assert.equal(e5, generation.units.length);
    assert.equal(generation.units[0]?.header.semanticSchemaId, "iris.system.v1");
    assert.equal(generation.units[1]?.header.semanticSchemaId, "iris.persona.v1");
    assert.equal(generation.units[2]?.header.semanticSchemaId, "iris.declarations.v1");
    assert.equal(verifyGenerationHashesV2(generation), true);
  }
});

test("v2: deterministic ordering — P5 input order is ignored, contextSeq is authoritative", () => {
  const a = p5Source(durableUnit({ contextUnitId: "a", contextSeq: 2 }));
  const b = p5Source(durableUnit({ contextUnitId: "b", contextSeq: 1 }));
  const generation = buildGenerationV2(makeInput({ p5: [a, b] }));
  assert.equal(generation.units[3]?.header.contextUnitId, "b", "lower contextSeq first");
  assert.equal(generation.units[4]?.header.contextUnitId, "a");
});

test("v2: hash stability — identical input produces identical hashes and ids", () => {
  const first = buildGenerationV2(makeInput());
  const second = buildGenerationV2(makeInput());
  assert.deepEqual(first, second, "rebuild is byte-identical");
  assert.equal(first.header.contextGenerationId, second.header.contextGenerationId);
  assert.equal(first.header.contextGenerationHash, second.header.contextGenerationHash);
  for (let i = 0; i < first.units.length; i += 1) {
    assert.equal(
      first.units[i]?.header.contentHash,
      second.units[i]?.header.contentHash,
      `unit ${i} hash stable`,
    );
  }
});

test("v2: identity stable / index movable — inserting a unit shifts indexes, never identities", () => {
  const u1 = p5Source(
    durableUnit({ contextUnitId: "u1", contextSeq: 1, contentHash: sha256("u1") }),
  );
  const u2 = p5Source(
    durableUnit({ contextUnitId: "u2", contextSeq: 2, contentHash: sha256("u2") }),
  );
  const before = buildGenerationV2(makeInput({ p5: [u1, u2] }));
  const beforeU1 = expectUnit(before.units, 3);
  const beforeU2 = expectUnit(before.units, 4);

  // A NEW lower-seq unit lands before u1/u2 — their indexes shift.
  const u0 = p5Source(
    durableUnit({ contextUnitId: "u0", contextSeq: 0, contentHash: sha256("u0") }),
  );
  const after = buildGenerationV2(makeInput({ p5: [u2, u0, u1] }));
  const afterU1 = expectUnit(after.units, 4);
  const afterU2 = expectUnit(after.units, 5);
  assert.equal(afterU1.header.contextUnitId, "u1", "identity preserved");
  assert.equal(afterU2.header.contextUnitId, "u2", "identity preserved");
  assert.equal(afterU1.header.contentHash, beforeU1.header.contentHash, "content hash preserved");
  assert.equal(afterU2.header.contentHash, beforeU2.header.contentHash, "content hash preserved");
  assert.deepEqual(afterU1.semanticContent, beforeU1.semanticContent);
  assert.notEqual(
    after.header.contextGenerationHash,
    before.header.contextGenerationHash,
    "generation hash covers the new unit",
  );
});

test("v2: duplicate P5 contextUnitId fails closed", () => {
  const dup = p5Source(durableUnit({ contextUnitId: "same" }));
  assert.throws(
    () => buildGenerationV2(makeInput({ p5: [dup, { ...dup, unit: { ...dup.unit } }] })),
    /duplicate P5 contextUnitId/,
  );
});

test("v2: layerEnds validation — a tampered generation is rejected by validate", () => {
  const generation = buildGenerationV2(makeInput());
  const invalid = {
    ...generation,
    header: { ...generation.header, layerEnds: [1, 2, 3, 3, 3, 5] as const },
  };
  assert.equal(verifyGenerationHashesV2(invalid), false, "layerEnds[5] != length");
  const invalidMonotonic = {
    ...generation,
    header: { ...generation.header, layerEnds: [1, 2, 1, 3, 3, 3] as const },
  };
  assert.equal(verifyGenerationHashesV2(invalidMonotonic), false, "non-monotonic layerEnds");
  const invalidNegative = {
    ...generation,
    header: { ...generation.header, layerEnds: [-1, 2, 3, 3, 3, 3] as const },
  };
  assert.equal(verifyGenerationHashesV2(invalidNegative), false, "negative layerEnd");
});

test("v2: hash verification — tampered semanticContent or contextGenerationHash fails", () => {
  const generation = buildGenerationV2(makeInput());
  assert.equal(verifyGenerationHashesV2(generation), true);
  const tamperedContent = {
    ...generation,
    units: generation.units.map((unit, index) =>
      index === 0 ? { ...unit, semanticContent: "tampered" } : unit,
    ),
  };
  assert.equal(verifyGenerationHashesV2(tamperedContent), false, "content tamper detected");
  const tamperedOrder = {
    ...generation,
    units: [...generation.units].reverse(),
  };
  assert.equal(verifyGenerationHashesV2(tamperedOrder), false, "order tamper detected");
});

test("v2: V1→V2 rejection fence — legacy flat units are rejected", () => {
  const legacyFlat = {
    sourceRef: { sourceId: "legacy" },
    content: "legacy flat content",
  };
  assert.throws(
    () =>
      buildGenerationV2(
        makeInput({
          p5: [{ unit: legacyFlat as unknown as ContextMessageUnitV1, semanticContent: "x" }],
        }),
      ),
    /V1\/V2 mixing is forbidden/,
  );
});

test("v2: sensitivity — a RENAMED legacy flat DTO is still rejected (structure, not name)", () => {
  interface RenamedLegacyFlatUnit {
    sourceRef: { sourceId: string };
    content: string;
  }
  const renamed: RenamedLegacyFlatUnit = {
    sourceRef: { sourceId: "renamed-dto" },
    content: "still the old flat structure",
  };
  // The renamed type has the legacy shape (sourceRef + content, no
  // schemaId/header) — the fence must catch it by STRUCTURE.
  assert.throws(
    () =>
      buildGenerationV2(
        makeInput({
          p5: [
            {
              unit: renamed as unknown as ContextMessageUnitV1,
              semanticContent: { role: "user", content: "x" },
            },
          ],
        }),
      ),
    /V1\/V2 mixing is forbidden/,
    "renaming the DTO must not bypass the rejection fence",
  );
});

test("v2: renderer — P0 becomes systemPrompt; P1-P4 synthetic user messages; P5 restores payloads", () => {
  const payload: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: "committed steer" }],
    timestamp: 1,
  };
  const generation = buildGenerationV2(
    makeInput({
      p3: [{ compartmentId: "c", text: "compartment text" }],
      p5: [
        {
          unit: durableUnit({ contextUnitId: "in-1", contextSeq: 1 }),
          semanticContent: payloadAsJsonValue(payload),
        },
      ],
    }),
  );
  const rendered = renderGenerationV2(generation);
  assert.equal(rendered.systemPrompt, "IRIS SYSTEM PROMPT V1");
  assert.equal(rendered.messages.length, 4, "P1 + P2 + P3 + P5");

  const p1 = expectMessage(rendered.messages, 0);
  assert.equal(p1.role, "user");
  assert.equal(contentOf(p1), "IRIS PERSONA SNAPSHOT V1");
  assert.equal(p1.timestamp, SYNTHETIC_MESSAGE_TIMESTAMP);

  const p2 = expectMessage(rendered.messages, 1);
  assert.equal(contentOf(p2), "IRIS DECLARATIONS V1");
  const p3 = expectMessage(rendered.messages, 2);
  assert.equal(contentOf(p3), "compartment text");

  const p5 = expectMessage(rendered.messages, 3);
  assert.deepEqual(p5, payload, "P5 payload restored from canonical JSON round-trip");
});

test("v2: renderer fails closed on invalid or tampered generations", () => {
  const generation = buildGenerationV2(makeInput());
  assert.throws(
    () =>
      renderGenerationV2({
        ...generation,
        header: { ...generation.header, layerEnds: [1, 2, 3, 3, 3, 99] as const },
      }),
    /layerEnds/,
  );
  assert.throws(
    () =>
      renderGenerationV2({
        ...generation,
        units: generation.units.map((unit, index) =>
          index === 0 ? { ...unit, semanticContent: "tampered" } : unit,
        ),
      }),
    /hash mismatch/,
  );
});

test("v2: projectStoreUnitToV1 preserves identity/order/hash and maps semantics", () => {
  const storeUnit: ContextMessageUnit = {
    lineageId: LINEAGE,
    runtimeSessionId: SESSION,
    contextSeq: 7,
    unitId: "store-unit-7",
    sourceEventId: "src-7",
    runtimeEventId: "evt-7",
    unitType: "assistant",
    disposition: "include",
    entryId: "entry-7",
    entrySeq: 7,
    contentHash: sha256("payload"),
    payload: {
      role: "user",
      content: [{ type: "text", text: "hi" }],
      timestamp: 1,
    } as AgentMessage,
    paired: false,
    derivationRefs: { memoryRefs: [], compartmentIds: [], sourceContextMessageUnitIds: [] },
    schemaVersion: "iris-context-units-v1",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
  const v1 = projectStoreUnitToV1(storeUnit);
  assert.equal(v1.contextUnitId, "store-unit-7");
  assert.equal(v1.contextSeq, 7);
  assert.equal(v1.runtimeEventId, "evt-7");
  assert.equal(v1.unitType, "output", "assistant → output");
  assert.equal(v1.disposition, "include");
  assert.equal(v1.contentHash, sha256("payload"));
  assert.equal(v1.lifecycleState, "committed");

  const excluded = projectStoreUnitToV1({ ...storeUnit, disposition: "exclude" });
  assert.equal(excluded.disposition, "exclude");
  const retired = projectStoreUnitToV1({ ...storeUnit, disposition: "retired" });
  assert.equal(retired.disposition, "exclude", "retired maps to exclude");
});

test("v2: generation built from projected store units round-trips through the renderer", () => {
  const storeUnits: ContextMessageUnit[] = [
    {
      lineageId: LINEAGE,
      runtimeSessionId: SESSION,
      contextSeq: 1,
      unitId: "input-1",
      sourceEventId: "src-1",
      unitType: "input",
      disposition: "include",
      contentHash: sha256("wire"),
      payload: { role: "user", content: [{ type: "text", text: "hello iris" }], timestamp: 1 },
      paired: true,
      derivationRefs: { memoryRefs: [], compartmentIds: [], sourceContextMessageUnitIds: [] },
      schemaVersion: "iris-context-units-v1",
      createdAt: "2026-08-01T00:00:00.000Z",
    },
  ];
  const generation = buildGenerationV2(
    makeInput({
      p5: storeUnits.map((unit) => ({
        unit: projectStoreUnitToV1(unit),
        semanticContent: payloadAsJsonValue(unit.payload),
      })),
    }),
  );
  const rendered = renderGenerationV2(generation);
  const last = expectMessage(rendered.messages, rendered.messages.length - 1);
  assert.deepEqual(
    last,
    storeUnits[0]?.payload,
    "committed store payload reaches the provider unchanged",
  );
});

test("v2: contextGenerationId/contextGenerationHash are lineage-bound (v27 basis)", () => {
  const a = buildGenerationV2(makeInput({ lineageId: "identity-a" }));
  const b = buildGenerationV2(makeInput({ lineageId: "identity-b" }));
  assert.notEqual(a.header.contextGenerationId, b.header.contextGenerationId);
  assert.notEqual(
    a.header.contextGenerationHash,
    b.header.contextGenerationHash,
    "v27 hash basis includes contextLineageId",
  );
});

test("v2: ContextGenerationV2 satisfies the structural contract types", () => {
  const generation: ContextGenerationV2 = buildGenerationV2(makeInput());
  const header = generation.header;
  assert.equal(typeof header.contextGenerationId, "string");
  assert.equal(header.layerEnds.length, 6);
  assert.equal(typeof header.contextGenerationHash, "string");
  for (const unit of generation.units) {
    const v2Unit: ContextUnitV2 = unit;
    assert.equal(v2Unit.schemaId, "iris.context_unit.v2");
    assert.equal(typeof v2Unit.header.contentHash, "string");
    assert.equal(typeof v2Unit.header.contextUnitId, "string");
    assert.equal(typeof v2Unit.header.semanticSchemaId, "string");
  }
});

test("v2: semanticContent supports structured JsonValue, not only string", () => {
  const payload: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: "structured steer" }],
    timestamp: 7,
  };
  const generation = buildGenerationV2(
    makeInput({ p5: [p5Source(durableUnit(), payloadAsJsonValue(payload))] }),
  );
  const unit = expectUnit(generation.units, 3);
  const semanticContent: JsonValue = unit.semanticContent;
  assert.deepEqual(semanticContent, payload, "P5 semanticContent carries the message object");
  assert.equal(verifyGenerationHashesV2(generation), true);
});
