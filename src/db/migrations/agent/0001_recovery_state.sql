-- iris_agent#68: Runtime Recovery Supervisor durable state.
--
-- Survives restart and Runtime Session rollover. The supervisor reads this on
-- startup to resume a partially-exhausted recovery budget so a rollover cannot
-- silently reset it. One row per logical_execution_id (stable across epoch
-- rollovers for the same logical invocation).

CREATE TABLE IF NOT EXISTS recovery_state (
  logical_execution_id TEXT PRIMARY KEY,
  same_model_attempts INTEGER NOT NULL DEFAULT 0,
  current_model TEXT,
  fallback_index INTEGER NOT NULL DEFAULT 0,
  failed_models TEXT NOT NULL DEFAULT '{}',  -- JSON: {model: cooldownUntilISO}
  outcome_unknown INTEGER NOT NULL DEFAULT 0,
  exhausted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
