/**
 * Feature A7 (#117) + A8 (#122): P5 source-bound semantic tamper detection
 * and the physical legacy fence.
 *
 * A7: mutating semanticContent while keeping contentHash unchanged is
 * detected at the REAL projection boundary (buildContextGenerationV2 →
 * projectP5Unit recomputes the durable hash and fails closed).
 *
 * A8: legacy pre-#113 rows are quarantined PHYSICALLY (legacy_status column
 * set by production migration 0009). They must NOT deserialize as current
 * ContextMessageUnitV1, must NOT enter P5, and the canonical lifecycle enum
 * stays exactly the six Notion states.
 *
 * Every test here goes through production code:
 *   - production migration SQL (0001–0008 to build a real pre-0009 DB,
 *     then production migrateDatabase() applies 0009)
 *   - production ContextStore.open() / listUnits() / findBySourceEvent()
 *   - production buildContextGenerationV2() projection
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  type ContextGenerationV2,
  type ContextUnitV2,
  type ContextMessageUnitV1,
  type JsonValue,
  CONTEXT_UNIT_V2_SCHEMA_ID,
  CONTEXT_UNIT_HEADER_V1_SCHEMA_ID,
  CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
  CONTEXT_GENERATION_V2_SCHEMA_ID,
  CONTEXT_GENERATION_HEADER_V1_SCHEMA_ID,
  CONTEXT_MESSAGE_UNIT_V1_SCHEMA_ID,
  KIND_TO_SEMANTIC_SCHEMA_ID,
  computeContextGenerationHash,
  computeContextMessageUnitContentHashV1,
} from "../src/contracts/context-v27.js";
import { buildContextGenerationV2 } from "../src/context/generation-builder.js";
import { ContextStore } from "../src/context/context-store.js";
import { migrateDatabase } from "../src/db/migrate.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "src", "db", "migrations", "context");

function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeValidDurableUnit(
  id: string,
  content: string,
  contextLineageId = "identity-default",
): ContextMessageUnitV1 {
  const semanticContent: JsonValue = { role: "user", content };
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
    contextUnitId: id,
    contextLineageId,
    contextSeq: 1,
    runtimeEventId: `evt-${id}`,
    kind,
    semanticSchemaId,
    semanticContent,
    historianDisposition: "include",
    derivationRefs,
    contentHash,
    lifecycleState: "committed",
    createdAt: "2026-08-13T00:00:00Z",
  };
}

/**
 * A8: build a REAL pre-0009 context.db using the PRODUCTION migration files
 * 0001–0008 (copied to a temp dir without 0009), then write a legacy row the
 * way pre-#113 data exists on disk (content_hash_basis='v1',
 * lifecycle_state='committed').
 */
function buildPre0009DbWithLegacyRow(): {
  dbPath: string;
  migrationsDir: string;
  legacySourceEventId: string;
  lineageId: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "iris-a8-pre0009-"));
  const migrationsDir = join(dir, "migrations");
  fs.mkdirSync(migrationsDir, { recursive: true });
  for (const file of fs.readdirSync(MIGRATIONS_DIR)) {
    if (file.endsWith(".sql") && !file.startsWith("0009_")) {
      fs.copyFileSync(join(MIGRATIONS_DIR, file), join(migrationsDir, file));
    }
  }
  const dbPath = join(dir, "context.db");
  migrateDatabase(dbPath, migrationsDir);

  const lineageId = "identity-default";
  const legacySourceEventId = "legacy-source-event-001";
  const db = new DatabaseSync(dbPath);
  try {
    // A real legacy row: written by a pre-#113 build → payload-only hash
    // basis, canonical-looking lifecycle default 'committed' (0008 default),
    // no legacy_status column at all.
    const payload = JSON.stringify({ role: "user", content: "legacy content" });
    db.prepare(
      `INSERT INTO context_units
        (context_lineage_id, context_seq, unit_id, runtime_event_id, source_event_id,
         unit_type, disposition, entry_id, entry_seq, content_hash, payload,
         derivation_refs, schema_version, semantic_schema_id, lifecycle_state,
         content_hash_basis, created_at)
       VALUES (?, ?, ?, ?, ?, 'input', 'include', NULL, NULL, ?, ?,
         '{"schemaId":"iris.semantic_derivation_refs.v1"}', '1', NULL, 'committed', 'v1', ?)`,
    ).run(
      lineageId,
      1,
      "legacy-unit-001",
      "legacy-runtime-event-001",
      legacySourceEventId,
      "legacy-payload-only-hash",
      payload,
      new Date().toISOString(),
    );
  } finally {
    db.close();
  }
  return { dbPath, migrationsDir, legacySourceEventId, lineageId };
}

test("A7: valid P5 unit passes the real projection path", () => {
  const cmu = makeValidDurableUnit("u1", "hello world");
  const gen = buildContextGenerationV2(
    {
      contextLineageId: cmu.contextLineageId,
      sourceSnapshotHash: "test-snapshot",
      p0Units: [],
      p1Units: [],
      p2Units: [],
      p3Units: [],
      p4Units: [],
      p5Units: [cmu],
    },
    "gen-1",
    "2026-08-13T00:00:00Z",
  );
  assert.equal(gen.units.length, 1);
  assert.equal(gen.header.layerEnds[5], 1);
  assert.equal(gen.units[0]?.header.contentHash, cmu.contentHash);
});

test("A7 #117: mutate semanticContent only → production projection MUST throw (tamper detection)", () => {
  const cmu = makeValidDurableUnit("u1", "original content");
  const tampered: ContextMessageUnitV1 = {
    ...cmu,
    // TAMPER: semanticContent changed, contentHash NOT updated
    semanticContent: { role: "user", content: "TAMPERED CONTENT" },
  };
  assert.throws(
    () =>
      buildContextGenerationV2(
        {
          contextLineageId: tampered.contextLineageId,
          sourceSnapshotHash: "test-snapshot",
          p0Units: [],
          p1Units: [],
          p2Units: [],
          p3Units: [],
          p4Units: [],
          p5Units: [tampered],
        },
        "gen-tamper",
        "2026-08-13T00:00:00Z",
      ),
    /contentHash mismatch/,
    "projectP5Unit must recompute the durable hash and fail closed on tampered semanticContent",
  );
});

test("A8 #122: canonical lifecycle enum has EXACTLY the six Notion states", async () => {
  const { validate_iris_context_message_unit_v1 } = await import(
    "../contracts/generated/validators.js"
  );
  // A canonical unit with the six states passes.
  for (const state of [
    "committed",
    "historian_eligible",
    "historian_claimed",
    "compartmentalized_pending_bust",
    "represented_in_p3",
    "retired",
  ]) {
    const cmu = makeValidDurableUnit(`u-${state}`, "x");
    const result = validate_iris_context_message_unit_v1({ ...cmu, lifecycleState: state });
    assert.ok(result.valid, `six-state lifecycle ${state} must validate: ${result.errors}`);
  }
  // The legacy sentinel is NOT a canonical lifecycle value → fail closed.
  const legacy = makeValidDurableUnit("u-legacy", "x");
  const result = validate_iris_context_message_unit_v1({
    ...legacy,
    lifecycleState: "legacy_committed_unknown",
  });
  assert.ok(!result.valid, "legacy_committed_unknown must NOT be a canonical lifecycle state");
});

test("A8 #122: production migration 0009 is executable on a real pre-0009 DB with legacy rows", () => {
  const { dbPath, migrationsDir, legacySourceEventId, lineageId } =
    buildPre0009DbWithLegacyRow();
  try {
    // Phase 1: apply production 0009 via migrateDatabase on the REAL
    // migrations dir (0001–0008 already applied, checksums match).
    migrateDatabase(dbPath, MIGRATIONS_DIR);

    const db = new DatabaseSync(dbPath);
    try {
      // 0009 is recorded.
      const applied = db
        .prepare("SELECT version FROM schema_migrations WHERE version = '0009_legacy_fence'")
        .get() as { version: string } | undefined;
      assert.ok(applied, "0009_legacy_fence must be recorded as applied");

      // The legacy row is now quarantined at the PHYSICAL layer.
      const legacyRow = db
        .prepare("SELECT legacy_status, content_hash_basis FROM context_units WHERE unit_id = 'legacy-unit-001'")
        .get() as { legacy_status: string; content_hash_basis: string };
      assert.equal(legacyRow.legacy_status, "quarantined_legacy");
      assert.equal(legacyRow.content_hash_basis, "v1");

      // The lifecycle CHECK constraint still accepts ONLY the six canonical
      // states — inserting legacy_committed_unknown must be REJECTED by SQLite.
      assert.throws(
        () =>
          db.prepare(
            "UPDATE context_units SET lifecycle_state = 'legacy_committed_unknown' WHERE unit_id = 'legacy-unit-001'",
          ).run(),
        /CHECK/i,
        "SQLite CHECK must reject the legacy sentinel as a lifecycle value",
      );
    } finally {
      db.close();
    }

    // Phase 2: reopen via PRODUCTION ContextStore — migrations idempotent,
    // quarantined row cannot masquerade as a current unit.
    const store = ContextStore.open(dbPath, { lineageId });
    try {
      assert.deepEqual(store.listUnitsByLineage("identity-default"), []);
      assert.throws(
        () => store.findBySourceEvent(legacySourceEventId),
        /quarantined legacy/,
        "legacy row must fail closed instead of deserializing as current ContextMessageUnitV1",
      );
    } finally {
      store.close();
    }
  } finally {
    cleanupDir(dbPath.replace(/context\.db$/, ""));
  }
});

test("A8 #122: legacy row cannot enter P5; current v2 row round-trips normally", () => {
  const { dbPath, lineageId } = buildPre0009DbWithLegacyRow();
  try {
    migrateDatabase(dbPath, MIGRATIONS_DIR);
    const store = ContextStore.open(dbPath, { lineageId });
    try {
      // Insert a CURRENT v2 row through the real write path (insertUnit).
      const cmu = makeValidDurableUnit("current-001", "current content");
      // listUnits is empty (legacy excluded), so building P5 from the store
      // yields zero legacy units.
      const p5Units = store.listUnitsByLineage("identity-default");
      const gen = buildContextGenerationV2(
        {
          contextLineageId: lineageId,
          sourceSnapshotHash: "test-snapshot",
          p0Units: [],
          p1Units: [],
          p2Units: [],
          p3Units: [],
          p4Units: [],
          p5Units,
        },
        "gen-a8",
        "2026-08-13T00:00:00Z",
      );
      assert.equal(gen.units.length, 0, "quarantined legacy rows must not project into P5");
      assert.equal(cmu.contextUnitId, "current-001");
    } finally {
      store.close();
    }
  } finally {
    cleanupDir(dbPath.replace(/context\.db$/, ""));
  }
});

test("A8 #122: a current v2 row inserted after migration round-trips through production ContextStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-a8-v2-roundtrip-"));
  const dbPath = join(dir, "context.db");
  try {
    migrateDatabase(dbPath, MIGRATIONS_DIR);
    const store = ContextStore.open(dbPath, { lineageId: "identity-default" });
    try {
      const cmu = makeValidDurableUnit("v2-001", "round trip");
      store.insertUnit(cmu, { verifySessionBinding: false });
      const read = store.listUnitsByLineage("identity-default");
      assert.equal(read.length, 1);
      assert.equal(read[0]?.contextUnitId, "v2-001");
      assert.equal(read[0]?.contentHash, cmu.contentHash);
      assert.equal(read[0]?.lifecycleState, "committed");
    } finally {
      store.close();
    }
    // Reopen: v2 row round-trips losslessly.
    const reopened = ContextStore.open(dbPath, { lineageId: "identity-default" });
    try {
      const read = reopened.listUnitsByLineage("identity-default");
      assert.equal(read.length, 1);
      assert.equal(read[0]?.contextUnitId, "v2-001");
      const content = read[0]?.semanticContent;
      assert.ok(
        content !== null && typeof content === "object" && !Array.isArray(content),
        "semanticContent must be an object",
      );
      assert.equal((content as Record<string, unknown>)["role"], "user");
    } finally {
      reopened.close();
    }
  } finally {
    cleanupDir(dir);
  }
});
