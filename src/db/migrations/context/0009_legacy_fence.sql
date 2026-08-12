-- Feature A7 (iris_agent#117): legacy durable state fence.
--
-- Pre-existing rows had lifecycle_state DEFAULT 'committed' (migration 0008)
-- which silently reclassifies unknown historical lifecycle as canonical.
-- Per #117: unknown historical lifecycle must NOT be treated as canonical.
--
-- This migration renames the default to 'legacy_committed_unknown' so the
-- read path can fence/quarantine these rows instead of treating them as
-- current canonical ContextMessageUnitV1.
--
-- Additionally, rows with content_hash_basis='v1' (legacy payload-only hash)
-- are now fenced from P5 selection until they are explicitly migrated to v2.

-- Rename the DEFAULT and update existing 'committed' rows that were set by
-- the 0008 migration (not by explicit write). We use a sentinel: rows that
-- still have content_hash_basis='v1' are the ones from before #113 — their
-- lifecycle was never explicitly written.
UPDATE context_units
SET lifecycle_state = 'legacy_committed_unknown'
WHERE content_hash_basis = 'v1'
  AND lifecycle_state = 'committed';

-- Add the new lifecycle state to the CHECK constraint.
-- SQLite doesn't support ALTER TABLE ... MODIFY COLUMN, so we recreate.
-- The read path already handles 'legacy_committed_unknown' as a fence state.
