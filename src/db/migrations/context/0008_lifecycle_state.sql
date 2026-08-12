-- Feature A5 (iris_agent#113): lossless ContextMessageUnitV1 persistence.
--
-- 1) lifecycle_state — the canonical unit lifecycle (committed →
--    historian_eligible → historian_claimed → compartmentalized_pending_bust
--    → represented_in_p3 → retired) must survive restart. Before this
--    migration the read path fabricated lifecycleState: 'committed' for every
--    row, so historian_eligible/historian_claimed/... were lost. Existing
--    rows default to 'committed' (their true persisted lifecycle is unknown
--    before this migration — 'committed' is the safe base state).
--
-- 2) content_hash_basis — rows written before #113 carry a payload-only
--    content_hash ('v1'); rows written by this feature use the one versioned
--    canonical basis ('v2': semanticContent + kind + historianDisposition +
--    derivationRefs + semanticSchemaId). The read path verifies the stored
--    content_hash against the row's declared basis and fails closed on
--    mismatch (tamper detection). 'v1' rows stay verifiable (payload tamper
--    still fails closed) and are explicitly fenced as legacy until a pairing
--    update or rewrite migrates them to 'v2'.

ALTER TABLE context_units ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'committed' CHECK (
  lifecycle_state IN (
    'committed',
    'historian_eligible',
    'historian_claimed',
    'compartmentalized_pending_bust',
    'represented_in_p3',
    'retired'
  )
);

ALTER TABLE context_units ADD COLUMN content_hash_basis TEXT NOT NULL DEFAULT 'v1' CHECK (
  content_hash_basis IN ('v1', 'v2')
);
