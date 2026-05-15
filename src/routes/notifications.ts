import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../db";
import { authMiddleware, type JWTPayload } from "../middleware/auth";
import { ipRateLimit } from "../middleware/rate-limit";
import { publishToUser } from "../lib/realtime";
import { setPrivateNoStore } from "../lib/cache-headers";

// Mark-read floods would echo unread_count over every connected socket; cap
// at 120/min/IP so a real user clicking many notifications is fine but a
// scripted flood gets cut off.
const markReadLimit = ipRateLimit({
	keyPrefix: "notif-mark",
	limit: 120,
	windowSeconds: 60,
});

export const notificationsRoutes = new Hono<{ Variables: { user: JWTPayload } }>();

const NOTIFICATION_INCLUDE = {
	actor: { select: { id: true, name: true, username: true, avatarUrl: true } },
	post: {
		select: { id: true, slug: true, title: true, user: { select: { username: true } } },
	},
} as const;

const listSchema = z.object({
	limit: z.coerce.number().int().min(1).max(50).optional(),
	cursor: z.string().uuid().optional(),
});

notificationsRoutes.get("/", authMiddleware, zValidator("query", listSchema), async (c) => {
	const me = c.get("user");
	const { limit = 20, cursor } = c.req.valid("query");

	const items = await prisma.notification.findMany({
		where: { userId: me.sub },
		orderBy: { createdAt: "desc" },
		take: limit + 1,
		...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
		include: NOTIFICATION_INCLUDE,
	});

	const hasMore = items.length > limit;
	const trimmed = hasMore ? items.slice(0, limit) : items;
	setPrivateNoStore(c);
	return c.json({
		items: trimmed,
		nextCursor: hasMore ? trimmed[trimmed.length - 1]?.id : null,
	});
});

notificationsRoutes.get("/unread-count", authMiddleware, async (c) => {
	const me = c.get("user");
	const count = await prisma.notification.count({
		where: { userId: me.sub, isRead: false },
	});
	setPrivateNoStore(c);
	return c.json({ count });
});

const markReadSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(100) });

notificationsRoutes.post(
	"/mark-read",
	markReadLimit,
	authMiddleware,
	zValidator("json", markReadSchema),
	async (c) => {
		const me = c.get("user");
		const { ids } = c.req.valid("json");

		await prisma.notification.updateMany({
			where: { id: { in: ids }, userId: me.sub, isRead: false },
			data: { isRead: true },
		});

		const count = await prisma.notification.count({
			where: { userId: me.sub, isRead: false },
		});
		publishToUser(me.sub, { kind: "unread_count", count });

		return c.json({ success: true, unread: count });
	},
);

notificationsRoutes.post("/mark-all-read", markReadLimit, authMiddleware, async (c) => {
	const me = c.get("user");
	await prisma.notification.updateMany({
		where: { userId: me.sub, isRead: false },
		data: { isRead: true },
	});
	publishToUser(me.sub, { kind: "unread_count", count: 0 });
	return c.json({ success: true });
});
