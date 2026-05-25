/**
 * Standalone backfill: generate 400px thumbnails for posts that have a
 * coverUrl but no thumbnailUrl yet.
 *
 * Differs from backfill-thumbnails.ts by inlining all helpers — no relative
 * imports — so the file can be dropped into any location inside the container
 * (e.g. /tmp/) and run with `bun run /tmp/backfill-thumbnails-standalone.ts`.
 *
 * Safe to re-run; skips posts that already have thumbnailUrl.
 */

import sharp from "sharp";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const THUMB_WIDTH = 400;
const WEBP_QUALITY = 80;
const BATCH_SIZE = 10;
const FETCH_TIMEOUT_MS = 15_000;

const endpoint = process.env.S3_ENDPOINT;
const region = process.env.S3_REGION || "us-east-1";
const bucket = process.env.S3_BUCKET || "blog-media";
const accessKeyId = process.env.S3_ACCESS_KEY;
const secretAccessKey = process.env.S3_SECRET_KEY;
const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === "true";
const s3Url = process.env.S3_PUBLIC_URL || `${endpoint}/${bucket}`;
const publicUrl = process.env.CDN_PUBLIC_URL || s3Url;
const S3_PUBLIC_URL = publicUrl.replace(/\/$/, "");
const S3_DIRECT_URL = s3Url.replace(/\/$/, "");

const s3 = new S3Client({
	region,
	endpoint,
	forcePathStyle,
	credentials: {
		accessKeyId: accessKeyId ?? "",
		secretAccessKey: secretAccessKey ?? "",
	},
});

async function uploadImage(args: {
	key: string;
	body: Buffer;
	contentType: string;
}): Promise<string> {
	await s3.send(
		new PutObjectCommand({
			Bucket: bucket,
			Key: args.key,
			Body: args.body,
			ContentType: args.contentType,
			CacheControl: "public, max-age=31536000, immutable",
		}),
	);
	return `${S3_PUBLIC_URL}/${args.key}`;
}

// Backfill-only: extract the S3 key from any URL we issued, without the
// ownership check the runtime version enforces. Reason: this script only
// generates a NEW thumbnail next to the existing cover — it never deletes
// or rewrites the source file, so there's no security risk if the cover
// URL points at a user dir different from post.userId (e.g. an admin who
// later took over the post, or a cover that was re-used across authors).
function extractS3Key(url: string | null | undefined): string | null {
	if (!url) return null;
	const prefixes =
		S3_PUBLIC_URL === S3_DIRECT_URL
			? [`${S3_PUBLIC_URL}/`]
			: [`${S3_PUBLIC_URL}/`, `${S3_DIRECT_URL}/`];
	const matched = prefixes.find((p) => url.startsWith(p));
	if (!matched) return null;
	const key = url.slice(matched.length);
	if (key.length === 0) return null;
	// Sanity: must still be under the `posts/` prefix (avoid writing thumbs
	// next to arbitrary objects like avatars/).
	if (!key.startsWith("posts/")) return null;
	return key;
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

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

async function generateThumbnail(coverUrl: string): Promise<string | null> {
	if (coverUrl.endsWith(".gif")) return null;

	const key = extractS3Key(coverUrl);
	if (!key) {
		console.warn(`  skipping — URL not on our CDN: ${coverUrl}`);
		return null;
	}

	const inputBuffer = await fetchBuffer(coverUrl);
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
		select: { id: true, coverUrl: true },
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
					const thumbnailUrl = await generateThumbnail(post.coverUrl!);
					if (thumbnailUrl) {
						await prisma.post.update({
							where: { id: post.id },
							data: { thumbnailUrl },
						});
						done++;
						console.log(`  ✓ ${post.id} → ${thumbnailUrl}`);
					} else {
						console.log(`  – ${post.id} skipped (GIF or external URL)`);
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
