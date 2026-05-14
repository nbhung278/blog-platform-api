-- CreateTable
CREATE TABLE "reading_progress" (
    "user_id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "scroll_y" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reading_progress_pkey" PRIMARY KEY ("user_id","post_id")
);

-- CreateIndex
CREATE INDEX "reading_progress_user_id_updated_at_idx" ON "reading_progress"("user_id", "updated_at" DESC);

-- AddForeignKey
ALTER TABLE "reading_progress" ADD CONSTRAINT "reading_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reading_progress" ADD CONSTRAINT "reading_progress_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
