import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../db";
import { authMiddleware } from "../middleware/auth";
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

// [auth] List own posts
postsRoutes.get("/", authMiddleware, async (c) => {
	const user = c.get("user");

	const result = await prisma.post.findMany({
		where: { userId: user.sub },
		orderBy: { updatedAt: "desc" },
	});

	return c.json(result);
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

	// Background view count increment
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

// [auth] Create post
postsRoutes.post("/", authMiddleware, zValidator("json", createPostSchema), async (c) => {
	const user = c.get("user");
	const body = c.req.valid("json");

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

	// Enqueue for RAG indexing
	await enqueuePostIndexing(post.id, user.sub);

	return c.json(post, 201);
});

// [auth] Update post with optimistic locking
postsRoutes.patch("/:id", authMiddleware, zValidator("json", updatePostSchema), async (c) => {
	const user = c.get("user");
	const postId = c.req.param("id");
	const body = c.req.valid("json");

	const existing = await prisma.post.findFirst({
		where: { id: postId, userId: user.sub },
		select: { version: true },
	});

	if (!existing) {
		return c.json({ error: "Post not found" }, 404);
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

	// Re-index if content changed
	if (updates.content) {
		await enqueuePostIndexing(postId, user.sub);
	}

	return c.json(updated);
});

// [auth] Delete post
postsRoutes.delete("/:id", authMiddleware, async (c) => {
	const user = c.get("user");
	const postId = c.req.param("id");

	try {
		await prisma.post.delete({
			where: { id: postId, userId: user.sub },
		});
		return c.json({ success: true });
	} catch {
		return c.json({ error: "Post not found" }, 404);
	}
});
