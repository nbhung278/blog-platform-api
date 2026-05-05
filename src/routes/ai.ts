import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { authMiddleware } from "../middleware/auth";
import { ipRateLimit, userRateLimit } from "../middleware/rate-limit";
import { semanticSearch, assembleContext } from "../rag";
import { getLLMProvider, type Message } from "../llm/router";

export const aiRoutes = new Hono();

// Cap message length so a single request can't blow up our context window or
// the upstream LLM bill. 4000 chars is well above any reasonable question.
const chatSchema = z.object({
	message: z.string().min(1).max(4000),
	sessionId: z.string().uuid().optional(),
});

// Two-layer abuse protection on the LLM endpoint:
//  - per-IP burst limit catches anonymous-style flooding (botnets, shared NAT)
//  - per-user daily budget caps cost from a single account abusing the
//    streaming endpoint (auth alone doesn't stop the bill from compounding)
aiRoutes.post(
	"/chat",
	ipRateLimit({ keyPrefix: "ai-chat-ip", limit: 30, windowSeconds: 60 }),
	authMiddleware,
	userRateLimit({ keyPrefix: "ai-chat-user", limit: 200, windowSeconds: 24 * 60 * 60 }),
	zValidator("json", chatSchema),
	async (c) => {
		const user = c.get("user");
		const { message, sessionId } = c.req.valid("json");
		const llm = getLLMProvider();

		// Load chat history
		let history: Message[] = [];
		let currentSessionId = sessionId;

		if (sessionId) {
			// `findFirst` (not `findUnique`) is required when filtering by anything
			// other than a unique key — Prisma silently ignores extra `where`
			// fields on `findUnique`, which would let any logged-in user read
			// another user's chat history just by knowing/guessing a session id.
			const session = await prisma.chatSession.findFirst({
				where: { id: sessionId, userId: user.sub },
			});

			if (session) {
				history = (session.messages as unknown as Message[]).slice(-20);
			} else {
				// Session belongs to someone else (or doesn't exist) — start fresh
				// instead of writing into a stranger's row below.
				currentSessionId = undefined;
			}
		}

		// RAG: semantic search
		const chunks = await semanticSearch(message, user.sub);
		const context = assembleContext(chunks);

		const systemPrompt = `You are an AI assistant for a blog. Answer questions based ONLY on the blog content provided below. If the answer is not in the content, say so honestly.

--- Blog Content ---
${context}
--- End Content ---`;

		const messages: Message[] = [
			{ role: "system", content: systemPrompt },
			...history,
			{ role: "user", content: message },
		];

		return streamSSE(c, async (stream) => {
			let assistantResponse = "";

			for await (const token of llm.stream(messages)) {
				assistantResponse += token;
				await stream.writeSSE({ data: token, event: "token" });
			}

			// Save session
			const newHistory = [
				...history,
				{ role: "user" as const, content: message },
				{ role: "assistant" as const, content: assistantResponse },
			].slice(-20);

			if (currentSessionId) {
				// updateMany filters honor non-unique fields, unlike update.
				// Owner check above guarantees this only ever matches our row.
				await prisma.chatSession.updateMany({
					where: { id: currentSessionId, userId: user.sub },
					data: { messages: newHistory as unknown as Prisma.InputJsonValue },
				});
			} else {
				const session = await prisma.chatSession.create({
					data: { userId: user.sub, messages: newHistory as unknown as Prisma.InputJsonValue },
				});
				currentSessionId = session.id;
			}

			await stream.writeSSE({
				data: currentSessionId,
				event: "session_id",
			});
		});
	},
);
