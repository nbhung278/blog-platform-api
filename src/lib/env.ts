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
