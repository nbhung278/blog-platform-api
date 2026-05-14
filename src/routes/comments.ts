import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../db";
import { authMiddleware, type JWTPayload, tryGetUser } from "../middleware/auth";
import { PERMISSIONS } from "../lib/permissions";
import { ipRateLimit } from "../middleware/rate-limit";
import { createNotification } from "../lib/notifications";

const writeLimit = ipRateLimit({ keyPrefix: "comment-write", limit: 30, windowSeconds: 60 });
const readLimit = ipRateLimit({ keyPrefix: "comment-read", limit: 60, windowSeconds: 60 });

export const commentsRoutes = new Hono<{ Variables: { user: JWTPayload } }>();

const COMMENT_MAX_LEN = 5000;

// Comments are stored flat with parentId. We materialize a 2-level tree
// (top-level + direct replies) on read — deeper nesting tends to look bad
// and degrade quickly, so threads beyond depth 2 inline at depth 2 like Reddit.
type CommentRow = {
	id: string;
	postId: string;
	userId: string | null;
	parentId: string | null;
	content: string;
	isDeleted: boolean;
	clapCount: number;
	createdAt: Date;
	updatedAt: Date;
	user: { id: string; name: string; username: string; avatarUrl: string | null } | null;
};

function serialize(c: CommentRow, myClaps = 0) {
	// `updatedAt` lands a few microseconds after `createdAt` even on a fresh
	// row (Prisma sets both via the Postgres clock independently), so don't
	// rely on equality for the "(edited)" indicator. The threshold below is
	// generous enough to absorb that drift while still flagging real edits.
	const isEdited = c.updatedAt.getTime() - c.createdAt.getTime() > 1000;
	return {
		id: c.id,
		postId: c.postId,
		parentId: c.parentId,
		content: c.isDeleted ? "" : c.content,
		isDeleted: c.isDeleted,
		isEdited,
		clapCount: c.clapCount,
		myClaps,
		createdAt: c.createdAt.toISOString(),
		updatedAt: c.updatedAt.toISOString(),
		user: c.user,
	};
}

// Public list — paged top-level comments + every reply for those threads.
// We bundle all replies in one query (no N+1) and group them client-side.
commentsRoutes.get("/posts/:postId", readLimit, async (c) => {
	const postId = c.req.param("postId");
	const limit = Math.min(50, Math.max(1, Number(c.req.query("limit")) || 20));
	const cursor = c.req.query("cursor");
	const sort = c.req.query("sort") === "top" ? "top" : "new";
	const viewer = await tryGetUser(c);

	const cursorFilter = (() => {
		if (!cursor) return {};
		if (sort === "new") return { createdAt: { lt: new Date(cursor) } };
		const colonIdx = cursor.indexOf(":");
		const clapCount = Number(cursor.slice(0, colonIdx));
		const createdAt = new Date(cursor.slice(colonIdx + 1));
		if (colonIdx === -1 || isNaN(clapCount) || isNaN(createdAt.getTime())) return {};
		return {
			OR: [{ clapCount: { lt: clapCount } }, { clapCount, createdAt: { lt: createdAt } }],
		};
	})();

	const where = {
		postId,
		parentId: null,
		...cursorFilter,
	};

	const orderBy =
		sort === "top"
			? [{ clapCount: "desc" as const }, { createdAt: "desc" as const }]
			: [{ createdAt: "desc" as const }];

	// Fetch the page and the total count in parallel — the count query is
	// independent of the page query, so paying the round-trip serially was
	// wasted latency on every list request.
	const [top, total] = await Promise.all([
		prisma.comment.findMany({
			where,
			orderBy,
			take: limit + 1,
			include: {
				user: { select: { id: true, name: true, username: true, avatarUrl: true } },
			},
		}),
		prisma.comment.count({ where: { postId, isDeleted: false } }),
	]);

	const hasMore = top.length > limit;
	const items = hasMore ? top.slice(0, limit) : top;
	const lastItem = items[items.length - 1];
	const nextCursor = hasMore
		? sort === "new"
			? lastItem.createdAt.toISOString()
			: `${lastItem.clapCount}:${lastItem.createdAt.toISOString()}`
		: null;

	const replies = items.length
		? await prisma.comment.findMany({
				where: { parentId: { in: items.map((t) => t.id) } },
				orderBy: { createdAt: "asc" },
				include: {
					user: { select: { id: true, name: true, username: true, avatarUrl: true } },
				},
			})
		: [];

	// Fetch the viewer's clap count on every comment in this page in one query.
	let clapMap = new Map<string, number>();
	if (viewer) {
		const ids = [...items.map((i) => i.id), ...replies.map((r) => r.id)];
		if (ids.length) {
			const claps = await prisma.commentClap.findMany({
				where: { userId: viewer.sub, commentId: { in: ids } },
				select: { commentId: true, count: true },
			});
			clapMap = new Map(claps.map((v) => [v.commentId, v.count]));
		}
	}

	const repliesByParent = new Map<string, CommentRow[]>();
	for (const r of replies) {
		const list = repliesByParent.get(r.parentId!) ?? [];
		list.push(r);
		repliesByParent.set(r.parentId!, list);
	}

	const out = items.map((t) => ({
		...serialize(t, clapMap.get(t.id) ?? 0),
		replies: (repliesByParent.get(t.id) ?? []).map((r) => serialize(r, clapMap.get(r.id) ?? 0)),
	}));

	return c.json({ items: out, nextCursor, total });
});

const createSchema = z.object({
	content: z.string().min(1).max(COMMENT_MAX_LEN),
	parentId: z.string().uuid().optional(),
});

commentsRoutes.post(
	"/posts/:postId",
	writeLimit,
	authMiddleware,
	zValidator("json", createSchema),
	async (c) => {
		const postId = c.req.param("postId");
		const me = c.get("user");
		const { content, parentId } = c.req.valid("json");

		const post = await prisma.post.findUnique({
			where: { id: postId },
			select: { id: true, status: true, userId: true, slug: true, title: true },
		});
		if (!post || post.status !== "published") {
			return c.json({ error: "Post not found" }, 404);
		}

		// If replying, verify parent belongs to this post. We cap at 1 level of
		// nesting — replies-of-replies attach to the same root. We still want to
		// notify the *direct* parent's author so a thread like A → B → C surfaces
		// "C replied" to B (not just to A).
		let resolvedParentId: string | null = null;
		let directParentAuthorId: string | null = null;
		if (parentId) {
			const parent = await prisma.comment.findUnique({
				where: { id: parentId },
				select: { postId: true, parentId: true, userId: true, id: true },
			});
			if (!parent || parent.postId !== postId) {
				return c.json({ error: "Parent comment not found" }, 404);
			}
			resolvedParentId = parent.parentId ?? parent.id;
			directParentAuthorId = parent.userId;
		}

		// Atomic insert: comment + reply notification commit together. Without
		// this, a comment could be persisted while its reply notification is
		// silently dropped (network blip between the two statements), and the
		// parent comment author would never know they were replied to.
		const created = await prisma.$transaction(async (tx) => {
			const comment = await tx.comment.create({
				data: {
					postId,
					userId: me.sub,
					parentId: resolvedParentId,
					content,
				},
				include: {
					user: { select: { id: true, name: true, username: true, avatarUrl: true } },
				},
			});

			// Notify only the parent commenter on a reply. Top-level comments do NOT
			// notify the post author — keeps the inbox quiet on popular posts.
			if (resolvedParentId && directParentAuthorId) {
				await createNotification(
					{
						userId: directParentAuthorId,
						actorId: me.sub,
						type: "comment_reply",
						postId: post.id,
						commentId: comment.id,
					},
					tx,
				);
			}

			return comment;
		});

		return c.json(serialize(created, 0), 201);
	},
);

const updateSchema = z.object({
	content: z.string().min(1).max(COMMENT_MAX_LEN),
});

commentsRoutes.patch(
	"/:id",
	writeLimit,
	authMiddleware,
	zValidator("json", updateSchema),
	async (c) => {
		const id = c.req.param("id");
		const me = c.get("user");
		const { content } = c.req.valid("json");

		const existing = await prisma.comment.findUnique({
			where: { id },
			select: { userId: true, isDeleted: true },
		});
		if (!existing || existing.isDeleted) {
			return c.json({ error: "Comment not found" }, 404);
		}
		if (existing.userId !== me.sub) {
			return c.json({ error: "Forbidden" }, 403);
		}

		const updated = await prisma.comment.update({
			where: { id },
			data: { content },
			include: {
				user: { select: { id: true, name: true, username: true, avatarUrl: true } },
			},
		});
		return c.json(serialize(updated, 0));
	},
);

// Soft-delete to preserve thread structure (Reddit/HN approach).
commentsRoutes.delete("/:id", authMiddleware, async (c) => {
	const id = c.req.param("id");
	const me = c.get("user");

	const existing = await prisma.comment.findUnique({
		where: { id },
		select: { userId: true, isDeleted: true },
	});
	if (!existing) return c.json({ error: "Comment not found" }, 404);
	if (existing.isDeleted) return c.json({ success: true });

	const isOwner = existing.userId === me.sub;
	const canDeleteAny = me.permissions.includes(PERMISSIONS.COMMENT_DELETE_ANY);
	if (!isOwner && !canDeleteAny) {
		return c.json({ error: "Forbidden" }, 403);
	}

	await prisma.comment.update({
		where: { id },
		data: { content: "", isDeleted: true },
	});
	return c.json({ success: true });
});
