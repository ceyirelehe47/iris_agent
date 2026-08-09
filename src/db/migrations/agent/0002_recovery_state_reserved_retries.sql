-- iris_agent#90: reserved-dispatch retries must survive restart/rollover.
--
-- Previously `reservedRetries` was process-local state in the Recovery
-- Supervisor; a restart silently reset the bounded acquisition budget. This
-- forward migration adds the durable column. Fresh databases get the column
-- here (after 0001); existing databases are upgraded in place with a default
-- of 0, which is the correct starting value for a logical execution that has
-- not yet consumed any reserved-dispatch retry.

ALTER TABLE recovery_state ADD COLUMN reserved_retries INTEGER NOT NULL DEFAULT 0;
