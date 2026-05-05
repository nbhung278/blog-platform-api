import { Hono } from "hono";
import sharp from "sharp";
import { authMiddleware, requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../lib/permissions";
import { uploadImage } from "../lib/s3";
import { ipRateLimit } from "../middleware/rate-limit";
import { logger } from "../lib/logger";

const uploadLimit = ipRateLimit({ keyPrefix: "upload", limit: 20, windowSeconds: 60 * 15 });

export const uploadsRoutes = new Hono();

const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
// Cap output width so mobile/desktop never download an oversized hero image.
// 1200px covers retina mobile (2x of ~600px viewport) and is enough for non-
// retina desktop hero images at typical layout widths. Smaller LCP than 1600w
// while still looking sharp on phones, which is where most readers are.
const MAX_WIDTH = 1200;
const WEBP_QUALITY = 80;

uploadsRoutes.post(
	"/image",
	uploadLimit,
	authMiddleware,
	requirePermission(PERMISSIONS.MEDIA_UPLOAD),
	async (c) => {
		const user = c.get("user");

		let form: FormData;
		try {
			form = await c.req.formData();
		} catch {
			return c.json({ error: "Expected multipart/form-data" }, 400);
		}

		const file = form.get("file");
		if (!(file instanceof File)) {
			return c.json({ error: "Missing 'file' field" }, 400);
		}

		if (!ALLOWED_TYPES.has(file.type)) {
			return c.json({ error: `Unsupported type: ${file.type}` }, 400);
		}

		if (file.size > MAX_BYTES) {
			return c.json({ error: "File exceeds 5MB limit" }, 400);
		}

		const inputBuffer = Buffer.from(await file.arrayBuffer());

		// GIF can be animated; sharp would flatten it to a still frame, so pass
		// through untouched. Everything else gets resized + re-encoded as WebP
		// (smaller than JPEG/PNG at equivalent quality, modern-browser support).
		let outputBuffer: Buffer;
		let outputContentType: string;
		let outputExt: string;
		if (file.type === "image/gif") {
			outputBuffer = inputBuffer;
			outputContentType = "image/gif";
			outputExt = "gif";
		} else {
			try {
				outputBuffer = await sharp(inputBuffer, { failOn: "none" })
					.rotate() // honor EXIF orientation before resize
					.resize({ width: MAX_WIDTH, withoutEnlargement: true })
					.webp({ quality: WEBP_QUALITY })
					.toBuffer();
				outputContentType = "image/webp";
				outputExt = "webp";
			} catch (err) {
				logger.error({ err }, "[uploads] sharp transform failed");
				return c.json({ error: "Image processing failed" }, 400);
			}
		}

		const key = `posts/${user.sub}/${crypto.randomUUID()}.${outputExt}`;

		try {
			const url = await uploadImage({ key, body: outputBuffer, contentType: outputContentType });
			return c.json(
				{ url, key, size: outputBuffer.byteLength, contentType: outputContentType },
				201,
			);
		} catch (err) {
			logger.error({ err }, "[uploads] s3 put failed");
			return c.json({ error: "Upload failed" }, 500);
		}
	},
);
