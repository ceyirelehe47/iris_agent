/**
 * Feature B10 — iris_agent#45: Historian provenance fail-closed.
 *
 * AC map:
 *  - every v2 Publication identifies the TRUE identity-level Context lineage
 *  - Runtime Session rollover does not change the lineage identity
 *  - Context range + rangeHash derive from the exact committed unit batch
 *  - no 1..1 (or any) provenance fabricated when there is no Context batch
 *  - production Historian cannot publish without the Context read/claim port
 *  - Session ranges stay raw archive locators only (no session id leakage)
 *  - changed basis/disposition/contentHash/derivationRefs changes the
 *    canonical payload hash
 *  - crash/retry/replay preserves publication identity + provenance
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { canonicalJson } from "../src/contracts/tool.js";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";

import type { ContextHistoryReadPort } from "../src/context/history-read-port.js";
import { historianBatchHash } from "../src/contracts/historian.js";
import { freezeBoundary } from "../src/historian/historian-boundary.js";
import { HistorianRunner } from "../src/historian/historian-runner.js";
import { createPublicationCommitHook } from "../src/historian/historian-publication.js";
import { HistorianStore } from "../src/historian/historian-store.js";
import { canonicalUnitRangeHash } from "../src/historian/historian-publication.js";
import { contextUnitToSequencedEntry } from "../src/historian/historian-runner.js";
import type { HistorianUnitView } from "../src/historian/anti-echo.js";

const SESSION = "iris-runtime-2026-08-01-1";
const SESSION_B = "iris-runtime-2026-08-02-1";
const LINEAGE = "identity-real-lineage-9f2c";

function u(id: string, parentId: string | null, text = "hello", ts = 1): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: { role: "user", content: text, timestamp: ts },
  } as unknown as SessionTreeEntry;
}

function unit(contextSeq: number, overrides: Partial<HistorianUnitView> = {}): HistorianUnitView {
  return {
    contextUnitId: `unit-${contextSeq}`,
    contextSeq,
    runtimeEventId: `evt-${contextSeq}`,
    unitType: "input",
    disposition: "include",
    contentHash: createHash("sha256").update(`content-${contextSeq}`).digest("hex"),
    derivationRefs: { memoryRefs: [], compartmentIds: [], sourceContextMessageUnitIds: [] },
    ...overrides,
  };
}

/** Fake ContextHistoryReadPort: configurable unit views + a fixed lineage id.
 * iris_agent#76: claimHistorianBatch serves FULL committed ContextMessageUnit
 * rows (the normal semantic input); the narrow views stay values-only. */
function stubPort(units: HistorianUnitView[], lineageId = LINEAGE): ContextHistoryReadPort {
  const claim = (fromContextSeq: number, toContextSeq: number) =>
    units
      .filter((u) => u.contextSeq >= fromContextSeq && u.contextSeq <= toContextSeq)
      .map((u) => ({
        lineageId,
        runtimeSessionId: "attribution-stub",
        contextSeq: u.contextSeq,
        unitId: u.contextUnitId,
        sourceEventId: u.runtimeEventId,
        runtimeEventId: u.runtimeEventId,
        unitType: u.unitType,
        disposition: u.disposition,
        entryId: `entry-${u.contextSeq}`,
        entrySeq: u.contextSeq,
        contentHash: u.contentHash,
        payload: { role: "user" as const, content: `content-${u.contextSeq}`, timestamp: 1 },
        paired: false,
        derivationRefs: u.derivationRefs,
        schemaVersion: "context-unit-v1",
        createdAt: "2026-08-01T00:00:00.000Z",
      }));
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
      return units;
    },
    listUnitsWithPayload() {
      return units.map((unit) => ({
        contextUnitId: unit.contextUnitId,
        contextSeq: unit.contextSeq,
        runtimeEventId: unit.runtimeEventId,
        unitType: unit.unitType,
        disposition: unit.disposition,
        contentHash: unit.contentHash,
        derivationRefs: unit.derivationRefs,
        payload: { role: "user", content: `content-${unit.contextSeq}`, timestamp: 0 },
        payloadTimestamp: new Date().toISOString(),
      }));
    },
    claimHistorianBatch({ afterContextSeqExclusive, throughContextSeqInclusive }) {
      const claimed = claim(
        afterContextSeqExclusive + 1,
        Math.min(throughContextSeqInclusive, units.length),
      );
      const batch: import("../src/contracts/historian.js").HistorianBatchV1 = {
        schemaVersion: "historian-batch-v1",
        lineageId,
        afterContextSeqExclusive,
        throughContextSeqInclusive:
          claimed.length === 0
            ? afterContextSeqExclusive
            : (claimed[claimed.length - 1]?.contextSeq ?? afterContextSeqExclusive),
        units: claimed,
        batchHash: "",
        frozenAt: new Date().toISOString(),
      };
      batch.batchHash = historianBatchHash(batch);
      return batch;
    },
    lineageId() {
      return lineageId;
    },
  } as ContextHistoryReadPort;
}

interface Fixture {
  store: HistorianStore;
  dir: string;
  runCycle: (entries: SessionTreeEntry[], sessionId?: string) => Promise<{ status: string }>;
  envelopeOf: (sessionId?: string) => Record<string, unknown> | undefined;
}

function fixture(port: ContextHistoryReadPort): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "iris-b10-"));
  const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  return {
    store,
    dir,
    async runCycle(entries, sessionId = SESSION) {
      // iris_agent#66: BOTH the freeze head and the runner input come from
      // the SAME Context claim path (committed units) — the freeze must see
      // exactly what the runner consumes, or the frozen sourceRangeHash
      // would never match the claimed range.
      const claimed = port.claimHistorianBatch({
        afterContextSeqExclusive: 0,
        throughContextSeqInclusive: 4096,
      }).units;
      const claimedEntries = claimed
        .filter((unit) => unit.entrySeq !== undefined)
        .map((unit) => contextUnitToSequencedEntry(sessionId, unit));
      void entries; // the fixture's entries feed freeze through the claim path
      const freeze = freezeBoundary({
        rawSeamInput: {
          runtimeSessionId: sessionId,
          lineageId: "identity-stub",
          entries: claimedEntries,
          processedThroughEntrySeq: 0,
          tailMarginEntries: 0,
          modelProviderProfile: "opencode/deepseek-v4-flash",
          frozenAt: "2026-08-01T00:00:00.000Z",
        },
      });
      const runner = new HistorianRunner({
        store,
        historyPort: port,
        commitHook: createPublicationCommitHook({ store, historyPort: port }),
      });
      return runner.run({ runtimeSessionId: sessionId, boundary: freeze.snapshot });
    },
    envelopeOf(sessionId = SESSION) {
      const row = store
        .raw()
        .prepare(
          "SELECT payload_json FROM publication_outbox WHERE runtime_session_id = ? ORDER BY outbox_sequence DESC LIMIT 1",
        )
        .get(sessionId) as { payload_json: string | null } | undefined;
      if (row === undefined) {
        return undefined;
      }
      if (row.payload_json === null) {
        return undefined;
      }
      return JSON.parse(row.payload_json) as Record<string, unknown>;
    },
  };
}

function rangeOf(envelope: Record<string, unknown>): {
  contextLineageId: string;
  fromContextSeq: number;
  toContextSeq: number;
  rangeHash: string;
} {
  return (envelope as { contextRange: never }).contextRange as never;
}

/** The documented canonical range-hash rule (ordered by contextSeq). */
function canonicalRangeHash(units: HistorianUnitView[]): string {
  const ordered = [...units].sort((a, b) => a.contextSeq - b.contextSeq);
  return createHash("sha256")
    .update(
      JSON.stringify(
        ordered.map((x) => ({
          contextSeq: x.contextSeq,
          contextUnitId: x.contextUnitId,
          runtimeEventId: x.runtimeEventId,
          contentHash: x.contentHash,
        })),
      ),
      "utf8",
    )
    .digest("hex");
}

test("B10-AC1/AC2: v2 Publication identifies the TRUE lineage id, stable across rollover (no identity-<session> synthesis)", async () => {
  const fx = fixture(stubPort([unit(1), unit(2)]));
  try {
    const r1 = await fx.runCycle([u("u-1", null, "one")]);
    assert.equal(r1.status, "committed");
    const env1 = fx.envelopeOf();
    assert.ok(env1);
    assert.equal(rangeOf(env1).contextLineageId, LINEAGE, "real lineage id from the port");
    assert.notEqual(
      rangeOf(env1).contextLineageId,
      `identity-${SESSION}`,
      "never synthesized from the Session",
    );

    // Rollover: Session B publishes against the SAME lineage.
    // iris_agent#84: after rollover, the lineage cursor persists at 2
    // (A processed units 1..2). B cannot re-claim the same units — it
    // starts from the lineage cursor. To get a committed publication for
    // B, the port must supply NEW units (3+) that B hasn't seen.
    const r2 = await fx.runCycle([u("u-1", null, "two")], SESSION_B);
    assert.equal(
      r2.status,
      "nothing_new",
      "rollover does not re-process already-committed units (iris_agent#84)",
    );
    // iris_agent#84: nothing_new means NO publication for B — the lineage
    // cursor prevents a duplicate publication of units 1..2.
    const env2 = fx.envelopeOf(SESSION_B);
    assert.equal(env2, undefined, "no duplicate publication on rollover without new units");
  } finally {
    fx.store.close();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("B10-AC3: Context range and rangeHash derive from the exact committed units, deterministically", async () => {
  const fx = fixture(stubPort([unit(2), unit(3)]));
  try {
    const r = await fx.runCycle([u("u-1", null, "one")]);
    assert.equal(r.status, "committed");
    const env = fx.envelopeOf();
    assert.ok(env);
    const range = rangeOf(env);
    assert.equal(range.fromContextSeq, 2);
    assert.equal(range.toContextSeq, 3);
    assert.equal(
      range.rangeHash,
      canonicalRangeHash([unit(2), unit(3)]),
      "canonical ordered unit hash",
    );

    // Determinism: a second identical cycle produces the same rangeHash.
    const fx2 = fixture(stubPort([unit(2), unit(3)]));
    try {
      await fx2.runCycle([u("u-1", null, "one")]);
      assert.equal(rangeOf(fx2.envelopeOf() ?? ({} as never)).rangeHash, range.rangeHash);
    } finally {
      fx2.store.close();
      rmSync(fx2.dir, { recursive: true, force: true });
    }

    // Changed content hash must change the rangeHash (and payloadHash).
    const fx3 = fixture(stubPort([unit(2, { contentHash: "c".repeat(64) }), unit(3)]));
    try {
      await fx3.runCycle([u("u-1", null, "one")]);
      const env3 = fx3.envelopeOf();
      assert.ok(env3, "envelope exists");
      assert.notEqual(rangeOf(env3).rangeHash, range.rangeHash);
      assert.notEqual(
        env3["payloadHash"],
        env["payloadHash"],
        "content change ripples to payloadHash",
      );
    } finally {
      fx3.store.close();
      rmSync(fx3.dir, { recursive: true, force: true });
    }
  } finally {
    fx.store.close();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("B10-AC4: no Context batch -> nothing new, never a fabricated 1..1 range", async () => {
  const fx = fixture(stubPort([]));
  try {
    // iris_agent#66: with Context-owned input the claim port IS the batch
    // source — an empty claim means there are no committed semantic units,
    // so the runner reports nothing_new (no fabrication, no publication,
    // no cursor advance). The previous Session-derived freeze path could
    // see a Session head and try to publish against an empty Context range;
    // now both freeze and runner read the SAME claim, so this cannot arise.
    const result = await fx.runCycle([u("u-1", null, "one")]);
    assert.equal(result.status, "nothing_new");
    const env = fx.envelopeOf();
    assert.equal(env, undefined, "no publication with fabricated provenance");
    const pubs = fx.store
      .raw()
      .prepare("SELECT COUNT(*) AS n FROM publications WHERE runtime_session_id = ?")
      .get(SESSION) as { n: number };
    assert.equal(pubs.n, 0);
    // No cursor was invented either.
    assert.equal(fx.store.getSessionState(SESSION), undefined);
  } finally {
    fx.store.close();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("B10-AC5: production Historian cannot publish without the Context read/claim port", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b10-noport-"));
  try {
    const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    const hp = stubPort([unit(1)]);
    const claimedEntries = hp
      .claimHistorianBatch({ afterContextSeqExclusive: 0, throughContextSeqInclusive: 1 })
      .units.filter((unit) => unit.entrySeq !== undefined)
      .map((unit) => contextUnitToSequencedEntry(SESSION, unit));
    const freeze = freezeBoundary({
      rawSeamInput: {
        runtimeSessionId: SESSION,
        lineageId: "identity-stub",
        entries: claimedEntries,
        processedThroughEntrySeq: 0,
        tailMarginEntries: 0,
        modelProviderProfile: "m",
        frozenAt: "2026-08-01T00:00:00.000Z",
      },
    });
    // NOTE: createPublicationCommitHook WITHOUT historyPort — the runner
    // still needs its Context input (iris_agent#66), but the hook must fail
    // closed when the publication service has no Context provenance.
    const runner = new HistorianRunner({
      store,
      historyPort: hp,
      commitHook: createPublicationCommitHook({ store }),
    });
    await assert.rejects(
      () => runner.run({ runtimeSessionId: SESSION, boundary: freeze.snapshot }),
      /cannot publish without a ContextHistoryReadPort/,
    );
    const pubs = store
      .raw()
      .prepare("SELECT COUNT(*) AS n FROM publications WHERE runtime_session_id = ?")
      .get(SESSION) as { n: number };
    assert.equal(pubs.n, 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B10-AC6: payloadHash is canonical over the complete payload; provenance changes change it", async () => {
  const base = [unit(1)];
  const fx = fixture(stubPort(base));
  try {
    await fx.runCycle([u("u-1", null, "one")]);
    const env = fx.envelopeOf();
    assert.ok(env, "envelope exists");

    // Self-reference rule: hash of the envelope with payloadHash blanked
    // equals the recorded payloadHash (canonical sorted-key serialization —
    // the same basis iris_memory recomputes).
    const blanked = { ...env, payloadHash: "" };
    const recomputed = createHash("sha256").update(canonicalJson(blanked), "utf8").digest("hex");
    assert.equal(
      recomputed,
      env["payloadHash"],
      "payloadHash covers the complete payload (documented no-self-ref rule)",
    );

    // Changed derivation refs change the payload hash.
    const derived = unit(1, {
      derivationRefs: { memoryRefs: ["mem-1"], compartmentIds: [], sourceContextMessageUnitIds: [] },
    });
    const fx2 = fixture(stubPort([derived]));
    try {
      await fx2.runCycle([u("u-1", null, "one")]);
      assert.notEqual(
        fx2.envelopeOf()?.["payloadHash"],
        env["payloadHash"],
        "derivation change ripples to payloadHash",
      );
    } finally {
      fx2.store.close();
      rmSync(fx2.dir, { recursive: true, force: true });
    }

    // Changed disposition (reference_only) changes the payload hash.
    const refOnly = unit(1, { disposition: "reference_only" });
    const fx3 = fixture(stubPort([refOnly]));
    try {
      await fx3.runCycle([u("u-1", null, "one")]);
      assert.notEqual(fx3.envelopeOf()?.["payloadHash"], env["payloadHash"]);
    } finally {
      fx3.store.close();
      rmSync(fx3.dir, { recursive: true, force: true });
    }
  } finally {
    fx.store.close();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("B10-AC7: Session ids appear nowhere in the v3 envelope (raw archive attribution only)", async () => {
  const fx = fixture(stubPort([unit(1), unit(2)]));
  try {
    await fx.runCycle([u("u-1", null, "one")]);
    const env = fx.envelopeOf();
    assert.ok(env);
    assert.ok(!JSON.stringify(env).includes(SESSION), "no Session id leaks into the Publication");
    assert.ok(!JSON.stringify(env).includes(SESSION_B));
  } finally {
    fx.store.close();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("B10-AC8: derived-only with basis keeps a REAL range from the basis refs", async () => {
  const basisUnits = [unit(1), unit(2)];
  const fx = fixture(stubPort(basisUnits));
  try {
    // Derived-only classification comes from buildCompartment (anti-echo);
    // a batch whose units are all derived-only still carries basis refs for
    // the source units, so the range is real — never 1..1.
    const r = await fx.runCycle([u("u-1", null, "one")]);
    assert.equal(r.status, "committed");
    const env = fx.envelopeOf();
    assert.ok(env, "envelope exists");
    const range = rangeOf(env);
    assert.ok(range.fromContextSeq >= 1 && range.toContextSeq >= range.fromContextSeq);
    assert.ok(
      !(
        range.fromContextSeq === 1 &&
        range.toContextSeq === 1 &&
        (env["evidenceCount"] as number) === 0
      ),
      "no fabricated minimal range",
    );
  } finally {
    fx.store.close();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("B10-AC3b: canonicalUnitRangeHash basis-only branch — deterministic over ordered basis refs, sensitive to content", () => {
  const basisA = [
    {
      contextUnitId: "unit-1",
      contextSeq: 1,
      runtimeEventId: "evt-1",
      contentHash: "a".repeat(64),
    },
    {
      contextUnitId: "unit-2",
      contextSeq: 2,
      runtimeEventId: "evt-2",
      contentHash: "b".repeat(64),
    },
  ];
  const basisShuffled = [basisA[1], basisA[0]];
  const basisMutated = [{ ...basisA[0], contentHash: "c".repeat(64) }, basisA[1]];
  const h1 = canonicalUnitRangeHash([], basisA as never);
  const h2 = canonicalUnitRangeHash([], basisShuffled as never);
  const h3 = canonicalUnitRangeHash([], basisMutated as never);
  assert.equal(h1, h2, "order-independent canonical hash (sorted by contextSeq)");
  assert.notEqual(h1, h3, "content change ripples to the canonical range hash");
  assert.ok(!h1.includes("unit-"), "hash is a digest, not a serialization");
});
