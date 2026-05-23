-- Remove soft-delete from posts: switch to hard delete
DROP INDEX IF EXISTS "posts_deleted_at_idx";
ALTER TABLE "posts" DROP COLUMN IF EXISTS "deleted_at";
