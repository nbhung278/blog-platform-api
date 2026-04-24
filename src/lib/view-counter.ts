import { redis } from "./redis";
import { prisma } from "../db";

export async function incrementView(postId: string): Promise<void> {
	await redis.incr(`viewcount:${postId}`);
}

async function flushViewCounts(): Promise<void> {
	const keys = await redis.keys("viewcount:*");

	for (const key of keys) {
		const count = await redis.getdel(key);
		if (!count || count === "0") continue;

		const postId = key.replace("viewcount:", "");
		await prisma.post.update({
			where: { id: postId },
			data: { viewCount: { increment: Number(count) } },
		});
	}

	if (keys.length > 0) {
		console.log(`[view-counter] Flushed ${keys.length} view counts`);
	}
}

export function startViewCountFlusher(): void {
	setInterval(flushViewCounts, 30_000);
	console.log("[view-counter] Flusher started (every 30s)");
}
