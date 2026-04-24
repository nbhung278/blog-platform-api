import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../db";
import { authMiddleware, requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../lib/permissions";

export const analyticsRoutes = new Hono();

const eventSchema = z.object({
	postId: z.string().uuid(),
	event: z.enum(["pageview", "scroll_50", "scroll_100", "like", "share"]),
	meta: z
		.object({
			referrer: z.string().optional(),
			country: z.string().optional(),
			device: z.string().optional(),
			os: z.string().optional(),
		})
		.optional(),
});

// Public: track event
analyticsRoutes.post("/event", zValidator("json", eventSchema), async (c) => {
	const body = c.req.valid("json");

	await prisma.analyticsEvent.create({
		data: {
			postId: body.postId,
			sessionId: c.req.header("x-session-id") || null,
			event: body.event,
			meta: body.meta || {},
		},
	});

	return c.json({ success: true }, 201);
});

// [auth] Get stats for a post — needs analytics:view
analyticsRoutes.get(
	"/:postId",
	authMiddleware,
	requirePermission(PERMISSIONS.ANALYTICS_VIEW),
	async (c) => {
		const postId = c.req.param("postId");

		const stats = await prisma.analyticsEvent.groupBy({
			by: ["event"],
			where: { postId },
			_count: { event: true },
		});

		return c.json(stats.map((s) => ({ event: s.event, count: s._count.event })));
	},
);
