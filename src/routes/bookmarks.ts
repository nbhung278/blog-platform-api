import { Hono } from "hono";
import { prisma } from "../db";
import { authMiddleware, type JWTPayload } from "../middleware/auth";
import { ipRateLimit } from "../middleware/rate-limit";
import { setPrivateNoStore } from "../lib/cache-headers";

const bookmarkLimit = ipRateLimit({ keyPrefix: "bookmark", limit: 120, windowSeconds: 60 });

export const bookmarksRoutes = new Hono<{ Variables: { user: JWTPayload } }>();

// List my bookmarks — paginated by createdAt for "your saved posts" page.
bookmarksRoutes.get("/", authMiddleware, async (c) => {
	const me = c.get("user");
	const limit = Math.min(50, Math.max(1, Number(c.req.query("limit")) || 20));
	const cursor = c.req.query("cursor"); // postId of the last item

	const rows = await prisma.postBookmark.findMany({
		where: { userId: me.sub },
		orderBy: { createdAt: "desc" },
		take: limit + 1,
		...(cursor ? { cursor: { userId_postId: { userId: me.sub, postId: cursor } }, skip: 1 } : {}),
		include: {
			post: {
				select: {
					id: true,
					title: true,
					slug: true,
					excerpt: true,
					coverUrl: true,
					thumbnailUrl: true,
					publishedAt: true,
					readingTime: true,
					tags: true,
					user: { select: { name: true, username: true, avatarUrl: true } },
				},
			},
		},
	});

	const hasMore = rows.length > limit;
	const items = hasMore ? rows.slice(0, limit) : rows;
	const nextCursor = hasMore ? items[items.length - 1].postId : null;

	setPrivateNoStore(c);
	return c.json({
		items: items.map((r) => ({ ...r.post, savedAt: r.createdAt })),
		nextCursor,
	});
});

// Did I save this post?
bookmarksRoutes.get("/posts/:postId", authMiddleware, async (c) => {
	const me = c.get("user");
	const postId = c.req.param("postId");
	const row = await prisma.postBookmark.findUnique({
		where: { userId_postId: { userId: me.sub, postId } },
		select: { createdAt: true },
	});
	setPrivateNoStore(c);
	return c.json({ saved: !!row, savedAt: row?.createdAt ?? null });
});

// Toggle save (idempotent). POST = save, DELETE = unsave.
bookmarksRoutes.post("/posts/:postId", bookmarkLimit, authMiddleware, async (c) => {
	const me = c.get("user");
	const postId = c.req.param("postId");

	const post = await prisma.post.findUnique({
		where: { id: postId },
		select: { status: true },
	});
	if (!post || post.status !== "published") {
		return c.json({ error: "Post not found" }, 404);
	}

	await prisma.postBookmark.upsert({
		where: { userId_postId: { userId: me.sub, postId } },
		create: { userId: me.sub, postId },
		update: {},
	});
	return c.json({ saved: true });
});

bookmarksRoutes.delete("/posts/:postId", bookmarkLimit, authMiddleware, async (c) => {
	const me = c.get("user");
	const postId = c.req.param("postId");
	await prisma.postBookmark.deleteMany({
		where: { userId: me.sub, postId },
	});
	return c.json({ saved: false });
});
