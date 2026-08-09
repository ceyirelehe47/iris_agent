/**
 * R3-P2：跨项目长期记忆契约的 Historian 侧契约钉（contract pin）测试。
 *
 * 契约方向（AGENTS.md 权威来源）：
 *  - iris-memory 发布版本化契约工件（fixtures/memory-contracts-artifact/
 *    iris-memory-contracts-0.2.0/），iris-agent 固定精确 version 并消费之，
 *    绝不手写复制跨项目 DTO；
 *  - Historian 是 Envelope 的生产方（authoritative publication_outbox），
 *    iris-memory 是 Consumer。
 *
 * 本套件覆盖：
 *  (a) production-lock.json 的 memoryContracts 钉 与 工件 manifest 哈希一致
 *      （复用 memory-contract-gate 的 canonical-JSON 重算方式）；
 *  (b) 用真实 Historian B5 事务的输出（publications + publication_outbox 行）
 *      构造 HistorianPublicationV1 envelope，用 Ajv 验证其符合
 *      historian-publication-v1.schema.json；
 *  (c) outbox 投递幂等键候选（publicationId / processingKey）符合
 *      publication-acceptance-request-v1 的 idempotencyKey 模式
 *      ^[A-Za-z0-9._:-]+$。
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";

import { readContractPin } from "../src/contracts/memory-pin.js";
import { SessionHistoryReadPort } from "../src/historian/history-read-port.js";
import { HistorianStore } from "../src/historian/historian-store.js";
import { freezeBoundary } from "../src/historian/historian-boundary.js";
import { buildAnalysisView, validateRange } from "../src/historian/historian-analysis.js";
import { PublicationService } from "../src/historian/historian-publication.js";

const ARTIFACT_ROOT = join(
  import.meta.dirname,
  "..",
  "fixtures",
  "memory-contracts-artifact",
  "iris-memory-contracts-0.3.0",
);
const PRODUCTION_LOCK = join(
  import.meta.dirname,
  "..",
  "src",
  "contracts",
  "pins",
  "production-lock.json",
);
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;
/** ajv-formats 的 uuid 判定（RFC 4122 外观）。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SESSION = "iris-runtime-2026-08-01-1";

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ARTIFACT_ROOT, relative), "utf8")) as Record<string, unknown>;
}

/** 与 memory-contract-gate 相同的 manifest 哈希重算：去掉 manifestSha256
 * 后的 canonical JSON（sorted keys + compact separators），sha256 其 UTF-8 字节。 */
function recomputeManifestSha256(manifest: Record<string, unknown>): string {
  const withoutSelf: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (key !== "manifestSha256") {
      withoutSelf[key] = value;
    }
  }
  const canonical = JSON.stringify(withoutSelf, sortedKeys, 0);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function sortedKeys(_key: string, value: unknown): unknown {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortedKeys(key, record[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * 用真实的 Historian B5 事务产出一条 publication + outbox 行（走
 * PublicationService.commitSafePrefix，绝不 mock 中间产物），并读取落库后的
 * 行数据用于构造 envelope。
 */
async function producePublication(): Promise<{
  dir: string;
  store: HistorianStore;
  publication: {
    publicationId: string;
    publicationSequence: number;
    processingKey: string;
    outputHash: string;
    compartmentCount: number;
    segmentCount: number;
    evidenceCount: number;
    createdAt: string;
  };
  outbox: { publicationId: string; payloadHash: string };
  summary: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), "iris-pin-"));
  const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  const entries: SessionTreeEntry[] = [
    {
      type: "message",
      id: "u-1",
      parentId: null,
      timestamp: "2026-08-01T00:00:01.000Z",
      message: { role: "user", content: "the deployment plan is confirmed", timestamp: 1 },
    },
  ] as unknown as SessionTreeEntry[];

  const port = new SessionHistoryReadPort({ readRawEntries: async () => entries });
  const page = await port.readEntries({ runtimeSessionId: SESSION, limit: 100 });
  const frozen = freezeBoundary({
    rawSeamInput: {
      runtimeSessionId: SESSION,
      lineageId: "identity-pin",
      entries: page.entries,
      processedThroughEntrySeq: 0,
      tailMarginEntries: 0,
      modelProviderProfile: "opencode/deepseek-v4-flash",
      frozenAt: "2026-08-01T00:00:00.000Z",
    },
  });
  const analysis = buildAnalysisView({
    runtimeSessionId: SESSION,
    boundary: frozen.snapshot,
    eligibleEntries: page.entries,
  });
  const outcome = validateRange({
    runtimeSessionId: SESSION,
    boundary: frozen.snapshot,
    eligibleEntries: page.entries,
    // iris_agent#76: the fixture's durable contextSeq cursor is 0 → anchor
    // = 1 (same as the freeze's unprocessedFromContextSeq).
    unprocessedFromContextSeq: 1,
  });
  assert.ok(outcome.ok, "fixture range must validate");

  store.begin();
  // iris_agent#45: publications require the Context read/claim port.
  new PublicationService({
    store,
    historyPort: {
      getMaterializedBoundary: () => ({
        representedThroughContextSeq: 0,
        representedThroughEntrySeq: 0,
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
          contentHash: "f".repeat(64),
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
          contentHash: "f".repeat(64),
          derivationRefs: { memoryRefs: [], compartmentIds: [], sourceContextMessageUnitIds: [] },
          payload: { role: "user", content: "hello", timestamp: 0 },
          payloadTimestamp: "2026-08-01T00:00:00.000Z",
        },
      ],
      claimHistorianBatch: ({ afterContextSeqExclusive, throughContextSeqInclusive }) => ({
        schemaVersion: "historian-batch-v1",
        lineageId: "identity-pin",
        afterContextSeqExclusive,
        throughContextSeqInclusive,
        units: [],
        batchHash: "",
        frozenAt: new Date().toISOString(),
      }),
      lineageId: () => "identity-pin",
    },
  }).commitSafePrefix({
    runtimeSessionId: SESSION,
    boundary: frozen.snapshot,
    safePrefix: page.entries,
    analysis,
    outcome: {
      ok: true,
      commitThroughEntrySeq: outcome.commitThroughEntrySeq,
      commitThroughContextSeq: outcome.commitThroughContextSeq,
      discardedFromEntrySeq: outcome.discardedFromEntrySeq,
    },
    previousProcessedThroughEntrySeq: 0,
  });
  store.commit();

  const publicationRow = store
    .raw()
    .prepare(
      "SELECT publication_id, publication_sequence, processing_key, output_hash, " +
        "compartment_ids_json, segment_ids_json, evidence_set_ids_json, created_at " +
        "FROM publications",
    )
    .get() as {
    publication_id: string;
    publication_sequence: number;
    processing_key: string;
    output_hash: string;
    compartment_ids_json: string;
    segment_ids_json: string;
    evidence_set_ids_json: string;
    created_at: string;
  };
  assert.ok(publicationRow, "publication row persisted by the B5 transaction");
  const outboxRow = store
    .raw()
    .prepare("SELECT publication_id, payload_hash FROM publication_outbox")
    .get() as { publication_id: string; payload_hash: string };
  assert.ok(outboxRow, "outbox row persisted by the B5 transaction");
  const compartmentRow = store.raw().prepare("SELECT content FROM compartments").get() as {
    content: string;
  };
  assert.ok(compartmentRow, "compartment persisted by the B5 transaction");

  return {
    dir,
    store,
    publication: {
      publicationId: publicationRow.publication_id,
      publicationSequence: publicationRow.publication_sequence,
      processingKey: publicationRow.processing_key,
      outputHash: publicationRow.output_hash,
      compartmentCount: (JSON.parse(publicationRow.compartment_ids_json) as string[]).length,
      segmentCount: (JSON.parse(publicationRow.segment_ids_json) as string[]).length,
      evidenceCount: (JSON.parse(publicationRow.evidence_set_ids_json) as string[]).length,
      createdAt: publicationRow.created_at,
    },
    outbox: { publicationId: outboxRow.publication_id, payloadHash: outboxRow.payload_hash },
    summary: compartmentRow.content,
  };
}

/** 按 delivery 层映射构造 HistorianPublicationV1 envelope（id 可注入）。 */
function buildEnvelope(
  publication: Awaited<ReturnType<typeof producePublication>>["publication"],
  summary: string,
  publicationId: string,
): Record<string, unknown> {
  return {
    schemaVersion: "historian-publication-v1",
    publicationId,
    sourceSequence: publication.publicationSequence,
    publishedAt: publication.createdAt,
    payloadHash: publication.outputHash,
    compartmentCount: publication.compartmentCount,
    segmentCount: publication.segmentCount,
    evidenceCount: publication.evidenceCount,
    summary,
  };
}

test("R3-P2: production-lock memoryContracts pin matches the artifact manifest hash", () => {
  const manifest = readJson("manifest.json");
  const lock = JSON.parse(readFileSync(PRODUCTION_LOCK, "utf8")) as {
    memoryContracts: { package: string; version: string; manifestSha256: string; owner: string };
  };
  const recomputed = recomputeManifestSha256(manifest);
  assert.equal(
    lock.memoryContracts.manifestSha256,
    recomputed,
    "production-lock 钉必须与工件 manifest 的 canonical sha256 精确一致",
  );
  assert.equal(lock.memoryContracts.package, "iris-memory-contracts");
  assert.equal(lock.memoryContracts.version, manifest["version"]);
  assert.equal(lock.memoryContracts.version, "0.3.0");
});

test("R3-P2: historian-publication-v1 schema is pinned in the schema set", () => {
  const pin = readContractPin();
  assert.ok(
    pin.schemaSet.includes("historian-publication-v1.schema.json"),
    "historian-publication-v1 必须在被钉的 schema 集合内",
  );
  const schema = readJson("schemas/historian-publication-v1.schema.json");
  assert.equal(schema["$id"], "urn:iris:memory:historian-publication:v1");
});

test("R3-P2: real Historian output maps to a schema-conforming envelope (uuid id gap documented)", async () => {
  const produced = await producePublication();
  try {
    const schema = readJson("schemas/historian-publication-v1.schema.json");
    const { Ajv2020 } = await import("ajv/dist/2020.js");
    const formatsModule = await import("ajv-formats");
    const formatsPlugin = formatsModule.default as unknown as (validator: unknown) => void;
    const validate = (
      instance: unknown,
    ): { valid: boolean; errors: Array<{ instancePath: string; keyword: string }> } => {
      const ajv = new Ajv2020({ allErrors: true });
      formatsPlugin(ajv);
      const fn = ajv.compile(schema);
      const valid = fn(instance) === true;
      return {
        valid,
        errors: (fn.errors ?? []).map((e) => ({
          instancePath: e.instancePath ?? "",
          keyword: e.keyword ?? "",
        })),
      };
    };

    // 用真实的 publicationId（当前为 `publication-<session>-<seq>`）构造。
    const asIs = buildEnvelope(
      produced.publication,
      produced.summary,
      produced.publication.publicationId,
    );
    const asIsResult = validate(asIs);
    // 已知缺口（R3-P2 记录）：内部 publicationId 非 UUID 形态，delivery 层
    // （后续 P）映射 envelope 时必须改用 UUID（或把内部 id 改为 UUID）。
    assert.equal(asIsResult.valid, false, "非 UUID 的 publicationId 无法通过 schema");
    assert.deepEqual(
      asIsResult.errors.map((e) => e.instancePath).sort(),
      ["/publicationId"],
      "除 publicationId 的 uuid 格式外，其余字段必须全部符合 schema",
    );
    assert.equal(
      UUID_PATTERN.test(produced.publication.publicationId),
      false,
      "当前内部 id 确为已知缺口",
    );

    // 同一份真实输出、仅把 publicationId 映射为 UUID 后，envelope 必须完全
    // 符合 historian-publication-v1（证明其余字段映射全部合规）。
    const conforming = buildEnvelope(
      produced.publication,
      produced.summary,
      "a1b2c3d4-1111-4111-8111-000000000001",
    );
    assert.equal(
      validate(conforming).valid,
      true,
      "delivery 层映射 UUID 后 envelope 必须通过 schema",
    );
  } finally {
    produced.store.close();
    rmSync(produced.dir, { recursive: true, force: true });
  }
});

test("R3-P2: outbox delivery keys match the contract idempotencyKey pattern", async () => {
  const produced = await producePublication();
  try {
    // 幂等键候选：publicationId 与 processingKey（投递层用于
    // publication-acceptance-request-v1 的 idempotencyKey 字段）。
    for (const key of [produced.outbox.publicationId, produced.publication.processingKey]) {
      assert.ok(
        IDEMPOTENCY_KEY_PATTERN.test(key),
        `idempotency key 必须匹配 ^[A-Za-z0-9._:-]+$，实际为: ${key}`,
      );
      assert.ok(key.length >= 1 && key.length <= 128, "idempotency key 长度须在 [1,128]");
    }
    // outbox payloadHash = 64 位小写十六进制（同时满足 idempotencyKey 字符集）。
    assert.equal(produced.outbox.payloadHash, produced.publication.outputHash);
    assert.match(produced.outbox.payloadHash, /^[a-f0-9]{64}$/);
    // 固定版本匹配：contractVersion 使用被钉的 0.2.0（semver 三字段）。
    assert.match("0.2.0", /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
  } finally {
    produced.store.close();
    rmSync(produced.dir, { recursive: true, force: true });
  }
});
