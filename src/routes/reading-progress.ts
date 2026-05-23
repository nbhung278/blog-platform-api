import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../db";
import { authMiddleware } from "../middleware/auth";
import { ipRateLimit } from "../middleware/rate-limit";
import { setPrivateNoStore } from "../lib/cache-headers";

export const readingProgressRoutes = new Hono();

// Bounds chosen so a "Continue reading" card shows up only when the user has
// meaningfully started AND not effectively finished. <5% is treated as a
// drive-by (opened, scrolled a touch, left); >=95% is "done" and the card
// just clutters the list.
const RESUME_MIN_PROGRESS = 0.05;
const RESUME_MAX_PROGRESS = 0.95;

// Hard cap on rows kept per user. When we upsert and the user has more than
// this many rows, the oldest are pruned. Keeps a single user's history from
// growing unbounded if they read 1000 posts.
const MAX_ROWS_PER_USER = 50;

const upsertSchema = z.object({
	postId: z.string().uuid(),
	progress: z.number().min(0).max(1),
	scrollY: z.number().int().min(0).max(1_000_000),
});

// [auth] Upsert reading progress for the current user on a post.
// Rate-limited generously (per minute) because the editor's scroll listener
// fires every ~5s while the user scrolls; bursts during fast scrolling are
// expected and benign.
readingProgressRoutes.post(
	"/",
	ipRateLimit({ keyPrefix: "reading-progress", limit: 60, windowSeconds: 60 }),
	authMiddleware,
	zValidator("json", upsertSchema),
	async (c) => {
		const user = c.get("user");
		const { postId, progress, scrollY } = c.req.valid("json");

		// Validate the post exists and is visible to the user. Tracking
		// progress on a deleted/private post would just create orphan rows
		// the cleanup job has to mop up.
		const post = await prisma.post.findFirst({
			where: { id: postId, status: "published" },
			select: { id: true },
		});
		if (!post) return c.json({ error: "Post not found" }, 404);

		// "Max progress ever reached" semantics: progress only ever moves
		// forward, never backwards. Without this, a user returning to a
		// half-read article and scrolling from the top would silently lower
		// the stored value, causing the resume banner to render behind where
		// they actually got to last time.
		//
		// scrollY tracks the current viewport position regardless of
		// progress comparison — that's what the resume button restores. The
		// pair "highest progress so far + most recent scrollY" is sometimes
		// inconsistent (eg progress=60% but scrollY corresponds to 30%), but
		// scrollY is the right thing to restore: it's where the user was
		// when they left, which is also where they want to come back to.
		//
		// Done as raw SQL so the read-and-conditional-write happens in one
		// round trip — a Prisma read + branched upsert would race on
		// concurrent scroll updates from the same user.
		await prisma.$executeRaw`
			INSERT INTO reading_progress (user_id, post_id, progress, scroll_y, updated_at)
			VALUES (${user.sub}::uuid, ${postId}::uuid, ${progress}, ${scrollY}, NOW())
			ON CONFLICT (user_id, post_id) DO UPDATE
			SET progress = GREATEST(reading_progress.progress, EXCLUDED.progress),
			    scroll_y = EXCLUDED.scroll_y,
			    updated_at = NOW()
		`;

		// Trim oldest rows past the per-user cap. Done as a best-effort follow
		// up: not in a transaction with the upsert because a 1-row-too-many
		// blip is harmless, and a slow DELETE shouldn't block the user's
		// reading. The cap is generous enough that this rarely fires.
		void trimOldRows(user.sub).catch(() => {
			/* best-effort */
		});

		return c.json({ ok: true });
	},
);

// [auth] Get the caller's progress for a single post. Used by the post detail
// page to show a "Resume from where you left off" banner.
readingProgressRoutes.get("/:postId", authMiddleware, async (c) => {
	const user = c.get("user");
	const postId = c.req.param("postId");

	const row = await prisma.readingProgress.findUnique({
		where: { userId_postId: { userId: user.sub, postId } },
		select: { progress: true, scrollY: true, updatedAt: true },
	});

	setPrivateNoStore(c);
	if (!row) return c.json({ progress: 0, scrollY: 0, updatedAt: null });
	return c.json(row);
});

// [auth] List posts the user has started but not finished — drives the
// "Continue reading" rail on home. Rate-limited because each call does a
// relation-rich select (post + author) and home page mount might trigger
// it repeatedly during a refresh loop.
readingProgressRoutes.get(
	"/",
	ipRateLimit({ keyPrefix: "reading-progress-list", limit: 60, windowSeconds: 60 }),
	authMiddleware,
	async (c) => {
		const user = c.get("user");
		const limit = Math.min(Math.max(Number(c.req.query("limit")) || 4, 1), 12);

		const rows = await prisma.readingProgress.findMany({
			where: {
				userId: user.sub,
				progress: { gte: RESUME_MIN_PROGRESS, lt: RESUME_MAX_PROGRESS },
				post: { status: "published" },
			},
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: {
				progress: true,
				scrollY: true,
				updatedAt: true,
				post: {
					select: {
						id: true,
						title: true,
						slug: true,
						excerpt: true,
						coverUrl: true,
						thumbnailUrl: true,
						readingTime: true,
						user: { select: { name: true, username: true, avatarUrl: true } },
					},
				},
			},
		});

		setPrivateNoStore(c);
		return c.json({ items: rows });
	},
);

// [auth] Clear all reading history for the current user. Surfaced in the
// settings page for users who want their reading habits forgotten.
readingProgressRoutes.delete("/", authMiddleware, async (c) => {
	const user = c.get("user");
	const result = await prisma.readingProgress.deleteMany({
		where: { userId: user.sub },
	});
	return c.json({ deleted: result.count });
});

// [auth] Delete progress for a single post. Useful when a user wants to
// remove just one item from their "Continue reading" rail without nuking
// everything.
readingProgressRoutes.delete("/:postId", authMiddleware, async (c) => {
	const user = c.get("user");
	const postId = c.req.param("postId");
	await prisma.readingProgress
		.delete({ where: { userId_postId: { userId: user.sub, postId } } })
		.catch(() => {
			// already gone — treat as success
		});
	return c.json({ ok: true });
});

async function trimOldRows(userId: string) {
	const count = await prisma.readingProgress.count({ where: { userId } });
	if (count <= MAX_ROWS_PER_USER) return;

	// Identify the specific rows to remove by primary key rather than by a
	// cutoff timestamp. A timestamp-based delete would accidentally drop rows
	// inside the top-N window whenever multiple rows shared the same
	// updated_at (rapid scrolling can produce identical timestamps within
	// the same millisecond).
	const survivors = await prisma.readingProgress.findMany({
		where: { userId },
		orderBy: [{ updatedAt: "desc" }, { postId: "desc" }],
		take: MAX_ROWS_PER_USER,
		select: { postId: true },
	});
	const survivorIds = survivors.map((s) => s.postId);

	await prisma.readingProgress.deleteMany({
		where: { userId, postId: { notIn: survivorIds } },
	});
}
