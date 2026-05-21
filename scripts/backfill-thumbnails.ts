/**
 * One-time script: generate 400px thumbnails for all posts that have a
 * coverUrl but no thumbnailUrl yet.
 *
 * Usage:
 *   cd blog-platform-backend
 *   npx dotenv -e .env -- npx tsx scripts/backfill-thumbnails.ts
 *
 * Safe to re-run — skips posts that already have thumbnailUrl.
 */

import sharp from "sharp";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { uploadImage, extractOwnedS3Key } from "../src/lib/s3";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });
const THUMB_WIDTH = 400;
const WEBP_QUALITY = 80;
const BATCH_SIZE = 10;
const FETCH_TIMEOUT_MS = 15_000;

async function fetchBuffer(url: string): Promise<Buffer> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
		return Buffer.from(await res.arrayBuffer());
	} finally {
		clearTimeout(timer);
	}
}

async function generateThumbnail(coverUrl: string, userId: string): Promise<string | null> {
	// Skip GIFs — sharp would flatten animation.
	if (coverUrl.endsWith(".gif")) return null;

	const key = extractOwnedS3Key(coverUrl, userId);
	if (!key) {
		console.warn(`  skipping — URL not owned by user: ${coverUrl}`);
		return null;
	}

	const inputBuffer = await fetchBuffer(coverUrl);

	// Derive thumbnail key from cover key: insert "-thumb" before extension.
	// e.g. posts/abc/uuid.webp → posts/abc/uuid-thumb.webp
	const thumbKey = key.replace(/(\.[^.]+)$/, "-thumb.webp");

	const thumbBuffer = await sharp(inputBuffer, { failOn: "none" })
		.rotate()
		.resize({ width: THUMB_WIDTH, withoutEnlargement: true })
		.webp({ quality: WEBP_QUALITY })
		.toBuffer();

	return uploadImage({ key: thumbKey, body: thumbBuffer, contentType: "image/webp" });
}

async function main() {
	const posts = await prisma.post.findMany({
		where: {
			coverUrl: { not: null },
			thumbnailUrl: null,
			deletedAt: null,
		},
		select: { id: true, coverUrl: true, userId: true },
		orderBy: { createdAt: "asc" },
	});

	console.log(`Found ${posts.length} posts to backfill.`);
	if (posts.length === 0) return;

	let done = 0;
	let failed = 0;

	for (let i = 0; i < posts.length; i += BATCH_SIZE) {
		const batch = posts.slice(i, i + BATCH_SIZE);

		await Promise.all(
			batch.map(async (post) => {
				try {
					const thumbnailUrl = await generateThumbnail(post.coverUrl!, post.userId);
					if (thumbnailUrl) {
						await prisma.post.update({
							where: { id: post.id },
							data: { thumbnailUrl },
						});
						done++;
						console.log(`  ✓ ${post.id} → ${thumbnailUrl}`);
					} else {
						console.log(`  – ${post.id} skipped (GIF or unowned URL)`);
					}
				} catch (err) {
					failed++;
					console.error(`  ✗ ${post.id}: ${err}`);
				}
			}),
		);

		console.log(`[${Math.min(i + BATCH_SIZE, posts.length)}/${posts.length}] batch done`);
	}

	console.log(`\nDone. ${done} thumbnails generated, ${failed} failed.`);
}

main()
	.catch((err) => {
		console.error(err);
		process.exit(1);
	})
	.finally(() => prisma.$disconnect());
