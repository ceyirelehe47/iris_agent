-- iris_agent#102: durable pending outcome_unknown state.
--
-- Previously the recovery snapshot only persisted an integer `outcome_unknown`
-- counter. A crash/restart after a possibly-accepted dispatch therefore could
-- not restore the typed pending ambiguity (dispatch identity + model + when it
-- occurred) needed to reconcile BEFORE any replay dispatch, and a restart could
-- silently turn `still ambiguous` into attempt zero.
--
-- This forward migration adds a TEXT column storing the JSON-serialized
-- pending outcome_unknown record (or NULL when no dispatch is pending). Fresh
-- databases get the column here (after 0003); existing databases are upgraded
-- in place with a default of NULL, which is the correct starting value for a
-- logical execution with no pending ambiguity.

ALTER TABLE recovery_state ADD COLUMN pending_outcome_unknown TEXT;
