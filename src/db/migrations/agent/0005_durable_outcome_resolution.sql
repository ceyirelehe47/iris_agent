-- Feature D6 (iris_agent#118): durable outcome resolution.
--
-- When outcome_unknown reconciliation returns confirmed_applied, the
-- resolution must be persisted so that:
-- 1. A process restart does NOT re-query external subsystems.
-- 2. The resolution carries durable evidence identity (not a fabricated claim).
-- 3. The resolution is tied to the exact logicalExecutionId + inputId + dispatchId.
--
-- This table stores one resolution per logical execution. The recovery
-- supervisor reads it on startup BEFORE any provider dispatch.

CREATE TABLE IF NOT EXISTS durable_outcome_resolution (
  logical_execution_id TEXT PRIMARY KEY NOT NULL,
  input_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL,
  resolution TEXT NOT NULL CHECK (resolution IN ('confirmed_applied', 'replay_safe', 'ambiguous')),
  -- The subsystem that provided the evidence (e.g. 'pi_session', 'memory_publication').
  evidence_source TEXT NOT NULL,
  -- A hash/ref/identity pointing to the durable proof (e.g. receipt hash).
  evidence_ref TEXT NOT NULL,
  resolved_at TEXT NOT NULL,
  -- The recovery snapshot state at resolution time (for audit).
  resolved_state_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_durable_outcome_input
  ON durable_outcome_resolution(input_id);
