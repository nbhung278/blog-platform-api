import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { logger } from "./logger";

const endpoint = process.env.S3_ENDPOINT;
const region = process.env.S3_REGION || "us-east-1";
const bucket = process.env.S3_BUCKET || "blog-media";
const accessKeyId = process.env.S3_ACCESS_KEY;
const secretAccessKey = process.env.S3_SECRET_KEY;
const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === "true";
const publicUrl = process.env.S3_PUBLIC_URL || `${endpoint}/${bucket}`;

if (!accessKeyId || !secretAccessKey) {
	logger.warn("[s3] Missing S3_ACCESS_KEY / S3_SECRET_KEY — uploads will fail");
}

export const s3 = new S3Client({
	region,
	endpoint,
	forcePathStyle,
	credentials: {
		accessKeyId: accessKeyId ?? "",
		secretAccessKey: secretAccessKey ?? "",
	},
});

export const S3_BUCKET = bucket;
export const S3_PUBLIC_URL = publicUrl.replace(/\/$/, "");

export async function uploadImage(args: {
	key: string;
	body: Buffer | Uint8Array;
	contentType: string;
}): Promise<string> {
	await s3.send(
		new PutObjectCommand({
			Bucket: S3_BUCKET,
			Key: args.key,
			Body: args.body,
			ContentType: args.contentType,
			CacheControl: "public, max-age=31536000, immutable",
		}),
	);
	return `${S3_PUBLIC_URL}/${args.key}`;
}

/**
 * Best-effort delete. Failures are logged but never thrown — cleanup is async
 * housekeeping that must not block or rollback the user-facing request that
 * triggered it. A leaked object costs cents; a failed delete shouldn't surface
 * as a 500 to a user who just successfully deleted their post.
 */
export async function deleteObject(key: string): Promise<void> {
	try {
		await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
	} catch (err) {
		logger.warn({ err, key }, "[s3] delete failed");
	}
}

/**
 * Pull the S3 key out of a URL we issued, but only if it belongs to `ownerId`.
 *
 * Why the ownership check: nothing stops user B from setting their post's
 * coverUrl to user A's image URL (same host → passes the media allowlist).
 * If we then deleted by key without checking, user B could erase user A's
 * files just by deleting their own post. We refuse to return the key unless
 * the path matches `posts/{ownerId}/...`, so cleanup can never touch a file
 * that doesn't belong to the post's author.
 *
 * Returns null for: empty/null URL, URL on a different host (legacy/external),
 * or our-host URL whose path prefix doesn't match the expected owner.
 */
export function extractOwnedS3Key(url: string | null | undefined, ownerId: string): string | null {
	if (!url) return null;
	const prefix = `${S3_PUBLIC_URL}/`;
	if (!url.startsWith(prefix)) return null;
	const key = url.slice(prefix.length);
	if (key.length === 0) return null;
	// Key shape from /api/uploads/image is `posts/{userSub}/{uuid}.{ext}`.
	// Reject anything that isn't in this user's directory — that's an attempt
	// to point our cleanup at someone else's file.
	if (!key.startsWith(`posts/${ownerId}/`)) return null;
	return key;
}
