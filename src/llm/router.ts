import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

export interface Message {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface LLMProvider {
	complete(
		messages: Message[],
		options?: { maxTokens?: number; temperature?: number },
	): Promise<string>;
	stream(messages: Message[], options?: { maxTokens?: number }): AsyncIterable<string>;
	embed(text: string): Promise<number[]>;
	embedBatch(texts: string[]): Promise<number[][]>;
}

class OpenAIProvider implements LLMProvider {
	private client: OpenAI;

	constructor() {
		this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
	}

	async complete(
		messages: Message[],
		options?: { maxTokens?: number; temperature?: number },
	): Promise<string> {
		const response = await this.client.chat.completions.create({
			model: process.env.OPENAI_MODEL || "gpt-4o",
			messages,
			max_tokens: options?.maxTokens || 1024,
			temperature: options?.temperature || 0.7,
		});
		return response.choices[0].message.content || "";
	}

	async *stream(messages: Message[], options?: { maxTokens?: number }): AsyncIterable<string> {
		const response = await this.client.chat.completions.create({
			model: process.env.OPENAI_MODEL || "gpt-4o",
			messages,
			max_tokens: options?.maxTokens || 1024,
			stream: true,
		});

		for await (const chunk of response) {
			const content = chunk.choices[0]?.delta?.content;
			if (content) yield content;
		}
	}

	async embed(text: string): Promise<number[]> {
		const response = await this.client.embeddings.create({
			model: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
			input: text,
		});
		return response.data[0].embedding;
	}

	async embedBatch(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) return [];
		const response = await this.client.embeddings.create({
			model: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
			input: texts,
		});
		// OpenAI returns embeddings in input order, but sort by index defensively.
		return response.data
			.slice()
			.sort((a, b) => a.index - b.index)
			.map((d) => d.embedding);
	}
}

class AnthropicProvider implements LLMProvider {
	private client: Anthropic;
	private openai: OpenAI; // For embeddings (Anthropic has no embedding API)

	constructor() {
		this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
		this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
	}

	async complete(
		messages: Message[],
		options?: { maxTokens?: number; temperature?: number },
	): Promise<string> {
		const systemMessage = messages.find((m) => m.role === "system");
		const nonSystemMessages = messages.filter((m) => m.role !== "system");

		const response = await this.client.messages.create({
			model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250514",
			max_tokens: options?.maxTokens || 1024,
			temperature: options?.temperature || 0.7,
			system: systemMessage?.content,
			messages: nonSystemMessages.map((m) => ({
				role: m.role as "user" | "assistant",
				content: m.content,
			})),
		});

		return response.content[0].type === "text" ? response.content[0].text : "";
	}

	async *stream(messages: Message[], options?: { maxTokens?: number }): AsyncIterable<string> {
		const systemMessage = messages.find((m) => m.role === "system");
		const nonSystemMessages = messages.filter((m) => m.role !== "system");

		const stream = this.client.messages.stream({
			model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250514",
			max_tokens: options?.maxTokens || 1024,
			system: systemMessage?.content,
			messages: nonSystemMessages.map((m) => ({
				role: m.role as "user" | "assistant",
				content: m.content,
			})),
		});

		for await (const event of stream) {
			if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
				yield event.delta.text;
			}
		}
	}

	async embed(text: string): Promise<number[]> {
		// Anthropic doesn't have embedding API, use OpenAI
		const response = await this.openai.embeddings.create({
			model: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
			input: text,
		});
		return response.data[0].embedding;
	}

	async embedBatch(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) return [];
		const response = await this.openai.embeddings.create({
			model: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
			input: texts,
		});
		return response.data
			.slice()
			.sort((a, b) => a.index - b.index)
			.map((d) => d.embedding);
	}
}

let providerInstance: LLMProvider | null = null;

export function getLLMProvider(): LLMProvider {
	if (!providerInstance) {
		const provider = process.env.LLM_PROVIDER || "openai";
		providerInstance = provider === "anthropic" ? new AnthropicProvider() : new OpenAIProvider();
		console.log(`[llm] Using provider: ${provider}`);
	}
	return providerInstance;
}
