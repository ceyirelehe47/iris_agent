import test from "node:test";

import assert from "node:assert/strict";

import {
  classifyEvidenceBasis,
  hasAnyDerivationRefs,
  isDerivedOnlyUnit,
  isEvidenceEligibleUnit,
  toEvidenceBasisRef,
  type HistorianUnitView,
} from "../src/historian/anti-echo.js";

function unitView(overrides: Partial<HistorianUnitView> = {}): HistorianUnitView {
  return {
    contextUnitId: "unit-1",
    contextSeq: 1,
    runtimeEventId: "evt-1",
    unitType: "input",
    disposition: "include",
    contentHash: "a".repeat(64),
    derivationRefs: { memoryRefs: [], compartmentIds: [], sourceContextMessageUnitIds: [] },
    ...overrides,
  };
}

test("anti-echo: user input with no derivation refs is evidence-eligible", () => {
  const unit = unitView({ unitType: "input" });
  assert.equal(isDerivedOnlyUnit(unit), false);
  assert.equal(isEvidenceEligibleUnit(unit), true);
  const ref = toEvidenceBasisRef(unit);
  assert.ok(ref);
  assert.equal(ref?.historianDisposition, "include");
});

test("anti-echo: tool result is never derived-only", () => {
  const unit = unitView({
    unitType: "tool_result",
    derivationRefs: { memoryRefs: ["mem-1"], compartmentIds: [], sourceContextMessageUnitIds: [] },
  });
  assert.equal(isDerivedOnlyUnit(unit), false);
  assert.equal(isEvidenceEligibleUnit(unit), true);
});

test("anti-echo: assistant restating recalled memory is derived-only and excluded", () => {
  const unit = unitView({
    unitType: "assistant",
    derivationRefs: {
      memoryRefs: ["mem-1"],
      compartmentIds: ["comp-1"],
      sourceContextMessageUnitIds: [],
    },
  });
  assert.equal(isDerivedOnlyUnit(unit), true);
  assert.equal(isEvidenceEligibleUnit(unit), false);
  assert.equal(toEvidenceBasisRef(unit), undefined);
});

test("anti-echo: reference_only disposition never becomes evidence basis", () => {
  const unit = unitView({ unitType: "input", disposition: "reference_only" });
  assert.equal(isEvidenceEligibleUnit(unit), false);
  assert.equal(toEvidenceBasisRef(unit), undefined);
});

test("anti-echo: exclude disposition never becomes evidence basis", () => {
  const unit = unitView({ unitType: "input", disposition: "exclude" });
  assert.equal(isEvidenceEligibleUnit(unit), false);
});

test("anti-echo: classifyEvidenceBasis keeps only eligible units", () => {
  const units = [
    unitView({ contextUnitId: "u1", contextSeq: 1, unitType: "input" }),
    unitView({
      contextUnitId: "u2",
      contextSeq: 2,
      unitType: "assistant",
      derivationRefs: {
        memoryRefs: ["mem-9"],
        compartmentIds: [],
        sourceContextMessageUnitIds: [],
      },
    }),
    unitView({ contextUnitId: "u3", contextSeq: 3, unitType: "tool_result" }),
    unitView({
      contextUnitId: "u4",
      contextSeq: 4,
      unitType: "input",
      disposition: "reference_only",
    }),
  ];
  const { evidenceBasis, derivedOnly } = classifyEvidenceBasis(units);
  assert.equal(derivedOnly, false);
  assert.deepEqual(
    evidenceBasis.map((ref) => ref.contextUnitId),
    ["u1", "u3"],
  );
});

test("anti-echo: all-derived batch is marked derivedOnly", () => {
  const units = [
    unitView({
      contextUnitId: "e1",
      contextSeq: 1,
      unitType: "assistant",
      derivationRefs: {
        memoryRefs: ["mem-1"],
        compartmentIds: [],
        sourceContextMessageUnitIds: [],
      },
    }),
    unitView({
      contextUnitId: "e2",
      contextSeq: 2,
      unitType: "assistant",
      derivationRefs: {
        memoryRefs: [],
        compartmentIds: ["comp-2"],
        sourceContextMessageUnitIds: [],
      },
    }),
  ];
  const { evidenceBasis, derivedOnly } = classifyEvidenceBasis(units);
  assert.equal(derivedOnly, true);
  assert.equal(evidenceBasis.length, 0);
});

test("anti-echo: empty batch is derivedOnly (no new evidence)", () => {
  const { evidenceBasis, derivedOnly } = classifyEvidenceBasis([]);
  assert.equal(derivedOnly, true);
  assert.equal(evidenceBasis.length, 0);
});

test("anti-echo: batch semantics — assistant grounded in new user input is not derived-only", () => {
  // 新 user 输入 + assistant 回答(引用该输入)→ 回答成为 evidence basis。
  const units = [
    unitView({ contextUnitId: "u1", contextSeq: 1, unitType: "input" }),
    unitView({
      contextUnitId: "u2",
      contextSeq: 2,
      unitType: "assistant",
      derivationRefs: {
        memoryRefs: ["mem-1"],
        compartmentIds: [],
        sourceContextMessageUnitIds: ["u1"],
      },
    }),
  ];
  const { evidenceBasis, derivedOnly } = classifyEvidenceBasis(units);
  assert.equal(derivedOnly, false);
  assert.deepEqual(
    evidenceBasis.map((ref) => ref.contextUnitId),
    ["u1", "u2"],
    "assistant grounded in new observation must be evidence-eligible",
  );
});

test("anti-echo: batch semantics — assistant citing only old memory stays derived-only", () => {
  const units = [
    unitView({ contextUnitId: "u1", contextSeq: 1, unitType: "input" }),
    unitView({
      contextUnitId: "u2",
      contextSeq: 2,
      unitType: "assistant",
      derivationRefs: {
        memoryRefs: ["mem-1"],
        compartmentIds: [],
        sourceContextMessageUnitIds: ["old-unit-9"],
      },
    }),
  ];
  const { evidenceBasis, derivedOnly } = classifyEvidenceBasis(units);
  assert.equal(derivedOnly, false, "user input still produces basis");
  assert.deepEqual(
    evidenceBasis.map((ref) => ref.contextUnitId),
    ["u1"],
    "assistant citing only old memory must be excluded",
  );
});

test("anti-echo: hasAnyDerivationRefs covers workSnapshotVersion", () => {
  assert.equal(
    hasAnyDerivationRefs({
      memoryRefs: [],
      compartmentIds: [],
      sourceContextMessageUnitIds: [],
      workSnapshotVersion: "v3",
    }),
    true,
  );
  assert.equal(
    hasAnyDerivationRefs({ memoryRefs: [], compartmentIds: [], sourceContextMessageUnitIds: [] }),
    false,
  );
});
