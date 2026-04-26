import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { authRoutes } from "./routes/auth";
import { postsRoutes } from "./routes/posts";
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
		origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
		credentials: true,
	}),
);

app.route("/api/auth", authRoutes);
app.route("/api/posts", postsRoutes);
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
