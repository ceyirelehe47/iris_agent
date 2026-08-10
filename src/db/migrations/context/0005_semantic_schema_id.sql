-- Feature A (#103): Add semantic_schema_id to context_units.
--
-- Per v27 Notion spec, ContextMessageUnitV1 carries a semanticSchemaId that
-- is the canonical semantic type discriminator. P5 projection must reuse this
-- 1:1 rather than re-deriving it from unitType via a second mapper.
--
-- This migration adds the column with a deterministic default derived from
-- the existing unit_type value, so existing rows get a valid semanticSchemaId
-- without ambiguity.
--
-- Default mapping (matching KIND_TO_SEMANTIC_SCHEMA_ID):
--   input       → iris.semantic.context_message.user.v1
--   assistant   → iris.semantic.context_message.assistant.v1
--   tool_result → iris.semantic.context_message.tool_result.v1

ALTER TABLE context_units ADD COLUMN semantic_schema_id TEXT;

-- Backfill existing rows deterministically from unit_type.
UPDATE context_units SET semantic_schema_id = CASE
  WHEN unit_type = 'input' THEN 'iris.semantic.context_message.user.v1'
  WHEN unit_type = 'assistant' THEN 'iris.semantic.context_message.assistant.v1'
  WHEN unit_type = 'tool_result' THEN 'iris.semantic.context_message.tool_result.v1'
  ELSE 'iris.semantic.context_message.unknown.v1'
END;

-- After backfill, enforce NOT NULL on new rows.
-- SQLite does not support adding NOT NULL to existing columns directly,
-- so the application layer enforces it for new inserts.
