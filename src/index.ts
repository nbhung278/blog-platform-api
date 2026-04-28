import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { authRoutes } from "./routes/auth";
import { postsRoutes } from "./routes/posts";
import { categoriesRoutes } from "./routes/categories";
import { aiRoutes } from "./routes/ai";
import { analyticsRoutes } from "./routes/analytics";
import { usersRoutes } from "./routes/users";
import { rolesRoutes } from "./routes/roles";
import { uploadsRoutes } from "./routes/uploads";
import { startWorkers } from "./queue";
import { startViewCountFlusher } from "./lib/view-counter";

const app = new Hono();

app.use("*", logger());
const allowedOrigins = [
	process.env.APP_URL || "http://localhost:5173",
	process.env.ADMIN_URL || "http://localhost:5174",
];

app.use(
	"*",
	cors({
		// Reflect only explicitly allowed origins. Returning null for everything
		// else means cookies will not be honored cross-origin.
		origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
		credentials: true,
		allowHeaders: ["Content-Type", "Authorization", "X-CSRF-Token"],
		allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
		exposeHeaders: [],
		maxAge: 600,
	}),
);

// Baseline security headers. Backend only emits JSON, so CSP here is mostly
// defense-in-depth: if a misconfigured route ever returned HTML, this CSP would
// neuter inline scripts. The admin SPA's own CSP is set in its index.html (and
// should be re-set at the reverse proxy in production for frame-ancestors etc).
app.use("*", async (c, next) => {
	await next();
	c.header("X-Content-Type-Options", "nosniff");
	c.header("X-Frame-Options", "DENY");
	c.header("Referrer-Policy", "no-referrer");
	c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
	c.header(
		"Content-Security-Policy",
		["default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'"].join("; "),
	);
});

app.route("/api/auth", authRoutes);
app.route("/api/posts", postsRoutes);
app.route("/api/categories", categoriesRoutes);
app.route("/api/ai", aiRoutes);
app.route("/api/analytics", analyticsRoutes);
app.route("/api/users", usersRoutes);
app.route("/api/roles", rolesRoutes);
app.route("/api/uploads", uploadsRoutes);

app.get("/", (c) => c.json({ status: "ok" }));

// Start background workers
startWorkers();
startViewCountFlusher();

const port = Number(process.env.PORT) || 3000;
console.log(`[server] Starting on port ${port}`);

export default {
	port,
	fetch: app.fetch,
};
