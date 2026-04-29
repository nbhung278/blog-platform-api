import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { authMiddleware, type JWTPayload, tryGetUser } from "../middleware/auth";
import { ipRateLimit } from "../middleware/rate-limit";

// Per-user cap, mirroring Medium. The client batches clicks and sends a delta;
// the server clamps so a misbehaving client can't push past the cap.
const MAX_CLAPS_PER_USER = 50;

// Generous because each request now represents many clicks (the client
// debounces ~1.5s before flushing). 60/min/IP gives plenty of headroom for a
// real user clapping fast on multiple posts in a session.
const clapLimit = ipRateLimit({ keyPrefix: "post-clap", limit: 60, windowSeconds: 60 });

const commentClapLimit = ipRateLimit({
	keyPrefix: "comment-clap",
	limit: 120,
	windowSeconds: 60,
});

export const clapsRoutes = new Hono<{ Variables: { user: JWTPayload } }>();

const clapBody = z.object({
	// `count` is a *delta* (number of new claps to add). The client batches
	// clicks before sending, so this is typically 1–50. We clamp on the
	// remaining headroom so two flushes interleaving cannot push past the cap.
	count: z.number().int().min(1).max(MAX_CLAPS_PER_USER),
});

interface ClapResult {
	total: number;
	myCount: number;
}

// Run a clap transaction with `Serializable` isolation. Two concurrent
// flushes from the same user (e.g. across two tabs) would otherwise race on
// the read-modify-write of the per-user count: both could read the same
// `current` and both could push past the cap. Serializable + retry on the
// 40001 (serialization_failure) error is Postgres' idiomatic answer.
//
// The retry budget is small; concurrency is naturally bounded because (a) a
// single user can't issue many claps per second and (b) the IP rate limiter
// caps request volume.
async function runClapTx<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
	const MAX_ATTEMPTS = 3;
	let attempt = 0;
	while (true) {
		try {
			return await prisma.$transaction(work, {
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
			});
		} catch (err: unknown) {
			attempt += 1;
			const code = err instanceof Prisma.PrismaClientKnownRequestError ? err.code : undefined;
			// P2034 = Prisma's wrapper for Postgres 40001 serialization_failure.
			if (code === "P2034" && attempt < MAX_ATTEMPTS) continue;
			throw err;
		}
	}
}

// Public read: total claps + (if signed in) the caller's own clap count.
// Two queries in parallel — the post row and the per-user clap row — so we
// don't pay the latency twice.
clapsRoutes.get("/posts/:postId", async (c) => {
	const postId = c.req.param("postId");
	const viewer = await tryGetUser(c);

	const [post, myRow] = await Promise.all([
		prisma.post.findUnique({
			where: { id: postId },
			select: { clapCount: true },
		}),
		viewer
			? prisma.postClap.findUnique({
					where: { userId_postId: { userId: viewer.sub, postId } },
					select: { count: true },
				})
			: Promise.resolve(null),
	]);
	if (!post) return c.json({ error: "Post not found" }, 404);

	return c.json({
		total: post.clapCount,
		myCount: myRow?.count ?? 0,
		max: MAX_CLAPS_PER_USER,
	});
});

clapsRoutes.post(
	"/posts/:postId",
	clapLimit,
	authMiddleware,
	zValidator("json", clapBody),
	async (c) => {
		const postId = c.req.param("postId");
		const me = c.get("user");
		const { count: requested } = c.req.valid("json");

		const post = await prisma.post.findUnique({
			where: { id: postId },
			select: { id: true, status: true },
		});
		if (!post || post.status !== "published") {
			return c.json({ error: "Post not found" }, 404);
		}

		const result = await runClapTx<ClapResult>(async (tx) => {
			const existing = await tx.postClap.findUnique({
				where: { userId_postId: { userId: me.sub, postId } },
				select: { count: true },
			});
			const current = existing?.count ?? 0;
			const delta = Math.max(0, Math.min(requested, MAX_CLAPS_PER_USER - current));

			if (delta === 0) {
				const aggregate = await tx.post.findUniqueOrThrow({
					where: { id: postId },
					select: { clapCount: true },
				});
				return { total: aggregate.clapCount, myCount: current };
			}

			const updatedRow = await tx.postClap.upsert({
				where: { userId_postId: { userId: me.sub, postId } },
				create: { userId: me.sub, postId, count: delta },
				update: { count: { increment: delta } },
				select: { count: true },
			});
			const updatedPost = await tx.post.update({
				where: { id: postId },
				data: { clapCount: { increment: delta } },
				select: { clapCount: true },
			});
			return { total: updatedPost.clapCount, myCount: updatedRow.count };
		});

		return c.json({ ...result, max: MAX_CLAPS_PER_USER });
	},
);

clapsRoutes.post(
	"/comments/:id",
	commentClapLimit,
	authMiddleware,
	zValidator("json", clapBody),
	async (c) => {
		const id = c.req.param("id");
		const me = c.get("user");
		const { count: requested } = c.req.valid("json");

		const comment = await prisma.comment.findUnique({
			where: { id },
			select: { isDeleted: true },
		});
		if (!comment || comment.isDeleted) {
			return c.json({ error: "Comment not found" }, 404);
		}

		const result = await runClapTx<ClapResult>(async (tx) => {
			const existing = await tx.commentClap.findUnique({
				where: { userId_commentId: { userId: me.sub, commentId: id } },
				select: { count: true },
			});
			const current = existing?.count ?? 0;
			const delta = Math.max(0, Math.min(requested, MAX_CLAPS_PER_USER - current));

			if (delta === 0) {
				const aggregate = await tx.comment.findUniqueOrThrow({
					where: { id },
					select: { clapCount: true },
				});
				return { total: aggregate.clapCount, myCount: current };
			}

			const updatedRow = await tx.commentClap.upsert({
				where: { userId_commentId: { userId: me.sub, commentId: id } },
				create: { userId: me.sub, commentId: id, count: delta },
				update: { count: { increment: delta } },
				select: { count: true },
			});
			const updatedComment = await tx.comment.update({
				where: { id },
				data: { clapCount: { increment: delta } },
				select: { clapCount: true },
			});
			return { total: updatedComment.clapCount, myCount: updatedRow.count };
		});

		return c.json({ ...result, max: MAX_CLAPS_PER_USER });
	},
);
