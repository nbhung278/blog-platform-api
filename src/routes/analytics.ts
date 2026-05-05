import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../db";
import { authMiddleware, requirePermission, type JWTPayload } from "../middleware/auth";
import { PERMISSIONS } from "../lib/permissions";
import { ipRateLimit } from "../middleware/rate-limit";

export const analyticsRoutes = new Hono<{ Variables: { user: JWTPayload } }>();

// Tight cap on the public ingest endpoint. Each value is short metadata; we
// truncate aggressively because anything bigger is almost certainly noise or
// abuse.
const META_FIELD_MAX = 200;
const SESSION_ID_MAX = 128;

const eventSchema = z.object({
	postId: z.string().uuid(),
	event: z.enum(["pageview", "scroll_50", "scroll_100", "like", "share"]),
	meta: z
		.object({
			referrer: z.string().max(META_FIELD_MAX).optional(),
			country: z.string().max(META_FIELD_MAX).optional(),
			device: z.string().max(META_FIELD_MAX).optional(),
			os: z.string().max(META_FIELD_MAX).optional(),
		})
		.optional(),
});

// Public endpoint — IP-bounded so anonymous traffic can't fill the table.
const eventLimit = ipRateLimit({ keyPrefix: "analytics-event", limit: 60, windowSeconds: 60 });

// Public: track event
analyticsRoutes.post("/event", eventLimit, zValidator("json", eventSchema), async (c) => {
	const body = c.req.valid("json");

	// Reject events for non-existent or non-published posts so the table stays
	// honest. `select: { id }` is cheap and indexed by PK.
	const post = await prisma.post.findFirst({
		where: { id: body.postId, status: "published" },
		select: { id: true },
	});
	if (!post) return c.json({ error: "Post not found" }, 404);

	const sessionId = (c.req.header("x-session-id") || "").slice(0, SESSION_ID_MAX) || null;

	await prisma.analyticsEvent.create({
		data: {
			postId: body.postId,
			sessionId,
			event: body.event,
			meta: body.meta || {},
		},
	});

	return c.json({ success: true }, 201);
});

// [auth] Get stats for a post — needs analytics:view + must own the post (or have write:any)
analyticsRoutes.get(
	"/:postId",
	authMiddleware,
	requirePermission(PERMISSIONS.ANALYTICS_VIEW),
	async (c) => {
		const user = c.get("user");
		const postId = c.req.param("postId");

		const post = await prisma.post.findUnique({
			where: { id: postId },
			select: { userId: true },
		});

		if (!post) {
			return c.json({ error: "Post not found" }, 404);
		}

		const isOwner = post.userId === user.sub;
		const canSeeAny = user.permissions.includes(PERMISSIONS.POST_WRITE_ANY);

		if (!isOwner && !canSeeAny) {
			return c.json({ error: "Forbidden" }, 403);
		}

		const stats = await prisma.analyticsEvent.groupBy({
			by: ["event"],
			where: { postId },
			_count: { event: true },
		});

		return c.json(stats.map((s) => ({ event: s.event, count: s._count.event })));
	},
);
