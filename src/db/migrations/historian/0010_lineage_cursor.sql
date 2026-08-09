-- iris_agent#84: the Historian's processedThroughContextSeq MUST be durable at
-- Context-lineage scope, not Runtime Session scope. A Session rollover creates
-- a new runtime_session_id with no prior cursor row, causing Session B to
-- re-claim Context units that Session A already processed.
--
-- This migration adds a lineage-keyed cursor table that is the AUTHORITATIVE
-- semantic boundary. session_state.processed_through_context_seq becomes a
-- secondary attribution column that is always derived from (or reconciled
-- against) the lineage cursor on read.
--
-- lineage_cursors is keyed by context_lineage_id (one Iris identity/data root).
-- processed_through_context_seq: highest committed contextSeq (exclusive cursor;
--   next eligible batch starts at +1).
-- observed_head_context_seq: frozen head in Context coordinates (attribution).

CREATE TABLE IF NOT EXISTS lineage_cursors (
  lineage_id TEXT PRIMARY KEY,
  processed_through_context_seq INTEGER NOT NULL DEFAULT 0,
  observed_head_context_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Backfill: derive lineage_cursors from the highest known per-session cursor
-- for each lineage_id. The boundary_snapshots table carries lineage_id (added
-- by migration 0009) and the highest eligible_through_context_seq per lineage
-- is the conservative starting watermark — a lineage that never had a boundary
-- snapshot starts at 0 (safe: nothing processed). We use boundary_snapshots
-- because session_state does not carry lineage_id (it is keyed by runtime_session_id).
INSERT OR IGNORE INTO lineage_cursors (lineage_id, processed_through_context_seq, observed_head_context_seq, updated_at)
SELECT
  bs.lineage_id,
  MAX(bs.eligible_through_context_seq),
  MAX(bs.observed_head_context_seq),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM boundary_snapshots bs
WHERE bs.lineage_id != ''
GROUP BY bs.lineage_id;
