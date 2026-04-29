-- DropForeignKey
ALTER TABLE "comment_votes" DROP CONSTRAINT "comment_votes_comment_id_fkey";

-- DropForeignKey
ALTER TABLE "comment_votes" DROP CONSTRAINT "comment_votes_user_id_fkey";

-- DropForeignKey
ALTER TABLE "post_votes" DROP CONSTRAINT "post_votes_post_id_fkey";

-- DropForeignKey
ALTER TABLE "post_votes" DROP CONSTRAINT "post_votes_user_id_fkey";

-- AlterTable
ALTER TABLE "comments" DROP COLUMN "downvote_count",
DROP COLUMN "upvote_count",
ADD COLUMN     "clap_count" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "posts" DROP COLUMN "downvote_count",
DROP COLUMN "like_count",
DROP COLUMN "upvote_count",
ADD COLUMN     "clap_count" INTEGER NOT NULL DEFAULT 0;

-- DropTable
DROP TABLE "comment_votes";

-- DropTable
DROP TABLE "post_votes";

-- CreateTable
CREATE TABLE "post_claps" (
    "user_id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_claps_pkey" PRIMARY KEY ("user_id","post_id")
);

-- CreateTable
CREATE TABLE "comment_claps" (
    "user_id" UUID NOT NULL,
    "comment_id" UUID NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_claps_pkey" PRIMARY KEY ("user_id","comment_id")
);

-- CreateIndex
CREATE INDEX "post_claps_post_id_idx" ON "post_claps"("post_id");

-- CreateIndex
CREATE INDEX "comment_claps_comment_id_idx" ON "comment_claps"("comment_id");

-- AddForeignKey
ALTER TABLE "post_claps" ADD CONSTRAINT "post_claps_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_claps" ADD CONSTRAINT "post_claps_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_claps" ADD CONSTRAINT "comment_claps_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_claps" ADD CONSTRAINT "comment_claps_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

