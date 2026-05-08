import { redis } from "./redis";
import { prisma } from "../db";
import { logger } from "./logger";

const VC_KEY_PREFIX = "blog:vc:post:";

export async function incrementView(postId: string): Promise<void> {
	await redis.incr(`${VC_KEY_PREFIX}${postId}`);
}

// Read the unflushed view count sitting in Redis. Add this to posts.viewCount
// in API responses so readers see an accurate number without waiting for the
// 30s flush.
export async function getPendingViews(postId: string): Promise<number> {
	const v = await redis.get(`${VC_KEY_PREFIX}${postId}`);
	return v ? Number(v) : 0;
}

// Batch variant for list endpoints — single MGET round-trip.
export async function getPendingViewsMap(postIds: string[]): Promise<Map<string, number>> {
	const map = new Map<string, number>();
	if (postIds.length === 0) return map;
	const keys = postIds.map((id) => `${VC_KEY_PREFIX}${id}`);
	const values = await redis.mget(...keys);
	postIds.forEach((id, i) => {
		const v = values[i];
		if (v) map.set(id, Number(v));
	});
	return map;
}

const FLUSH_LOCK_KEY = "blog:vc:flush:lock";
// TTL must be long enough to cover a slow flush of a large keyspace, but short
// enough that a crashed instance frees the lock before the next 30s tick.
const FLUSH_LOCK_TTL_SECONDS = 60;

export async function flushViewCounts(): Promise<void> {
	// SET NX EX — only one instance across the whole cluster runs a flush at a
	// time. The local boolean was insufficient: two pods would both SCAN and
	// race on getdel, but more importantly the post.update calls would
	// double-apply if both reads saw the key before either getdel landed.
	const lockToken = `${process.pid}-${Date.now()}-${Math.random()}`;
	const acquired = await redis.set(FLUSH_LOCK_KEY, lockToken, "EX", FLUSH_LOCK_TTL_SECONDS, "NX");
	if (acquired !== "OK") return;

	try {
		// SCAN instead of KEYS to avoid blocking Redis on large keyspaces.
		const keys: string[] = [];
		let cursor = 0;
		do {
			const [next, batch] = await redis.scan(cursor, "MATCH", `${VC_KEY_PREFIX}*`, "COUNT", 100);
			cursor = Number(next);
			keys.push(...batch);
		} while (cursor !== 0);

		for (const key of keys) {
			if (key === FLUSH_LOCK_KEY) continue;
			const count = await redis.getdel(key);
			if (!count || count === "0") continue;

			const postId = key.replace(VC_KEY_PREFIX, "");
			await prisma.post.update({
				where: { id: postId },
				data: { viewCount: { increment: Number(count) } },
			});
		}
	} finally {
		// Release the lock only if we still own it (don't stomp another holder
		// after our TTL expired mid-flush).
		const releaseScript = `
			if redis.call("get", KEYS[1]) == ARGV[1] then
				return redis.call("del", KEYS[1])
			else
				return 0
			end
		`;
		await redis.eval(releaseScript, 1, FLUSH_LOCK_KEY, lockToken).catch(() => {});
	}
}

let flusherTimer: ReturnType<typeof setInterval> | null = null;

export function startViewCountFlusher(): void {
	if (flusherTimer) return;
	flusherTimer = setInterval(flushViewCounts, 30_000);
	logger.info("[view-counter] flusher started (every 30s)");
}

export function stopViewCountFlusher(): void {
	if (flusherTimer) {
		clearInterval(flusherTimer);
		flusherTimer = null;
	}
}
