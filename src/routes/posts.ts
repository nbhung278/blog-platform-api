import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { authMiddleware, requireAnyPermission, tryGetUser } from "../middleware/auth";
import { PERMISSIONS } from "../lib/permissions";
import { ipRateLimit } from "../middleware/rate-limit";
import { incrementView, getPendingViews, getPendingViewsMap } from "../lib/view-counter";
import { notifyFollowersOfPost } from "../lib/notifications";
import { logger } from "../lib/logger";
import { isAllowedMediaUrl } from "../lib/url-allowlist";
import { deleteObject, extractOwnedS3Key } from "../lib/s3";

export const postsRoutes = new Hono();

// draft     — author saves, not visible to anyone but the author
// pending   — author submitted for review, awaiting moderator
// published — live on the public blog
// rejected  — moderator rejected; author can edit and resubmit
const POST_STATUSES = ["draft", "pending", "published", "rejected"] as const;
type PostStatus = (typeof POST_STATUSES)[number];

// Cap categories per post to keep listings focused and discourage tag-spam
// across every section. Mirrored in the frontend and admin editors.
const MAX_CATEGORIES_PER_POST = 3;

const createPostSchema = z.object({
	title: z.string().min(1).max(200),
	contentMd: z.string().max(200_000),
	contentHtml: z.string().max(400_000),
	excerpt: z.string().max(500).optional(),
	coverUrl: z
		.string()
		.url()
		.refine((u) => isAllowedMediaUrl(u), "coverUrl host not allowed")
		.nullable()
		.optional(),
	status: z.enum(POST_STATUSES).default("draft"),
	tags: z.array(z.string().max(50)).max(20).default([]),
	metaTitle: z.string().max(200).optional(),
	metaDesc: z.string().max(500).optional(),
	categoryIds: z
		.array(z.string().uuid())
		.min(1, "At least one category is required")
		.max(MAX_CATEGORIES_PER_POST, `At most ${MAX_CATEGORIES_PER_POST} categories are allowed`),
});

const updatePostSchema = z.object({
	title: z.string().min(1).max(200).optional(),
	contentMd: z.string().max(200_000).optional(),
	contentHtml: z.string().max(400_000).optional(),
	excerpt: z.string().max(500).optional(),
	coverUrl: z
		.string()
		.url()
		.refine((u) => isAllowedMediaUrl(u), "coverUrl host not allowed")
		.nullable()
		.optional(),
	status: z.enum(POST_STATUSES).optional(),
	tags: z.array(z.string().max(50)).max(20).optional(),
	metaTitle: z.string().max(200).optional(),
	metaDesc: z.string().max(500).optional(),
	version: z.number().int(),
	categoryIds: z
		.array(z.string().uuid())
		.min(1, "At least one category is required")
		.max(MAX_CATEGORIES_PER_POST, `At most ${MAX_CATEGORIES_PER_POST} categories are allowed`)
		.optional(),
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
	const q = (c.req.query("q") ?? "").trim().slice(0, 200);
	const page = Math.max(1, Number(c.req.query("page")) || 1);
	const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 20));

	const canSeeAll =
		user.permissions.includes(PERMISSIONS.POST_WRITE_ANY) ||
		user.permissions.includes(PERMISSIONS.POST_REVIEW);

	const wantAll = scope === "all" && canSeeAll;

	const where = {
		deletedAt: null,
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

		if (!canDeleteAny && !canDeleteOwn) {
			return c.json({ error: "Forbidden" }, 403);
		}

		// Fetch all posts to check ownership
		const posts = await prisma.post.findMany({
			where: { id: { in: ids }, deletedAt: null },
			select: { id: true, userId: true, coverUrl: true },
		});

		// Determine which posts the caller may actually delete. If they can only
		// delete their own, refuse the whole request when any forbidden id is
		// present — mixing allowed/forbidden in a bulk op is treated as caller
		// error rather than partial-success, so behavior matches the existing
		// API contract.
		const targets = canDeleteAny ? posts : [];
		if (!canDeleteAny) {
			const forbidden = posts.filter((p) => p.userId !== user.sub);
			if (forbidden.length > 0) {
				return c.json({ error: "Forbidden: you do not own some of these posts" }, 403);
			}
			targets.push(...posts.filter((p) => p.userId === user.sub));
		}

		if (targets.length === 0) {
			return c.json({ deleted: 0 });
		}

		const targetIds = targets.map((p) => p.id);
		const now = new Date();
		const result = await prisma.post.updateMany({
			where: { id: { in: targetIds }, deletedAt: null },
			data: { deletedAt: now },
		});

		// Fire-and-forget S3 cleanup. Each post's cover is only deleted if the
		// key lives under that author's prefix — refuses to wipe a file the
		// post's owner doesn't actually own (eg coverUrl pointed at someone
		// else's image).
		for (const p of targets) {
			const key = extractOwnedS3Key(p.coverUrl, p.userId);
			if (key) void deleteObject(key);
		}

		return c.json({ deleted: result.count });
	},
);

// Shared list-view projection — drops contentMd/contentHtml so list endpoints
// don't ship megabytes of body markup per request.
const POST_LIST_SELECT = {
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
	createdAt: true,
	updatedAt: true,
	user: { select: { name: true, username: true, avatarUrl: true } },
	categories: { select: { category: { select: { id: true, name: true, slug: true } } } },
} as const;

// Public: feed of all published posts from every author
postsRoutes.get(
	"/feed",
	ipRateLimit({ keyPrefix: "feed", limit: 120, windowSeconds: 60 }),
	async (c) => {
		c.header("Cache-Control", "public, s-maxage=30, stale-while-revalidate=60");
		const limit = Math.min(Number(c.req.query("limit")) || 20, 50);
		const cursor = c.req.query("cursor");

		const result = await prisma.post.findMany({
			where: { status: "published", deletedAt: null },
			orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
			take: limit + 1,
			...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
			select: POST_LIST_SELECT,
		});

		const hasMore = result.length > limit;
		const items = hasMore ? result.slice(0, limit) : result;
		const nextCursor = hasMore ? items[items.length - 1].id : null;

		return c.json({ items: await withPendingViews(items), nextCursor });
	},
);

// Public: top posts by all-time view count (homepage "Most viewed" rail).
postsRoutes.get(
	"/most-viewed",
	ipRateLimit({ keyPrefix: "posts-popular", limit: 60, windowSeconds: 60 }),
	async (c) => {
		c.header("Cache-Control", "public, s-maxage=120, stale-while-revalidate=300");
		const limit = Math.min(Math.max(Number(c.req.query("limit")) || 4, 1), 12);

		const posts = await prisma.post.findMany({
			where: { status: "published", deletedAt: null },
			orderBy: [{ viewCount: "desc" }, { publishedAt: "desc" }, { id: "desc" }],
			take: limit,
			select: POST_LIST_SELECT,
		});

		return c.json({ items: await withPendingViews(posts) });
	},
);

// Public: published posts grouped by category (homepage sections).
// `sort=popular` (default) ranks posts by viewCount; `sort=recent` falls back to
// publishedAt for chronological browsing.
//
// Implemented as two queries:
//   1) raw SQL with ROW_NUMBER() to pick the top `perCategory` post IDs per
//      category in a single pass, ranked by the requested order;
//   2) Prisma findMany on those IDs to load the relation-rich POST_LIST_SELECT
//      shape (author + categories) that the homepage renders.
// The naive shape — one findMany per category — was an N+1 that scaled with
// `maxCategories`; the window-function form is constant-query regardless.
postsRoutes.get(
	"/by-categories",
	ipRateLimit({ keyPrefix: "posts-by-cats", limit: 60, windowSeconds: 60 }),
	async (c) => {
		c.header("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
		const perCategory = Math.min(Math.max(Number(c.req.query("perCategory")) || 4, 1), 8);
		const maxCategories = Math.min(Math.max(Number(c.req.query("maxCategories")) || 6, 1), 12);
		const sort = c.req.query("sort") === "recent" ? "recent" : "popular";

		// Both branches tie-break on (published_at desc, id desc) so the order is
		// total — without the id tiebreaker, posts published in the same second
		// could swap positions between requests and break pagination assumptions
		// downstream.
		const rankExpr = Prisma.raw(
			sort === "popular"
				? "ROW_NUMBER() OVER (PARTITION BY pc.category_id ORDER BY p.view_count DESC, p.published_at DESC, p.id DESC)"
				: "ROW_NUMBER() OVER (PARTITION BY pc.category_id ORDER BY p.published_at DESC, p.id DESC)",
		);

		const ranked = await prisma.$queryRaw<
			{ post_id: string; category_id: string; category_name: string; category_slug: string }[]
		>`
			SELECT post_id, category_id, category_name, category_slug FROM (
				SELECT
					p.id AS post_id,
					c.id AS category_id,
					c.name AS category_name,
					c.slug AS category_slug,
					${rankExpr} AS rn
				FROM posts p
				JOIN post_categories pc ON pc.post_id = p.id
				JOIN categories c ON c.id = pc.category_id
				WHERE p.status = 'published' AND p.deleted_at IS NULL
			) t
			WHERE rn <= ${perCategory}
			ORDER BY category_name ASC, rn ASC
			LIMIT ${perCategory * maxCategories}
		`;

		if (ranked.length === 0) return c.json({ sections: [] });

		// Distinct categories in deterministic name order, capped at maxCategories.
		// We can't push maxCategories into SQL easily without another window pass,
		// so trim here — perCategory * maxCategories rows is small (≤ 96 default).
		const categoryOrder: { id: string; name: string; slug: string }[] = [];
		const seenCategories = new Set<string>();
		for (const r of ranked) {
			if (!seenCategories.has(r.category_id)) {
				seenCategories.add(r.category_id);
				if (categoryOrder.length < maxCategories) {
					categoryOrder.push({ id: r.category_id, name: r.category_name, slug: r.category_slug });
				}
			}
		}
		const allowedCategories = new Set(categoryOrder.map((c) => c.id));
		const trimmed = ranked.filter((r) => allowedCategories.has(r.category_id));
		const postIds = [...new Set(trimmed.map((r) => r.post_id))];

		const posts = await prisma.post.findMany({
			where: { id: { in: postIds } },
			select: POST_LIST_SELECT,
		});
		const hydrated = await withPendingViews(posts);
		const postById = new Map(hydrated.map((p) => [p.id, p]));

		const sections = categoryOrder
			.map((cat) => ({
				category: cat,
				posts: trimmed
					.filter((r) => r.category_id === cat.id)
					.map((r) => postById.get(r.post_id))
					.filter((p): p is NonNullable<typeof p> => p !== undefined),
			}))
			.filter((s) => s.posts.length > 0);

		return c.json({ sections });
	},
);

// Public: search posts by text query OR filter by category slug.
// Search requires q.length >= 3 to avoid scanning the whole table on noisy
// queries like "a"; category browse has no such floor.
const MIN_SEARCH_QUERY_LENGTH = 3;

postsRoutes.get(
	"/search",
	ipRateLimit({ keyPrefix: "post-search", limit: 30, windowSeconds: 60 }),
	async (c) => {
		const q = (c.req.query("q") ?? "").trim().slice(0, 200);
		const categorySlug = (c.req.query("category") ?? "").trim().slice(0, 100);
		const page = Math.max(Number(c.req.query("page")) || 1, 1);
		const limit = Math.min(Math.max(Number(c.req.query("limit")) || 12, 1), 50);

		if (!q && !categorySlug) {
			return c.json({ items: [], total: 0, page, limit, totalPages: 0 });
		}

		if (q && !categorySlug && q.length < MIN_SEARCH_QUERY_LENGTH) {
			return c.json(
				{ error: `Search query must be at least ${MIN_SEARCH_QUERY_LENGTH} characters` },
				400,
			);
		}

		const where = categorySlug
			? {
					status: "published" as const,
					deletedAt: null,
					categories: { some: { category: { slug: categorySlug } } },
				}
			: {
					status: "published" as const,
					deletedAt: null,
					OR: [
						{ title: { contains: q, mode: "insensitive" as const } },
						{ tags: { has: q } },
						{ user: { name: { contains: q, mode: "insensitive" as const } } },
						{ user: { username: { contains: q, mode: "insensitive" as const } } },
					],
				};

		const [total, result] = await Promise.all([
			prisma.post.count({ where }),
			prisma.post.findMany({
				where,
				orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
				skip: (page - 1) * limit,
				take: limit,
				select: POST_LIST_SELECT,
			}),
		]);

		const items = await withPendingViews(result);
		return c.json({
			items,
			total,
			page,
			limit,
			totalPages: Math.ceil(total / limit),
		});
	},
);

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

	if (!post || post.deletedAt) {
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
postsRoutes.get(
	"/:slug",
	ipRateLimit({ keyPrefix: "post-slug", limit: 300, windowSeconds: 60 }),
	async (c) => {
		c.header("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
		const slug = c.req.param("slug");

		const post = await prisma.post.findFirst({
			where: { slug, status: "published", deletedAt: null },
			include: {
				user: { select: { id: true, name: true, username: true, avatarUrl: true } },
				categories: { select: { category: { select: { id: true, name: true, slug: true } } } },
			},
		});

		if (!post) {
			return c.json({ error: "Post not found" }, 404);
		}

		// Increment first, then read pending — guarantees the current view is reflected.
		await incrementView(post.id).catch((err) =>
			logger.error({ err, postId: post.id }, "[view] increment failed"),
		);
		const pending = await getPendingViews(post.id);

		return c.json({ ...post, viewCount: post.viewCount + pending });
	},
);

// Public: list posts by username. The author themself sees own
// drafts/pending/rejected as well, so they can manage in-flight work
// from their profile page.
postsRoutes.get(
	"/public/:username",
	ipRateLimit({ keyPrefix: "post-by-user", limit: 60, windowSeconds: 60 }),
	async (c) => {
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
				deletedAt: null,
				...(isOwner
					? { status: { in: ["draft", "pending", "published", "rejected"] } }
					: { status: "published" }),
			},
			orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }],
			select: POST_LIST_SELECT,
		});

		return c.json(await withPendingViews(result));
	},
);

// [auth] Create post — needs write:own or write:any.
postsRoutes.post(
	"/",
	ipRateLimit({ keyPrefix: "post-create", limit: 20, windowSeconds: 60 * 60 }),
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
		select: {
			version: true,
			userId: true,
			status: true,
			publishedAt: true,
			deletedAt: true,
			coverUrl: true,
		},
	});

	if (!existing || existing.deletedAt) {
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

	if (isFirstPublish) {
		await notifyFollowersOfPost(existing.userId, postId, "post_published");
	} else if (isPublishedEdit) {
		await notifyFollowersOfPost(existing.userId, postId, "post_updated");
	}

	// Cover replaced or cleared → free the old object. Compare by key (not URL)
	// so a no-op rehost that returns the same key doesn't trigger a delete of
	// the file we just kept. Ownership-scoped extractor refuses to return a
	// key that doesn't live under the post owner's prefix — prevents a hostile
	// PATCH where coverUrl points at someone else's file from triggering its
	// deletion on the next update.
	if (updates.coverUrl !== undefined) {
		const oldKey = extractOwnedS3Key(existing.coverUrl, existing.userId);
		const newKey = extractOwnedS3Key(updates.coverUrl, existing.userId);
		if (oldKey && oldKey !== newKey) void deleteObject(oldKey);
	}

	return c.json(updated);
});

// [auth] Delete post — owner with delete:own, or anyone with delete:any
postsRoutes.delete("/:id", authMiddleware, async (c) => {
	const user = c.get("user");
	const postId = c.req.param("id");

	const existing = await prisma.post.findUnique({
		where: { id: postId },
		select: { userId: true, deletedAt: true, coverUrl: true },
	});

	if (!existing || existing.deletedAt) {
		return c.json({ error: "Post not found" }, 404);
	}

	const isOwner = existing.userId === user.sub;
	const canDeleteAny = user.permissions.includes(PERMISSIONS.POST_DELETE_ANY);
	const canDeleteOwn = user.permissions.includes(PERMISSIONS.POST_DELETE_OWN);

	if (!canDeleteAny && !(isOwner && canDeleteOwn)) {
		return c.json({ error: "Forbidden" }, 403);
	}

	await prisma.post.update({ where: { id: postId }, data: { deletedAt: new Date() } });

	// Free the cover from S3. Soft-delete keeps the row for audit/restore, but
	// the file is dead weight either way and storage adds up. If we add a
	// restore endpoint later, drop this and sweep on hard-delete instead.
	// Ownership-scoped: refuses to delete a key whose path doesn't match the
	// post owner — defends against coverUrl pointing at someone else's file.
	const key = extractOwnedS3Key(existing.coverUrl, existing.userId);
	if (key) void deleteObject(key);

	return c.json({ success: true });
});
