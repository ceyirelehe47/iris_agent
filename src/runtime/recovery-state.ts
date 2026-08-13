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
  /**
   * iris_agent#100: how long the supervisor waits for a positively validated
   * abort/settled boundary after a watchdog fires before treating the abort
   * as failed and entering the fail-closed state. Default 15000 (matches the
   * RuntimeCoordinator abort settlement timeout).
   */
  abortSettlementTimeoutMs: number;
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
    abortSettlementTimeoutMs: 15000,
  };
}

/**
 * iris_agent#102: typed pending outcome_unknown state for one logical
 * execution.
 *
 * Persisted durably (JSON column `pending_outcome_unknown`) BEFORE any
 * reconciliation runs, so a crash/restart after a possibly-accepted dispatch
 * restores the exact pending ambiguity instead of only a bare counter. The
 * supervisor reconciles it before ANY provider dispatch on restart and never
 * clears it while the outcome is still ambiguous.
 */
export interface PendingOutcomeUnknown {
  /**
   * Stable logical dispatch identity (the native invocationId).
   * This is the dispatch-level id, NOT the logical execution id.
   */
  dispatchId: string;
  /**
   * #107: The stable logical execution id for this pending ambiguity.
   * This is the same id used by the RecoveryStateSnapshot and persists
   * across restarts. On restart, reconciliation MUST use this id —
   * never the dispatchId or a borrowed current input id.
   */
  logicalExecutionId: string;
  /**
   * #107: The input/effect idempotency identity for this pending dispatch.
   * Carries the stable input identity needed for same-logical-execution
   * reconciliation. On restart, this is read from the pending record,
   * not reconstructed from the current prompt.
   */
  inputId: string;
  /** The model that was active for the possibly-accepted dispatch. */
  model: string | null;
  /** ISO-8601 timestamp of when the ambiguity was recorded. */
  occurredAt: string;
  /** Diagnostic detail from the native failure signal. */
  detail?: string | undefined;
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
  /** Reserved-dispatch retries consumed (iris_agent#90: durable across restart). */
  reservedRetries: number;
  /**
   * Total fallback attempts consumed (iris_agent#89/#90: durable across
   * restart so a process restart cannot reset the fallback budget).
   */
  fallbackAttempts: number;
  exhausted: boolean;
  /**
   * iris_agent#102: typed pending outcome_unknown record, or null when no
   * dispatch is pending ambiguity. Persisted before reconciliation and only
   * cleared after the reconciliation disposition is persisted.
   */
  pendingOutcomeUnknown: PendingOutcomeUnknown | null;
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
  reserved_retries: number;
  fallback_attempts: number;
  exhausted: number;
  pending_outcome_unknown: string | null;
  created_at: string;
  updated_at: string | null;
}

function rowToSnapshot(row: RecoveryStateRow): RecoveryStateSnapshot {
  const parsed = JSON.parse(row.failed_models) as unknown;
  const failedModels =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  const pending = parsePendingOutcomeUnknown(row.pending_outcome_unknown);
  return {
    logicalExecutionId: row.logical_execution_id,
    sameModelAttempts: row.same_model_attempts,
    currentModel: row.current_model,
    fallbackIndex: row.fallback_index,
    failedModels,
    outcomeUnknown: row.outcome_unknown,
    reservedRetries: row.reserved_retries,
    fallbackAttempts: row.fallback_attempts,
    exhausted: row.exhausted === 1,
    pendingOutcomeUnknown: pending,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parsePendingOutcomeUnknown(raw: string | null): PendingOutcomeUnknown | null {
  if (raw === null || raw === "") {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as { dispatchId?: unknown }).dispatchId === "string" &&
      typeof (parsed as { occurredAt?: unknown }).occurredAt === "string"
    ) {
      const p = parsed as Record<string, unknown>;
      return {
        dispatchId: p["dispatchId"] as string,
        // iris_agent#111: NEVER substitute dispatchId for logicalExecutionId.
        // Old records missing logicalExecutionId are LEGACY — fail closed by
        // returning a synthetic pending that blocks all provider dispatch
        // until an explicit migration or verified reconciliation resolves it.
        // The legacy fence uses "unknown-legacy-pending" as a sentinel that
        // no real reconciliation will accept as replay-safe.
        logicalExecutionId:
          typeof p["logicalExecutionId"] === "string"
            ? p["logicalExecutionId"]
            : "unknown-legacy-pending",
        // iris_agent#111: never guess inputId from current state.
        inputId: typeof p["inputId"] === "string" ? p["inputId"] : "unknown-legacy-pending",
        model: typeof p["model"] === "string" ? p["model"] : null,
        occurredAt: p["occurredAt"] as string,
        ...(p["detail"] !== undefined ? { detail: p["detail"] as string } : {}),
      };
    }
    // iris_agent#107 finding 4: structurally malformed JSON (parses but
    // missing required fields) must NOT return null — that would silently
    // drop the ambiguity fence and permit normal dispatch. Return a synthetic
    // fail-closed pending so reconciliation runs and stays fail-closed.
    return {
      dispatchId: "unknown-malformed-pending",
      logicalExecutionId: "unknown-malformed-pending",
      inputId: "unknown-malformed-pending",
      model: null,
      occurredAt: new Date(0).toISOString(),
      detail: `malformed pending_outcome_unknown payload (missing/wrong fields): ${raw.slice(0, 200)}`,
    };
  } catch {
    return {
      dispatchId: "unknown-corrupt-pending",
      logicalExecutionId: "unknown-corrupt-pending",
      inputId: "unknown-corrupt-pending",
      model: null,
      occurredAt: new Date(0).toISOString(),
      detail: `corrupt pending_outcome_unknown payload: ${raw.slice(0, 200)}`,
    };
  }
}

function snapshotToRow(snapshot: RecoveryStateSnapshot): {
  logical_execution_id: string;
  same_model_attempts: number;
  current_model: string | null;
  fallback_index: number;
  failed_models: string;
  outcome_unknown: number;
  reserved_retries: number;
  fallback_attempts: number;
  exhausted: number;
  pending_outcome_unknown: string | null;
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
    reserved_retries: snapshot.reservedRetries,
    fallback_attempts: snapshot.fallbackAttempts,
    exhausted: snapshot.exhausted ? 1 : 0,
    pending_outcome_unknown:
      snapshot.pendingOutcomeUnknown === null
        ? null
        : JSON.stringify(snapshot.pendingOutcomeUnknown),
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
   * Round 7 (#118/#125): all logical executions that still carry a durable
   * pendingOutcomeUnknown — these MUST be reconciled at Host startup BEFORE
   * any dispatch, even when their input was already appended to the Pi
   * Session (the crash window persists pending first, appends second).
   */
  listWithPendingOutcomeUnknown(): RecoveryStateSnapshot[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM recovery_state WHERE pending_outcome_unknown IS NOT NULL ORDER BY created_at",
      )
      .all() as unknown as RecoveryStateRow[];
    return rows.map(rowToSnapshot);
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
           fallback_index, failed_models, outcome_unknown, reserved_retries,
           fallback_attempts, exhausted, pending_outcome_unknown,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(logical_execution_id) DO UPDATE SET
           same_model_attempts = excluded.same_model_attempts,
           current_model = excluded.current_model,
           fallback_index = excluded.fallback_index,
           failed_models = excluded.failed_models,
           outcome_unknown = excluded.outcome_unknown,
           reserved_retries = excluded.reserved_retries,
           fallback_attempts = excluded.fallback_attempts,
           exhausted = excluded.exhausted,
           pending_outcome_unknown = excluded.pending_outcome_unknown,
           updated_at = excluded.updated_at`,
      )
      .run(
        row.logical_execution_id,
        row.same_model_attempts,
        row.current_model,
        row.fallback_index,
        row.failed_models,
        row.outcome_unknown,
        row.reserved_retries,
        row.fallback_attempts,
        row.exhausted,
        row.pending_outcome_unknown,
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
    reservedRetries: 0,
    fallbackAttempts: 0,
    exhausted: false,
    pendingOutcomeUnknown: null,
    createdAt: now,
    updatedAt: null,
  };
}

/**
 * Derive the stable logical execution identity for one accepted input.
 *
 * iris_agent#99: the identity must survive Runtime Session rollover and
 * process restart so the durable recovery budgets (retry/fallback/exhaustion)
 * and the pending outcome_unknown fence stay attached to the SAME logical
 * invocation. The Host instance epoch is the dedupe namespace and the inputId
 * is the stable input identity — neither changes when a rollover CAS swaps the
 * active Capsule.
 */
export function logicalExecutionIdFor(instanceEpoch: number, inputId: string): string {
  return `logical-exec-${instanceEpoch}:${inputId}`;
}

// ---------------------------------------------------------------------------
// D6 (#118): Durable outcome resolution — terminal state after reconciliation.
// ---------------------------------------------------------------------------

/**
 * D6 (#118): A durable, restart-stable resolution for a previously
 * outcome_unknown logical execution. After reconciliation determines the
 * outcome, this record persists the decision so that:
 *
 * - On restart, the supervisor reads the resolution and does NOT re-query
 *   external subsystems or re-dispatch.
 * - The evidence source and reference prove WHY the resolution was made.
 * - The identity (logicalExecutionId + inputId + dispatchId) is preserved
 *   for audit and prevents duplicate execution.
 *
 * This replaces the Round-5 behavior where confirmed_applied just cleared
 * pendingOutcomeUnknown and every restart re-ran the reconciler forever.
 */
export interface DurableOutcomeResolution {
  logicalExecutionId: string;
  inputId: string;
  dispatchId: string;
  /** The reconciliation result. */
  resolution: "confirmed_applied" | "replay_safe" | "ambiguous";
  /** The subsystem that provided the evidence (e.g. 'pi_session', 'memory_publication'). */
  evidenceSource: string;
  /** A hash/ref/identity pointing to the durable proof. */
  evidenceRef: string;
  /** ISO-8601 timestamp of when the resolution was recorded. */
  resolvedAt: string;
}

/**
 * D6 (#118): Store for durable outcome resolutions. Lives in the recovery
 * SQLite database alongside recovery_state. One resolution per logical
 * execution id.
 */
export class DurableOutcomeResolutionStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
  }

  /** Persist a resolution. Overwrites if one already exists for this logical execution. */
  save(resolution: DurableOutcomeResolution): void {
    this.db
      .prepare(
        `INSERT INTO durable_outcome_resolution (
           logical_execution_id, input_id, dispatch_id, resolution,
           evidence_source, evidence_ref, resolved_at, resolved_state_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(logical_execution_id) DO UPDATE SET
           input_id = excluded.input_id,
           dispatch_id = excluded.dispatch_id,
           resolution = excluded.resolution,
           evidence_source = excluded.evidence_source,
           evidence_ref = excluded.evidence_ref,
           resolved_at = excluded.resolved_at,
           resolved_state_json = excluded.resolved_state_json`,
      )
      .run(
        resolution.logicalExecutionId,
        resolution.inputId,
        resolution.dispatchId,
        resolution.resolution,
        resolution.evidenceSource,
        resolution.evidenceRef,
        resolution.resolvedAt,
        JSON.stringify({ savedAt: resolution.resolvedAt }),
      );
  }

  /** Load a resolution by logical execution id. Returns null if not found. */
  load(logicalExecutionId: string): DurableOutcomeResolution | null {
    const row = this.db
      .prepare(
        `SELECT logical_execution_id, input_id, dispatch_id, resolution,
                evidence_source, evidence_ref, resolved_at
         FROM durable_outcome_resolution
         WHERE logical_execution_id = ?`,
      )
      .get(logicalExecutionId) as
      | {
          logical_execution_id: string;
          input_id: string;
          dispatch_id: string;
          resolution: string;
          evidence_source: string;
          evidence_ref: string;
          resolved_at: string;
        }
      | undefined;

    if (row === undefined) return null;

    return {
      logicalExecutionId: row.logical_execution_id,
      inputId: row.input_id,
      dispatchId: row.dispatch_id,
      resolution: row.resolution as DurableOutcomeResolution["resolution"],
      evidenceSource: row.evidence_source,
      evidenceRef: row.evidence_ref,
      resolvedAt: row.resolved_at,
    };
  }

  /** Delete a resolution (e.g. after full successful recovery). */
  delete(logicalExecutionId: string): void {
    this.db
      .prepare("DELETE FROM durable_outcome_resolution WHERE logical_execution_id = ?")
      .run(logicalExecutionId);
  }

  close(): void {
    this.db.close();
  }
}
