import { z } from "zod";

// Treat an empty-string env var as "not set" before any further validation
// runs. Shells and Docker Compose interpolation (`${VAR:-}`) both surface
// missing/blank values as `""` rather than `undefined`, but Zod's `.optional()`
// only allows `undefined` — so a schema like `z.string().regex(...).optional()`
// rejects `""` with a regex error, crash-looping the container.
//
// Wrap every optional env in `optionalEnvString(...)` instead of bare
// `.optional()` to make blank/missing equivalent. Required env vars deliberately
// don't use this so a missing critical value still fails fast.
function optionalEnvString<T extends z.ZodTypeAny>(schema: T) {
	return z.preprocess(
		(v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
		schema.optional(),
	);
}

// Validate process.env once at startup. Anything required for the server to
// boot in any reasonable mode goes here so a misconfigured deploy fails fast
// instead of throwing on the first request that needs the missing value.
const EnvSchema = z
	.object({
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
		REDIS_URL: optionalEnvString(z.string().url()),

		// CORS / cookies
		APP_URL: z.string().url().default("http://localhost:5173"),
		ADMIN_URL: z.string().url().default("http://localhost:5174"),

		// S3-compatible storage (uploads)
		S3_BUCKET: z.string().default("blog-media"),
		S3_REGION: z.string().default("us-east-1"),
		S3_ENDPOINT: optionalEnvString(z.string().url()),
		S3_ACCESS_KEY: optionalEnvString(z.string()),
		S3_SECRET_KEY: optionalEnvString(z.string()),
		S3_PUBLIC_URL: optionalEnvString(z.string().url()),
		S3_FORCE_PATH_STYLE: z
			.string()
			.optional()
			.transform((v) => v === "true"),

		// CDN in front of S3 (e.g. CloudFront). When set, newly uploaded images are
		// served via this URL instead of the raw S3 endpoint. The S3 hostname stays
		// allowlisted so historical URLs continue to validate after migration.
		CDN_PUBLIC_URL: optionalEnvString(z.string().url()),

		// One-shot install token: when set, /api/auth/setup requires the caller to
		// echo this value via the X-Setup-Token header. Lets you keep the endpoint
		// reachable for bootstrapping without leaving it open to whoever races the
		// first signup if the DB ever ends up empty.
		SETUP_TOKEN: optionalEnvString(z.string().min(16)),

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
		RESEND_API_KEY: optionalEnvString(z.string()),
		RESEND_WEBHOOK_SECRET: optionalEnvString(z.string()),
		EMAIL_FROM: z.string().default("Strix Blog <noreply@mail.strix-blog.uk>"),
		EMAIL_REPLY_TO: z.string().default("support@strix-blog.uk"),

		// Frontend URL used to build links in transactional emails (reset password
		// callback, etc.). Defaults to APP_URL but kept separate so email links
		// can point at a different host if needed.
		FRONTEND_URL: optionalEnvString(z.string().url()),

		// Google OAuth (Phase 2). When all three are set, the /google routes are
		// active; otherwise the backend rejects them with 503 so a half-configured
		// deploy can't silently expose a broken sign-in path.
		GOOGLE_CLIENT_ID: optionalEnvString(z.string()),
		GOOGLE_CLIENT_SECRET: optionalEnvString(z.string()),
		GOOGLE_REDIRECT_URI: optionalEnvString(z.string().url()),

		// IndexNow — fast URL submission for Bing / Yandex / other engines that
		// honor the protocol. The key is a 32-char hex string we generate once and
		// host at /<key>.txt for ownership verification. When unset, the helper
		// no-ops so a missing key never blocks a publish.
		INDEXNOW_KEY: optionalEnvString(
			z.string().regex(/^[a-f0-9]{8,128}$/i, "INDEXNOW_KEY must be hex, 8-128 chars"),
		),
	})
	.refine((env) => env.NODE_ENV !== "production" || !!env.SETUP_TOKEN, {
		// Without SETUP_TOKEN in production the /setup endpoint is open to whoever
		// races the next signup after a DB reset/migration mishap. Forbid booting
		// prod without it so the bootstrap path stays single-shot. Dev/test stay
		// optional — those environments rebuild the DB often and the friction of
		// supplying a token every time isn't worth the marginal protection there.
		message: "SETUP_TOKEN is required when NODE_ENV=production",
		path: ["SETUP_TOKEN"],
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
