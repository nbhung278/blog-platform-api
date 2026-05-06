import { Hono } from "hono";
import sharp from "sharp";
import { authMiddleware, requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../lib/permissions";
import { uploadImage } from "../lib/s3";
import { ipRateLimit } from "../middleware/rate-limit";
import { logger } from "../lib/logger";
import { isPrivateOrLocalHost } from "../lib/ssrf-guard";
import { isAllowedMediaUrl } from "../lib/url-allowlist";

const uploadLimit = ipRateLimit({ keyPrefix: "upload", limit: 20, windowSeconds: 60 * 15 });

export const uploadsRoutes = new Hono();

const MAX_BYTES = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
// Cap output width so mobile/desktop never download an oversized hero image.
// 1200px covers retina mobile (2x of ~600px viewport) and is enough for non-
// retina desktop hero images at typical layout widths. Smaller LCP than 1600w
// while still looking sharp on phones, which is where most readers are.
const MAX_WIDTH = 1200;
const WEBP_QUALITY = 80;
const FETCH_TIMEOUT_MS = 10_000;

async function processAndUpload(
	inputBuffer: Buffer,
	contentType: string,
	userSub: string,
): Promise<{ url: string; key: string; size: number; contentType: string }> {
	// GIF can be animated; sharp would flatten it to a still frame, so pass
	// through untouched. Everything else gets resized + re-encoded as WebP.
	let outputBuffer: Buffer;
	let outputContentType: string;
	let outputExt: string;
	if (contentType === "image/gif") {
		outputBuffer = inputBuffer;
		outputContentType = "image/gif";
		outputExt = "gif";
	} else {
		outputBuffer = await sharp(inputBuffer, { failOn: "none" })
			.rotate()
			.resize({ width: MAX_WIDTH, withoutEnlargement: true })
			.webp({ quality: WEBP_QUALITY })
			.toBuffer();
		outputContentType = "image/webp";
		outputExt = "webp";
	}

	const key = `posts/${userSub}/${crypto.randomUUID()}.${outputExt}`;
	const url = await uploadImage({ key, body: outputBuffer, contentType: outputContentType });
	return { url, key, size: outputBuffer.byteLength, contentType: outputContentType };
}

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
			return c.json({ error: "File exceeds 10MB limit" }, 400);
		}

		const inputBuffer = Buffer.from(await file.arrayBuffer());

		try {
			const result = await processAndUpload(inputBuffer, file.type, user.sub);
			return c.json(result, 201);
		} catch (err) {
			logger.error({ err }, "[uploads] image upload failed");
			return c.json({ error: "Upload failed" }, 500);
		}
	},
);

// Rehost an external image URL onto our S3 bucket. Lets users paste any image
// link (Google, blogs, stock sites) without us trusting that host: we fetch it,
// validate, re-encode, and serve from our own origin. Also avoids tracking
// pixels and broken images when the source disappears.
uploadsRoutes.post(
	"/from-url",
	uploadLimit,
	authMiddleware,
	requirePermission(PERMISSIONS.MEDIA_UPLOAD),
	async (c) => {
		const user = c.get("user");

		let body: { url?: unknown };
		try {
			body = await c.req.json<{ url?: unknown }>();
		} catch {
			return c.json({ error: "Expected JSON body" }, 400);
		}

		if (typeof body.url !== "string" || body.url.length === 0) {
			return c.json({ error: "Missing 'url' field" }, 400);
		}

		let parsed: URL;
		try {
			parsed = new URL(body.url);
		} catch {
			return c.json({ error: "Invalid URL" }, 400);
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return c.json({ error: "Only http(s) URLs are allowed" }, 400);
		}

		// Already on our own media origin → skip the fetch + re-encode round-trip.
		// Lets the admin UI call this unconditionally on save without rehosting
		// images that came out of /api/uploads/image.
		if (isAllowedMediaUrl(parsed.toString())) {
			return c.json({ url: parsed.toString() }, 200);
		}

		// SSRF guard: refuse to fetch from private/loopback/link-local hosts so an
		// attacker can't probe internal services or cloud metadata via this proxy.
		try {
			if (await isPrivateOrLocalHost(parsed.hostname)) {
				return c.json({ error: "URL host not allowed" }, 400);
			}
		} catch (err) {
			logger.error({ err, host: parsed.hostname }, "[uploads] dns resolve failed");
			return c.json({ error: "Could not resolve URL" }, 400);
		}

		// `redirect: "manual"` because following redirects re-opens the SSRF hole
		// the DNS check just closed: a public host can 302 to an internal IP and
		// fetch would happily follow. We tell the user to give us the final URL
		// instead. Practically, image CDNs serve directly without redirects.
		let res: Response;
		try {
			res = await fetch(parsed.toString(), {
				redirect: "manual",
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
				headers: { "User-Agent": "blog-platform-rehost/1.0" },
			});
		} catch (err) {
			logger.warn({ err, url: parsed.toString() }, "[uploads] rehost fetch failed");
			return c.json({ error: "Could not fetch URL" }, 400);
		}

		// Treat 3xx as failure since we refuse to follow redirects.
		if (res.status >= 300 && res.status < 400) {
			return c.json({ error: "Source redirected; provide a direct image URL" }, 400);
		}
		if (!res.ok) {
			return c.json({ error: `Source returned ${res.status}` }, 400);
		}

		const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
		if (!ALLOWED_TYPES.has(contentType)) {
			return c.json({ error: `Unsupported type: ${contentType || "unknown"}` }, 400);
		}

		// Trust Content-Length first (cheap reject), then enforce again while
		// reading because servers can lie or omit the header.
		const declaredLen = Number(res.headers.get("content-length") ?? "0");
		if (declaredLen > MAX_BYTES) {
			return c.json({ error: "Source exceeds 10MB limit" }, 400);
		}

		const reader = res.body?.getReader();
		if (!reader) {
			return c.json({ error: "Empty response" }, 400);
		}

		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.byteLength;
				if (total > MAX_BYTES) {
					await reader.cancel();
					return c.json({ error: "Source exceeds 10MB limit" }, 400);
				}
				chunks.push(value);
			}
		} catch (err) {
			logger.warn({ err }, "[uploads] rehost stream read failed");
			return c.json({ error: "Could not read source" }, 400);
		}

		const inputBuffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));

		try {
			const result = await processAndUpload(inputBuffer, contentType, user.sub);
			return c.json(result, 201);
		} catch (err) {
			logger.error({ err }, "[uploads] rehost process/upload failed");
			return c.json({ error: "Upload failed" }, 500);
		}
	},
);
