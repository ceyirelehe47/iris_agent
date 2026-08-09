/**
 * R3 (iris_agent#9) — anti-echo 生产接线端到端测试。
 *
 * 证明 Exit Gate 3 在生产管线生效:
 *  1. PublicationService 通过 ContextHistoryReadPort 获取单元窄视图 →
 *     EvidenceSet 携带 evidenceBasis/derivedOnly → 持久化到
 *     evidence_sets.evidence_basis_json/derived_only;
 *  2. derived-only 批(assistant 只重述既有记忆)→ derivedOnly=true、
 *     evidenceBasis 空;
 *  3. 新 user 输入 + 回答的批 → 产生 evidence basis。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { ContextStore } from "../src/context/context-store.js";
import { createContextHistoryReadPort } from "../src/context/history-read-port.js";
import type { ContextHistoryReadPort } from "../src/context/history-read-port.js";
import type { HistorianUnitView } from "../src/historian/anti-echo.js";
import type { SequencedSessionEntry } from "../src/contracts/historian.js";
import { PublicationService } from "../src/historian/historian-publication.js";
import { HistorianStore } from "../src/historian/historian-store.js";

const SESSION = "iris-runtime-2026-08-01-1";

function makeLineageInput() {
  return {
    lineageId: "identity-test",
    runtimeSessionId: SESSION,
    contextSourceSnapshotId: "src-1",
    epochId: SESSION,
    personaSnapshotId: "persona-1",
    declarationVersion: "v1",
    providerProfileId: "mock",
    canonicalSystemPrompt: "sys",
    systemProjectionHash: "sys-hash",
    preparedAt: "t",
    materializationId: "mat-1",
    contextSerializerVersion: "v1",
    carrierSchemaVersion: "v1",
  };
}

function makeUnitViews(overrides: Partial<HistorianUnitView>[]): HistorianUnitView[] {
  return overrides.map((o, i) => ({
    contextUnitId: `unit-${i + 1}`,
    contextSeq: i + 1,
    runtimeEventId: `evt-${i + 1}`,
    unitType: "input",
    disposition: "include",
    contentHash: "a".repeat(64),
    derivationRefs: { memoryRefs: [], compartmentIds: [], sourceContextMessageUnitIds: [] },
    ...o,
  }));
}

/** 最小 fake historyPort(不依赖真实 ContextStore)。 */
function fakeHistoryPort(units: HistorianUnitView[]): ContextHistoryReadPort {
  return {
    getMaterializedBoundary: () => {
      throw new Error("not used in this test");
    },
    listUnitsForHistorian: () => units,
    listUnitsWithPayload: () =>
      units.map((unit) => ({
        contextUnitId: unit.contextUnitId,
        contextSeq: unit.contextSeq,
        runtimeEventId: unit.runtimeEventId,
        unitType: unit.unitType,
        disposition: unit.disposition,
        contentHash: unit.contentHash,
        derivationRefs: unit.derivationRefs,
        payload: { role: "user", content: `content-${unit.contextSeq}`, timestamp: 0 },
        payloadTimestamp: new Date().toISOString(),
      })),
    claimHistorianBatch: (input: {
      afterContextSeqExclusive: number;
      throughContextSeqInclusive: number;
    }) => ({
      schemaVersion: "historian-batch-v1" as const,
      lineageId: "identity-anti-echo",
      afterContextSeqExclusive: input.afterContextSeqExclusive,
      throughContextSeqInclusive: input.throughContextSeqInclusive,
      units: [],
      batchHash: "",
      frozenAt: new Date().toISOString(),
    }),
    lineageId: () => "identity-anti-echo",
  };
}

function runPublication(
  store: HistorianStore,
  historyPort: ReturnType<typeof fakeHistoryPort>,
  entrySeqs: number[],
): void {
  const service = new PublicationService({ store, historyPort });
  // 最小 safePrefix:一条 entry(满足 buildCompartment 非空)。
  const safePrefix: SequencedSessionEntry[] = entrySeqs.map((seq) => ({
    runtimeSessionId: SESSION,
    entrySeq: seq,
    // iris_agent#76: entries carry their Context coordinate so the
    // publication's anti-echo view maps to the Context range.
    contextSeq: seq,
    entryId: `entry-${seq}`,
    entry: {
      type: "message",
      id: `e-${seq}`,
      parentId: null,
      timestamp: "t",
      message: { role: "user", content: "hello", timestamp: 1 },
    },
    contentHash: "b".repeat(64),
  }));
  service.commitSafePrefix({
    runtimeSessionId: SESSION,
    boundary: {
      boundarySnapshotId: "bs-1",
      runtimeSessionId: SESSION,
      lineageId: "identity-anti-echo",
      observedHeadEntrySeq: Math.max(...entrySeqs),
      observedHeadContextSeq: Math.max(...entrySeqs),
      eligibleThroughEntrySeq: Math.max(...entrySeqs),
      eligibleThroughContextSeq: Math.max(...entrySeqs),
      protectedTailStartEntrySeq: Math.max(...entrySeqs) + 1,
      trueRawEligibleTokens: 10,
      narratableEligibleTokens: 10,
      sourceRangeHash: "range-hash-1",
      modelProviderProfile: "mock",
      frozenAt: "t",
    },
    safePrefix,
    analysis: {
      runtimeSessionId: SESSION,
      boundary: {} as never,
      eligibleEntries: safePrefix as never,
      units: entrySeqs.map((seq) => ({
        entrySeq: seq,
        entryId: `entry-${seq}`,
        kind: "user_input" as const,
        inFlight: false,
        providerVisible: "hello",
      })),
      trueRawEligibleTokens: 10,
    },
    outcome: {
      ok: true,
      commitThroughEntrySeq: Math.max(...entrySeqs),
      discardedFromEntrySeq: null,
    } as never,
    previousProcessedThroughEntrySeq: 0,
  });
}

test("r3 anti-echo wiring: derived-only batch persists derivedOnly=true and empty basis", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-r3-anti-echo-"));
  const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  try {
    const units = makeUnitViews([
      {
        unitType: "assistant",
        derivationRefs: { memoryRefs: ["mem-1"], compartmentIds: [], sourceContextMessageUnitIds: [] },
      },
      {
        unitType: "assistant",
        derivationRefs: { memoryRefs: [], compartmentIds: ["comp-1"], sourceContextMessageUnitIds: [] },
      },
    ]);
    runPublication(store, fakeHistoryPort(units), [1, 2]);

    const row = store
      .raw()
      .prepare(
        "SELECT evidence_basis_json, derived_only FROM evidence_sets WHERE compartment_id = ?",
      )
      .get("compartment-iris-runtime-2026-08-01-1-1") as {
      evidence_basis_json: string | null;
      derived_only: number | null;
    };
    assert.equal(row.derived_only, 1, "derived-only batch must persist derived_only=1");
    assert.equal(row.evidence_basis_json, "[]", "empty basis persisted");
  } finally {
    store.close();
  }
});

test("r3 anti-echo wiring: new observation batch persists non-empty basis", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-r3-anti-echo-"));
  const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  try {
    const units = makeUnitViews([
      { contextUnitId: "unit-1", unitType: "input" },
      {
        contextUnitId: "unit-2",
        unitType: "tool_result",
      },
    ]);
    runPublication(store, fakeHistoryPort(units), [1, 2]);

    const row = store
      .raw()
      .prepare(
        "SELECT evidence_basis_json, derived_only FROM evidence_sets WHERE compartment_id = ?",
      )
      .get("compartment-iris-runtime-2026-08-01-1-1") as {
      evidence_basis_json: string | null;
      derived_only: number | null;
    };
    assert.equal(row.derived_only, 0, "new observations must not be derived-only");
    const basis = JSON.parse(row.evidence_basis_json ?? "[]") as Array<{ contextUnitId: string }>;
    assert.deepEqual(
      basis.map((b) => b.contextUnitId),
      ["unit-1", "unit-2"],
    );
  } finally {
    store.close();
  }
});

test("r3 anti-echo wiring: reference_only unit never enters basis", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-r3-anti-echo-"));
  const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  try {
    const units = makeUnitViews([
      { contextUnitId: "unit-1", unitType: "input" },
      { contextUnitId: "unit-2", unitType: "input", disposition: "reference_only" },
    ]);
    runPublication(store, fakeHistoryPort(units), [1, 2]);

    const row = store
      .raw()
      .prepare("SELECT evidence_basis_json FROM evidence_sets WHERE compartment_id = ?")
      .get("compartment-iris-runtime-2026-08-01-1-1") as { evidence_basis_json: string };
    const basis = JSON.parse(row.evidence_basis_json) as Array<{ contextUnitId: string }>;
    assert.deepEqual(
      basis.map((b) => b.contextUnitId),
      ["unit-1"],
      "reference_only must not increase evidence basis",
    );
  } finally {
    store.close();
  }
});

test("r3 anti-echo wiring: real ContextStore port end-to-end", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-r3-anti-echo-ctx-"));
  // iris_agent#76: the store's authoritative lineage id must match the
  // inserted units (production passes the data-root-derived id at open).
  const store = ContextStore.open(join(dir, "context.db"), { lineageId: "identity-test" });
  try {
    store.createLineage(makeLineageInput());
    // 插入一个 include input + 一个 derived-only assistant(有 entry_seq)。
    store.insertUnit({
      lineageId: "identity-test",
      runtimeSessionId: SESSION,
      contextSeq: 1,
      unitId: "u1",
      sourceEventId: "evt-1",
      runtimeEventId: "evt-1",
      unitType: "input",
      disposition: "include",
      entryId: "entry-1",
      entrySeq: 1,
      contentHash: "c".repeat(64),
      payload: { role: "user", content: "hello" } as never,
      paired: false,
      derivationRefs: { memoryRefs: [], compartmentIds: [], sourceContextMessageUnitIds: [] },
      schemaVersion: "context-unit-v1",
      createdAt: "t",
    });
    store.insertUnit({
      lineageId: "identity-test",
      runtimeSessionId: SESSION,
      contextSeq: 2,
      unitId: "u2",
      sourceEventId: "evt-2",
      runtimeEventId: "evt-2",
      unitType: "assistant",
      disposition: "include",
      entryId: "entry-2",
      entrySeq: 2,
      contentHash: "d".repeat(64),
      payload: { role: "assistant", content: "as you recall..." } as never,
      paired: false,
      derivationRefs: { memoryRefs: ["mem-1"], compartmentIds: [], sourceContextMessageUnitIds: [] },
      schemaVersion: "context-unit-v1",
      createdAt: "t",
    });

    const port = createContextHistoryReadPort(store);
    const historian = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    try {
      const units = port.listUnitsForHistorian(port.lineageId(), 1, 2);
      assert.equal(units.length, 2);
      const derived = units.find((u) => u.contextUnitId === "u2");
      assert.ok(derived);
      assert.equal(derived.derivationRefs.memoryRefs.length, 1);

      runPublication(historian, fakeHistoryPort(units), [1, 2]);
      const row = historian
        .raw()
        .prepare(
          "SELECT evidence_basis_json, derived_only FROM evidence_sets WHERE compartment_id = ?",
        )
        .get("compartment-iris-runtime-2026-08-01-1-1") as {
        evidence_basis_json: string;
        derived_only: number;
      };
      const basis = JSON.parse(row.evidence_basis_json) as Array<{ contextUnitId: string }>;
      assert.deepEqual(
        basis.map((b) => b.contextUnitId),
        ["u1"],
        "only include non-derived unit becomes basis",
      );
      assert.equal(row.derived_only, 0);
    } finally {
      historian.close();
    }
  } finally {
    store.close();
  }
});
