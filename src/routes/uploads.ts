import { Hono } from "hono";
import { authMiddleware, requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../lib/permissions";
import { uploadImage } from "../lib/s3";
import { ipRateLimit } from "../middleware/rate-limit";

const uploadLimit = ipRateLimit({ keyPrefix: "upload", limit: 20, windowSeconds: 60 * 15 });

export const uploadsRoutes = new Hono();

const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const EXT_BY_TYPE: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"image/gif": "gif",
};

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

		const ext = EXT_BY_TYPE[file.type];
		const key = `posts/${user.sub}/${crypto.randomUUID()}.${ext}`;
		const buffer = Buffer.from(await file.arrayBuffer());

		try {
			const url = await uploadImage({ key, body: buffer, contentType: file.type });
			return c.json({ url, key, size: file.size, contentType: file.type }, 201);
		} catch (err) {
			console.error("[uploads] S3 put failed", err);
			return c.json({ error: "Upload failed" }, 500);
		}
	},
);
