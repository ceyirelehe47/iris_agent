/**
 * R3-P3 移植说明：本文件从已通过审查的
 * `agent/r2-product-parity-fix-r3-historian` 分支（commit 5b94db7）的
 * `test/historian-b5-publication.test.ts` 移植。
 *
 * 适配点（R3-P1 起）：
 *  - `freezeBoundary` 签名由平铺参数改为 `{ rawSeamInput, lineageBoundary? }`
 *    （R3-P1 ContextHistoryReadPort m0-clamp），`runOneCycle` 改为传入
 *    `rawSeamInput`，不传 lineageBoundary（纯 raw 语义，与 R3-P0 一致）；
 *  - 其余导入（buildCompartment / buildAnalysisView / SessionHistoryReadPort /
 *    HistorianStore / PublicationService / HistorianRunner）在 main 上均已存在。
 *
 * R3-P3 新增（相对分支原文件）：
 *  - markFailed 测试补充断言：retry_wait 必须携带未来退避 lease
 *    （R3-P0 oracle 审查标记的 hot-loop 偏差修复验证）；
 *  - 新增 delivery-pump 崩溃窗口测试：claim → 崩溃重开 → lease 过期 →
 *    重新认领 → 交付成功（exactly-once，不丢失已提交 publication）。
 *
 * Feature B5：publication + authoritative outbox 原子事务。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import type { SessionTreeEntry } from "@iris/pi-agent-core";

import type { ContextHistoryReadPort } from "../src/context/history-read-port.js";
import { historianBatchHash } from "../src/contracts/historian.js";

import { freezeBoundary } from "../src/historian/historian-boundary.js";
import { contextUnitToSequencedEntry, HistorianRunner } from "../src/historian/historian-runner.js";
import {
  createPublicationCommitHook,
  PublicationService,
} from "../src/historian/historian-publication.js";
import { HistorianStore } from "../src/historian/historian-store.js";

const SESSION = "iris-runtime-2026-08-01-1";

function u(id: string, parentId: string | null, text = "hello", ts = 1): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: { role: "user", content: text, timestamp: ts },
  } as unknown as SessionTreeEntry;
}

function c(id: string, parentId: string, ts = 2): SessionTreeEntry {
  return {
    type: "custom_message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    customType: "iris_input_meta",
    content: "<iris-input-meta/>",
    display: false,
  } as unknown as SessionTreeEntry;
}

function assistantWithToolCall(
  id: string,
  parentId: string,
  callId: string,
  ts = 3,
): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name: "read_file", arguments: {} }],
      api: "x",
      provider: "m",
      model: "v",
      timestamp: ts,
    },
  } as unknown as SessionTreeEntry;
}

function toolResult(id: string, parentId: string, callId: string, ts = 4): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "read_file",
      content: [{ type: "text", text: "file content: 42 lines" }],
      isError: false,
      timestamp: ts,
    },
  } as unknown as SessionTreeEntry;
}

function storeFixture(): { store: HistorianStore; dir: string; service: PublicationService } {
  const dir = mkdtempSync(join(tmpdir(), "iris-b5-"));
  const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  const service = new PublicationService({ store });
  return { store, dir, service };
}

/** iris_agent#45: publication requires a Context read port (fail closed). */
function stubHistoryPort(texts?: string[]): ContextHistoryReadPort {
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
    listUnitsForHistorian(_lineageId, fromContextSeq, toContextSeq) {
      // iris_agent#76: anti-echo views are keyed by CONTEXT coordinates.
      // One committed unit view per claimed seq.
      const units: import("../src/historian/anti-echo.js").HistorianUnitView[] = [];
      for (let seq = fromContextSeq; seq <= toContextSeq; seq++) {
        units.push({
          contextUnitId: `unit-${seq}`,
          contextSeq: seq,
          runtimeEventId: `evt-${seq}`,
          kind: "user",
          historianDisposition: "include",
          contentHash: "b".repeat(64),
          derivationRefs: { memoryRefs: [], compartmentIds: [], sourceContextMessageUnitIds: [] },
        });
      }
      return units;
    },
    listUnitsWithPayload(_lineageId, fromContextSeq, toContextSeq) {
      const views = this.listUnitsForHistorian(_lineageId, fromContextSeq, toContextSeq);
      return views.map((view) => ({
        ...view,
        payload: { role: "user", content: `content-${view.contextSeq}`, timestamp: 0 },
        payloadTimestamp: new Date().toISOString(),
      }));
    },
    claimHistorianBatch({ afterContextSeqExclusive, throughContextSeqInclusive }) {
      // iris_agent#76: full committed units (payload included), keyed by
      // global contextSeq — the runner's normal semantic input.
      const units: import("../src/contracts/context-v27.js").ContextMessageUnitV1[] = [];
      for (let seq = afterContextSeqExclusive + 1; seq <= throughContextSeqInclusive; seq++) {
        units.push({
          schemaId: "iris.context_message_unit.v1",
          contextUnitId: `unit-${seq}`,
          contextLineageId: "identity-b5",
          contextSeq: seq,
          runtimeEventId: `evt-${seq}`,
          kind: "user",
          semanticSchemaId: "iris.semantic.context_message.user.v1",
          semanticContent: {
            role: "user",
            content: texts?.[seq - 1] ?? `content-${seq}`,
            timestamp: 1,
          },
          historianDisposition: "include",
          contentHash: "b".repeat(64),
          derivationRefs: {
            schemaId: "iris.semantic_derivation_refs.v1",
            memoryRefs: [],
            compartmentIds: [],
            sourceContextMessageUnitIds: [],
          },
          rawArchiveRef: {
            schemaId: "iris.raw_archive_ref.v1" as const,
            runtimeSessionId: SESSION,
            startEntrySeq: seq,
            entryIds: [`entry-${seq}`],
          },
          lifecycleState: "committed",
          createdAt: "2026-08-01T00:00:00.000Z",
        });
      }
      const batch: import("../src/contracts/historian.js").HistorianBatchV1 = {
        schemaVersion: "historian-batch-v1",
        lineageId: "identity-b5",
        afterContextSeqExclusive,
        throughContextSeqInclusive:
          units.length === 0
            ? afterContextSeqExclusive
            : (units[units.length - 1]?.contextSeq ?? afterContextSeqExclusive),
        units,
        batchHash: "",
        frozenAt: new Date().toISOString(),
      };
      batch.batchHash = historianBatchHash(batch);
      return batch;
    },
    lineageId() {
      return "identity-b5";
    },
  };
}

async function runOneCycle(
  store: HistorianStore,
  entries: SessionTreeEntry[],
  processedThroughEntrySeq = 0,
) {
  // iris_agent#66: the freeze head AND the runner input both come from the
  // SAME Context claim path (committed units) — the frozen sourceRangeHash
  // must match what the runner re-reads, or every cycle fails validation.
  // The stub port's claimed window is capped at the fixture's entry count so
  // the freeze head matches the test's notion of "the session so far".
  const historyPort = stubHistoryPort();
  const head = entries.length;
  const claimed = historyPort.claimHistorianBatch({
    afterContextSeqExclusive: 0,
    throughContextSeqInclusive: head,
  }).units;
  const claimedEntries = claimed
    .filter((unit) => unit.rawArchiveRef?.startEntrySeq !== undefined)
    .map((unit) => contextUnitToSequencedEntry(SESSION, unit, unit.rawArchiveRef?.startEntrySeq));
  void entries;
  // R3-P1 适配：freezeBoundary 拆分为 { rawSeamInput, lineageBoundary? }。
  // 不传 lineageBoundary = 纯 raw 语义（与 R3-P0 分支行为一致）。
  const freeze = freezeBoundary({
    rawSeamInput: {
      runtimeSessionId: SESSION,
      lineageId: "identity-stub",
      entries: claimedEntries,
      processedThroughEntrySeq,
      // iris_agent#76: the fixture's Context cursor mirrors the durable
      // entrySeq cursor (entrySeq == contextSeq in these fixtures) — the
      // frozen hash window must start at the SAME anchor the runner's
      // durable contextSeq cursor implies, or second-cycle validation
      // fails with a range-hash mismatch.
      processedThroughContextSeq: processedThroughEntrySeq,
      tailMarginEntries: 0,
      modelProviderProfile: "opencode/deepseek-v4-flash",
      frozenAt: "2026-08-01T00:00:00.000Z",
    },
  });
  const runner = new HistorianRunner({
    store,
    historyPort,
    commitHook: createPublicationCommitHook({ store, historyPort }),
  });
  return runner.run({ runtimeSessionId: SESSION, boundary: freeze.snapshot });
}

test("B5: one atomic transaction commits compartments + publication + outbox + cursor", async () => {
  const { store, dir } = storeFixture();
  try {
    const entries: SessionTreeEntry[] = [
      u("u-1", null, "please read the file"),
      c("c-1", "u-1"),
      assistantWithToolCall("a-1", "c-1", "call-1"),
      toolResult("tr-1", "a-1", "call-1"),
    ];
    const result = await runOneCycle(store, entries);
    assert.equal(result.status, "committed");

    // Compartment 已持久化。
    const compartment = store
      .raw()
      .prepare("SELECT COUNT(*) AS n FROM compartments WHERE runtime_session_id = ?")
      .get(SESSION) as { n: number };
    assert.equal(compartment.n, 1, "one compartment committed");
    // Publication 已持久化且 sequence = 1（MAX+1，绝不预分配）。
    const pub = store
      .raw()
      .prepare(
        "SELECT publication_sequence, publication_id, processing_key, output_hash, state FROM publications WHERE runtime_session_id = ?",
      )
      .get(SESSION) as {
      publication_sequence: number;
      publication_id: string;
      processing_key: string;
      output_hash: string;
      state: string;
    };
    assert.equal(pub.publication_sequence, 1);
    assert.ok(pub.publication_id.startsWith(`publication-${SESSION}-1`));
    assert.ok(pub.processing_key.includes(`${SESSION}:`));
    assert.equal(pub.output_hash.length, 64);
    assert.equal(pub.state, "pending");
    // outbox 行在同一个事务里。
    const outbox = store
      .raw()
      .prepare(
        "SELECT publication_id, payload_hash, state FROM publication_outbox WHERE publication_id = ?",
      )
      .get(pub.publication_id) as { publication_id: string; payload_hash: string; state: string };
    assert.equal(outbox.payload_hash, pub.output_hash, "outbox payload hash matches");
    assert.equal(outbox.state, "pending");
    // cursor 前进到同一个提交点。
    const state = store.getSessionState(SESSION);
    assert.equal(state?.processedThroughEntrySeq, result.commitThroughEntrySeq);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B5: publicationSequence is strictly increasing across publications (MAX+1 in-transaction)", async () => {
  const { store, dir } = storeFixture();
  try {
    const entries1: SessionTreeEntry[] = [u("u-1", null, "first"), c("c-1", "u-1")];
    const r1 = await runOneCycle(store, entries1);
    assert.equal(r1.status, "committed");
    const entries2: SessionTreeEntry[] = [
      u("u-1", null, "first"),
      c("c-1", "u-1"),
      u("u-2", "c-1", "second"),
      c("c-2", "u-2"),
    ];
    const r2 = await runOneCycle(store, entries2, r1.commitThroughEntrySeq);
    assert.equal(r2.status, "committed");
    const rows = store
      .raw()
      .prepare(
        "SELECT publication_sequence FROM publications WHERE runtime_session_id = ? ORDER BY publication_sequence",
      )
      .all(SESSION) as unknown as Array<{ publication_sequence: number }>;
    assert.deepEqual(
      rows.map((row) => row.publication_sequence),
      [1, 2],
      "strictly increasing, no pre-allocation gaps",
    );
    // 第二条 publication 链接到第一条。
    const pub2 = store
      .raw()
      .prepare(
        "SELECT previous_publication_sequence, previous_session_processed_through_entry_seq FROM publications WHERE publication_sequence = 2",
      )
      .get() as {
      previous_publication_sequence: number | null;
      previous_session_processed_through_entry_seq: number;
    };
    assert.equal(pub2.previous_publication_sequence, 1, "previous publication chain");
    assert.equal(
      pub2.previous_session_processed_through_entry_seq,
      r1.commitThroughEntrySeq,
      "previous session cursor chain records the cursor BEFORE this commit",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B5: outbox state machine — claim → delivering → delivered (Router ACK)", async () => {
  const { store, dir, service } = storeFixture();
  try {
    const entries: SessionTreeEntry[] = [u("u-1", null, "hello"), c("c-1", "u-1")];
    const result = await runOneCycle(store, entries);
    assert.equal(result.status, "committed");
    const pubId = (
      store.raw().prepare("SELECT publication_id FROM publications LIMIT 1").get() as {
        publication_id: string;
      }
    ).publication_id;

    const batch = service.claimBatch({ batchSize: 10 });
    assert.equal(batch.length, 1, "one row claimed");
    assert.equal(batch[0]?.publicationId, pubId);
    assert.equal(batch[0]?.state, "delivering", "claimed → delivering");
    assert.ok(batch[0]?.claimLeasedUntil, "lease set");

    // delivering 行在 lease 有效期内不会被再次认领。
    const again = service.claimBatch({ batchSize: 10 });
    assert.equal(again.length, 0, "active lease suppresses re-claim");

    service.markDelivered({
      publicationId: pubId,
      receipt: {
        schemaVersion: "acceptance-receipt-v1",
        status: "accepted",
        receiptId: "receipt-1",
        publicationId: pubId,
        canonicalPayloadHash: "a".repeat(64),
        contractVersion: "0.2.0",
        acceptedAt: "2026-08-01T00:00:00.000Z",
      },
    });
    const outbox = store
      .raw()
      .prepare("SELECT state FROM publication_outbox WHERE publication_id = ?")
      .get(pubId) as { state: string };
    assert.equal(outbox.state, "delivered", "Router ACK → delivered");
    const pub = store
      .raw()
      .prepare("SELECT state, delivered_receipt_hash FROM publications WHERE publication_id = ?")
      .get(pubId) as { state: string; delivered_receipt_hash: string | null };
    assert.equal(pub.state, "delivered");
    assert.equal(
      pub.delivered_receipt_hash,
      "receipt-1",
      "ACK receipt persisted for the audit trail",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B5: expired claim lease is recovered (crashed claim re-claimed)", async () => {
  const { store, dir } = storeFixture();
  // 可控时钟：1ms lease + 推进时钟，避免真实 sleep 的时序抖动。
  let now = 1_000_000;
  const shortLease = new PublicationService({ store, nowMs: () => now, claimLeaseMs: 1 });
  try {
    const entries: SessionTreeEntry[] = [u("u-1", null, "hello"), c("c-1", "u-1")];
    await runOneCycle(store, entries);
    const pubId = (
      store.raw().prepare("SELECT publication_id FROM publications LIMIT 1").get() as {
        publication_id: string;
      }
    ).publication_id;

    // 以极短 lease 认领。
    shortLease.claimBatch({ batchSize: 10 });
    // 时钟未推进：lease 尚未过期。
    assert.equal(shortLease.claimBatch({ batchSize: 10 }).length, 0, "unexpired lease blocks");
    // 推进时钟越过 lease 过期。
    now += 2;
    // 崩溃的认领被恢复。
    const recovered = shortLease.claimBatch({ batchSize: 10 });
    assert.equal(recovered.length, 1, "expired lease → re-claimed");
    assert.equal(recovered[0]?.publicationId, pubId);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B5: markFailed — retry_wait (with backoff lease) → quarantined after max attempts", async () => {
  const { store, dir, service } = storeFixture();
  try {
    const entries: SessionTreeEntry[] = [u("u-1", null, "hello"), c("c-1", "u-1")];
    await runOneCycle(store, entries);
    const pubId = (
      store.raw().prepare("SELECT publication_id FROM publications LIMIT 1").get() as {
        publication_id: string;
      }
    ).publication_id;

    const before = Date.now();
    service.markFailed({ publicationId: pubId, errorCode: "router_unreachable" });
    let outbox = store
      .raw()
      .prepare(
        "SELECT state, attempt_count, claim_leased_until FROM publication_outbox WHERE publication_id = ?",
      )
      .get(pubId) as { state: string; attempt_count: number; claim_leased_until: string | null };
    assert.equal(outbox.state, "retry_wait");
    assert.equal(outbox.attempt_count, 1);
    // R3-P3 修复验证：retry_wait 必须携带未来退避 lease（绝不 NULL），
    // 否则 claimBatch 会立即重新认领 → 热循环。attempt 1 → now + 2^0 秒。
    assert.ok(
      outbox.claim_leased_until !== null &&
        new Date(outbox.claim_leased_until).getTime() > before + 500,
      "retry_wait carries a future backoff lease (no hot loop)",
    );
    // 退避 lease 有效期内不会被重新认领。
    assert.equal(service.claimBatch({ batchSize: 10 }).length, 0, "backoff suppresses re-claim");
    // 耗尽尝试次数 → quarantined。
    for (let index = 0; index < 8; index += 1) {
      service.markFailed({ publicationId: pubId, errorCode: "router_unreachable" });
    }
    outbox = store
      .raw()
      .prepare(
        "SELECT state, attempt_count, claim_leased_until FROM publication_outbox WHERE publication_id = ?",
      )
      .get(pubId) as { state: string; attempt_count: number; claim_leased_until: string | null };
    assert.equal(outbox.state, "quarantined", "max attempts → quarantined");
    // quarantined 行不会被重新认领。
    assert.equal(service.claimBatch({ batchSize: 10 }).length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B5: a publication with recall projections commits assessment deltas in the SAME transaction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b5-assess-"));
  const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  try {
    const entries: SessionTreeEntry[] = [
      u("u-1", null, "the user confirms the deployment plan is correct"),
      c("c-1", "u-1"),
    ];
    // iris_agent#66: freeze head from the SAME Context claim path as the
    // runner (stub port window capped at the fixture entry count). The
    // assessment deltas depend on the REAL user text, so the stub serves
    // the fixture message verbatim.
    const hp = stubHistoryPort(["the user confirms the deployment plan is correct"]);
    const claimedEntries = hp
      .claimHistorianBatch({
        afterContextSeqExclusive: 0,
        throughContextSeqInclusive: entries.length,
      })
      .units.map((unit, i) => contextUnitToSequencedEntry(SESSION, unit, i + 1));
    // R3-P1 适配：freezeBoundary 拆分为 { rawSeamInput }。
    const freeze = freezeBoundary({
      rawSeamInput: {
        runtimeSessionId: SESSION,
        lineageId: "identity-stub",
        entries: claimedEntries,
        processedThroughEntrySeq: 0,
        tailMarginEntries: 0,
        modelProviderProfile: "m",
        frozenAt: "x",
      },
    });
    const runner = new HistorianRunner({
      store,
      historyPort: hp,
      commitHook: createPublicationCommitHook({
        store,
        historyPort: hp,
        recallProjections: [
          {
            invocationId: "inv-1",
            runtimeSessionId: SESSION,
            memoryRefs: ["memory-ref-deployment"],
          },
        ],
      }),
    });
    const result = await runner.run({ runtimeSessionId: SESSION, boundary: freeze.snapshot });
    assert.equal(result.status, "committed");
    // assessment delta 与 publication 原子提交。
    const deltas = store
      .raw()
      .prepare(
        "SELECT assessment_id, relation FROM memory_assessment_deltas WHERE runtime_session_id = ?",
      )
      .all(SESSION) as unknown as Array<{ assessment_id: string; relation: string }>;
    assert.ok(deltas.length >= 1, "assessment delta committed with the publication");
    assert.equal(deltas[0]?.relation, "supports");
    // publication 引用这些 assessment delta ids。
    const pub = store
      .raw()
      .prepare("SELECT assessment_delta_ids_json FROM publications WHERE runtime_session_id = ?")
      .get(SESSION) as { assessment_delta_ids_json: string };
    const ids = JSON.parse(pub.assessment_delta_ids_json) as string[];
    assert.deepEqual(
      ids,
      deltas.map((d) => d.assessment_id),
      "publication chains its assessment deltas",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B5: a publication commit-hook failure rolls back cursor + publication + outbox atomically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b5-fail-"));
  const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  try {
    const entries: SessionTreeEntry[] = [u("u-1", null, "hello"), c("c-1", "u-1")];
    // iris_agent#66: freeze head from the SAME Context claim path as the
    // runner (stub port window capped at the fixture entry count).
    const hp = stubHistoryPort();
    const claimedEntries = hp
      .claimHistorianBatch({
        afterContextSeqExclusive: 0,
        throughContextSeqInclusive: entries.length,
      })
      .units.map((unit, i) => contextUnitToSequencedEntry(SESSION, unit, i + 1));
    // R3-P1 适配：freezeBoundary 拆分为 { rawSeamInput }。
    const freeze = freezeBoundary({
      rawSeamInput: {
        runtimeSessionId: SESSION,
        lineageId: "identity-stub",
        entries: claimedEntries,
        processedThroughEntrySeq: 0,
        tailMarginEntries: 0,
        modelProviderProfile: "m",
        frozenAt: "x",
      },
    });
    // 一个在部分插入后抛错的 hook（模拟 publication 路径内的失败）——
    // 整个事务必须全部回滚（cursor、compartments、publication、outbox）。
    const failingHook = {
      commitSafePrefix: () => {
        throw new Error("model/parse failure (simulated)");
      },
    };
    const runner = new HistorianRunner({
      store,
      historyPort: hp,
      commitHook: failingHook,
    });
    await assert.rejects(
      () => runner.run({ runtimeSessionId: SESSION, boundary: freeze.snapshot }),
      /model\/parse failure/,
    );
    assert.equal(store.getSessionState(SESSION), undefined, "cursor rolled back");
    const compartmentCount = store
      .raw()
      .prepare("SELECT COUNT(*) AS n FROM compartments WHERE runtime_session_id = ?")
      .get(SESSION) as { n: number };
    assert.equal(compartmentCount.n, 0, "no compartments on failure");
    const pubCount = store.raw().prepare("SELECT COUNT(*) AS n FROM publications").get() as {
      n: number;
    };
    assert.equal(pubCount.n, 0, "no publication on failure");
    const outboxCount = store
      .raw()
      .prepare("SELECT COUNT(*) AS n FROM publication_outbox")
      .get() as { n: number };
    assert.equal(outboxCount.n, 0, "no outbox row on failure");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B5: delivery pump crash window — claim survives reopen, lease expiry recovers, exactly-once deliver", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b5-crash-"));
  const dbPath = join(dir, "historian.db");
  const store = HistorianStore.open({ databasePath: dbPath });
  // 可控时钟：lease 比较完全确定（无需真实 sleep）。
  let now = 1_000_000;
  const nowMs = (): number => now;
  try {
    // 提交一个 publication（原子事务落盘）。
    const entries: SessionTreeEntry[] = [u("u-1", null, "hello"), c("c-1", "u-1")];
    const result = await runOneCycle(store, entries);
    assert.equal(result.status, "committed");

    // delivery pump 认领该行（state → delivering，写入 lease = now + 60s）。
    const service = new PublicationService({ store, nowMs, claimLeaseMs: 60_000 });
    const batch = service.claimBatch({ batchSize: 10 });
    assert.equal(batch.length, 1);
    const claimed = batch[0];
    assert.ok(claimed !== undefined, "one row claimed");
    const pubId = claimed.publicationId;
    assert.equal(claimed.claimLeasedUntil, new Date(now + 60_000).toISOString());

    // 崩溃：在 markDelivered 之前直接关闭 DB（模拟 SIGKILL/进程终止）。
    store.close();

    // 重开：已提交事务必须幸存 —— publication、outbox（delivering + lease）、cursor 都在。
    const reopened = HistorianStore.open({ databasePath: dbPath });
    try {
      const pub = reopened
        .raw()
        .prepare("SELECT publication_sequence, state FROM publications WHERE publication_id = ?")
        .get(pubId) as { publication_sequence: number; state: string };
      assert.equal(pub.publication_sequence, 1, "committed publication survives crash");
      // 权威投递状态在 outbox 行：claim 后为 delivering（publications 表
      // 的 state 只在 markDelivered/markFailed 时同步，认领本身不写它）。
      const outbox = reopened
        .raw()
        .prepare(
          "SELECT state, claim_leased_until FROM publication_outbox WHERE publication_id = ?",
        )
        .get(pubId) as { state: string; claim_leased_until: string | null };
      assert.equal(outbox.state, "delivering", "outbox row survives in delivering state");
      assert.equal(
        outbox.claim_leased_until,
        new Date(now + 60_000).toISOString(),
        "lease persisted unchanged",
      );
      assert.equal(
        reopened.getSessionState(SESSION)?.processedThroughEntrySeq,
        result.commitThroughEntrySeq,
        "cursor survived the crash",
      );

      // lease 有效期内不可重复认领。
      const freshService = new PublicationService({ store: reopened, nowMs, claimLeaseMs: 60_000 });
      assert.equal(freshService.claimBatch({ batchSize: 10 }).length, 0, "unexpired lease blocks");

      // 时间推进过 lease 到期 → 崩溃的认领被恢复 → 重新投递成功。
      now += 61_000;
      const recovered = freshService.claimBatch({ batchSize: 10 });
      assert.equal(recovered.length, 1, "expired lease recovered after reopen");
      assert.equal(recovered[0]?.publicationId, pubId);
      freshService.markDelivered({
        publicationId: pubId,
        receipt: {
          schemaVersion: "acceptance-receipt-v1",
          status: "accepted",
          receiptId: "receipt-crash-1",
          publicationId: pubId,
          canonicalPayloadHash: "a".repeat(64),
          contractVersion: "0.2.0",
          acceptedAt: "2026-08-01T00:00:00.000Z",
        },
      });
      const after = reopened
        .raw()
        .prepare("SELECT state, attempt_count FROM publication_outbox WHERE publication_id = ?")
        .get(pubId) as { state: string; attempt_count: number };
      assert.equal(after.state, "delivered");
      assert.equal(after.attempt_count, 0, "delivery never counted as an attempt");
      assert.equal(
        (
          reopened
            .raw()
            .prepare("SELECT delivered_receipt_hash FROM publications WHERE publication_id = ?")
            .get(pubId) as { delivered_receipt_hash: string | null }
        ).delivered_receipt_hash,
        "receipt-crash-1",
        "ACK receipt persisted",
      );
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
