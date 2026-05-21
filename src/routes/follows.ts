import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../db";
import { authMiddleware, type JWTPayload } from "../middleware/auth";
import { ipRateLimit } from "../middleware/rate-limit";
import { createNotification } from "../lib/notifications";
import { setPrivateNoStore } from "../lib/cache-headers";
import { isUniqueViolation } from "../lib/prisma-errors";

// Cap follow/unfollow churn at 60/min/IP — generous for a real user, low
// enough to dampen scripted graph spam.
const followMutationLimit = ipRateLimit({
	keyPrefix: "follow-mut",
	limit: 60,
	windowSeconds: 60,
});

export const followsRoutes = new Hono<{ Variables: { user: JWTPayload } }>();

async function getUserByUsername(username: string) {
	return prisma.user.findUnique({
		where: { username },
		select: { id: true, username: true, name: true, avatarUrl: true },
	});
}

const readLimit = ipRateLimit({ keyPrefix: "follow-stats", limit: 60, windowSeconds: 60 });

// Public: how many followers/following a user has, plus (if signed in) whether
// the caller is following them.
followsRoutes.get("/:username/stats", readLimit, async (c) => {
	const username = c.req.param("username");
	const target = await getUserByUsername(username);
	if (!target) return c.json({ error: "User not found" }, 404);

	const [followers, following] = await Promise.all([
		prisma.follow.count({ where: { followingId: target.id } }),
		prisma.follow.count({ where: { followerId: target.id } }),
	]);

	return c.json({ followers, following });
});

// Auth-only: state of the caller's relationship to :username. Returns
// { following: false } when no follow row exists.
followsRoutes.get("/:username/me", authMiddleware, async (c) => {
	const username = c.req.param("username");
	const me = c.get("user");
	const target = await getUserByUsername(username);
	if (!target) return c.json({ error: "User not found" }, 404);

	const row = await prisma.follow.findUnique({
		where: { followerId_followingId: { followerId: me.sub, followingId: target.id } },
		select: { emailEnabled: true, createdAt: true },
	});
	setPrivateNoStore(c);
	if (!row) return c.json({ following: false });
	return c.json({ following: true, emailEnabled: row.emailEnabled, since: row.createdAt });
});

followsRoutes.post("/:username", followMutationLimit, authMiddleware, async (c) => {
	const username = c.req.param("username");
	const me = c.get("user");
	const target = await getUserByUsername(username);
	if (!target) return c.json({ error: "User not found" }, 404);
	if (target.id === me.sub) return c.json({ error: "Cannot follow yourself" }, 400);

	// Idempotent: re-following an already-followed user is a no-op (200) so the
	// UI doesn't have to special-case race conditions. We still try create
	// below and catch the unique-violation as the canonical idempotency path —
	// the find here is just a fast-path that avoids the tx + notification work
	// in the common case.
	const existing = await prisma.follow.findUnique({
		where: { followerId_followingId: { followerId: me.sub, followingId: target.id } },
	});
	if (existing) {
		return c.json({ following: true, emailEnabled: existing.emailEnabled });
	}

	// Follow + "you have a new follower" notification commit atomically.
	// Previously the two writes were sequential — if the second one failed,
	// the followee never saw a notification about a follow that did happen,
	// which is exactly the kind of "ghost state" that's painful to debug later.
	//
	// Two concurrent POSTs from the same user can both see existing===null
	// above and race here; catch P2002 (unique violation on
	// follower_id+following_id) and return the idempotent 200 in that case
	// rather than 500-ing the second request.
	try {
		const follow = await prisma.$transaction(async (tx) => {
			const f = await tx.follow.create({
				data: { followerId: me.sub, followingId: target.id },
			});
			await createNotification({ userId: target.id, actorId: me.sub, type: "follow" }, tx);
			return f;
		});
		return c.json({ following: true, emailEnabled: follow.emailEnabled }, 201);
	} catch (err) {
		if (isUniqueViolation(err)) {
			const winner = await prisma.follow.findUnique({
				where: { followerId_followingId: { followerId: me.sub, followingId: target.id } },
				select: { emailEnabled: true },
			});
			return c.json({ following: true, emailEnabled: winner?.emailEnabled ?? true });
		}
		throw err;
	}
});

followsRoutes.delete("/:username", followMutationLimit, authMiddleware, async (c) => {
	const username = c.req.param("username");
	const me = c.get("user");
	const target = await getUserByUsername(username);
	if (!target) return c.json({ error: "User not found" }, 404);

	await prisma.follow.deleteMany({
		where: { followerId: me.sub, followingId: target.id },
	});
	return c.json({ following: false });
});

const updateSchema = z.object({ emailEnabled: z.boolean() });

followsRoutes.patch(
	"/:username",
	followMutationLimit,
	authMiddleware,
	zValidator("json", updateSchema),
	async (c) => {
		const username = c.req.param("username");
		const me = c.get("user");
		const { emailEnabled } = c.req.valid("json");

		const target = await getUserByUsername(username);
		if (!target) return c.json({ error: "User not found" }, 404);

		const row = await prisma.follow.findUnique({
			where: { followerId_followingId: { followerId: me.sub, followingId: target.id } },
		});
		if (!row) return c.json({ error: "Not following this user" }, 404);

		const updated = await prisma.follow.update({
			where: { followerId_followingId: { followerId: me.sub, followingId: target.id } },
			data: { emailEnabled },
		});
		return c.json({ following: true, emailEnabled: updated.emailEnabled });
	},
);
