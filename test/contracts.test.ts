import { readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import {
  MEMORY_CONTRACTS_PIN,
  memoryContractsVersion,
  originHash,
} from "../src/contracts/index.js";

test("memory contract pin is exact and does not copy memory DTOs", () => {
  assert.equal(MEMORY_CONTRACTS_PIN.package, "iris-memory-contracts");
  assert.equal(MEMORY_CONTRACTS_PIN.version, "0.3.0");
  assert.ok(memoryContractsVersion().includes("artifact_ready_pending_release"));
  const contractFiles = readdirSync(join(process.cwd(), "src", "contracts"));
  assert.ok(
    !contractFiles.some(
      (name) =>
        name.includes("historian-publication") ||
        name.includes("recall-request") ||
        name.includes("memory-recall-card"),
    ),
  );
});

test("memory contract pin schema set matches the published 0.3.0 manifest", () => {
  // The pin declares a manifestSha256 anchor (SHA-256 of the published
  // iris-memory v0.3.0 contracts/assets/manifest.json) plus the authoritative
  // schema list. The expected set below is the schema surface published by
  // that manifest (verified by re-running `sha256sum manifest.json` in the
  // iris-memory repo); a drift on either side (hash or list) fails here, so
  // the two cannot silently diverge from each other.
  assert.equal(
    MEMORY_CONTRACTS_PIN.manifestSha256,
    "b55b5e1c8b022063019ce0bd02c26e184749e600f9c2f0cb6c4e737559fae560",
    "manifestSha256 must equal the published iris-memory v0.3.0 artifact manifest hash",
  );
  const publishedSchemas = [
    "acceptance-receipt-v1.schema.json",
    "capability-handshake-v2.schema.json",
    "context-range-v1.schema.json",
    "duplicate-replay-receipt-v1.schema.json",
    "evidence-basis-ref-v1.schema.json",
    "expansion-request-v1.schema.json",
    "expansion-response-v1.schema.json",
    "health-response-v1.schema.json",
    "historian-publication-v1.schema.json",
    "historian-publication-v2.schema.json",
    "idempotency-conflict-error-v1.schema.json",
    "memory-recall-card-v1.schema.json",
    "not-implemented-error-v1.schema.json",
    "publication-acceptance-request-v1.schema.json",
    "publication-acceptance-request-v2.schema.json",
    "raw-archive-ref-v1.schema.json",
    "recall-request-v1.schema.json",
    "semantic-derivation-refs-v1.schema.json",
    "sequence-conflict-error-v1.schema.json",
    "unsupported-version-error-v1.schema.json",
    // iris_memory#11: the Graphiti-ready v3 surface.
    "acceptance-receipt-v3.schema.json",
    "compartment-revision-v1.schema.json",
    "duplicate-replay-receipt-v2.schema.json",
    "graphiti-episode-source-v1.schema.json",
    "historian-publication-v3.schema.json",
    "publication-acceptance-request-v3.schema.json",
    // iris_memory#14: the focused v2 semantic metadata surface.
    "graphiti-episode-source-v2.schema.json",
  ];
  assert.deepEqual(
    [...MEMORY_CONTRACTS_PIN.schemas].sort(),
    publishedSchemas.sort(),
    "pin schema list must exactly match the published manifest schema surface",
  );
  // No duplicates, no omissions.
  assert.equal(new Set(MEMORY_CONTRACTS_PIN.schemas).size, publishedSchemas.length);
});

test("memory contract pin version is a strict 0.3.x semver", () => {
  assert.match(MEMORY_CONTRACTS_PIN.version, /^0\.3\.\d+$/);
  assert.equal(MEMORY_CONTRACTS_PIN.major, 0);
});

test("originHash is deterministic and canonical", () => {
  const origin = {
    schemaVersion: 1,
    channel: "cli",
    principalKind: "user" as const,
    authority: "user_request" as const,
    trust: "limited" as const,
  };
  assert.equal(originHash(origin), originHash({ ...origin }));
  assert.match(originHash(origin), /^[0-9a-f]{64}$/);
});
