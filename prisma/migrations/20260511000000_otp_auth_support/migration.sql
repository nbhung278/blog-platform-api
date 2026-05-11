-- Adds OTP-based email verification and device-bound login step-up.
--
-- Backfill note: every existing user is grandfathered with email_verified=true
-- because they signed up before this feature shipped. The DEFAULT false applies
-- only to rows inserted after this migration runs (i.e. new signups, which now
-- go through the OTP flow).
--
-- password_hash is being relaxed to nullable so Phase 2 (Google OAuth) can
-- create accounts that have never had a password. Existing rows are unaffected.

ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;

ALTER TABLE "users" ADD COLUMN "email_verified" BOOLEAN NOT NULL DEFAULT false;

-- Grandfather existing users: anyone present before this migration is treated
-- as already-verified. Without this step every old user would silently fail
-- /login until they manually re-verified.
UPDATE "users" SET "email_verified" = true;

CREATE TABLE "known_devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip" TEXT,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "known_devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "known_devices_user_id_fingerprint_key" ON "known_devices"("user_id", "fingerprint");
CREATE INDEX "known_devices_user_id_idx" ON "known_devices"("user_id");

ALTER TABLE "known_devices" ADD CONSTRAINT "known_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "email_suppressions" (
    "email" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "bounce_type" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("email")
);
