-- iris_agent#90: fallback attempt count must survive restart/rollover.
--
-- Previously `fallbackAttempts` was a process-local variable inside
-- RecoverySupervisor.prompt(); a restart silently reset the fallback budget
-- for the same logical execution. This forward migration adds the durable
-- column. Fresh databases get the column here (after 0002); existing databases
-- are upgraded in place with a default of 0, which is the correct starting
-- value for a logical execution that has not yet consumed any fallback attempt.

ALTER TABLE recovery_state ADD COLUMN fallback_attempts INTEGER NOT NULL DEFAULT 0;
