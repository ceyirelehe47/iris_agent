/**
 * iris_agent#107 AC 11: Real Host integration tests.
 *
 * Covers:
 * - Provider-id collision: duplicate bare model IDs fail closed
 * - Durable pending identity: PendingOutcomeUnknown carries logicalExecutionId + inputId
 * - Malformed JSON fail-closed: parsePendingOutcomeUnknown never returns null for non-empty input
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { resolveFallbackModel } from "../src/runtime/runtime-coordinator.js";
import { RecoveryStateStore, type RecoveryStateSnapshot } from "../src/runtime/recovery-state.js";
import type { PendingOutcomeUnknown } from "../src/runtime/recovery-state.js";
import type { Model } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Helper: create a Model with provider+id
// ---------------------------------------------------------------------------
function makeModel(provider: string, id: string): Model<string> {
  return {
    id,
    provider,
    contextLength: 4096,
    maxOutputTokens: 2048,
    supportsToolCalls: true,
    supportsSystemPrompt: true,
    extra: {},
  } as unknown as Model<string>;
}

test("#107 AC1: duplicate bare model IDs across providers fail closed", () => {
  const catalog: Model<string>[] = [
    makeModel("provider-a", "shared-model"),
    makeModel("provider-b", "shared-model"),
  ];

  // Bare id with duplicates → undefined (fail closed)
  const bare = resolveFallbackModel(catalog, "shared-model");
  assert.equal(bare, undefined, "duplicate bare model id must not select a first match");

  // Qualified provider/model resolves uniquely
  const qualified = resolveFallbackModel(catalog, "provider-a/shared-model");
  assert.ok(qualified !== undefined, "qualified provider/model must resolve");
  assert.equal(qualified.provider, "provider-a");
  assert.equal(qualified.id, "shared-model");

  // Unique bare id still works
  const unique = resolveFallbackModel([makeModel("p", "unique-model")], "unique-model");
  assert.ok(unique !== undefined, "unique bare model id must resolve");
});

test("#107 AC1: non-existent model returns undefined (fail closed)", () => {
  const catalog: Model<string>[] = [makeModel("provider-a", "model-1")];

  const missing = resolveFallbackModel(catalog, "nonexistent");
  assert.equal(missing, undefined, "non-existent model must return undefined");

  const wrongProvider = resolveFallbackModel(catalog, "provider-z/model-1");
  assert.equal(wrongProvider, undefined, "wrong provider must return undefined");
});

test("#107 AC6: RecoveryStateStore.load preserves durable logicalExecutionId + inputId in pending", () => {
  // This test exercises the REAL persistence layer: writes a snapshot with
  // logicalExecutionId and inputId, then loads it back and verifies the
  // pending record carries these durable identity fields.
  const path = `/tmp/test-durable-pending-${Date.now()}.db`;
  const store = new RecoveryStateStore(path);

  // Save a snapshot with a pending record that has the new identity fields
  const snapshot: RecoveryStateSnapshot = {
    logicalExecutionId: "exec-durable-123",
    sameModelAttempts: 1,
    currentModel: "test-model",
    fallbackIndex: 0,
    failedModels: {},
    outcomeUnknown: 1,
    reservedRetries: 0,
    fallbackAttempts: 0,
    exhausted: false,
    pendingOutcomeUnknown: {
      dispatchId: "dispatch-456",
      logicalExecutionId: "exec-durable-123",
      inputId: "input-789",
      model: "test-model",
      occurredAt: "2026-01-01T00:00:00Z",
      detail: "test ambiguity",
    } satisfies PendingOutcomeUnknown,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  store.save(snapshot);
  store.close();

  // Reopen and verify the durable identity survives persistence
  const store2 = new RecoveryStateStore(path);
  const loaded = store2.load("exec-durable-123") as RecoveryStateSnapshot | null;
  store2.close();

  assert.ok(loaded !== null, "snapshot must load");
  assert.ok(loaded.pendingOutcomeUnknown !== null, "pending must be preserved");

  const pending = loaded.pendingOutcomeUnknown as PendingOutcomeUnknown;
  assert.equal(
    pending.logicalExecutionId,
    "exec-durable-123",
    "logicalExecutionId must survive persistence/restart",
  );
  assert.equal(pending.inputId, "input-789", "inputId must survive persistence/restart");
  assert.notEqual(
    pending.logicalExecutionId,
    pending.dispatchId,
    "logicalExecutionId must NOT equal dispatchId — they are different identity layers",
  );
});

test("#107 AC7: malformed pending JSON (valid parse, missing fields) stays fail-closed via store.load", () => {
  // This test exercises the REAL parsePendingOutcomeUnknown through the
  // public RecoveryStateStore.load API — no mocking, no local literals.
  const path = `/tmp/test-malformed-pending-${Date.now()}.db`;
  const store = new RecoveryStateStore(path);
  store.close();

  // Inject a structurally malformed pending JSON directly into the DB
  const db = new DatabaseSync(path);
  db.exec(`
    INSERT OR REPLACE INTO recovery_state (
      logical_execution_id, same_model_attempts, current_model,
      fallback_index, failed_models, outcome_unknown,
      reserved_retries, fallback_attempts, exhausted,
      pending_outcome_unknown, created_at, updated_at
    ) VALUES (
      'exec-malformed', 0, 'test-model',
      0, '{}', 0,
      0, 0, 0,
      '{"randomField":"not-a-valid-pending"}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    )
  `);
  db.close();

  // Load must NOT return pendingOutcomeUnknown === null for this malformed JSON.
  // It must produce a synthetic fail-closed pending.
  const store2 = new RecoveryStateStore(path);
  const loaded = store2.load("exec-malformed") as RecoveryStateSnapshot | null;
  store2.close();

  assert.ok(loaded !== null, "state must load");
  assert.ok(
    loaded.pendingOutcomeUnknown !== null,
    "malformed JSON must NOT silently return null — must stay fail-closed",
  );

  const pending = loaded.pendingOutcomeUnknown as PendingOutcomeUnknown;
  assert.ok(
    pending.dispatchId.includes("malformed") ||
      pending.dispatchId.includes("corrupt") ||
      pending.dispatchId.includes("unknown"),
    "malformed pending must produce a synthetic fail-closed dispatchId",
  );
});
