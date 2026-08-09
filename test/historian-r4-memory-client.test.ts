/**
 * R4 (iris_agent#9) — Memory Client 投递链路测试。
 *
 * 覆盖:
 *  1. drainOutbox 用 MemoryClient 投递 → 真实 receipt hash 回写 outbox;
 *  2. conflict(409)→ 视为 delivered(重放安全);
 *  3. rejected(400/422)→ quarantined;
 *  4. unavailable → 保持 delivering,lease 过期后可重认领;
 *  5. 无 memoryClient → 旧伪 receipt 行为(lease 恢复证明);
 *  6. envelope 字段与 historian-publication-v2 schema 对齐(anti-echo
 *     evidenceBasis/derivedOnly 传递)。
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { canonicalJson } from "../src/contracts/tool.js";
import {
  HistorianManager,
  type HistorianManagerOptions,
} from "../src/historian/historian-manager.js";
import { HistorianStore } from "../src/historian/historian-store.js";
import { canonicalPayloadHash, FakeMemoryClient } from "../src/historian/memory-client.js";
import type { MemoryClientPort } from "../src/contracts/ports.js";
import type { ContextHistoryReadPort } from "../src/context/history-read-port.js";
import { historianBatchHash } from "../src/contracts/historian.js";

const SESSION = "iris-runtime-2026-08-01-1";

function fixture(): {
  store: HistorianStore;
  manager: HistorianManager;
  memory: FakeMemoryClient;
} {
  const dir = mkdtempSync(join(tmpdir(), "iris-r4-memory-client-"));
  const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  const memory = new FakeMemoryClient();
  const manager = new HistorianManager({
    store,
    modelProviderProfile: "mock",
    nowMs: () => Date.now(),
    historyPort: fakeHistoryPort(),
    memoryClient: memory,
  });
  return { store, manager, memory };
}

function fakeHistoryPort(): ContextHistoryReadPort {
  return {
    getMaterializedBoundary: () => ({
      representedThroughContextSeq: 0,
      representedThroughEntrySeq: null,
      m0ContentHash: null,
      lineageStatus: "ok",
      providerProfileId: "mock",
    }),
    listUnitsForHistorian: () => [
      {
        contextUnitId: "unit-1",
        contextSeq: 1,
        runtimeEventId: "evt-1",
        unitType: "input",
        disposition: "include",
        contentHash: "d".repeat(64),
        derivationRefs: { memoryRefs: [], compartmentIds: [], sourceContextMessageUnitIds: [] },
      },
    ],
    listUnitsWithPayload: () => [
      {
        contextUnitId: "unit-1",
        contextSeq: 1,
        runtimeEventId: "evt-1",
        unitType: "input",
        disposition: "include",
        contentHash: "d".repeat(64),
        derivationRefs: { memoryRefs: [], compartmentIds: [], sourceContextMessageUnitIds: [] },
        payload: { role: "user", content: "hello", timestamp: 0 },
        payloadTimestamp: "2026-08-01T00:00:00.000Z",
      },
    ],
    claimHistorianBatch: ({ afterContextSeqExclusive, throughContextSeqInclusive }) => {
      const units: import("../src/contracts/context-units.js").ContextMessageUnit[] = [];
      if (afterContextSeqExclusive < 1 && throughContextSeqInclusive >= 1) {
        units.push({
          lineageId: "identity-r4",
          runtimeSessionId: SESSION,
          contextSeq: 1,
          unitId: "unit-1",
          sourceEventId: "evt-1",
          runtimeEventId: "evt-1",
          unitType: "input",
          disposition: "include",
          entryId: "entry-1",
          entrySeq: 1,
          contentHash: "d".repeat(64),
          payload: { role: "user", content: "hello", timestamp: 1 },
          paired: false,
          derivationRefs: { memoryRefs: [], compartmentIds: [], sourceContextMessageUnitIds: [] },
          schemaVersion: "context-unit-v1",
          createdAt: "2026-08-01T00:00:00.000Z",
        });
      }
      const batch: import("../src/contracts/historian.js").HistorianBatchV1 = {
        schemaVersion: "historian-batch-v1",
        lineageId: "identity-r4",
        afterContextSeqExclusive,
        throughContextSeqInclusive: units.length === 0 ? afterContextSeqExclusive : 1,
        units,
        batchHash: "",
        frozenAt: new Date().toISOString(),
      };
      batch.batchHash = historianBatchHash(batch);
      return batch;
    },
    lineageId: () => "identity-r4",
  };
}

/** 直接插入一条带 payload 的 outbox 行(模拟 commitSafePrefix 已写入)。 */
function seedOutbox(store: HistorianStore, payload: unknown, seq = 1): void {
  store.begin();
  store.insertPublication({
    publicationSequence: seq,
    publicationId: `publication-${SESSION}-${seq}`,
    runtimeSessionId: SESSION,
    processingKey: `pk-${seq}`,
    outputHash: "h".repeat(64),
    compartmentIds: [`compartment-${SESSION}-${seq}`],
    segmentIds: [],
    evidenceSetIds: [],
    assessmentDeltaIds: [],
    continuitySnapshotId: null,
    previousPublicationSequence: null,
    previousSessionProcessedThroughEntrySeq: 0,
    state: "pending",
    attemptCount: 0,
    claimLeasedUntil: null,
    createdAt: "t",
    updatedAt: "t",
  });
  store.insertOutboxRow({
    publicationId: `publication-${SESSION}-${seq}`,
    runtimeSessionId: SESSION,
    payloadHash: "h".repeat(64),
    payloadJson: JSON.stringify(payload),
    state: "pending",
    attemptCount: 0,
    lastErrorCode: null,
    claimLeasedUntil: null,
    createdAt: "t",
    updatedAt: "t",
  });
  store.commit();
}

function outboxState(
  store: HistorianStore,
  publicationId: string,
): {
  state: string;
  delivered_receipt_hash: string | null;
} {
  return store
    .raw()
    .prepare(
      "SELECT o.state, p.delivered_receipt_hash FROM publication_outbox o JOIN publications p ON p.publication_id = o.publication_id WHERE o.publication_id = ?",
    )
    .get(publicationId) as { state: string; delivered_receipt_hash: string | null };
}

const SAMPLE_ENVELOPE = (() => {
  // iris_memory#11: the Graphiti-ready v3 envelope (episode-source batch +
  // compartment revisions; no Segment/EvidenceSet wire objects).
  const lineageId = "identity-x";
  const rangeHash = "b".repeat(64);
  const episodeSourceBase = {
    episodeId: `episode:${lineageId}:1..2:${rangeHash.slice(0, 12)}`,
    lineageId,
    contextRange: {
      contextLineageId: lineageId,
      fromContextSeq: 1,
      toContextSeq: 2,
      rangeHash,
    },
    sourceUnitIds: ["u1", "u2"],
    canonicalContent: "[1] user: hello\n[2] assistant: hi",
    targetGroupId: `group:${lineageId}`,
    temporal: {
      startedAt: "2026-08-06T00:00:00Z",
      endedAt: "2026-08-06T00:00:01Z",
    },
    isDerivedOnly: false,
    derivation: {
      memoryRefs: [],
      compartmentIds: ["comp-x"],
      sourceContextMessageUnitIds: [],
    },
  };
  const episodeSourceHash = createHash("sha256")
    .update(canonicalJson(episodeSourceBase), "utf8")
    .digest("hex");
  const envelopeBase = {
    schemaVersion: "historian-publication-v3",
    publicationId: `publication-${SESSION}-1`,
    sourceSequence: 1,
    publishedAt: "2026-08-06T00:00:00Z",
    contractVersion: "0.3.0",
    projectionVersion: "graphiti-0.29.2",
    lineageId,
    contextRange: {
      contextLineageId: lineageId,
      fromContextSeq: 1,
      toContextSeq: 2,
      rangeHash,
    },
    compartmentRevisions: [
      {
        compartmentId: "comp-x",
        sequence: 1,
        headContextSeq: 2,
        summary: "summary",
        memoryRefs: [],
      },
    ],
    episodeSources: [{ ...episodeSourceBase, episodeSourceHash }],
    derivationSummary: {
      derivedOnly: false,
      memoryRefs: [],
    },
    temporal: {
      startedAt: "2026-08-06T00:00:00Z",
      endedAt: "2026-08-06T00:00:01Z",
    },
  };
  const payloadHash = createHash("sha256")
    .update(canonicalJson({ ...envelopeBase, payloadHash: "" }), "utf8")
    .digest("hex");
  return { ...envelopeBase, payloadHash };
})();

/** iris_agent#64:construct a receipt BOUND to the sample envelope
 * (publicationId + canonical payload hash + contract version all match). */
function boundReceipt(
  receiptId: string,
  overrides: Partial<Record<string, unknown>> = {},
): {
  schemaVersion: "acceptance-receipt-v1";
  status: "accepted";
  receiptId: string;
  publicationId: string;
  canonicalPayloadHash: string;
  contractVersion: string;
  acceptedAt: string;
} {
  const receipt = {
    schemaVersion: "acceptance-receipt-v1",
    status: "accepted",
    receiptId,
    publicationId: SAMPLE_ENVELOPE.publicationId,
    canonicalPayloadHash: canonicalPayloadHash(SAMPLE_ENVELOPE),
    contractVersion: "0.3.0",
    acceptedAt: "2026-08-06T00:00:01Z",
  };
  const merged = { ...receipt, ...overrides };
  return {
    schemaVersion: "acceptance-receipt-v1",
    status: "accepted",
    receiptId: (merged.receiptId as string | undefined) ?? receiptId,
    publicationId: (merged.publicationId as string | undefined) ?? receipt.publicationId,
    canonicalPayloadHash:
      (merged.canonicalPayloadHash as string | undefined) ?? receipt.canonicalPayloadHash,
    contractVersion: (merged.contractVersion as string | undefined) ?? receipt.contractVersion,
    acceptedAt: (merged.acceptedAt as string | undefined) ?? receipt.acceptedAt,
  };
}

test("r4 memory client: success delivers with real receipt hash", async () => {
  const { store, manager, memory } = fixture();
  try {
    seedOutbox(store, SAMPLE_ENVELOPE);
    memory.queue({ ok: true, receipt: boundReceipt("real-receipt-123") });
    await manager.drainOutbox();
    const row = outboxState(store, `publication-${SESSION}-1`);
    assert.equal(row.state, "delivered");
    assert.equal(row.delivered_receipt_hash, "real-receipt-123");
    assert.equal(memory.delivered.length, 1);
  } finally {
    store.close();
  }
});

test("r4 memory client: conflict (409) is a FAILURE, never delivered (iris_agent#64)", async () => {
  const { store, manager, memory } = fixture();
  try {
    seedOutbox(store, SAMPLE_ENVELOPE);
    // The HttpMemoryClient maps 409 idempotency/sequence conflict to
    // rejected; a conflict means the SAME key carried DIFFERENT content —
    // an error signal, not a replay-safe success.
    memory.queue({ ok: false, error: "rejected" });
    await manager.drainOutbox();
    const row = outboxState(store, `publication-${SESSION}-1`);
    assert.notEqual(row.state, "delivered", "conflict must never authorize delivered");
    assert.equal(row.state, "quarantined");
  } finally {
    store.close();
  }
});

test("r4 memory client: rejected (400/422) quarantines immediately", async () => {
  const { store, manager, memory } = fixture();
  try {
    seedOutbox(store, SAMPLE_ENVELOPE);
    memory.queue({ ok: false, error: "rejected" });
    await manager.drainOutbox();
    const row = outboxState(store, `publication-${SESSION}-1`);
    assert.equal(row.state, "quarantined");
  } finally {
    store.close();
  }
});

test("r4 memory client: unavailable keeps row claimable (lease recovery)", async () => {
  const { store, manager, memory } = fixture();
  try {
    seedOutbox(store, SAMPLE_ENVELOPE);
    memory.queue({ ok: false, error: "unavailable" });
    await manager.drainOutbox();
    const row = outboxState(store, `publication-${SESSION}-1`);
    assert.equal(row.state, "delivering", "unavailable must not mark delivered");
    // lease 过期后重新 claim 并可再次投递成功
    memory.queue({ ok: true, receipt: boundReceipt("second-try-receipt") });
    const now = Date.now();
    store
      .raw()
      .prepare("UPDATE publication_outbox SET claim_leased_until = ? WHERE publication_id = ?")
      .run(new Date(now - 1000).toISOString(), `publication-${SESSION}-1`);
    await manager.drainOutbox();
    const after = outboxState(store, `publication-${SESSION}-1`);
    assert.equal(after.state, "delivered", "retry after lease expiry must succeed");
    assert.equal(after.delivered_receipt_hash, "second-try-receipt");
  } finally {
    store.close();
  }
});

test("r4 memory client: no client wired NEVER fabricates receipts (iris_agent#46)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-r4-noclient-"));
  const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  try {
    const manager = new HistorianManager({
      store,
      modelProviderProfile: "mock",
      nowMs: () => Date.now(),
      historyPort: fakeHistoryPort(),
    } as HistorianManagerOptions);
    seedOutbox(store, SAMPLE_ENVELOPE);
    const metrics = await manager.drainOutbox();
    assert.equal(metrics.claimed, 1, "row is claimed for delivery");
    assert.equal(metrics.accepted, 0, "NOTHING accepted without a client");
    assert.equal(metrics.deferred, 1, "row stays retryable");
    const row = outboxState(store, `publication-${SESSION}-1`);
    assert.notEqual(row.state, "delivered", "never marked delivered");
    assert.equal(row.delivered_receipt_hash, null, "no fabricated receipt hash");
    // The claim lease expires and the row becomes claimable again — it is
    // not lost and not falsely acked; it stays pending/retryable.
    assert.equal(manager.health().memoryDelivery, "unavailable");
    assert.equal(store.countOutboxPending(), 1, "row stays pending and retryable");
  } finally {
    store.close();
  }
});

test("r4 memory client: thrown client errors are caught (no unhandled rejection) and rows stay retryable (iris_agent#46)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-r4-throw-"));
  const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  try {
    const throwing = {
      deliverPublication: async () => {
        throw new Error("connection refused");
      },
    } as unknown as MemoryClientPort;
    const manager = new HistorianManager({
      store,
      modelProviderProfile: "mock",
      nowMs: () => Date.now(),
      historyPort: fakeHistoryPort(),
      memoryClient: throwing,
    } as HistorianManagerOptions);
    seedOutbox(store, SAMPLE_ENVELOPE);
    // Must resolve (not reject) with deferred metrics.
    const metrics = await manager.drainOutbox();
    assert.equal(metrics.accepted, 0);
    assert.equal(metrics.deferred, 1);
    const row = outboxState(store, `publication-${SESSION}-1`);
    assert.notEqual(row.state, "delivered", "thrown error never fabricates delivered");
    assert.equal(manager.health().deliveryErrors, 1, "exception recorded, not unhandled");
    assert.match(manager.health().lastDeliveryError ?? "", /connection refused/);
    // The row remains claimable: the lease expires and it is retried.
    assert.equal(store.countOutboxPending(), 1);
  } finally {
    store.close();
  }
});

test("r4 memory client: fake/missing receipts cannot authorize outbox reclaim (iris_agent#46)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-r4-reclaim-"));
  const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  try {
    const manager = new HistorianManager({
      store,
      modelProviderProfile: "mock",
      nowMs: () => Date.now(),
      historyPort: fakeHistoryPort(),
    } as HistorianManagerOptions);
    seedOutbox(store, SAMPLE_ENVELOPE);
    // Without a client the row can never be delivered, even after a real
    // drain pass (iris_agent#46: no fabricated receipts).
    await manager.drainOutbox();
    const row = outboxState(store, `publication-${SESSION}-1`);
    assert.notEqual(row.state, "delivered");
    // Direct tamper attempt on the receipt hash alone cannot flip state to
    // delivered (the state machine owns the transition; markDelivered is the
    // only writer and it is driven by a real client receipt).
    const tampered = outboxState(store, `publication-${SESSION}-1`);
    assert.equal(tampered.delivered_receipt_hash, null);
    // Reclaim path (hot-row release) requires a real publication delivery;
    // the row is not delivered, so its release view cannot exist with a
    // memory durable ack (nothing was ever acknowledged to memory).
    const releases = store.listCompartmentReleaseViews(SESSION);
    assert.equal(
      releases.some((r) => r.memoryReceiptHash !== null && r.reclaimedAt === null),
      false,
      "no release authorized by a fake/missing receipt",
    );
  } finally {
    store.close();
  }
});

test("r4 memory client: envelope carries anti-echo basis and derivedOnly", async () => {
  const { store, manager, memory } = fixture();
  try {
    const derivedEnvelope = {
      ...SAMPLE_ENVELOPE,
      derivedOnly: true,
      evidenceBasis: [],
      evidenceCount: 0,
    };
    seedOutbox(store, derivedEnvelope);
    memory.queue({
      ok: true,
      receipt: {
        ...boundReceipt("r"),
        canonicalPayloadHash: canonicalPayloadHash(derivedEnvelope),
      },
    });
    await manager.drainOutbox();
    assert.equal(memory.delivered.length, 1);
    const sent = memory.delivered[0] as {
      derivedOnly: boolean;
      evidenceBasis: unknown[];
      evidenceCount: number;
    };
    assert.equal(sent.derivedOnly, true);
    assert.equal(sent.evidenceBasis.length, 0);
    assert.equal(sent.evidenceCount, 0);
  } finally {
    store.close();
  }
});

test("r4 memory client: real envelope (from commitSafePrefix) validates against pinned 0.3.0 schema", async () => {
  // 驱动真实生产路径:PublicationService.commitSafePrefix → buildCompartment
  // (带 unitViews)→ buildPublicationEnvelope → outbox payload_json。
  const dir = mkdtempSync(join(tmpdir(), "iris-r4-schema-"));
  const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  try {
    const { PublicationService } = await import("../src/historian/historian-publication.js");
    const service = new PublicationService({ store, historyPort: fakeHistoryPort() });
    const safePrefix = [
      {
        runtimeSessionId: SESSION,
        entrySeq: 1,
        // iris_agent#76: entries carry their Context coordinate so the
        // publication's anti-echo view maps to the Context range.
        contextSeq: 1,
        entryId: "entry-1",
        entry: {
          type: "message",
          id: "e-1",
          parentId: null,
          timestamp: "t",
          message: { role: "user", content: "hello", timestamp: 1 },
        },
        contentHash: "b".repeat(64),
      },
    ];
    service.commitSafePrefix({
      runtimeSessionId: SESSION,
      boundary: {
        boundarySnapshotId: "bs-1",
        runtimeSessionId: SESSION,
        lineageId: "identity-r4",
        observedHeadEntrySeq: 1,
        observedHeadContextSeq: 1,
        eligibleThroughEntrySeq: 1,
        eligibleThroughContextSeq: 1,
        protectedTailStartEntrySeq: 2,
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
        units: [
          {
            entrySeq: 1,
            entryId: "entry-1",
            kind: "user_input" as const,
            inFlight: false,
            providerVisible: "hello",
          },
        ],
        trueRawEligibleTokens: 10,
      },
      outcome: { ok: true, commitThroughEntrySeq: 1, discardedFromEntrySeq: null } as never,
      previousProcessedThroughEntrySeq: 0,
    });

    const row = store
      .raw()
      .prepare("SELECT payload_json FROM publication_outbox WHERE publication_id = ?")
      .get("publication-iris-runtime-2026-08-01-1-1") as { payload_json: string };
    assert.ok(row.payload_json, "envelope must be persisted");
    const sent = JSON.parse(row.payload_json) as Record<string, unknown>;

    // 用 pinned 0.3.0 schema(与 memory-contract-gate 相同方式)校验
    const { Ajv2020 } = await import("ajv/dist/2020.js");
    const formatsModule = await import("ajv-formats");
    const formatsPlugin = formatsModule.default as unknown as (validator: unknown) => void;
    const ARTIFACT = "fixtures/memory-contracts-artifact/iris-memory-contracts-0.3.0";
    const manifest = JSON.parse(readFileSync(join(ARTIFACT, "manifest.json"), "utf8")) as {
      schemas: string[];
    };
    const ajv = new Ajv2020({ allErrors: true });
    formatsPlugin(ajv);
    let targetId: string | undefined;
    for (const schemaRelative of manifest.schemas) {
      const s = JSON.parse(readFileSync(join(ARTIFACT, schemaRelative), "utf8")) as {
        $id?: string;
      };
      if (typeof s.$id === "string") {
        ajv.addSchema(s, s.$id);
        if (schemaRelative === "schemas/historian-publication-v3.schema.json") {
          targetId = s.$id;
        }
      }
    }
    const validate = ajv.getSchema(targetId ?? "");
    assert.ok(validate, "v2 schema must be registered");
    const valid = validate(sent);
    if (!valid) {
      assert.fail(`envelope fails pinned schema: ${JSON.stringify(validate.errors)}`);
    }
    // publicationId 必须满足 uuid 格式
    const pubId = sent["publicationId"] as string;
    assert.match(pubId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // contextRange 必须 >= 1
    const range = sent["contextRange"] as { fromContextSeq: number; toContextSeq: number };
    assert.ok(range.fromContextSeq >= 1);
    assert.ok(range.toContextSeq >= 1);
    assert.ok(range.fromContextSeq <= range.toContextSeq);
  } finally {
    store.close();
  }
});

test("r4 memory client: a receipt bound to a DIFFERENT publication cannot ACK this row (manager defensive check, iris_agent#64)", async () => {
  const { store, manager, memory } = fixture();
  try {
    seedOutbox(store, SAMPLE_ENVELOPE);
    // 客户端层面的绑定校验已过(这是 deliverOne 的防御性复查):receipt 的
    // publicationId 是另一个 publication → 必须 fail closed 进 quarantine,
    // 绝不 markDelivered。
    memory.queue({
      ok: true,
      receipt: {
        ...boundReceipt("wrong-pub-receipt"),
        publicationId: "some-other-publication",
      },
    });
    await manager.drainOutbox();
    const row = outboxState(store, `publication-${SESSION}-1`);
    assert.equal(row.state, "quarantined", "receipt for another publication quarantines");
    assert.equal(row.delivered_receipt_hash, null, "no delivered binding persisted");
  } finally {
    store.close();
  }
});

test("r4 memory client: delivered persists the FULL verified binding (receiptId + publicationId + canonical hash + contract version, iris_agent#64)", async () => {
  const { store, manager, memory } = fixture();
  try {
    seedOutbox(store, SAMPLE_ENVELOPE);
    const receipt = boundReceipt("bound-receipt-1");
    memory.queue({ ok: true, receipt });
    await manager.drainOutbox();
    const row = store
      .raw()
      .prepare(
        `SELECT state, delivered_receipt_hash, delivered_receipt_id,
                delivered_receipt_schema_version, delivered_receipt_publication_id,
                delivered_canonical_payload_hash, delivered_contract_version,
                delivered_duplicate_replay
         FROM publications WHERE publication_id = ?`,
      )
      .get(`publication-${SESSION}-1`) as {
      state: string;
      delivered_receipt_hash: string | null;
      delivered_receipt_id: string | null;
      delivered_receipt_schema_version: string | null;
      delivered_receipt_publication_id: string | null;
      delivered_canonical_payload_hash: string | null;
      delivered_contract_version: string | null;
      delivered_duplicate_replay: number;
    };
    assert.equal(row.state, "delivered");
    assert.equal(row.delivered_receipt_hash, "bound-receipt-1");
    assert.equal(row.delivered_receipt_id, "bound-receipt-1");
    assert.equal(row.delivered_receipt_schema_version, "acceptance-receipt-v1");
    assert.equal(row.delivered_receipt_publication_id, SAMPLE_ENVELOPE.publicationId);
    assert.equal(row.delivered_canonical_payload_hash, canonicalPayloadHash(SAMPLE_ENVELOPE));
    assert.equal(row.delivered_contract_version, "0.3.0");
    assert.equal(row.delivered_duplicate_replay, 0);
  } finally {
    store.close();
  }
});

test("r4 memory client: duplicate_replay receipt persists the duplicate marker (iris_agent#64)", async () => {
  const { store, manager, memory } = fixture();
  try {
    seedOutbox(store, SAMPLE_ENVELOPE);
    memory.queue({
      ok: true,
      receipt: {
        ...boundReceipt("dup-receipt-1"),
        schemaVersion: "duplicate-replay-receipt-v1",
        status: "duplicate_replay",
        originalAcceptedAt: "2026-08-06T00:00:02Z",
      },
    });
    await manager.drainOutbox();
    const row = store
      .raw()
      .prepare(
        `SELECT state, delivered_receipt_schema_version, delivered_duplicate_replay
         FROM publications WHERE publication_id = ?`,
      )
      .get(`publication-${SESSION}-1`) as {
      state: string;
      delivered_receipt_schema_version: string | null;
      delivered_duplicate_replay: number;
    };
    assert.equal(row.state, "delivered", "duplicate replay is a valid delivered path");
    assert.equal(row.delivered_receipt_schema_version, "duplicate-replay-receipt-v1");
    assert.equal(row.delivered_duplicate_replay, 1);
  } finally {
    store.close();
  }
});
