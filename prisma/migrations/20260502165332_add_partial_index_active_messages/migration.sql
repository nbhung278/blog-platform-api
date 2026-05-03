-- Partial index on active (non-deleted) messages.
-- The hot path always filters WHERE deleted_at IS NULL.
-- This lets Postgres skip deleted rows entirely during the index scan,
-- keeping page-fetch cost at O(page_size) regardless of deletion volume.
CREATE INDEX "direct_messages_active_idx"
ON "direct_messages" ("conversation_id", "created_at" DESC)
WHERE "deleted_at" IS NULL;