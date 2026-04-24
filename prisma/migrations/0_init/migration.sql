-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column to post_chunks after Prisma creates the table
-- Run this after `prisma migrate dev`:
-- ALTER TABLE post_chunks ADD COLUMN embedding vector(1536);
-- CREATE INDEX post_chunks_embedding_idx ON post_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
