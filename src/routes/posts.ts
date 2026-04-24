import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../db";
import { authMiddleware, requireAnyPermission } from "../middleware/auth";
import { PERMISSIONS } from "../lib/permissions";
import { enqueuePostIndexing } from "../queue";
import { incrementView } from "../lib/view-counter";

export const postsRoutes = new Hono();

const createPostSchema = z.object({
	title: z.string().min(1),
	content: z.string(),
	excerpt: z.string().optional(),
	coverUrl: z.string().url().optional(),
	status: z.enum(["draft", "published"]).default("draft"),
	tags: z.array(z.string()).default([]),
	metaTitle: z.string().optional(),
	metaDesc: z.string().optional(),
});

const updatePostSchema = z.object({
	title: z.string().min(1).optional(),
	content: z.string().optional(),
	excerpt: z.string().optional(),
	coverUrl: z.string().url().nullable().optional(),
	status: z.enum(["draft", "published"]).optional(),
	tags: z.array(z.string()).optional(),
	metaTitle: z.string().optional(),
	metaDesc: z.string().optional(),
	version: z.number().int(),
});

function slugify(title: string): string {
	return (
		title
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, "")
			.replace(/\s+/g, "-")
			.replace(/-+/g, "-")
			.trim() +
		"-" +
		Date.now().toString(36)
	);
}

function calcReadingTime(content: string): number {
	const wordCount = content.split(/\s+/).filter(Boolean).length;
	return Math.ceil(wordCount / 200);
}

// [auth] List posts — own posts, or all posts if user has POST_WRITE_ANY
postsRoutes.get("/", authMiddleware, async (c) => {
	const user = c.get("user");
	const canSeeAll = user.permissions.includes(PERMISSIONS.POST_WRITE_ANY);

	const result = await prisma.post.findMany({
		where: canSeeAll ? {} : { userId: user.sub },
		orderBy: { updatedAt: "desc" },
	});

	return c.json(result);
});

// Public: feed of all published posts from every author
postsRoutes.get("/feed", async (c) => {
	const limit = Math.min(Number(c.req.query("limit")) || 20, 50);
	const cursor = c.req.query("cursor");

	const result = await prisma.post.findMany({
		where: { status: "published" },
		orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
		take: limit + 1,
		...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
		include: {
			user: {
				select: { name: true, username: true, avatarUrl: true },
			},
		},
	});

	const hasMore = result.length > limit;
	const items = hasMore ? result.slice(0, limit) : result;
	const nextCursor = hasMore ? items[items.length - 1].id : null;

	return c.json({ items, nextCursor });
});

// Public: get post by slug
postsRoutes.get("/:slug", async (c) => {
	const slug = c.req.param("slug");

	const post = await prisma.post.findFirst({
		where: { slug, status: "published" },
	});

	if (!post) {
		return c.json({ error: "Post not found" }, 404);
	}

	incrementView(post.id).catch(() => {});

	return c.json(post);
});

// Public: list posts by username
postsRoutes.get("/public/:username", async (c) => {
	const username = c.req.param("username");

	const result = await prisma.post.findMany({
		where: {
			status: "published",
			user: { username },
		},
		orderBy: { publishedAt: "desc" },
		include: {
			user: {
				select: { name: true, username: true, avatarUrl: true },
			},
		},
	});

	return c.json(result);
});

// [auth] Create post — needs write:own or write:any. Publish needs publish:any.
postsRoutes.post(
	"/",
	authMiddleware,
	requireAnyPermission(PERMISSIONS.POST_WRITE_OWN, PERMISSIONS.POST_WRITE_ANY),
	zValidator("json", createPostSchema),
	async (c) => {
		const user = c.get("user");
		const body = c.req.valid("json");

		if (body.status === "published" && !user.permissions.includes(PERMISSIONS.POST_PUBLISH_ANY)) {
			return c.json({ error: "Forbidden: cannot publish" }, 403);
		}

		const slug = slugify(body.title);
		const readingTime = calcReadingTime(body.content);
		const publishedAt = body.status === "published" ? new Date() : null;

		const post = await prisma.post.create({
			data: {
				userId: user.sub,
				title: body.title,
				slug,
				content: body.content,
				excerpt: body.excerpt,
				coverUrl: body.coverUrl,
				status: body.status,
				publishedAt,
				readingTime,
				tags: body.tags,
				metaTitle: body.metaTitle,
				metaDesc: body.metaDesc,
			},
		});

		await enqueuePostIndexing(post.id, user.sub);

		return c.json(post, 201);
	},
);

// [auth] Update post — author can update own, admin (write:any) can update any
postsRoutes.patch("/:id", authMiddleware, zValidator("json", updatePostSchema), async (c) => {
	const user = c.get("user");
	const postId = c.req.param("id");
	const body = c.req.valid("json");

	const existing = await prisma.post.findUnique({
		where: { id: postId },
		select: { version: true, userId: true },
	});

	if (!existing) {
		return c.json({ error: "Post not found" }, 404);
	}

	const isOwner = existing.userId === user.sub;
	const canWriteAny = user.permissions.includes(PERMISSIONS.POST_WRITE_ANY);
	const canWriteOwn = user.permissions.includes(PERMISSIONS.POST_WRITE_OWN);

	if (!canWriteAny && !(isOwner && canWriteOwn)) {
		return c.json({ error: "Forbidden" }, 403);
	}

	if (body.status === "published" && !user.permissions.includes(PERMISSIONS.POST_PUBLISH_ANY)) {
		return c.json({ error: "Forbidden: cannot publish" }, 403);
	}

	if (existing.version !== body.version) {
		return c.json({ error: "Conflict" }, 409);
	}

	const { version, ...updates } = body;
	const readingTime = updates.content ? calcReadingTime(updates.content) : undefined;
	const publishedAt = updates.status === "published" ? new Date() : undefined;

	const updated = await prisma.post.update({
		where: { id: postId },
		data: {
			...updates,
			...(readingTime !== undefined && { readingTime }),
			...(publishedAt !== undefined && { publishedAt }),
			version: version + 1,
		},
	});

	if (updates.content) {
		await enqueuePostIndexing(postId, existing.userId);
	}

	return c.json(updated);
});

// [auth] Delete post — owner with delete:own, or anyone with delete:any
postsRoutes.delete("/:id", authMiddleware, async (c) => {
	const user = c.get("user");
	const postId = c.req.param("id");

	const existing = await prisma.post.findUnique({
		where: { id: postId },
		select: { userId: true },
	});

	if (!existing) {
		return c.json({ error: "Post not found" }, 404);
	}

	const isOwner = existing.userId === user.sub;
	const canDeleteAny = user.permissions.includes(PERMISSIONS.POST_DELETE_ANY);
	const canDeleteOwn = user.permissions.includes(PERMISSIONS.POST_DELETE_OWN);

	if (!canDeleteAny && !(isOwner && canDeleteOwn)) {
		return c.json({ error: "Forbidden" }, 403);
	}

	await prisma.post.delete({ where: { id: postId } });
	return c.json({ success: true });
});
