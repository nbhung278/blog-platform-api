import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { authRoutes } from "./routes/auth";
import { postsRoutes } from "./routes/posts";
import { aiRoutes } from "./routes/ai";
import { analyticsRoutes } from "./routes/analytics";
import { startWorkers } from "./queue";
import { startViewCountFlusher } from "./lib/view-counter";

const app = new Hono();

app.use("*", logger());
app.use(
	"*",
	cors({
		origin: process.env.APP_URL || "http://localhost:5173",
		credentials: true,
	}),
);

app.route("/api/auth", authRoutes);
app.route("/api/posts", postsRoutes);
app.route("/api/ai", aiRoutes);
app.route("/api/analytics", analyticsRoutes);

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
