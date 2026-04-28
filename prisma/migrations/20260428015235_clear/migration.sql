/*
  Warnings:

  - You are about to drop the column `content` on the `posts` table. All the data in the column will be lost.
  - Added the required column `content_html` to the `posts` table without a default value. This is not possible if the table is not empty.
  - Added the required column `content_md` to the `posts` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "posts" DROP COLUMN "content",
ADD COLUMN     "content_html" TEXT NOT NULL,
ADD COLUMN     "content_md" TEXT NOT NULL;
