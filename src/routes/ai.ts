import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { authMiddleware } from "../middleware/auth";
import { semanticSearch, assembleContext } from "../rag";
import { getLLMProvider, type Message } from "../llm/router";

export const aiRoutes = new Hono();

const chatSchema = z.object({
	message: z.string().min(1),
	sessionId: z.string().uuid().optional(),
});

aiRoutes.post("/chat", authMiddleware, zValidator("json", chatSchema), async (c) => {
	const user = c.get("user");
	const { message, sessionId } = c.req.valid("json");
	const llm = getLLMProvider();

	// Load chat history
	let history: Message[] = [];
	let currentSessionId = sessionId;

	if (sessionId) {
		const session = await prisma.chatSession.findUnique({
			where: { id: sessionId, userId: user.sub },
		});

		if (session) {
			history = (session.messages as unknown as Message[]).slice(-20);
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
			await prisma.chatSession.update({
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
});
