import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../db";
import { authMiddleware, requireAnyPermission } from "../middleware/auth";
import { PERMISSIONS } from "../lib/permissions";
import { enqueuePostIndexing } from "../queue";
import { incrementView, getPendingViews, getPendingViewsMap } from "../lib/view-counter";

export const postsRoutes = new Hono();

// draft     — author saves, not visible to anyone but the author
// pending   — author submitted for review, awaiting moderator
// published — live on the public blog
// rejected  — moderator rejected; author can edit and resubmit
const POST_STATUSES = ["draft", "pending", "published", "rejected"] as const;
type PostStatus = (typeof POST_STATUSES)[number];

const createPostSchema = z.object({
	title: z.string().min(1),
	contentMd: z.string(),
	contentHtml: z.string(),
	excerpt: z.string().optional(),
	coverUrl: z.string().url().nullable().optional(),
	status: z.enum(POST_STATUSES).default("draft"),
	tags: z.array(z.string()).default([]),
	metaTitle: z.string().optional(),
	metaDesc: z.string().optional(),
});

const updatePostSchema = z.object({
	title: z.string().min(1).optional(),
	contentMd: z.string().optional(),
	contentHtml: z.string().optional(),
	excerpt: z.string().optional(),
	coverUrl: z.string().url().nullable().optional(),
	status: z.enum(POST_STATUSES).optional(),
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

function calcReadingTime(markdown: string): number {
	const wordCount = markdown.split(/\s+/).filter(Boolean).length;
	return Math.ceil(wordCount / 200);
}

// What status is the user allowed to assign?
//   - POST_PUBLISH_ANY → can set anything (publish/reject moderation actions)
//   - otherwise        → only draft/pending (submit for review)
function assertCanSetStatus(
	status: PostStatus | undefined,
	permissions: string[],
): { ok: true } | { ok: false; reason: string } {
	if (!status) return { ok: true };
	if (status === "published" || status === "rejected") {
		if (!permissions.includes(PERMISSIONS.POST_PUBLISH_ANY)) {
			return { ok: false, reason: `Forbidden: cannot set status to ${status}` };
		}
	}
	return { ok: true };
}

// Merge unflushed Redis pending views into a list of posts in one MGET.
async function withPendingViews<T extends { id: string; viewCount: number }>(
	posts: T[],
): Promise<T[]> {
	if (posts.length === 0) return posts;
	const pending = await getPendingViewsMap(posts.map((p) => p.id));
	if (pending.size === 0) return posts;
	return posts.map((p) => ({ ...p, viewCount: p.viewCount + (pending.get(p.id) ?? 0) }));
}

// [auth] List posts — own posts, or all posts if user has POST_WRITE_ANY / POST_REVIEW
postsRoutes.get("/", authMiddleware, async (c) => {
	const user = c.get("user");
	const scope = c.req.query("scope"); // "mine" | "all"
	const statusFilter = c.req.query("status") as PostStatus | undefined;

	const canSeeAll =
		user.permissions.includes(PERMISSIONS.POST_WRITE_ANY) ||
		user.permissions.includes(PERMISSIONS.POST_REVIEW);

	const wantAll = scope === "all" && canSeeAll;

	const result = await prisma.post.findMany({
		where: {
			...(wantAll ? {} : { userId: user.sub }),
			...(statusFilter && POST_STATUSES.includes(statusFilter) ? { status: statusFilter } : {}),
		},
		orderBy: { updatedAt: "desc" },
		select: {
			id: true,
			title: true,
			slug: true,
			excerpt: true,
			coverUrl: true,
			status: true,
			publishedAt: true,
			readingTime: true,
			viewCount: true,
			likeCount: true,
			tags: true,
			version: true,
			createdAt: true,
			updatedAt: true,
			user: { select: { id: true, name: true, username: true, avatarUrl: true } },
		},
	});

	return c.json(await withPendingViews(result));
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

	return c.json({ items: await withPendingViews(items), nextCursor });
});

// [auth] Get a single post by id (for editing / preview).
// Author can read own, moderator/admin can read any.
postsRoutes.get("/id/:id", authMiddleware, async (c) => {
	const user = c.get("user");
	const id = c.req.param("id");

	const post = await prisma.post.findUnique({
		where: { id },
		include: {
			user: { select: { id: true, name: true, username: true, avatarUrl: true } },
		},
	});

	if (!post) {
		return c.json({ error: "Post not found" }, 404);
	}

	const isOwner = post.userId === user.sub;
	const canSeeAny =
		user.permissions.includes(PERMISSIONS.POST_WRITE_ANY) ||
		user.permissions.includes(PERMISSIONS.POST_REVIEW);

	if (!isOwner && !canSeeAny) {
		return c.json({ error: "Forbidden" }, 403);
	}

	const pending = await getPendingViews(post.id);
	return c.json({ ...post, viewCount: post.viewCount + pending });
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

	// Increment first, then read pending — guarantees the current view is reflected.
	await incrementView(post.id).catch(() => {});
	const pending = await getPendingViews(post.id);

	return c.json({ ...post, viewCount: post.viewCount + pending });
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

	return c.json(await withPendingViews(result));
});

// [auth] Create post — needs write:own or write:any.
postsRoutes.post(
	"/",
	authMiddleware,
	requireAnyPermission(PERMISSIONS.POST_WRITE_OWN, PERMISSIONS.POST_WRITE_ANY),
	zValidator("json", createPostSchema),
	async (c) => {
		const user = c.get("user");
		const body = c.req.valid("json");

		const guard = assertCanSetStatus(body.status, user.permissions);
		if (!guard.ok) {
			return c.json({ error: guard.reason }, 403);
		}

		const slug = slugify(body.title);
		const readingTime = calcReadingTime(body.contentMd);
		const publishedAt = body.status === "published" ? new Date() : null;

		const post = await prisma.post.create({
			data: {
				userId: user.sub,
				title: body.title,
				slug,
				contentMd: body.contentMd,
				contentHtml: body.contentHtml,
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

// [auth] Update post — author can update own, admin (write:any) can update any.
postsRoutes.patch("/:id", authMiddleware, zValidator("json", updatePostSchema), async (c) => {
	const user = c.get("user");
	const postId = c.req.param("id");
	const body = c.req.valid("json");

	const existing = await prisma.post.findUnique({
		where: { id: postId },
		select: { version: true, userId: true, status: true, publishedAt: true },
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

	const guard = assertCanSetStatus(body.status, user.permissions);
	if (!guard.ok) {
		return c.json({ error: guard.reason }, 403);
	}

	if (existing.version !== body.version) {
		return c.json({ error: "Conflict" }, 409);
	}

	const { version, ...updates } = body;
	const readingTime = updates.contentMd ? calcReadingTime(updates.contentMd) : undefined;
	// Set publishedAt when transitioning to published for the first time.
	const publishedAt =
		updates.status === "published" && existing.status !== "published" ? new Date() : undefined;

	const updated = await prisma.post.update({
		where: { id: postId },
		data: {
			...updates,
			...(readingTime !== undefined && { readingTime }),
			...(publishedAt !== undefined && { publishedAt }),
			version: version + 1,
		},
	});

	if (updates.contentMd) {
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
