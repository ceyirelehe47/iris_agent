import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { migrateDatabase } from "../db/migrate.js";

/**
 * iris_agent#68: durable recovery state for the Runtime Recovery Supervisor.
 *
 * The supervisor's escalation budget (same-model retries, fallback index,
 * failed-model cooldowns, exhaustion flag) is durable: a process restart or
 * Runtime Session rollover must NOT silently reset it. This module owns the
 * SQLite table `recovery_state` (migration 0001_recovery_state.sql) and exposes
 * load / save primitives. The supervisor is the sole writer.
 *
 * One row per `logicalExecutionId` — a stable id that survives epoch rollover
 * for the same logical invocation.
 */

export type RetryClassification =
  | "transient_retryable" // 429/5xx/network — same-model retry
  | "model_not_found" // skip directly to fallback
  | "quota_exhausted" // skip directly to fallback
  | "provider_unavailable" // skip directly to fallback
  | "context_overflow" // do NOT retry (terminal)
  | "semantic_failure" // do NOT retry (terminal)
  | "abort" // do NOT retry (terminal)
  | "outcome_unknown" // reconcile before replay
  | "reserved_dispatch" // bounded retry acquisition (does not consume fallback)
  | "terminal";

export interface FallbackConfig {
  /** Ordered fallback chain (model identifiers). */
  models: string[];
  /** Same-model transient retry budget per fallback slot. Default 3. */
  sameModelRetryBudget: number;
  /** Maximum number of fallback attempts. Default 3. */
  fallbackAttemptBudget: number;
  /** Cooldown before a failed model may be retried. Default 60000 (60s). */
  failedModelCooldownMs: number;
  /** Watchdog: abort a fallback model if no progress in this window. Default 30000 (30s). */
  fallbackNoProgressTimeoutMs: number;
  /** Watchdog: abort a subagent if no first progress in this window. Default 90000 (90s). */
  subagentFirstProgressMs: number;
  /** Bounded retries for reserved-dispatch acquisition. Default 6 (linear). */
  reservedDispatchRetries: number;
  /** Overall recovery budget across all strategies. Default 600000 (10min). */
  overallBudgetMs: number;
}

export function defaultFallbackConfig(models: string[]): FallbackConfig {
  return {
    models,
    sameModelRetryBudget: 3,
    fallbackAttemptBudget: 3,
    failedModelCooldownMs: 60000,
    fallbackNoProgressTimeoutMs: 30000,
    subagentFirstProgressMs: 90000,
    reservedDispatchRetries: 6,
    overallBudgetMs: 600000,
  };
}

/**
 * The mutable recovery counters for one logical execution.
 *
 * `failedModels` maps a model id to an ISO-8601 timestamp after which it may be
 * considered again (cooldown expiry). The supervisor writes a fresh snapshot to
 * SQLite after every transition via {@link RecoveryStateStore.save}.
 */
export interface RecoveryStateSnapshot {
  logicalExecutionId: string;
  sameModelAttempts: number;
  currentModel: string | null;
  fallbackIndex: number;
  failedModels: Record<string, string>;
  outcomeUnknown: number;
  exhausted: boolean;
  createdAt: string;
  updatedAt: string | null;
}

interface RecoveryStateRow {
  logical_execution_id: string;
  same_model_attempts: number;
  current_model: string | null;
  fallback_index: number;
  failed_models: string;
  outcome_unknown: number;
  exhausted: number;
  created_at: string;
  updated_at: string | null;
}

function rowToSnapshot(row: RecoveryStateRow): RecoveryStateSnapshot {
  const parsed = JSON.parse(row.failed_models) as unknown;
  const failedModels =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  return {
    logicalExecutionId: row.logical_execution_id,
    sameModelAttempts: row.same_model_attempts,
    currentModel: row.current_model,
    fallbackIndex: row.fallback_index,
    failedModels,
    outcomeUnknown: row.outcome_unknown,
    exhausted: row.exhausted === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function snapshotToRow(snapshot: RecoveryStateSnapshot): {
  logical_execution_id: string;
  same_model_attempts: number;
  current_model: string | null;
  fallback_index: number;
  failed_models: string;
  outcome_unknown: number;
  exhausted: number;
  created_at: string;
  updated_at: string | null;
} {
  return {
    logical_execution_id: snapshot.logicalExecutionId,
    same_model_attempts: snapshot.sameModelAttempts,
    current_model: snapshot.currentModel,
    fallback_index: snapshot.fallbackIndex,
    failed_models: JSON.stringify(snapshot.failedModels),
    outcome_unknown: snapshot.outcomeUnknown,
    exhausted: snapshot.exhausted ? 1 : 0,
    created_at: snapshot.createdAt,
    updated_at: snapshot.updatedAt,
  };
}

/**
 * SQLite-backed store for {@link RecoveryStateSnapshot}.
 *
 * Constructed with a database file path; the recovery_state migration is
 * applied on first open. The store is the single durable writer for recovery
 * state — the supervisor holds one instance.
 */
export class RecoveryStateStore {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    const migrationRoot = fileURLToPath(new URL("../db/migrations", import.meta.url));
    migrateDatabase(databasePath, join(migrationRoot, "agent"));
  }

  /** Load an existing snapshot, or return undefined when no row exists. */
  load(logicalExecutionId: string): RecoveryStateSnapshot | undefined {
    const row = this.db
      .prepare("SELECT * FROM recovery_state WHERE logical_execution_id = ?")
      .get(logicalExecutionId) as RecoveryStateRow | undefined;
    return row === undefined ? undefined : rowToSnapshot(row);
  }

  /**
   * Insert or update a snapshot. `updatedAt` is always set to now. Use this
   * after every recovery transition so durability holds across restart.
   */
  save(snapshot: RecoveryStateSnapshot): void {
    const now = new Date().toISOString();
    const row = snapshotToRow({ ...snapshot, updatedAt: now });
    this.db
      .prepare(
        `INSERT INTO recovery_state (
           logical_execution_id, same_model_attempts, current_model,
           fallback_index, failed_models, outcome_unknown, exhausted,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(logical_execution_id) DO UPDATE SET
           same_model_attempts = excluded.same_model_attempts,
           current_model = excluded.current_model,
           fallback_index = excluded.fallback_index,
           failed_models = excluded.failed_models,
           outcome_unknown = excluded.outcome_unknown,
           exhausted = excluded.exhausted,
           updated_at = excluded.updated_at`,
      )
      .run(
        row.logical_execution_id,
        row.same_model_attempts,
        row.current_model,
        row.fallback_index,
        row.failed_models,
        row.outcome_unknown,
        row.exhausted,
        row.created_at,
        row.updated_at,
      );
  }

  /** Remove a snapshot (e.g. after successful settlement). */
  delete(logicalExecutionId: string): void {
    this.db
      .prepare("DELETE FROM recovery_state WHERE logical_execution_id = ?")
      .run(logicalExecutionId);
  }

  close(): void {
    this.db.close();
  }
}

/** Build a fresh snapshot for a new logical execution. */
export function freshRecoveryState(logicalExecutionId: string, now: string): RecoveryStateSnapshot {
  return {
    logicalExecutionId,
    sameModelAttempts: 0,
    currentModel: null,
    fallbackIndex: 0,
    failedModels: {},
    outcomeUnknown: 0,
    exhausted: false,
    createdAt: now,
    updatedAt: null,
  };
}
