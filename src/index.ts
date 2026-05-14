// Validate env first so we fail fast on misconfiguration.
import { env } from "./lib/env";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { bodyLimit } from "hono/body-limit";
import { authRoutes } from "./routes/auth";
import { postsRoutes } from "./routes/posts";
import { categoriesRoutes } from "./routes/categories";
import { analyticsRoutes } from "./routes/analytics";
import { usersRoutes } from "./routes/users";
import { rolesRoutes } from "./routes/roles";
import { uploadsRoutes } from "./routes/uploads";
import { followsRoutes } from "./routes/follows";
import { notificationsRoutes } from "./routes/notifications";
import { clapsRoutes } from "./routes/claps";
import { bookmarksRoutes } from "./routes/bookmarks";
import { commentsRoutes } from "./routes/comments";
import { conversationsRoutes } from "./routes/conversations";
import { readingProgressRoutes } from "./routes/reading-progress";
import { shareRoutes } from "./routes/share";
import { sitemapRoutes } from "./routes/sitemap";
import { feedRoutes } from "./routes/feed";
import { webhooksRoutes } from "./routes/webhooks";
import { startViewCountFlusher, stopViewCountFlusher, flushViewCounts } from "./lib/view-counter";
import { authenticateUpgradeRequest, wsHandlers, type WSData } from "./lib/ws";
import { prisma } from "./db";
import { redis } from "./lib/redis";
import { logger } from "./lib/logger";

const app = new Hono();

app.use("*", honoLogger());

// Hard cap on request body size to prevent memory-exhaustion attacks.
// The upload route enforces its own 5 MB file cap on top of this.
app.use("*", bodyLimit({ maxSize: 10 * 1024 * 1024 }));
const allowedOrigins = [env.APP_URL, env.ADMIN_URL];

app.use(
	"*",
	cors({
		// Reflect only explicitly allowed origins. Returning null for everything
		// else means cookies will not be honored cross-origin.
		origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
		credentials: true,
		allowHeaders: ["Content-Type", "Authorization", "X-CSRF-Token", "X-App-Client"],
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
	c.header("Referrer-Policy", "no-referrer");
	c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
	// API is consumed by SPAs hosted on a different origin, so resources must be
	// readable cross-origin. CORS handles auth; CORP just controls embedding.
	c.header("Cross-Origin-Resource-Policy", "cross-origin");
	// Only set HSTS when actually served over HTTPS — otherwise browsers will
	// pin localhost/dev hosts to https and break local dev permanently.
	const proto = c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "");
	if (proto === "https") {
		c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
	}

	// /share/* serves HTML to social crawlers and humans, with an inline
	// redirect script. The default API CSP (default-src 'none') would block
	// that script and unfurls would still work but humans wouldn't redirect.
	// X-Frame-Options:DENY is also relaxed because some crawlers preview in
	// iframes; the page is a static redirect so clickjacking doesn't apply.
	if (c.req.path.startsWith("/share/")) return;

	c.header("X-Frame-Options", "DENY");
	c.header(
		"Content-Security-Policy",
		["default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'"].join("; "),
	);
});

app.route("/api/auth", authRoutes);
app.route("/api/posts", postsRoutes);
app.route("/api/categories", categoriesRoutes);
app.route("/api/analytics", analyticsRoutes);
app.route("/api/users", usersRoutes);
app.route("/api/roles", rolesRoutes);
app.route("/api/uploads", uploadsRoutes);
app.route("/api/follows", followsRoutes);
app.route("/api/notifications", notificationsRoutes);
app.route("/api/claps", clapsRoutes);
app.route("/api/bookmarks", bookmarksRoutes);
app.route("/api/comments", commentsRoutes);
app.route("/api/conversations", conversationsRoutes);
app.route("/api/reading-progress", readingProgressRoutes);
// Public OG-tag / unfurl route. Lives outside /api/* so the share URLs are
// short and obviously not a JSON endpoint.
app.route("/share", shareRoutes);
app.route("/sitemap.xml", sitemapRoutes);
// RSS + Atom feeds. Mounted at the root so the public URLs are /feed.xml and
// /feed.atom — the deploy script bakes a snapshot into the SPA bucket so the
// feeds are reachable at strix-blog.uk (not just api.strix-blog.uk).
app.route("/", feedRoutes);
// External webhooks. Lives outside /api/* because the provider URL was
// registered as /webhooks/resend; changing it would require re-registering.
app.route("/webhooks", webhooksRoutes);

app.get("/", (c) => c.json({ status: "ok" }));

// Catch-all error handler. Without this, an uncaught exception bubbles to
// Hono's default which can leak the message + stack into the response. Log
// the full error server-side, but only return a generic 500 to the client.
app.onError((err, c) => {
	logger.error(
		{ err, path: c.req.path, method: c.req.method },
		"[server] unhandled error in route",
	);
	return c.json({ error: "Internal server error" }, 500);
});

// Start background workers
startViewCountFlusher();

const port = env.PORT;
logger.info({ port }, "[server] starting");

const server = Bun.serve<WSData, never>({
	port,
	async fetch(req, server) {
		// Inject the real TCP socket IP so rate-limit middleware can always
		// read it via x-real-socket-ip regardless of proxy headers. We strip
		// any client-supplied value first so it can't be spoofed.
		const socketIp = server.requestIP(req);
		const headers = new Headers(req.headers);
		headers.delete("x-real-socket-ip");
		if (socketIp) headers.set("x-real-socket-ip", socketIp.address);
		req = new Request(req, { headers });

		const url = new URL(req.url);
		// WebSocket upgrade handshake — auth via the access cookie before promoting
		// the connection. Origin is also enforced so only our SPAs can open sockets.
		if (url.pathname === "/ws") {
			// Strict origin allowlist on WebSocket upgrades. Browsers always set
			// Origin on WS handshakes; a missing/null Origin almost always means
			// a non-browser client and we don't grant those a socket.
			const origin = req.headers.get("origin");
			if (!origin || !allowedOrigins.includes(origin)) {
				return new Response("Forbidden", { status: 403 });
			}
			const userId = await authenticateUpgradeRequest(req);
			if (!userId) {
				return new Response("Unauthorized", { status: 401 });
			}
			const ok = server.upgrade(req, { data: { userId } });
			if (ok) return undefined;
			return new Response("Upgrade failed", { status: 500 });
		}
		return app.fetch(req);
	},
	websocket: wsHandlers,
});

logger.info({ url: `http://localhost:${server.port}` }, "[server] listening");

// Graceful shutdown — flush view counter + close infra so a
// container restart doesn't lose in-flight work or corrupt counters.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	logger.info({ signal }, "[server] shutdown signal received");

	// Stop accepting new HTTP/WS connections first.
	server.stop();

	// Stop scheduling new flushes, then run one final flush so anything sitting
	// in Redis lands in Postgres before we exit.
	stopViewCountFlusher();
	try {
		await flushViewCounts();
	} catch (err) {
		logger.error({ err }, "[server] final flushViewCounts failed");
	}

	// Release database + Redis handles.
	try {
		await prisma.$disconnect();
	} catch (err) {
		logger.error({ err }, "[server] prisma.$disconnect failed");
	}
	try {
		redis.disconnect();
	} catch (err) {
		logger.error({ err }, "[server] redis.disconnect failed");
	}

	logger.info("[server] shutdown complete");
	process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
