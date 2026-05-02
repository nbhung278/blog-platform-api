import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../db";
import { authMiddleware, type JWTPayload } from "../middleware/auth";
import { publishToUser } from "../lib/realtime";

export const conversationsRoutes = new Hono<{ Variables: { user: JWTPayload } }>();

conversationsRoutes.use("*", authMiddleware);

const SENDER_SELECT = {
	id: true,
	name: true,
	username: true,
	avatarUrl: true,
} as const;

// Search users to start a conversation with
conversationsRoutes.get(
	"/users/search",
	zValidator("query", z.object({ q: z.string().min(1).max(100) })),
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

	const myParticipantData = await prisma.conversationParticipant.findMany({
		where: { userId: me.sub, conversationId: { in: conversations.map((conv) => conv.id) } },
		select: { conversationId: true, lastReadAt: true },
	});

	const lastReadMap = new Map(myParticipantData.map((p) => [p.conversationId, p.lastReadAt]));

	const unreadCounts = await prisma.$transaction(
		conversations.map((conv) =>
			prisma.directMessage.count({
				where: {
					conversationId: conv.id,
					senderId: { not: me.sub },
					deletedAt: null,
					createdAt: { gt: lastReadMap.get(conv.id) ?? new Date(0) },
				},
			}),
		),
	);

	const result = conversations.map((conv, i) => ({
		id: conv.id,
		other: conv.participants.find((p) => p.userId !== me.sub)?.user ?? null,
		lastMessage: conv.messages[0] ?? null,
		unreadCount: unreadCounts[i],
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

		// Find existing 1:1 conversation between the two users
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
			limit: z.coerce.number().int().min(1).max(50).default(30),
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
			where: { conversationId: convId, deletedAt: null, ...cursorFilter },
			orderBy: { createdAt: "desc" },
			take: limit + 1,
			include: { sender: { select: SENDER_SELECT } },
		});

		const hasMore = messages.length > limit;
		const trimmed = hasMore ? messages.slice(0, limit) : messages;

		return c.json({
			items: trimmed.reverse(),
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
				imageUrl: z.string().url().optional(),
			})
			.refine((d) => d.content || d.imageUrl, { message: "content or imageUrl required" }),
	),
	async (c) => {
		const me = c.get("user");
		const convId = c.req.param("id");
		const { content, imageUrl } = c.req.valid("json");

		const participant = await prisma.conversationParticipant.findUnique({
			where: { conversationId_userId: { conversationId: convId, userId: me.sub } },
		});
		if (!participant) return c.json({ error: "Not found" }, 404);

		const [message] = await prisma.$transaction([
			prisma.directMessage.create({
				data: { conversationId: convId, senderId: me.sub, content, imageUrl },
				include: { sender: { select: SENDER_SELECT } },
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
			data: { ...message, conversationId: convId },
		};

		for (const { userId } of otherParticipants) {
			publishToUser(userId, payload);
		}
		// Push to sender's other devices too
		publishToUser(me.sub, payload);

		return c.json(message, 201);
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
