-- Round 7 (iris_agent#122): legacy durable rows are fenced PHYSICALLY, not via
-- the canonical lifecycle enum.
--
-- The canonical lifecycle enum is exactly the six Notion states
-- (committed / historian_eligible / historian_claimed /
-- compartmentalized_pending_bust / represented_in_p3 / retired) and stays
-- unchanged. `legacy_status` is a PHYSICAL migration-status column owned by
-- the persistence layer: it is NOT a ContextMessageUnitV1 lifecycle value and
-- never appears in `iris.context_message_unit.v1`.
--
-- Rows with content_hash_basis='v1' carry a pre-#113 payload-only hash whose
-- canonical semantic meaning (kind/disposition/derivation/schema identity)
-- cannot be proven. They are quarantined and cannot deserialize as current
-- ContextMessageUnitV1 until an explicit verified migration/rebuild rewrites
-- them to 'v2'. The read path fails closed on quarantined rows.

ALTER TABLE context_units ADD COLUMN legacy_status TEXT NOT NULL DEFAULT 'none' CHECK (
  legacy_status IN ('none', 'quarantined_legacy')
);

UPDATE context_units
SET legacy_status = 'quarantined_legacy'
WHERE content_hash_basis = 'v1';
