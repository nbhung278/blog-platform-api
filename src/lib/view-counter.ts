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
