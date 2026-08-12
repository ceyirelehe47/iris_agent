import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { ContextLineageResolutionError, ContextStore } from "../src/context/context-store.js";
import { ContextIngest } from "../src/context/context-ingest.js";
import { RuntimeEventLedger } from "../src/runtime/runtime-event-ledger.js";
import type { PiSeamEvent } from "../src/contracts/runtime-events.js";
import type { ContextMessageUnit } from "../src/contracts/context-units.js";
import { computeContextMessageUnitContentHashV1 } from "../src/contracts/context-v27.js";

/**
 * F4 (iris_agent#9): identity-level Context fail-closed lineage resolution.
 *
 * 4.1 — unknown/stale/wrong-data-root/corrupt session bindings NEVER fall back
 *       to a default lineage on the production write path; typed error; the
 *       reconciliation API is explicit and separate.
 * 4.2 — rollover keeps the SAME lineage; new events continue the global
 *       monotonic contextSeq; m0/m1/LKG/replay state preserved.
 * 4.3 — contextLineageId vs runtimeSessionId are not interchangeable: a unit
 *       carrying a different lineageId than its session binding is rejected.
 */

const SESSION = "iris-runtime-2026-08-05-1";
const LINEAGE = "identity-test";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "iris-f4-"));
}

function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function makeLineageInput(runtimeSessionId: string = SESSION, lineageId: string = LINEAGE) {
  return {
    lineageId,
    runtimeSessionId,
    contextSourceSnapshotId: `src-${runtimeSessionId}`,
    epochId: runtimeSessionId,
    personaSnapshotId: "persona-default-v1",
    declarationVersion: "decl-v1",
    providerProfileId: "mock",
    canonicalSystemPrompt: "IRIS SYSTEM PROMPT V1",
    systemProjectionHash: "sys-hash-1",
    preparedAt: "2026-08-01T00:00:00.000Z",
    materializationId: "mat-1",
    contextSerializerVersion: "iris-context-units-v1",
    carrierSchemaVersion: "1",
  };
}

function makeUnit(
  runtimeSessionId: string,
  contextSeq: number,
  overrides: Partial<ContextMessageUnit> = {},
): ContextMessageUnit {
  const unit: ContextMessageUnit = {
    schemaId: "iris.context_message_unit.v1",
    contextLineageId: LINEAGE,
    contextSeq,
    contextUnitId: `unit-${contextSeq}`,
    runtimeEventId: `event-${contextSeq}`,
    kind: "user",
    semanticSchemaId: "iris.semantic.context_message.user.v1",
    semanticContent: {
      role: "user",
      content: [{ type: "text", text: `msg-${contextSeq}` }],
      timestamp: 1,
    },
    historianDisposition: "include",
    contentHash: "",
    derivationRefs: {
      schemaId: "iris.semantic_derivation_refs.v1",
      memoryRefs: [],
      compartmentIds: [],
      sourceContextMessageUnitIds: [],
    },
    lifecycleState: "committed",
    createdAt: "2026-08-01T12:00:00.000Z",
    ...overrides,
  };
  // Feature A5 (#113): the store verifies content_hash on read against the
  // one versioned canonical basis — hand-built units must carry the real
  // canonical hash of their own durable semantic state.
  const contentHash =
    unit.contentHash !== ""
      ? unit.contentHash
      : computeContextMessageUnitContentHashV1({
          semanticSchemaId: unit.semanticSchemaId,
          kind: unit.kind,
          historianDisposition: unit.historianDisposition,
          derivationRefs: unit.derivationRefs ?? {
            schemaId: "iris.semantic_derivation_refs.v1",
            memoryRefs: [],
            compartmentIds: [],
            sourceContextMessageUnitIds: [],
          },
          semanticContent: unit.semanticContent as ContextMessageUnit["semanticContent"],
        });
  return { ...unit, contentHash };
}

function sampleEvent(overrides: Partial<PiSeamEvent> = {}): PiSeamEvent {
  return {
    type: "message_finalized",
    runtimeSessionId: SESSION,
    piSessionId: SESSION,
    entryId: "entry-1",
    role: "user",
    contentHash: "a".repeat(64),
    occurredAt: "2026-08-05T00:00:00.000Z",
    ...overrides,
  };
}

function userWire(): string {
  return JSON.stringify({ role: "user", content: "hello", timestamp: 1 });
}

// ---- 4.1: fail-closed resolution -----------------------------------------

test("f4.1: unknown session on the write path throws ContextLineageResolutionError (no default fallback)", () => {
  const dir = tempDir();
  const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
  try {
    // No lineage created at all: any write must fail closed, never land in
    // the store's default lineageId.
    assert.throws(
      () => {
        store.insertUnit(makeUnit("unknown-session", 1), { runtimeSessionId: "unknown-session" });
      },
      (error: unknown) => error instanceof ContextLineageResolutionError,
    );
    // Read path is fail-closed too: querying an unknown session must not
    // silently return the default lineage's units.
    assert.throws(
      () => store.listUnits("unknown-session", { disposition: "all" }),
      (error: unknown) => error instanceof ContextLineageResolutionError,
    );
  } finally {
    store.close();
    cleanupDir(dir);
  }
});

test("f4.1: stale session after rollover fails closed (binding moved to new session)", () => {
  const dir = tempDir();
  const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
  try {
    store.createLineage(makeLineageInput(SESSION));
    // Rollover binds the lineage to a new session; the OLD session must no
    // longer resolve (it is archive attribution only, not identity).
    store.bindCurrentSession(LINEAGE, "iris-runtime-2026-08-06-1");
    assert.throws(
      () => {
        store.insertUnit(makeUnit(SESSION, 1), { runtimeSessionId: SESSION });
      },
      (error: unknown) => error instanceof ContextLineageResolutionError,
    );
    // The new session resolves fine.
    store.insertUnit(makeUnit("iris-runtime-2026-08-06-1", 1), {
      runtimeSessionId: "iris-runtime-2026-08-06-1",
    });
    assert.equal(store.listUnits("iris-runtime-2026-08-06-1").length, 1);
  } finally {
    store.close();
    cleanupDir(dir);
  }
});

test("f4.1: wrong data root (foreign session) never writes into this store's lineage", () => {
  const dir = tempDir();
  const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
  try {
    store.createLineage(makeLineageInput(SESSION));
    // A session from another data root has no binding here → fail closed.
    assert.throws(
      () => {
        store.insertUnit(makeUnit("other-data-root-session", 1), {
          runtimeSessionId: "other-data-root-session",
        });
      },
      (error: unknown) => error instanceof ContextLineageResolutionError,
    );
    assert.equal(store.listUnits(SESSION).length, 0);
  } finally {
    store.close();
    cleanupDir(dir);
  }
});

test("f4.1: duplicate current binding is impossible (one lineage per session, one session per lineage)", () => {
  const dir = tempDir();
  const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
  try {
    store.createLineage(makeLineageInput(SESSION));
    // A second lineage cannot claim the same session as current.
    assert.throws(
      () => store.createLineage(makeLineageInput(SESSION, "identity-other")),
      (error: unknown) => error instanceof Error,
    );
  } finally {
    store.close();
    cleanupDir(dir);
  }
});

test("f4.1: database corruption / missing lineage row fails closed, never fabricates a cursor", () => {
  const dir = tempDir();
  const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
  try {
    store.createLineage(makeLineageInput(SESSION));
    // Simulate a corrupted/missing binding by deleting the lineage row
    // (direct DB access, test-only corruption simulation).
    (store as unknown as { db: { exec(sql: string): void } }).db.exec(
      "DELETE FROM context_lineages WHERE context_lineage_id = '" + LINEAGE + "'",
    );
    assert.throws(
      () => {
        store.insertUnit(makeUnit(SESSION, 1), { runtimeSessionId: SESSION });
      },
      (error: unknown) => error instanceof ContextLineageResolutionError,
    );
    assert.throws(
      () => {
        store.maxContextSeq(SESSION);
      },
      (error: unknown) => error instanceof ContextLineageResolutionError,
    );
  } finally {
    store.close();
    cleanupDir(dir);
  }
});

test("f4.1: reconciliation API returns null for unknown sessions (explicit, never silent fallback)", () => {
  const dir = tempDir();
  const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
  try {
    store.createLineage(makeLineageInput(SESSION));
    assert.equal(store.resolveLineageIdOrNull(SESSION), LINEAGE);
    assert.equal(store.resolveLineageIdOrNull("no-such-session"), null);
  } finally {
    store.close();
    cleanupDir(dir);
  }
});

test("f4.1: restart reconciliation — replaying the ledger for a bound session is exactly-once", () => {
  const dir = tempDir();
  try {
    const ledger = RuntimeEventLedger.open(join(dir, "runtime-ledger.db"));
    const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
    store.createLineage(makeLineageInput(SESSION));
    const ingest = new ContextIngest(ledger, store, store.lineageId);
    for (let i = 1; i <= 3; i += 1) {
      ledger.ingest(sampleEvent({ entryId: `e-${i}`, payload: userWire() }));
    }
    assert.equal(ingest.ensureUnitsUpTo(SESSION).length, 3);
    // Restart: fresh store + fresh ingest over the SAME ledger.
    store.close();
    ledger.close();

    const ledger2 = RuntimeEventLedger.open(join(dir, "runtime-ledger.db"));
    const store2 = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
    const ingest2 = new ContextIngest(ledger2, store2, store2.lineageId);
    // Exactly-once: re-ingesting the same committed events creates NO new
    // units (the ledger view still shows all 3; the row count stays 3).
    assert.equal(ingest2.ensureUnitsUpTo(SESSION).length, 3, "ledger view is unchanged");
    assert.equal(
      store2.listUnits(SESSION, { disposition: "all" }).length,
      3,
      "no duplicate rows after restart",
    );
    store2.close();
    ledger2.close();
  } finally {
    cleanupDir(dir);
  }
});

// ---- 4.2: rollover continues the same lineage ----------------------------

test("f4.2: rollover — new session continues global monotonic contextSeq on the same lineage", () => {
  const dir = tempDir();
  try {
    const ledgerA = RuntimeEventLedger.open(join(dir, "runtime-ledger.db"));
    const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
    store.createLineage(makeLineageInput(SESSION));
    const ingestA = new ContextIngest(ledgerA, store, store.lineageId);

    // Session A ingests 2 events.
    for (let i = 1; i <= 2; i += 1) {
      ledgerA.ingest(sampleEvent({ entryId: `e-a${i}`, payload: userWire() }));
    }
    assert.deepEqual(
      ingestA.ensureUnitsUpTo(SESSION).map((u) => u.contextSeq),
      [1, 2],
    );

    // Rollover: bind the SAME lineage to session B (new runtime session).
    const sessionB = "iris-runtime-2026-08-06-1";
    store.bindCurrentSession(LINEAGE, sessionB);
    const ledgerB = RuntimeEventLedger.open(join(dir, "runtime-ledger-b.db"));
    const ingestB = new ContextIngest(ledgerB, store, store.lineageId);
    for (let i = 1; i <= 2; i += 1) {
      ledgerB.ingest(
        sampleEvent({
          runtimeSessionId: sessionB,
          piSessionId: sessionB,
          entryId: `e-b${i}`,
          payload: userWire(),
        }),
      );
    }
    const unitsB = ingestB.ensureUnitsUpTo(sessionB);
    // Same lineage, contextSeq continues AFTER session A's max (no reset).
    // The lineage view spans both sessions, so all four units are visible;
    // the two NEW ones carry seq 3,4 (continuing, never reset to 1).
    assert.deepEqual(
      unitsB.map((u) => u.contextSeq),
      [1, 2, 3, 4],
    );
    // All units live under ONE lineage row.
    const lineage = store.getLineageByLineageId(LINEAGE);
    assert.ok(lineage !== undefined);
    assert.equal(lineage.currentRuntimeSessionId, sessionB);
    assert.equal(store.listUnits(sessionB).length, 4, "lineage view spans both sessions");
  } finally {
    cleanupDir(dir);
  }
});

// ---- 4.3: type separation ------------------------------------------------

test("f4.3: a unit whose lineageId disagrees with its session binding is rejected", () => {
  const dir = tempDir();
  const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
  try {
    store.createLineage(makeLineageInput(SESSION));
    // The session binds to LINEAGE; a unit claiming a DIFFERENT lineageId
    // must not slip in under the session's binding.
    assert.throws(
      () => {
        store.insertUnit(makeUnit(SESSION, 1, { contextLineageId: "identity-other" }), {
          runtimeSessionId: SESSION,
        });
      },
      (error: unknown) => error instanceof ContextLineageResolutionError,
    );
    // The valid unit still works.
    store.insertUnit(makeUnit(SESSION, 1), { runtimeSessionId: SESSION });
    assert.equal(store.listUnits(SESSION).length, 1);
  } finally {
    store.close();
    cleanupDir(dir);
  }
});
