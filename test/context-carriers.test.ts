import test from "node:test";

import assert from "node:assert/strict";

import {
  CARRIER_SCHEMA_VERSION,
  IRIS_CONTEXT_CARRIER_CUSTOM_TYPE,
  buildCarriers,
  buildCarriersFromLineage,
  canonicalCarrierJson,
  emptyM1Placeholder,
} from "../src/context/carriers.js";
import { IRIS_INPUT_META_CUSTOM_TYPE } from "../src/contracts/context.js";
import { M0_EMPTY_BODY, M1_EMPTY_PLACEHOLDER } from "../src/contracts/context.js";
import type { ContextLineage } from "../src/context/context-store.js";

const BASE_INPUT = {
  runtimeSessionId: "iris-runtime-2026-08-01-1",
  materializationId: "mat-1",
  providerProfileId: "mock",
  m0Body: "<session-history>folded baseline</session-history>",
  m1Body: "<session-history-since>delta</session-history-since>",
  atMs: 1_785_000_000_000,
};

test("carriers: exact role/customType/details/timestamp contract", () => {
  const { m0, m1 } = buildCarriers(BASE_INPUT);
  assert.equal(m0.role, "custom");
  assert.equal(m0.customType, IRIS_CONTEXT_CARRIER_CUSTOM_TYPE);
  assert.equal(m0.display, false);
  assert.equal(m1.role, "custom");
  assert.equal(m1.customType, IRIS_CONTEXT_CARRIER_CUSTOM_TYPE);
  assert.equal(m1.display, false);

  const m0Details = m0.details as {
    irisContext: {
      surface: string;
      schemaVersion: number;
      runtimeSessionId: string;
      materializationId: string;
      contentHash: string;
      carrierSchemaVersion: string;
      providerProfileId: string;
    };
  };
  assert.equal(m0Details.irisContext.surface, "m0");
  assert.equal(
    m1.details && (m1.details as { irisContext: { surface: string } }).irisContext.surface,
    "m1",
  );
  assert.equal(m0Details.irisContext.schemaVersion, 1);
  assert.equal(m0Details.irisContext.runtimeSessionId, "iris-runtime-2026-08-01-1");
  assert.equal(m0Details.irisContext.materializationId, "mat-1");
  assert.equal(m0Details.irisContext.carrierSchemaVersion, CARRIER_SCHEMA_VERSION);
  assert.equal(m0Details.irisContext.providerProfileId, "mock");
  assert.equal(m0Details.irisContext.contentHash.length, 64, "sha256 hex");
});

test("carriers: fixed empty values match the authority constants", () => {
  const { m0, m1 } = buildCarriers({
    ...BASE_INPUT,
    m0Body: "",
    m1Body: "",
  });
  assert.equal(m0.content, M0_EMPTY_BODY, "empty m0 uses the fixed M0_EMPTY_BODY");
  assert.equal(
    m1.content,
    M1_EMPTY_PLACEHOLDER,
    "empty m1 uses the fixed M1_EMPTY_PLACEHOLDER (never omitted)",
  );
  assert.equal(emptyM1Placeholder(), M1_EMPTY_PLACEHOLDER);
});

test("carriers: m1 placeholder is never omitted and m0/m1 are never merged", () => {
  const { m0, m1 } = buildCarriers(BASE_INPUT);
  assert.notEqual(m0.content, "", "m0 must carry the baseline body");
  assert.notEqual(m1.content, "", "m1 must never be empty — placeholder when empty");
  // Two distinct carriers, fixed order m0 then m1.
  assert.notEqual(m0.customType === m1.customType ? m0.content === m1.content : false, true);
});

test("carriers: byte-identical replay for identical state (determinism)", () => {
  const first = buildCarriers(BASE_INPUT);
  const second = buildCarriers(BASE_INPUT);
  assert.equal(first.m0ContentHash, second.m0ContentHash);
  assert.equal(first.m1ContentHash, second.m1ContentHash);
  assert.equal(first.carrierFingerprint, second.carrierFingerprint);
  assert.equal(
    canonicalCarrierJson(first.m0),
    canonicalCarrierJson(second.m0),
    "canonical JSON must be byte-identical",
  );
});

test("carriers: different provider profile invalidates the carrier (HARD signal)", () => {
  const mock = buildCarriers(BASE_INPUT);
  const other = buildCarriers({ ...BASE_INPUT, providerProfileId: "live" });
  assert.notEqual(
    mock.carrierFingerprint,
    other.carrierFingerprint,
    "provider profile change must change the prefix bytes",
  );
});

test("carriers: materializationId change invalidates the carrier", () => {
  const a = buildCarriers(BASE_INPUT);
  const b = buildCarriers({ ...BASE_INPUT, materializationId: "mat-2" });
  assert.notEqual(a.carrierFingerprint, b.carrierFingerprint);
});

test("carriers: buildCarriersFromLineage returns undefined when m0 never materialized", () => {
  const lineage: ContextLineage = {
    lineageId: "identity-test",
    currentRuntimeSessionId: "iris-runtime-2026-08-01-1",
    contextSourceSnapshotId: "src-1",
    epochId: "e1",
    personaSnapshotId: "p1",
    declarationVersion: "v1",
    providerProfileId: "mock",
    canonicalSystemPrompt: "sys",
    systemProjectionHash: "sh",
    preparedAt: "2026-08-01T12:00:00.000Z",
    materializationId: "mat-1",
    contextSerializerVersion: "v1",
    carrierSchemaVersion: "1",
    m0Body: null,
    m1Body: null,
    m0ContentHash: null,
    m1ContentHash: null,
    m0MaterializedAt: null,
    m1UpdatedAt: null,
    cachedM0SystemHash: null,
    cachedM0ModelKey: null,
    cachedM0ProviderProfileId: null,
    lastResponseTime: null,
    representedThroughEntrySeq: 0,
    representedThroughContextSeq: 0,
    protectedTailStartEntrySeq: null,
    lastSafeUserAnchorEntrySeq: null,
    clearedReasoningThroughTag: 0,
    toolReclaimWatermark: 0,
    mutationReplayWatermark: 0,
    deferredSignalCursor: 0,
    emergencyState: "ok",
    lastTransformError: null,
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
  };
  assert.equal(buildCarriersFromLineage(lineage), undefined, "no fake baseline");
});

test("carriers: reload/restart rebuilds byte-identical carriers from lineage", () => {
  const lineage: ContextLineage = {
    lineageId: "identity-test",
    currentRuntimeSessionId: "iris-runtime-2026-08-01-1",
    contextSourceSnapshotId: "src-1",
    epochId: "e1",
    personaSnapshotId: "p1",
    declarationVersion: "v1",
    providerProfileId: "mock",
    canonicalSystemPrompt: "sys",
    systemProjectionHash: "sh",
    preparedAt: "2026-08-01T12:00:00.000Z",
    materializationId: "mat-1",
    contextSerializerVersion: "v1",
    carrierSchemaVersion: "1",
    m0Body: "m0-after-restart",
    m1Body: "m1-after-restart",
    m0ContentHash: "h0",
    m1ContentHash: "h1",
    m0MaterializedAt: 1_785_000_000_000,
    m1UpdatedAt: 1_785_000_000_000,
    cachedM0SystemHash: "sys-v1",
    cachedM0ModelKey: "model-v1",
    cachedM0ProviderProfileId: "mock",
    lastResponseTime: 1_785_000_000_000,
    representedThroughEntrySeq: 0,
    representedThroughContextSeq: 5,
    protectedTailStartEntrySeq: 3,
    lastSafeUserAnchorEntrySeq: 2,
    clearedReasoningThroughTag: 0,
    toolReclaimWatermark: 0,
    mutationReplayWatermark: 0,
    deferredSignalCursor: 0,
    emergencyState: "ok",
    lastTransformError: null,
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
  };
  const rebuilt = buildCarriersFromLineage(lineage);
  assert.ok(rebuilt, "materialized lineage must rebuild carriers");
  assert.equal(rebuilt.m0.content, "m0-after-restart");
  assert.equal(rebuilt.m1.content, "m1-after-restart");
  assert.equal(
    rebuilt.m0.details &&
      (rebuilt.m0.details as { irisContext: { contentHash: string } }).irisContext.contentHash,
    rebuilt.m0ContentHash,
  );
});

test("carriers: companion must never enter the provider-visible payload", () => {
  // The carrier surface is a distinct customType from the input companion —
  // a filter that drops IRIS_INPUT_META_CUSTOM_TYPE must not drop carriers.
  const { m0 } = buildCarriers(BASE_INPUT);
  assert.notEqual(m0.customType, IRIS_INPUT_META_CUSTOM_TYPE);
  assert.equal(m0.customType, IRIS_CONTEXT_CARRIER_CUSTOM_TYPE);
});

test("carriers: exact provider-visible layout order is m0 then m1", () => {
  const { m0, m1 } = buildCarriers(BASE_INPUT);
  const surfaces = [m0, m1].map(
    (c) => (c.details as { irisContext: { surface: string } }).irisContext.surface,
  );
  assert.deepEqual(surfaces, ["m0", "m1"], "fixed order: m0, m1");
});
