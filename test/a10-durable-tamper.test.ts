/**
 * Feature A10 (#123): REAL P5 tamper detection through the durable storage
 * boundary.
 *
 * The Round-6 style "recompute the hash in the test and throw" is not
 * evidence. Here the production call chain is:
 *   ContextStore.insertUnit (durable write)
 *   → close
 *   → EXTERNAL tamper of the durable row (SQL UPDATE of semanticContent /
 *     kind / historianDisposition / derivationRefs / semanticSchemaId,
 *     contentHash and contentHashBasis UNTOUCHED)
 *   → reopen production ContextStore (real read path)
 *   → buildContextGenerationV2 → projectP5Unit (production validation)
 *   → MUST FAIL CLOSED (contentHash mismatch / read-path rejection)
 *
 * Deleting the production source-bound hash validation makes these tests
 * fail (sensitivity: the tamper is then invisible).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateDatabase } from "../src/db/migrate.js";
import { ContextStore } from "../src/context/context-store.js";
import { buildContextGenerationV2 } from "../src/context/generation-builder.js";
import {
  type ContextMessageUnitV1,
  type JsonValue,
  CONTEXT_MESSAGE_UNIT_V1_SCHEMA_ID,
  KIND_TO_SEMANTIC_SCHEMA_ID,
  computeContextMessageUnitContentHashV1,
} from "../src/contracts/context-v27.js";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "src", "db", "migrations", "context");

function cleanupDir(dir: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${dir}context.db${suffix}`, { force: true });
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeValidDurableUnit(unitId: string, text: string): ContextMessageUnitV1 {
  const semanticContent: JsonValue = { role: "user", content: text };
  const kind = "user" as const;
  const semanticSchemaId = KIND_TO_SEMANTIC_SCHEMA_ID[kind];
  // Insert path normalizes derivationRefs to the full shape; the hash must
  // be computed over the SAME canonical refs or restart verification fails.
  const derivationRefs = {
    schemaId: "iris.semantic_derivation_refs.v1" as const,
    memoryRefs: [] as string[],
    compartmentIds: [] as string[],
    sourceContextMessageUnitIds: [] as string[],
  };
  const contentHash = computeContextMessageUnitContentHashV1({
    semanticSchemaId,
    kind,
    historianDisposition: "include",
    derivationRefs,
    semanticContent,
  });
  return {
    schemaId: CONTEXT_MESSAGE_UNIT_V1_SCHEMA_ID,
    contextUnitId: unitId,
    contextSeq: 1,
    contextLineageId: "identity-default",
    runtimeEventId: `evt-${unitId}`,
    semanticSchemaId,
    kind,
    historianDisposition: "include",
    lifecycleState: "committed",
    semanticContent,
    derivationRefs,
    contentHash,
    createdAt: "2026-08-13T00:00:00Z",
  };
}

function buildP5FromStore(
  dbPath: string,
  lineageId: string,
  options?: { disposition?: "all" | "include" },
): () => void {
  return () => {
    const store = ContextStore.open(dbPath, { lineageId });
    try {
      // "all": the tamper must be OBSERVED by the production read path
      // (verifyStoredContentHash fails closed in rowToUnit) — a
      // disposition tamper that flips the row out of the default
      // include-filter would otherwise be silently invisible.
      const units = store.listUnitsByLineage(lineageId, {
        disposition: options?.disposition ?? "all",
      });
      buildContextGenerationV2(
        {
          contextLineageId: lineageId,
          sourceSnapshotHash: "snapshot",
          p0Units: [],
          p1Units: [],
          p2Units: [],
          p3Units: [],
          p4Units: [],
          p5Units: units,
        },
        "gen-a10",
        "2026-08-13T00:00:00Z",
      );
    } finally {
      store.close();
    }
  };
}

function tamperDurable(dbPath: string, sql: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

test("A10: valid durable unit round-trips through the REAL write → reopen → build chain", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-a10-ok-"));
  const dbPath = join(dir, "context.db");
  try {
    migrateDatabase(dbPath, MIGRATIONS_DIR);
    const store = ContextStore.open(dbPath, { lineageId: "identity-default" });
    store.insertUnit(makeValidDurableUnit("a10-ok-001", "hello"), {
      verifySessionBinding: false,
    });
    store.close();
    // Reopen + production build: PASS.
    assert.doesNotThrow(buildP5FromStore(dbPath, "identity-default"));
  } finally {
    cleanupDir(dir);
  }
});

test("A10: tamper semanticContent in the DURABLE row (contentHash untouched) → production build MUST FAIL", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-a10-tamper-content-"));
  const dbPath = join(dir, "context.db");
  try {
    migrateDatabase(dbPath, MIGRATIONS_DIR);
    const store = ContextStore.open(dbPath, { lineageId: "identity-default" });
    store.insertUnit(makeValidDurableUnit("a10-t1", "original"), {
      verifySessionBinding: false,
    });
    store.close();
    tamperDurable(
      dbPath,
      `UPDATE context_units SET payload = '{"role":"user","content":"TAMPERED"}' WHERE unit_id = 'a10-t1'`,
    );
    assert.throws(
      buildP5FromStore(dbPath, "identity-default"),
      /contentHash mismatch|tampered|corrupt/i,
      "projectP5Unit must fail closed when the durable semanticContent no longer matches contentHash",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("A10: tamper kind in the durable row (contentHash untouched) → production path MUST FAIL", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-a10-tamper-kind-"));
  const dbPath = join(dir, "context.db");
  try {
    migrateDatabase(dbPath, MIGRATIONS_DIR);
    const store = ContextStore.open(dbPath, { lineageId: "identity-default" });
    store.insertUnit(makeValidDurableUnit("a10-t2", "original"), {
      verifySessionBinding: false,
    });
    store.close();
    tamperDurable(
      dbPath,
      `UPDATE context_units SET unit_type = 'tool_result' WHERE unit_id = 'a10-t2'`,
    );
    assert.throws(
      buildP5FromStore(dbPath, "identity-default"),
      /contentHash mismatch|tampered|corrupt|fail closed/i,
      "tampered kind must be caught by the production source-bound hash validation",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("A10: tamper historianDisposition in the durable row → production path MUST FAIL", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-a10-tamper-disp-"));
  const dbPath = join(dir, "context.db");
  try {
    migrateDatabase(dbPath, MIGRATIONS_DIR);
    const store = ContextStore.open(dbPath, { lineageId: "identity-default" });
    store.insertUnit(makeValidDurableUnit("a10-t3", "original"), {
      verifySessionBinding: false,
    });
    store.close();
    tamperDurable(
      dbPath,
      `UPDATE context_units SET disposition = 'retired' WHERE unit_id = 'a10-t3'`,
    );
    assert.throws(
      buildP5FromStore(dbPath, "identity-default"),
      /contentHash mismatch|tampered|corrupt|fail closed/i,
      "tampered historianDisposition must be caught by the production source-bound hash validation",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("A10: tamper derivationRefs in the durable row → production path MUST FAIL", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-a10-tamper-deriv-"));
  const dbPath = join(dir, "context.db");
  try {
    migrateDatabase(dbPath, MIGRATIONS_DIR);
    const store = ContextStore.open(dbPath, { lineageId: "identity-default" });
    store.insertUnit(makeValidDurableUnit("a10-t4", "original"), {
      verifySessionBinding: false,
    });
    store.close();
    tamperDurable(
      dbPath,
      `UPDATE context_units SET derivation_refs = '{"schemaId":"iris.semantic_derivation_refs.v1","memoryRefs":[],"compartmentIds":[],"sourceContextMessageUnitIds":["EVIL-UNIT"]}' WHERE unit_id = 'a10-t4'`,
    );
    assert.throws(
      buildP5FromStore(dbPath, "identity-default"),
      /contentHash mismatch|tampered|corrupt|fail closed/i,
      "tampered derivationRefs must be caught by the production source-bound hash validation",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("A10: tamper semanticSchemaId in the durable row → production path MUST FAIL", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-a10-tamper-schema-"));
  const dbPath = join(dir, "context.db");
  try {
    migrateDatabase(dbPath, MIGRATIONS_DIR);
    const store = ContextStore.open(dbPath, { lineageId: "identity-default" });
    store.insertUnit(makeValidDurableUnit("a10-t5", "original"), {
      verifySessionBinding: false,
    });
    store.close();
    tamperDurable(
      dbPath,
      `UPDATE context_units SET semantic_schema_id = 'iris.semantic.context_message.tool_call.v1' WHERE unit_id = 'a10-t5'`,
    );
    assert.throws(
      buildP5FromStore(dbPath, "identity-default"),
      /contentHash mismatch|tampered|corrupt|fail closed|unknown/i,
      "tampered semanticSchemaId must be caught by the production source-bound hash validation",
    );
  } finally {
    cleanupDir(dir);
  }
});
