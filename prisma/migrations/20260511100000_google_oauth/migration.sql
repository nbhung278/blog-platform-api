-- Phase 2: Google OAuth support.
-- `google_id` is the subject identifier returned by Google's `userinfo`
-- endpoint. Nullable because the column is added retroactively and existing
-- email/password accounts won't have one. Unique so the lookup in the OAuth
-- callback ("do we already know this Google account?") is a primary-key-style
-- read.

ALTER TABLE "users" ADD COLUMN "google_id" TEXT;
CREATE UNIQUE INDEX "users_google_id_key" ON "users"("google_id");
