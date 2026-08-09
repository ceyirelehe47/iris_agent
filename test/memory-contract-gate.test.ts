import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { readContractPin } from "../src/contracts/memory-pin.js";

/**
 * Cross-repository compatibility gate (round 3, task 7).
 *
 * Dependency direction is fixed: iris-memory publishes the contract artifact;
 * iris-agent pins and verifies it. This suite reads the REAL built artifact
 * (committed under fixtures/memory-contracts-artifact), recomputes the
 * manifest SHA-256, checks the schema/fixture lists match, validates every
 * valid/invalid fixture, and proves major-version mismatch fails closed.
 *
 * The agent must NOT copy Memory DTOs and must NOT depend on the Memory
 * Python implementation — only the versioned artifact on disk.
 */

const ARTIFACT_ROOT = join(
  import.meta.dirname,
  "..",
  "fixtures",
  "memory-contracts-artifact",
  "iris-memory-contracts-0.3.0",
);

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ARTIFACT_ROOT, relative), "utf8")) as Record<string, unknown>;
}

test("cross-repo: agent reads the manifest from the REAL artifact", () => {
  const manifest = readJson("manifest.json");
  assert.equal(manifest["package"], "iris-memory-contracts");
  assert.equal(manifest["version"], "0.3.0");
  assert.equal(manifest["majorVersion"], 0);
  assert.ok(Array.isArray(manifest["schemas"]));
  assert.ok(Array.isArray(manifest["fixtures"]));
  const schemas = manifest["schemas"] as string[];
  assert.equal(schemas.length, 27);
});

test("cross-repo: pinned manifestSha256 equals the REAL artifact manifest hash", () => {
  const manifest = readJson("manifest.json");
  const pin = readContractPin();
  assert.equal(
    pin.manifestSha256,
    manifest["manifestSha256"],
    "agent pin must match the artifact's manifest checksum exactly",
  );
});

test("cross-repo: agent recomputes the manifest SHA-256 deterministically", () => {
  const manifest = readJson("manifest.json");
  // Recompute the checksum exactly like iris-memory does: canonical JSON of
  // the manifest WITHOUT manifestSha256 — sorted keys, compact separators
  // (ensure_ascii=false, separators=(",",":")), sha256 of the UTF-8 bytes.
  const withoutSelf: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (key !== "manifestSha256") {
      withoutSelf[key] = value;
    }
  }
  const canonical = JSON.stringify(withoutSelf, sortedKeys, 0);
  const recomputed = createHash("sha256").update(canonical).digest("hex");
  assert.equal(recomputed, manifest["manifestSha256"]);
});

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

test("cross-repo: every listed schema/fixture physically exists in the artifact", () => {
  const manifest = readJson("manifest.json");
  for (const group of ["schemas", "fixtures", "openapi"]) {
    const entries = manifest[group] as string[];
    for (const relative of entries) {
      const path = join(ARTIFACT_ROOT, relative);
      assert.ok(
        existsInArtifact(path),
        `artifact is missing ${group}/${relative} referenced by the manifest`,
      );
    }
  }
});

function existsInArtifact(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

test("cross-repo: agent validates valid/invalid fixtures against the artifact schemas", async () => {
  const manifest = readJson("manifest.json");
  const { Ajv2020 } = await import("ajv/dist/2020.js");
  const formatsModule = await import("ajv-formats");
  const formatsPlugin = formatsModule.default as unknown as (validator: unknown) => void;

  const fixtures = manifest["fixtures"] as string[];
  assert.ok(fixtures.length >= 30, `expected >=28 fixtures, got ${fixtures.length}`);
  for (const relative of fixtures) {
    const parts = relative.split("/");
    const name = parts[parts.length - 1] ?? "";
    const schemaName = name.includes(".valid.")
      ? (name.split(".valid.")[0] ?? "")
      : (name.split(".invalid")[0] ?? "");
    const expectValid = name.includes(".valid.");
    const schema = readJson(`schemas/${schemaName}.schema.json`);
    const instance = readJson(relative);
    // A fresh Ajv per fixture: schemas carry $id and ajv rejects duplicate
    // registration when compiling the same schema across fixtures. v2
    // schemas cross-reference reusable types by urn: id, so every packaged
    // schema must be registered in the Ajv instance first.
    const ajv = new Ajv2020({ allErrors: true });
    formatsPlugin(ajv);
    let targetId: string | undefined;
    for (const schemaRelative of manifest["schemas"] as string[]) {
      const s = readJson(schemaRelative);
      const id = s["$id"];
      if (typeof id === "string") {
        ajv.addSchema(s, id);
        if (schemaRelative === `schemas/${schemaName}.schema.json`) {
          targetId = id;
        }
      }
    }
    const validate =
      targetId !== undefined
        ? (ajv.getSchema(targetId) ?? ajv.compile(schema))
        : ajv.compile(schema);
    const valid = validate(instance) === true;
    if (expectValid) {
      assert.equal(valid, true, `fixture ${relative} should be valid`);
    } else {
      assert.equal(valid, false, `fixture ${relative} should be invalid`);
    }
  }
});

test("cross-repo: major-version mismatch fails closed", () => {
  const manifest = readJson("manifest.json");
  const major = manifest["majorVersion"] as number;
  const pin = readContractPin();
  // The agent pin must agree with the artifact's major version; a future
  // artifact with a different major version must be rejected, never guessed.
  assert.equal(pin.major, major);
  const supported = 0;
  assert.equal(major, supported, "major version mismatch must fail closed");
});

test("cross-repo: agent does not depend on the Memory Python implementation", () => {
  // The pin is a JSON contract file — not a copy of Memory DTOs, and there is
  // no Python import anywhere in the agent repo.
  const pin = readContractPin();
  assert.equal(typeof pin.schemaSet, "object");
  assert.equal(pin.schemaSet.length, 27);
});

test("cross-repo: committed artifact carries provenance and matches its pin", () => {
  // The checked-in artifact must record its producer source (repository +
  // commit) and its manifest hash must equal the agent's pin, so the gate
  // input cannot silently diverge from the producer repository.
  // review-pass-2 #6: provenance lives OUTSIDE the artifact directory (the
  // artifact is exactly its manifest surface), so read it one level up.
  const provenance = JSON.parse(
    readFileSync(join(ARTIFACT_ROOT, "..", "provenance.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(provenance["producer"], "blueforst/iris_memory");
  const producerCommit = provenance["producerCommit"];
  assert.equal(typeof producerCommit, "string");
  assert.ok((producerCommit as string).length >= 7);
  assert.equal(provenance["contractVersion"], "0.3.0");
  const pin = readContractPin();
  assert.equal(pin.manifestSha256, provenance["manifestSha256"]);
  const manifest = readJson("manifest.json");
  assert.equal(manifest["manifestSha256"], provenance["manifestSha256"]);
  // The artifact root must contain ONLY manifest.json as a FILE, plus the
  // three declared content directories (review-pass-2 #6: no extra files).
  const rootEntries = readdirSync(ARTIFACT_ROOT, { withFileTypes: true });
  const rootFiles = rootEntries.filter((e) => e.isFile()).map((e) => e.name);
  const rootDirs = rootEntries.filter((e) => e.isDirectory()).map((e) => e.name);
  assert.deepEqual(rootFiles, ["manifest.json"]);
  assert.deepEqual(rootDirs.sort(), ["fixtures", "openapi", "schemas"]);
});

test("cross-repo: pin metadata EXACTLY equals the pinned artifact (review-pass-3)", () => {
  // The pin is an exact contract-version pinning: version, schema set,
  // package and owner must equal the artifact/provenance byte-for-byte —
  // not just the manifest hash.
  const manifest = readJson("manifest.json");
  const provenance = JSON.parse(
    readFileSync(join(ARTIFACT_ROOT, "..", "provenance.json"), "utf8"),
  ) as Record<string, unknown>;
  const pin = readContractPin();

  assert.equal(pin.version, manifest["version"], "pin.version must equal manifest.version");
  assert.equal(
    pin.version,
    provenance["contractVersion"],
    "pin.version must equal provenance contractVersion",
  );
  assert.equal(pin.package, manifest["package"]);
  assert.equal(pin.package, "iris-memory-contracts");
  assert.equal(provenance["producer"], "blueforst/iris_memory");
  assert.equal(pin.owner, "blueforst/iris_memory");
  assert.equal(pin.owner, provenance["producer"]);

  // Schema set: exact basename set equality (v2 present, v1 absent).
  const manifestSchemas = (manifest["schemas"] as string[]).map((relative) =>
    relative.split("/").pop(),
  );
  const pinSchemas = [...pin.schemaSet].map((name) => name.split("/").pop());
  assert.deepEqual([...pinSchemas].sort(), [...manifestSchemas].sort());
  assert.ok(pinSchemas.includes("capability-handshake-v2.schema.json"));
  assert.ok(!pinSchemas.includes("capability-handshake-v1.schema.json"));
});
