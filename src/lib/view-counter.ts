import { redis } from "./redis";
import { prisma } from "../db";

export async function incrementView(postId: string): Promise<void> {
	await redis.incr(`viewcount:${postId}`);
}

// Read the unflushed view count sitting in Redis. Add this to posts.viewCount
// in API responses so readers see an accurate number without waiting for the
// 30s flush.
export async function getPendingViews(postId: string): Promise<number> {
	const v = await redis.get(`viewcount:${postId}`);
	return v ? Number(v) : 0;
}

// Batch variant for list endpoints — single MGET round-trip.
export async function getPendingViewsMap(postIds: string[]): Promise<Map<string, number>> {
	const map = new Map<string, number>();
	if (postIds.length === 0) return map;
	const keys = postIds.map((id) => `viewcount:${id}`);
	const values = await redis.mget(...keys);
	postIds.forEach((id, i) => {
		const v = values[i];
		if (v) map.set(id, Number(v));
	});
	return map;
}

let flushing = false;

async function flushViewCounts(): Promise<void> {
	if (flushing) return;
	flushing = true;

	try {
		// SCAN instead of KEYS to avoid blocking Redis on large keyspaces.
		const keys: string[] = [];
		let cursor = 0;
		do {
			const [next, batch] = await redis.scan(cursor, "MATCH", "viewcount:*", "COUNT", 100);
			cursor = Number(next);
			keys.push(...batch);
		} while (cursor !== 0);

		for (const key of keys) {
			const count = await redis.getdel(key);
			if (!count || count === "0") continue;

			const postId = key.replace("viewcount:", "");
			await prisma.post.update({
				where: { id: postId },
				data: { viewCount: { increment: Number(count) } },
			});
		}
	} finally {
		flushing = false;
	}
}

export function startViewCountFlusher(): void {
	setInterval(flushViewCounts, 30_000);
	console.log("[view-counter] Flusher started (every 30s)");
}
