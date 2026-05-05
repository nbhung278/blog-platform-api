import { Queue, Worker } from "bullmq";
import { redis } from "../lib/redis";
import { prisma } from "../db";
import { chunkByHeadings, indexChunks } from "../rag";
import { logger } from "../lib/logger";

const connection = redis;

const postIndexingQueue = new Queue("post-indexing", {
	connection,
	defaultJobOptions: {
		attempts: 5,
		backoff: { type: "exponential", delay: 5_000 },
		// Keep finished jobs around briefly for debugging without unbounded growth.
		removeOnComplete: { count: 100, age: 24 * 3600 },
		// Failed jobs after max attempts stay for a week so they can be inspected.
		removeOnFail: { count: 500, age: 7 * 24 * 3600 },
	},
});

export async function enqueuePostIndexing(postId: string, userId: string): Promise<void> {
	await postIndexingQueue.add("index", { postId, userId });
	logger.info({ postId }, "[queue] enqueued post for indexing");
}

let runningWorker: Worker | null = null;

export function startWorkers(): void {
	const worker = new Worker(
		"post-indexing",
		async (job) => {
			const { postId, userId } = job.data;

			const post = await prisma.post.findUnique({
				where: { id: postId },
				select: { contentMd: true },
			});

			if (!post) {
				logger.info({ postId }, "[indexing] post not found, skipping");
				return;
			}

			const chunks = chunkByHeadings(post.contentMd);

			// Delete old chunks
			await prisma.postChunk.deleteMany({ where: { postId } });

			// Index new chunks
			await indexChunks(postId, userId, chunks);

			logger.info({ postId, chunks: chunks.length }, "[indexing] post indexed");
		},
		{
			connection,
			concurrency: 3,
			limiter: { max: 10, duration: 1000 },
		},
	);

	worker.on("failed", (job, err) => {
		const attempts = job?.attemptsMade ?? 0;
		const max = job?.opts.attempts ?? 0;
		const exhausted = max > 0 && attempts >= max;
		logger.error(
			{ jobId: job?.id, attempts, max, exhausted, err: err.message },
			"[indexing] job failed",
		);
	});

	worker.on("error", (err) => {
		logger.error({ err }, "[indexing] worker error");
	});

	runningWorker = worker;
	logger.info("[queue] post indexing worker started");
}

export async function stopWorkers(): Promise<void> {
	if (runningWorker) {
		// `close()` waits for active jobs to finish (up to grace period).
		await runningWorker.close();
		runningWorker = null;
	}
	await postIndexingQueue.close();
}
