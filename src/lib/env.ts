import { z } from "zod";

// Validate process.env once at startup. Anything required for the server to
// boot in any reasonable mode goes here so a misconfigured deploy fails fast
// instead of throwing on the first request that needs the missing value.
const EnvSchema = z.object({
	NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
	PORT: z
		.string()
		.optional()
		.transform((v) => (v ? Number(v) : 3000))
		.pipe(z.number().int().positive()),

	// Auth / crypto — non-null assertions removed by importing `env.JWT_SECRET`.
	JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),

	// Datastores
	DATABASE_URL: z.string().url(),
	REDIS_URL: z.string().url().optional(),

	// CORS / cookies
	APP_URL: z.string().url().default("http://localhost:5173"),
	ADMIN_URL: z.string().url().default("http://localhost:5174"),

	// S3-compatible storage (uploads)
	S3_BUCKET: z.string().default("blog-media"),
	S3_REGION: z.string().default("us-east-1"),
	S3_ENDPOINT: z.string().url().optional(),
	S3_ACCESS_KEY: z.string().optional(),
	S3_SECRET_KEY: z.string().optional(),
	S3_PUBLIC_URL: z.string().url().optional(),
	S3_FORCE_PATH_STYLE: z
		.string()
		.optional()
		.transform((v) => v === "true"),

	// CDN in front of S3 (e.g. CloudFront). When set, newly uploaded images are
	// served via this URL instead of the raw S3 endpoint. The S3 hostname stays
	// allowlisted so historical URLs continue to validate after migration.
	CDN_PUBLIC_URL: z.string().url().optional(),

	// One-shot install token: when set, /api/auth/setup requires the caller to
	// echo this value via the X-Setup-Token header. Lets you keep the endpoint
	// reachable for bootstrapping without leaving it open to whoever races the
	// first signup if the DB ever ends up empty.
	SETUP_TOKEN: z.string().min(16).optional(),

	// Open public registration. Off by default so a fresh deploy is not
	// immediately open to anyone who finds the endpoint.
	ALLOW_REGISTRATION: z
		.string()
		.optional()
		.transform((v) => v === "true")
		.default("false"),

	// Transactional email (Resend). EMAIL_ENABLED is a kill switch — when off,
	// OTP flows still run their logic but the email itself is skipped, so we
	// can disable email globally without redeploying if the provider has an
	// incident. The other fields are only meaningful when EMAIL_ENABLED=true.
	EMAIL_ENABLED: z
		.string()
		.optional()
		.transform((v) => v === "true")
		.default("false"),
	RESEND_API_KEY: z.string().optional(),
	RESEND_WEBHOOK_SECRET: z.string().optional(),
	EMAIL_FROM: z.string().default("Strix Blog <noreply@mail.strix-blog.uk>"),
	EMAIL_REPLY_TO: z.string().default("support@strix-blog.uk"),

	// Frontend URL used to build links in transactional emails (reset password
	// callback, etc.). Defaults to APP_URL but kept separate so email links
	// can point at a different host if needed.
	FRONTEND_URL: z.string().url().optional(),

	// Google OAuth (Phase 2). When all three are set, the /google routes are
	// active; otherwise the backend rejects them with 503 so a half-configured
	// deploy can't silently expose a broken sign-in path.
	GOOGLE_CLIENT_ID: z.string().optional(),
	GOOGLE_CLIENT_SECRET: z.string().optional(),
	GOOGLE_REDIRECT_URI: z.string().url().optional(),

	// IndexNow — fast URL submission for Bing / Yandex / other engines that
	// honor the protocol. The key is a 32-char hex string we generate once and
	// host at /<key>.txt for ownership verification. When unset, the helper
	// no-ops so a missing key never blocks a publish.
	INDEXNOW_KEY: z
		.string()
		.regex(/^[a-f0-9]{8,128}$/i, "INDEXNOW_KEY must be hex, 8-128 chars")
		.optional(),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
	const result = EnvSchema.safeParse(process.env);
	if (!result.success) {
		const issues = result.error.issues
			.map((i) => `  - ${i.path.join(".")}: ${i.message}`)
			.join("\n");
		console.error(`[env] Invalid environment configuration:\n${issues}`);
		process.exit(1);
	}
	return result.data;
}

export const env = loadEnv();
