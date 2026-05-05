import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { authMiddleware, type JWTPayload } from "../middleware/auth";
import { ipRateLimit } from "../middleware/rate-limit";
import { publishToUser } from "../lib/realtime";
import { isAllowedMediaUrl } from "../lib/url-allowlist";

export const conversationsRoutes = new Hono<{ Variables: { user: JWTPayload } }>();

conversationsRoutes.use("*", authMiddleware);

const SENDER_SELECT = {
	id: true,
	name: true,
	username: true,
	avatarUrl: true,
} as const;

const REPLY_TO_SELECT = {
	id: true,
	content: true,
	imageUrl: true,
	sender: { select: SENDER_SELECT },
} as const;

const VALID_EMOJIS = ["love", "like", "haha", "sad", "angry"] as const;
type ReactionEmoji = (typeof VALID_EMOJIS)[number];

function buildReactions(
	rawReactions: { emoji: string; userId: string }[],
	myUserId: string,
): { emoji: ReactionEmoji; count: number; reactedByMe: boolean }[] {
	const map = new Map<ReactionEmoji, { count: number; reactedByMe: boolean }>();
	for (const r of rawReactions) {
		const emoji = r.emoji as ReactionEmoji;
		const existing = map.get(emoji) ?? { count: 0, reactedByMe: false };
		map.set(emoji, {
			count: existing.count + 1,
			reactedByMe: existing.reactedByMe || r.userId === myUserId,
		});
	}
	return Array.from(map.entries()).map(([emoji, v]) => ({ emoji, ...v }));
}

// Search users to start a conversation with.
// `min(2)` keeps single-character queries from cheaply enumerating the userbase
// one character at a time; the rate limit raises the cost of brute-forcing
// many short queries.
conversationsRoutes.get(
	"/users/search",
	ipRateLimit({ keyPrefix: "user-search", limit: 30, windowSeconds: 60 }),
	zValidator("query", z.object({ q: z.string().min(2).max(100) })),
	async (c) => {
		const me = c.get("user");
		const { q } = c.req.valid("query");

		const users = await prisma.user.findMany({
			where: {
				id: { not: me.sub },
				OR: [
					{ name: { contains: q, mode: "insensitive" } },
					{ username: { contains: q, mode: "insensitive" } },
				],
			},
			select: { id: true, name: true, username: true, avatarUrl: true, bio: true },
			take: 10,
			orderBy: { name: "asc" },
		});

		return c.json(users);
	},
);

// List my conversations
conversationsRoutes.get("/", async (c) => {
	const me = c.get("user");

	const conversations = await prisma.conversation.findMany({
		where: { participants: { some: { userId: me.sub } } },
		orderBy: { updatedAt: "desc" },
		include: {
			participants: {
				include: { user: { select: SENDER_SELECT } },
			},
			messages: {
				where: { deletedAt: null },
				orderBy: { createdAt: "desc" },
				take: 1,
			},
		},
	});

	// Single aggregated query replaces N individual COUNT queries.
	// Joins to conversation_participants to read last_read_at per conversation in one round-trip.
	const unreadRows = await prisma.$queryRaw<{ conversation_id: string; unread_count: number }[]>(
		Prisma.sql`
			SELECT
				dm.conversation_id,
				COUNT(*)::int AS unread_count
			FROM direct_messages dm
			JOIN conversation_participants cp
				ON cp.conversation_id = dm.conversation_id
				AND cp.user_id = ${me.sub}::uuid
			WHERE
				dm.sender_id   != ${me.sub}::uuid
				AND dm.deleted_at IS NULL
				AND dm.created_at  > COALESCE(cp.last_read_at, '-infinity'::timestamptz)
			GROUP BY dm.conversation_id
		`,
	);

	const unreadMap = new Map(unreadRows.map((r) => [r.conversation_id, r.unread_count]));

	const result = conversations.map((conv) => ({
		id: conv.id,
		other: conv.participants.find((p) => p.userId !== me.sub)?.user ?? null,
		lastMessage: conv.messages[0] ?? null,
		unreadCount: unreadMap.get(conv.id) ?? 0,
		updatedAt: conv.updatedAt,
	}));

	return c.json(result);
});

// Start or get existing 1:1 conversation
conversationsRoutes.post(
	"/",
	zValidator("json", z.object({ userId: z.string().uuid() })),
	async (c) => {
		const me = c.get("user");
		const { userId } = c.req.valid("json");

		if (userId === me.sub) {
			return c.json({ error: "Cannot start a conversation with yourself" }, 400);
		}

		const target = await prisma.user.findUnique({
			where: { id: userId },
			select: SENDER_SELECT,
		});
		if (!target) return c.json({ error: "User not found" }, 404);

		const existing = await prisma.conversation.findFirst({
			where: {
				AND: [
					{ participants: { some: { userId: me.sub } } },
					{ participants: { some: { userId } } },
				],
			},
			include: {
				participants: { include: { user: { select: SENDER_SELECT } } },
				messages: { where: { deletedAt: null }, orderBy: { createdAt: "desc" }, take: 1 },
			},
		});

		if (existing) {
			return c.json({
				id: existing.id,
				other: existing.participants.find((p) => p.userId !== me.sub)?.user ?? null,
				lastMessage: existing.messages[0] ?? null,
				unreadCount: 0,
				updatedAt: existing.updatedAt,
			});
		}

		const conv = await prisma.conversation.create({
			data: {
				participants: { create: [{ userId: me.sub }, { userId }] },
			},
			include: {
				participants: { include: { user: { select: SENDER_SELECT } } },
			},
		});

		return c.json(
			{
				id: conv.id,
				other: conv.participants.find((p) => p.userId !== me.sub)?.user ?? null,
				lastMessage: null,
				unreadCount: 0,
				updatedAt: conv.updatedAt,
			},
			201,
		);
	},
);

// Get messages for a conversation (cursor-based, newest-first page, returned oldest-first)
conversationsRoutes.get(
	"/:id/messages",
	zValidator(
		"query",
		z.object({
			limit: z.coerce.number().int().min(1).max(50).default(20),
			cursor: z.string().uuid().optional(),
		}),
	),
	async (c) => {
		const me = c.get("user");
		const convId = c.req.param("id");
		const { limit, cursor } = c.req.valid("query");

		const participant = await prisma.conversationParticipant.findUnique({
			where: { conversationId_userId: { conversationId: convId, userId: me.sub } },
		});
		if (!participant) return c.json({ error: "Not found" }, 404);

		let cursorFilter: object = {};
		if (cursor) {
			const cursorMsg = await prisma.directMessage.findUnique({
				where: { id: cursor },
				select: { createdAt: true },
			});
			if (cursorMsg) cursorFilter = { createdAt: { lt: cursorMsg.createdAt } };
		}

		const messages = await prisma.directMessage.findMany({
			where: {
				conversationId: convId,
				deletedAt: null,
				hiddenBy: { none: { userId: me.sub } },
				...cursorFilter,
			},
			orderBy: { createdAt: "desc" },
			take: limit + 1,
			include: {
				sender: { select: SENDER_SELECT },
				replyTo: { select: REPLY_TO_SELECT },
				reactions: { select: { emoji: true, userId: true } },
			},
		});

		const hasMore = messages.length > limit;
		const trimmed = hasMore ? messages.slice(0, limit) : messages;

		const items = trimmed.reverse().map((m) => ({
			...m,
			reactions: buildReactions(m.reactions, me.sub),
		}));

		return c.json({
			items,
			nextCursor: hasMore ? trimmed[0]?.id : null,
		});
	},
);

// Send a message
conversationsRoutes.post(
	"/:id/messages",
	zValidator(
		"json",
		z
			.object({
				content: z.string().min(1).max(4000).optional(),
				imageUrl: z
					.string()
					.url()
					.refine((u) => isAllowedMediaUrl(u), "imageUrl host not allowed")
					.optional(),
				replyToId: z.string().uuid().optional(),
			})
			.refine((d) => d.content || d.imageUrl, { message: "content or imageUrl required" }),
	),
	async (c) => {
		const me = c.get("user");
		const convId = c.req.param("id");
		const { content, imageUrl, replyToId } = c.req.valid("json");

		const participant = await prisma.conversationParticipant.findUnique({
			where: { conversationId_userId: { conversationId: convId, userId: me.sub } },
		});
		if (!participant) return c.json({ error: "Not found" }, 404);

		if (replyToId) {
			const parent = await prisma.directMessage.findFirst({
				where: { id: replyToId, conversationId: convId, deletedAt: null },
			});
			if (!parent) return c.json({ error: "Reply target not found" }, 404);
		}

		const [message] = await prisma.$transaction([
			prisma.directMessage.create({
				data: { conversationId: convId, senderId: me.sub, content, imageUrl, replyToId },
				include: {
					sender: { select: SENDER_SELECT },
					replyTo: { select: REPLY_TO_SELECT },
				},
			}),
			prisma.conversation.update({
				where: { id: convId },
				data: { updatedAt: new Date() },
			}),
			prisma.conversationParticipant.update({
				where: { conversationId_userId: { conversationId: convId, userId: me.sub } },
				data: { lastReadAt: new Date() },
			}),
		]);

		const otherParticipants = await prisma.conversationParticipant.findMany({
			where: { conversationId: convId, userId: { not: me.sub } },
			select: { userId: true },
		});

		const payload = {
			kind: "chat_message" as const,
			data: { ...message, reactions: [], conversationId: convId },
		};

		for (const { userId } of otherParticipants) {
			publishToUser(userId, payload);
		}
		publishToUser(me.sub, payload);

		return c.json({ ...message, reactions: [] }, 201);
	},
);

// Toggle a reaction on a message
conversationsRoutes.post(
	"/:id/messages/:msgId/reactions",
	zValidator("json", z.object({ emoji: z.enum(VALID_EMOJIS) })),
	async (c) => {
		const me = c.get("user");
		const convId = c.req.param("id");
		const msgId = c.req.param("msgId");
		const { emoji } = c.req.valid("json");

		const participant = await prisma.conversationParticipant.findUnique({
			where: { conversationId_userId: { conversationId: convId, userId: me.sub } },
		});
		if (!participant) return c.json({ error: "Not found" }, 404);

		const message = await prisma.directMessage.findFirst({
			where: { id: msgId, conversationId: convId, deletedAt: null },
		});
		if (!message) return c.json({ error: "Message not found" }, 404);

		const existing = await prisma.messageReaction.findUnique({
			where: { messageId_userId: { messageId: msgId, userId: me.sub } },
		});

		if (existing && existing.emoji === emoji) {
			// Same emoji — remove it (toggle off)
			await prisma.messageReaction.delete({
				where: { messageId_userId: { messageId: msgId, userId: me.sub } },
			});
		} else {
			// Different emoji or no reaction — upsert
			await prisma.messageReaction.upsert({
				where: { messageId_userId: { messageId: msgId, userId: me.sub } },
				create: { messageId: msgId, userId: me.sub, emoji },
				update: { emoji },
			});
		}

		const allReactions = await prisma.messageReaction.findMany({
			where: { messageId: msgId },
			select: { emoji: true, userId: true },
		});

		const participants = await prisma.conversationParticipant.findMany({
			where: { conversationId: convId },
			select: { userId: true },
		});

		for (const { userId } of participants) {
			publishToUser(userId, {
				kind: "message_reaction" as const,
				data: {
					messageId: msgId,
					conversationId: convId,
					reactions: buildReactions(allReactions, userId),
				},
			});
		}

		return c.json({ reactions: buildReactions(allReactions, me.sub) });
	},
);

// Edit a message (own only)
conversationsRoutes.patch(
	"/:id/messages/:msgId",
	zValidator("json", z.object({ content: z.string().min(1).max(4000) })),
	async (c) => {
		const me = c.get("user");
		const convId = c.req.param("id");
		const msgId = c.req.param("msgId");
		const { content } = c.req.valid("json");

		const participant = await prisma.conversationParticipant.findUnique({
			where: { conversationId_userId: { conversationId: convId, userId: me.sub } },
		});
		if (!participant) return c.json({ error: "Not found" }, 404);

		const message = await prisma.directMessage.findFirst({
			where: { id: msgId, conversationId: convId, deletedAt: null },
		});
		if (!message) return c.json({ error: "Message not found" }, 404);
		if (message.senderId !== me.sub) return c.json({ error: "Forbidden" }, 403);

		const updated = await prisma.directMessage.update({
			where: { id: msgId },
			data: { content, editedAt: new Date() },
		});

		const participants = await prisma.conversationParticipant.findMany({
			where: { conversationId: convId },
			select: { userId: true },
		});

		for (const { userId } of participants) {
			publishToUser(userId, {
				kind: "message_edit" as const,
				data: {
					messageId: msgId,
					conversationId: convId,
					content: updated.content,
					editedAt: updated.editedAt,
				},
			});
		}

		return c.json({ content: updated.content, editedAt: updated.editedAt });
	},
);

// Delete a message (for me or for all)
conversationsRoutes.delete(
	"/:id/messages/:msgId",
	zValidator("query", z.object({ scope: z.enum(["me", "all"]) })),
	async (c) => {
		const me = c.get("user");
		const convId = c.req.param("id");
		const msgId = c.req.param("msgId");
		const { scope } = c.req.valid("query");

		const participant = await prisma.conversationParticipant.findUnique({
			where: { conversationId_userId: { conversationId: convId, userId: me.sub } },
		});
		if (!participant) return c.json({ error: "Not found" }, 404);

		const message = await prisma.directMessage.findFirst({
			where: { id: msgId, conversationId: convId, deletedAt: null },
		});
		if (!message) return c.json({ error: "Message not found" }, 404);

		if (scope === "all") {
			if (message.senderId !== me.sub) return c.json({ error: "Forbidden" }, 403);

			await prisma.directMessage.update({
				where: { id: msgId },
				data: { deletedAt: new Date() },
			});

			const participants = await prisma.conversationParticipant.findMany({
				where: { conversationId: convId },
				select: { userId: true },
			});

			for (const { userId } of participants) {
				publishToUser(userId, {
					kind: "message_delete" as const,
					data: { messageId: msgId, conversationId: convId },
				});
			}
		} else {
			// scope === "me": hide only for current user
			await prisma.messageHiddenByUser.upsert({
				where: { messageId_userId: { messageId: msgId, userId: me.sub } },
				create: { messageId: msgId, userId: me.sub },
				update: {},
			});
		}

		return c.json({ success: true });
	},
);

// Mark conversation as read (updates lastReadAt)
conversationsRoutes.post("/:id/read", async (c) => {
	const me = c.get("user");
	const convId = c.req.param("id");

	const participant = await prisma.conversationParticipant.findUnique({
		where: { conversationId_userId: { conversationId: convId, userId: me.sub } },
	});
	if (!participant) return c.json({ error: "Not found" }, 404);

	await prisma.conversationParticipant.update({
		where: { conversationId_userId: { conversationId: convId, userId: me.sub } },
		data: { lastReadAt: new Date() },
	});

	return c.json({ success: true });
});
