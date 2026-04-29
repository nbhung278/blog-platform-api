import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../db";
import { authMiddleware, requireAnyPermission, tryGetUser } from "../middleware/auth";
import { PERMISSIONS } from "../lib/permissions";
import { enqueuePostIndexing } from "../queue";
import { incrementView, getPendingViews, getPendingViewsMap } from "../lib/view-counter";
import { notifyFollowersOfPost } from "../lib/notifications";

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
	categoryIds: z.array(z.string().uuid()).min(1, "At least one category is required"),
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
	categoryIds: z.array(z.string().uuid()).min(1, "At least one category is required").optional(),
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
	const categoryId = c.req.query("categoryId");
	const q = (c.req.query("q") ?? "").trim();
	const page = Math.max(1, Number(c.req.query("page")) || 1);
	const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 20));

	const canSeeAll =
		user.permissions.includes(PERMISSIONS.POST_WRITE_ANY) ||
		user.permissions.includes(PERMISSIONS.POST_REVIEW);

	const wantAll = scope === "all" && canSeeAll;

	const where = {
		...(wantAll ? {} : { userId: user.sub }),
		...(statusFilter && POST_STATUSES.includes(statusFilter) ? { status: statusFilter } : {}),
		...(categoryId ? { categories: { some: { categoryId } } } : {}),
		...(q ? { title: { contains: q, mode: "insensitive" as const } } : {}),
	};

	const [total, result] = await Promise.all([
		prisma.post.count({ where }),
		prisma.post.findMany({
			where,
			orderBy: { updatedAt: "desc" },
			skip: (page - 1) * limit,
			take: limit,
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
				clapCount: true,
				tags: true,
				version: true,
				createdAt: true,
				updatedAt: true,
				user: { select: { id: true, name: true, username: true, avatarUrl: true } },
				categories: { select: { category: { select: { id: true, name: true, slug: true } } } },
			},
		}),
	]);

	return c.json({ data: await withPendingViews(result), total, page, limit });
});

// [auth] Bulk delete posts
postsRoutes.post(
	"/bulk-delete",
	authMiddleware,
	zValidator("json", z.object({ ids: z.array(z.string().uuid()).min(1) })),
	async (c) => {
		const user = c.get("user");
		const { ids } = c.req.valid("json");

		const canDeleteAny = user.permissions.includes(PERMISSIONS.POST_DELETE_ANY);
		const canDeleteOwn = user.permissions.includes(PERMISSIONS.POST_DELETE_OWN);

		// Fetch all posts to check ownership
		const posts = await prisma.post.findMany({
			where: { id: { in: ids } },
			select: { id: true, userId: true },
		});

		// If user can delete any, skip ownership check
		if (!canDeleteAny) {
			const forbidden = posts.filter((p) => p.userId !== user.sub);
			if (forbidden.length > 0) {
				return c.json({ error: "Forbidden: you do not own some of these posts" }, 403);
			}
			if (!canDeleteOwn) {
				return c.json({ error: "Forbidden" }, 403);
			}
		}

		await prisma.post.deleteMany({ where: { id: { in: ids } } });
		return c.json({ deleted: ids.length });
	},
);

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
			user: { select: { name: true, username: true, avatarUrl: true } },
			categories: { select: { category: { select: { id: true, name: true, slug: true } } } },
		},
	});

	const hasMore = result.length > limit;
	const items = hasMore ? result.slice(0, limit) : result;
	const nextCursor = hasMore ? items[items.length - 1].id : null;

	return c.json({ items: await withPendingViews(items), nextCursor });
});

// Public: search posts by text query OR filter by category slug
postsRoutes.get("/search", async (c) => {
	const q = (c.req.query("q") ?? "").trim();
	const categorySlug = (c.req.query("category") ?? "").trim();

	if (!q && !categorySlug) return c.json({ items: [], total: 0 });

	const where = categorySlug
		? { status: "published" as const, categories: { some: { category: { slug: categorySlug } } } }
		: {
				status: "published" as const,
				OR: [
					{ title: { contains: q, mode: "insensitive" as const } },
					{ tags: { has: q } },
					{ user: { name: { contains: q, mode: "insensitive" as const } } },
					{ user: { username: { contains: q, mode: "insensitive" as const } } },
				],
			};

	const result = await prisma.post.findMany({
		where,
		orderBy: { publishedAt: "desc" },
		take: 50,
		include: {
			user: { select: { name: true, username: true, avatarUrl: true } },
			categories: { select: { category: { select: { id: true, name: true, slug: true } } } },
		},
	});

	const items = await withPendingViews(result);
	return c.json({ items, total: items.length });
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
			categories: { select: { category: { select: { id: true, name: true, slug: true } } } },
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
	await incrementView(post.id).catch((err) => console.error("[view] increment failed:", err));
	const pending = await getPendingViews(post.id);

	return c.json({ ...post, viewCount: post.viewCount + pending });
});

// Public: list posts by username. The author themself sees own
// drafts/pending/rejected as well, so they can manage in-flight work
// from their profile page.
postsRoutes.get("/public/:username", async (c) => {
	const username = c.req.param("username");
	const viewer = await tryGetUser(c);

	const author = await prisma.user.findUnique({
		where: { username },
		select: { id: true },
	});
	if (!author) return c.json([]);

	const isOwner = viewer?.sub === author.id;

	const result = await prisma.post.findMany({
		where: {
			user: { username },
			...(isOwner
				? { status: { in: ["draft", "pending", "published", "rejected"] } }
				: { status: "published" }),
		},
		orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }],
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
				categories: {
					create: body.categoryIds.map((categoryId) => ({ categoryId })),
				},
			},
			include: {
				categories: { select: { category: { select: { id: true, name: true, slug: true } } } },
			},
		});

		await enqueuePostIndexing(post.id, user.sub);

		if (post.status === "published") {
			await notifyFollowersOfPost(user.sub, post.id, "post_published");
		}

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

	const { version, categoryIds, ...updates } = body;
	const readingTime = updates.contentMd ? calcReadingTime(updates.contentMd) : undefined;
	// Set publishedAt when transitioning to published for the first time.
	const isFirstPublish = updates.status === "published" && existing.status !== "published";
	const publishedAt = isFirstPublish ? new Date() : undefined;

	// Followers care about meaningful content changes — title or body. Tag
	// edits, cover swaps, etc. shouldn't fan-out notifications.
	const isPublishedEdit =
		existing.status === "published" &&
		(updates.status === undefined || updates.status === "published") &&
		(updates.title !== undefined || updates.contentMd !== undefined);

	const updated = await prisma.post.update({
		where: { id: postId },
		data: {
			...updates,
			...(readingTime !== undefined && { readingTime }),
			...(publishedAt !== undefined && { publishedAt }),
			version: version + 1,
			...(categoryIds !== undefined && {
				categories: {
					deleteMany: {},
					create: categoryIds.map((categoryId) => ({ categoryId })),
				},
			}),
		},
		include: {
			categories: { select: { category: { select: { id: true, name: true, slug: true } } } },
		},
	});

	if (updates.contentMd) {
		await enqueuePostIndexing(postId, existing.userId);
	}

	if (isFirstPublish) {
		await notifyFollowersOfPost(existing.userId, postId, "post_published");
	} else if (isPublishedEdit) {
		await notifyFollowersOfPost(existing.userId, postId, "post_updated");
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
