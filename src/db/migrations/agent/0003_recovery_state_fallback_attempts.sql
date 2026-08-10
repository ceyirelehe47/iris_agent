-- iris_agent#89/#90: fallback attempt count must survive restart/rollover.
ALTER TABLE recovery_state ADD COLUMN fallback_attempts INTEGER NOT NULL DEFAULT 0;
