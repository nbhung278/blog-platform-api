-- Drop AI-related tables (RAG chunks + chat sessions). Foreign keys to
-- users/posts cascade so DROP TABLE is enough.
DROP TABLE IF EXISTS "post_chunks";
DROP TABLE IF EXISTS "chat_sessions";

-- pgvector extension was only used by post_chunks.embedding. Safe to drop now;
-- a future re-introduction of semantic search will recreate it via its own
-- migration.
DROP EXTENSION IF EXISTS vector;
