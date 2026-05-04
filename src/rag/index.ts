import { prisma } from "../db";
import { getLLMProvider } from "../llm/router";

export interface Chunk {
	heading: string | null;
	content: string;
	chunkIdx: number;
}

/**
 * Heading-based chunking: split markdown by H1/H2/H3 boundaries.
 * Each chunk = content under one heading, keeping semantic coherence.
 */
export function chunkByHeadings(markdown: string): Chunk[] {
	const lines = markdown.split("\n");
	const chunks: Chunk[] = [];
	let currentHeading: string | null = null;
	let currentContent: string[] = [];
	let chunkIdx = 0;

	for (const line of lines) {
		const headingMatch = line.match(/^#{1,3}\s+(.+)/);

		if (headingMatch) {
			if (currentContent.length > 0) {
				const content = currentContent.join("\n").trim();
				if (content.length >= 50) {
					chunks.push({ heading: currentHeading, content, chunkIdx });
					chunkIdx++;
				}
			}
			currentHeading = headingMatch[1];
			currentContent = [];
		} else {
			currentContent.push(line);
		}
	}

	// Save last chunk
	if (currentContent.length > 0) {
		const content = currentContent.join("\n").trim();
		if (content.length >= 50) {
			chunks.push({ heading: currentHeading, content, chunkIdx });
		}
	}

	return chunks;
}

function serializeEmbedding(embedding: number[]): string {
	if (!Array.isArray(embedding) || embedding.length === 0) {
		throw new Error("Invalid embedding: empty or not an array");
	}
	for (const v of embedding) {
		if (typeof v !== "number" || !Number.isFinite(v)) {
			throw new Error("Invalid embedding value (NaN/Infinity)");
		}
	}
	return `[${embedding.join(",")}]`;
}

/**
 * Embed and insert chunks into post_chunks table.
 * Uses raw SQL for the pgvector embedding column.
 *
 * Embeddings are produced in a single batch call instead of one-per-chunk —
 * OpenAI accepts an array `input` and returns one vector per element, so a
 * post with N chunks costs 1 round-trip rather than N.
 */
export async function indexChunks(postId: string, userId: string, chunks: Chunk[]): Promise<void> {
	if (chunks.length === 0) return;
	const llm = getLLMProvider();

	const texts = chunks.map((c) => (c.heading ? `${c.heading}\n${c.content}` : c.content));
	const embeddings = await llm.embedBatch(texts);

	if (embeddings.length !== chunks.length) {
		throw new Error(
			`Embedding count mismatch: expected ${chunks.length}, got ${embeddings.length}`,
		);
	}

	await Promise.all(
		chunks.map((chunk, i) => {
			const embeddingStr = serializeEmbedding(embeddings[i]);
			return prisma.$executeRaw`
      INSERT INTO post_chunks (id, post_id, user_id, chunk_idx, heading, content, embedding, created_at)
      VALUES (gen_random_uuid(), ${postId}::uuid, ${userId}::uuid, ${chunk.chunkIdx}, ${chunk.heading}, ${chunk.content}, ${embeddingStr}::vector, NOW())
    `;
		}),
	);
}

/**
 * Semantic search: find top-K relevant chunks for a user's query.
 */
export async function semanticSearch(
	query: string,
	userId: string,
	topK?: number,
): Promise<{ heading: string | null; content: string }[]> {
	const llm = getLLMProvider();
	const k = topK || Number(process.env.RAG_TOP_K) || 5;

	const queryEmbedding = await llm.embed(query);
	const embeddingStr = serializeEmbedding(queryEmbedding);

	const results = await prisma.$queryRaw<{ heading: string | null; content: string }[]>`
    SELECT heading, content
    FROM post_chunks
    WHERE user_id = ${userId}::uuid
    ORDER BY embedding <=> ${embeddingStr}::vector
    LIMIT ${k}
  `;

	return results;
}

/**
 * Assemble context string from chunks, respecting token budget.
 */
export function assembleContext(chunks: { heading: string | null; content: string }[]): string {
	const tokenBudget = Number(process.env.RAG_TOKEN_BUDGET) || 6000;
	const charBudget = tokenBudget * 4;

	let assembled = "";

	for (const chunk of chunks) {
		const section = chunk.heading
			? `## ${chunk.heading}\n${chunk.content}\n\n`
			: `${chunk.content}\n\n`;

		if (assembled.length + section.length > charBudget) break;
		assembled += section;
	}

	return assembled.trim();
}
