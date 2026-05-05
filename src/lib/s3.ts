import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
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
