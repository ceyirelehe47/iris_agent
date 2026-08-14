/**
 * iris_agent#64 — exact receipt binding (cross-repository, real process).
 *
 * The Memory-owned contract (iris-memory-contracts 0.2.0) returns
 * acceptance/duplicate-replay receipts carrying versioned immutable
 * identity: publicationId + canonicalPayloadHash + contractVersion.
 * Agent must verify that identity BEFORE markDelivered, and reclaim
 * authorization must see the verified bound receipt — never a bare opaque
 * string.
 *
 * This suite uses a REAL `iris_memory serve` subprocess (the contract
 * owner) and injects swapped/tampered receipts at the HTTP layer to prove
 * fail-closed behavior. It is skipped when the memory repo/python is not
 * available (CI without the sibling checkout) — run it locally with the
 * sibling checkout present.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

import { canonicalJson } from "../src/contracts/tool.js";
import {
  canonicalPayloadHash,
  HttpMemoryClient,
  parseBoundReceipt,
} from "../src/historian/memory-client.js";
import type { MemoryAcceptanceReceipt } from "../src/contracts/ports.js";

const MEMORY_REPO = join(import.meta.dirname, "..", "..", "iris_memory");
// 用 uv 托管解释器或系统 python3(任一可用即可)。
function findPython(): string | null {
  const candidates = [join(MEMORY_REPO, ".venv", "bin", "python"), "/usr/bin/python3"];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const memoryAvailable =
  existsSync(join(MEMORY_REPO, "src", "iris_memory", "__init__.py")) && findPython() !== null;

let nextSourceSequence = 100; // 避开任何既有 fixture 的 sequence(全局单调)

function sampleEnvelope(
  publicationId: string,
  sourceSequence = nextSourceSequence++,
): Record<string, unknown> {
  // iris_memory#11: the Graphiti-ready v3 envelope. The episode source hash
  // MUST equal iris_memory's deterministic canonical re-hash, otherwise the
  // cross-process acceptance fails validation (tampered provenance).
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
    // iris_memory graphiti-episode-source-v2 required provenance fields.
    semanticKind: "dialogue",
    attributionClass: "user",
    sourceTrust: "observed",
    referenceTime: "2026-08-06T00:00:00.500Z",
  };
  // iris_memory#11: the canonical episode-source hash covers the 9-field
  // identity+provenance+content subset (NOT the new v2 provenance fields) —
  // the memory re-hashes exactly this subset and fails closed on mismatch.
  const episodeSourceHash = createHash("sha256")
    .update(
      canonicalJson({
        episodeId: episodeSourceBase.episodeId,
        lineageId: episodeSourceBase.lineageId,
        contextRange: episodeSourceBase.contextRange,
        sourceUnitIds: episodeSourceBase.sourceUnitIds,
        canonicalContent: episodeSourceBase.canonicalContent,
        targetGroupId: episodeSourceBase.targetGroupId,
        temporal: episodeSourceBase.temporal,
        isDerivedOnly: episodeSourceBase.isDerivedOnly,
        derivation: episodeSourceBase.derivation,
      }),
      "utf8",
    )
    .digest("hex");
  const envelopeBase = {
    schemaVersion: "historian-publication-v3",
    publicationId,
    sourceSequence,
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
        summary: "cross-repo receipt binding fixture",
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
}

let memoryProc: ChildProcess | undefined;
let memoryPort = 0;

test.before(async () => {
  if (!memoryAvailable) {
    return;
  }
  memoryPort = 18_000 + Math.floor(Math.random() * 1000);
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-x64-memory-"));
  const env = { ...process.env } as Record<string, string>;
  env["PYTHONPATH"] = join(MEMORY_REPO, "src");
  const pythonPath = findPython();
  assert.ok(pythonPath !== null, "python must be available when memoryAvailable");
  memoryProc = spawn(
    pythonPath,
    ["-m", "iris_memory", "serve", "--data-root", dataRoot, "--port", String(memoryPort)],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  // Wait for /v1/health (same readiness probe the memory tests use).
  const deadline = Date.now() + 15_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (memoryProc.exitCode !== null) {
      throw new Error("iris_memory serve exited early");
    }
    try {
      const res = await fetch(`http://127.0.0.1:${memoryPort}/v1/health`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!ready) {
    throw new Error("iris_memory serve did not become ready");
  }
});

test.after(() => {
  if (memoryProc !== undefined) {
    memoryProc.kill("SIGKILL");
  }
});

test("iris_agent#64: real iris_memory returns a bound acceptance receipt (publicationId + canonical hash + contract version)", async (t) => {
  if (!memoryAvailable) {
    t.skip("iris_memory checkout/python not available");
    return;
  }
  const client = new HttpMemoryClient(`http://127.0.0.1:${memoryPort}`);
  const publication = sampleEnvelope("b6f0d1c2-0000-4000-8000-000000000001");
  const outcome = await client.deliverPublication(publication);
  assert.ok(outcome.ok, "real memory accepts the v2 envelope");
  if (!outcome.ok) {
    return;
  }
  assert.equal(outcome.receipt.schemaVersion, "acceptance-receipt-v3");
  assert.equal(outcome.receipt.status, "accepted");
  assert.equal(outcome.receipt.publicationId, publication["publicationId"]);
  assert.equal(
    outcome.receipt.canonicalPayloadHash,
    canonicalPayloadHash(publication),
    "receipt canonical hash == locally recomputed hash",
  );
  assert.equal(outcome.receipt.contractVersion, "0.3.0");
  assert.ok(outcome.receipt.receiptId.length > 0);
});

test("iris_agent#64: replay returns the SAME bound receipt (deterministic duplicate identity)", async (t) => {
  if (!memoryAvailable) {
    t.skip("iris_memory checkout/python not available");
    return;
  }
  const client = new HttpMemoryClient(`http://127.0.0.1:${memoryPort}`);
  const publication = sampleEnvelope("b6f0d1c2-0000-4000-8000-000000000002");
  const first = await client.deliverPublication(publication);
  assert.ok(first.ok);
  if (!first.ok) {
    return;
  }
  const replay = await client.deliverPublication(publication);
  assert.ok(
    replay.ok,
    `replay is safe (duplicate_replay): ${JSON.stringify(replay).slice(0, 400)}`,
  );
  if (!replay.ok) {
    return;
  }
  assert.equal(replay.receipt.schemaVersion, "duplicate-replay-receipt-v2");
  assert.equal(replay.receipt.status, "duplicate_replay");
  assert.equal(
    replay.receipt.originalPublicationId,
    (first.receipt as { publicationId?: string }).publicationId,
  );
  assert.equal(replay.receipt.originalContractVersion, "0.3.0");
  assert.equal(
    replay.receipt.originalCanonicalPayloadHash,
    (first.receipt as { canonicalPayloadHash?: string }).canonicalPayloadHash,
  );
});

test("iris_agent#64: a SWAPPED receipt (publication B's identity) cannot authorize delivery of publication A", async (t) => {
  if (!memoryAvailable) {
    t.skip("iris_memory checkout/python not available");
    return;
  }
  const publicationA = sampleEnvelope("b6f0d1c2-0000-4000-8000-000000000003");
  const publicationB = sampleEnvelope("b6f0d1c2-0000-4000-8000-0000000000B3");
  const client = new HttpMemoryClient(`http://127.0.0.1:${memoryPort}`);
  // First accept B for real so its receipt exists…
  const acceptedB = await client.deliverPublication(publicationB);
  assert.ok(acceptedB.ok);
  if (!acceptedB.ok) {
    return;
  }
  // …then replay A but with B's receipt injected at the HTTP layer: the
  // swap proxy forwards the request to the REAL memory but rewrites the
  // 200 receipt's publicationId to A's (making it look "valid").
  const swappedServer = await startSwapProxy(memoryPort, (receipt) => ({
    ...receipt,
    publicationId: String(publicationA["publicationId"]),
  }));
  try {
    const swappedClient = new HttpMemoryClient(`http://127.0.0.1:${swappedServer.port}`);
    // Accept A through the swap proxy: memory returns a REAL receipt for A
    // (which the proxy rewrites to publicationId=A — identical), so this
    // first hop just records A. The binding check still passes because the
    // true receipt IS for A.
    const firstA = await swappedClient.deliverPublication(publicationA);
    assert.ok(firstA.ok, `unmodified A receipt passes: ${JSON.stringify(firstA).slice(0, 300)}`);
    if (!firstA.ok) {
      return;
    }
    // Now swap B's receipt (publicationId=B, canonical hash of B) into the
    // response for A's request — this is the dangerous case the contract
    // must reject: a syntactically valid receipt for the WRONG publication.
    // (v3 duplicates bind via original* fields — the swap rewrites those.)
    const swappedServer2 = await startSwapProxy(memoryPort, (receipt) => {
      if (receipt["schemaVersion"] === "duplicate-replay-receipt-v2") {
        return {
          ...receipt,
          originalPublicationId: String(publicationB["publicationId"]),
          originalCanonicalPayloadHash: canonicalPayloadHash(publicationB),
        };
      }
      return { ...receipt, publicationId: String(publicationB["publicationId"]) };
    });
    try {
      const client2 = new HttpMemoryClient(`http://127.0.0.1:${swappedServer2.port}`);
      const bad = await client2.deliverPublication(publicationA);
      assert.ok(!bad.ok, "receipt bound to a DIFFERENT publication fails closed");
    } finally {
      await new Promise<void>((resolve) => {
        swappedServer2.server.close(() => {
          resolve();
        });
      });
    }
  } finally {
    await new Promise<void>((resolve) => {
      swappedServer.server.close(() => {
        resolve();
      });
    });
  }
});

test("iris_agent#64: a TAMPERED receipt (canonical hash rewritten) fails closed", async (t) => {
  if (!memoryAvailable) {
    t.skip("iris_memory checkout/python not available");
    return;
  }
  const publication = sampleEnvelope("b6f0d1c2-0000-4000-8000-000000000004");
  const tamperServer = await startSwapProxy(memoryPort, (receipt) => ({
    ...receipt,
    canonicalPayloadHash: "0".repeat(64),
  }));
  try {
    const client = new HttpMemoryClient(`http://127.0.0.1:${tamperServer.port}`);
    const outcome = await client.deliverPublication(publication);
    assert.ok(!outcome.ok, "receipt with a tampered canonical hash fails closed");
  } finally {
    await new Promise<void>((resolve) => {
      tamperServer.server.close(() => {
        resolve();
      });
    });
  }
});

test("iris_agent#64: a receipt with an UNKNOWN contract version fails closed", async (t) => {
  if (!memoryAvailable) {
    t.skip("iris_memory checkout/python not available");
    return;
  }
  const publication = sampleEnvelope("b6f0d1c2-0000-4000-8000-000000000005");
  const versionServer = await startSwapProxy(memoryPort, (receipt) => ({
    ...receipt,
    contractVersion: "9.9.9",
  }));
  try {
    const client = new HttpMemoryClient(`http://127.0.0.1:${versionServer.port}`);
    const outcome = await client.deliverPublication(publication);
    assert.ok(!outcome.ok, "receipt for an unsupported contract version fails closed");
  } finally {
    await new Promise<void>((resolve) => {
      versionServer.server.close(() => {
        resolve();
      });
    });
  }
});

test("iris_agent#64: a missing/empty receiptId fails closed (no fabricated identity)", async (t) => {
  if (!memoryAvailable) {
    t.skip("iris_memory checkout/python not available");
    return;
  }
  const publication = sampleEnvelope("b6f0d1c2-0000-4000-8000-000000000006");
  const missingServer = await startSwapProxy(memoryPort, (receipt) => ({
    ...receipt,
    receiptId: "",
  }));
  try {
    const client = new HttpMemoryClient(`http://127.0.0.1:${missingServer.port}`);
    const outcome = await client.deliverPublication(publication);
    assert.ok(!outcome.ok, "receipt without an identity fails closed");
  } finally {
    await new Promise<void>((resolve) => {
      missingServer.server.close(() => {
        resolve();
      });
    });
  }
});

test("iris_agent#64: parseBoundReceipt rejects swapped/tampered/stale receipts deterministically (pure)", () => {
  const publication = sampleEnvelope("b6f0d1c2-0000-4000-8000-000000000007");
  const good: MemoryAcceptanceReceipt = {
    schemaVersion: "acceptance-receipt-v1",
    status: "accepted",
    receiptId: "abc-123",
    publicationId: publication["publicationId"] as string,
    canonicalPayloadHash: canonicalPayloadHash(publication),
    contractVersion: "0.3.0",
    acceptedAt: "2026-08-06T00:00:01Z",
  };
  const expected = {
    expectedPublicationId: publication["publicationId"] as string,
    expectedCanonicalPayloadHash: canonicalPayloadHash(publication),
    expectedContractVersion: "0.3.0",
  };
  assert.ok(parseBoundReceipt(good as unknown as Record<string, unknown>, expected) !== null);
  // swapped: receipt for a DIFFERENT publication id
  assert.equal(
    parseBoundReceipt(
      { ...good, publicationId: "some-other-publication" } as unknown as Record<string, unknown>,
      expected,
    ),
    null,
  );
  // tampered canonical hash
  assert.equal(
    parseBoundReceipt(
      { ...good, canonicalPayloadHash: "e".repeat(64) } as unknown as Record<string, unknown>,
      expected,
    ),
    null,
  );
  // unknown contract version
  assert.equal(
    parseBoundReceipt(
      { ...good, contractVersion: "1.0.0" } as unknown as Record<string, unknown>,
      expected,
    ),
    null,
  );
  // missing receiptId
  assert.equal(
    parseBoundReceipt({ ...good, receiptId: "" } as unknown as Record<string, unknown>, expected),
    null,
  );
});

/** HTTP 层 swap/tamper proxy:把请求转发给真实 memory,按 rewrite 改写 200
 * receipt 后返回 —— 模拟 stale/swapped/tampered 响应(不触碰真实 memory
 * 的持久状态;改写只发生在回程)。 */
function startSwapProxy(
  upstreamPort: number,
  rewrite: (receipt: Record<string, unknown>) => Record<string, unknown>,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        void (async () => {
          const body = Buffer.concat(chunks).toString("utf8");
          try {
            const upstream = await fetch(`http://127.0.0.1:${upstreamPort}${req.url}`, {
              method: req.method ?? "GET",
              headers: { "content-type": "application/json" },
              ...(body.length > 0 ? { body } : {}),
            });
            const upstreamBody = await upstream.text();
            let outBody = upstreamBody;
            if (upstream.status === 200 && upstreamBody.length > 0) {
              try {
                const parsed = JSON.parse(upstreamBody) as Record<string, unknown>;
                outBody = JSON.stringify(rewrite(parsed));
              } catch {
                /* non-JSON passthrough */
              }
            }
            res.writeHead(upstream.status, { "content-type": "application/json" });
            res.end(outBody);
          } catch (error) {
            res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: String(error) }));
          }
        })();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address !== null && typeof address === "object");
      resolve({ server, port: address.port });
    });
  });
}
