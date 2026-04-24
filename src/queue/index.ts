import { Queue, Worker } from "bullmq";
import { redis } from "../lib/redis";
import { prisma } from "../db";
import { chunkByHeadings, indexChunks } from "../rag";

const connection = redis;

const postIndexingQueue = new Queue("post-indexing", { connection });

export async function enqueuePostIndexing(postId: string, userId: string): Promise<void> {
	await postIndexingQueue.add("index", { postId, userId });
	console.log(`[queue] Enqueued post ${postId} for indexing`);
}

export function startWorkers(): void {
	const worker = new Worker(
		"post-indexing",
		async (job) => {
			const { postId, userId } = job.data;

			const post = await prisma.post.findUnique({
				where: { id: postId },
				select: { content: true },
			});

			if (!post) {
				console.log(`[indexing] Post ${postId} not found, skipping`);
				return;
			}

			const chunks = chunkByHeadings(post.content);

			// Delete old chunks
			await prisma.postChunk.deleteMany({ where: { postId } });

			// Index new chunks
			await indexChunks(postId, userId, chunks);

			console.log(`[indexing] Post ${postId} indexed — ${chunks.length} chunks`);
		},
		{
			connection,
			concurrency: 3,
			limiter: { max: 10, duration: 1000 },
		},
	);

	worker.on("failed", (job, err) => {
		console.error(`[indexing] Job ${job?.id} failed:`, err.message);
	});

	console.log("[queue] Post indexing worker started");
}
