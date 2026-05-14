import { redis } from "./redis";
import { logger } from "./logger";

// Get-or-build with single-flight protection.
//
// The naive cache pattern — GET, if miss then query DB, then SET — has a
// thundering-herd failure mode: when the key expires under load, every
// concurrent request misses, every one runs the expensive `build()`, and
// the DB takes N× the load it should. For routes that produce big payloads
// (the RSS feed pulls 30 posts × full HTML body, ~MB) this can cascade into
// pool exhaustion.
//
// This helper serialises rebuilds: only the first miss-er holds a Redis
// lock and runs `build()`; everyone else polls the cache for the result
// the winner is about to write. The pattern is the same SET NX EX we use
// for the view-counter flush in view-counter.ts, just adapted for read paths.
//
// Tuning notes:
//   - LOCK_TTL covers a worst-case build (Postgres query + JSON.stringify + Redis SET).
//     30s is plenty for our feed/sitemap shapes; bump if `build()` ever calls slow APIs.
//   - WAIT_POLL_MS is small enough that losers respond within ~100ms of the winner
//     finishing, but not so small that polling becomes load itself.
//   - MAX_WAIT_MS prevents losers from hanging forever if the lock holder crashes
//     mid-build (the SET EX will eventually expire, but until then losers should
//     fall back to building themselves rather than 504).

const LOCK_TTL_SECONDS = 30;
const WAIT_POLL_MS = 50;
const MAX_WAIT_MS = 8_000;

function sleep(ms: number): Promise<void> {
	return new Promise((res) => setTimeout(res, ms));
}

export async function cachedOrBuild<T extends string>(opts: {
	cacheKey: string;
	cacheTtlSeconds: number;
	build: () => Promise<T>;
}): Promise<T> {
	const { cacheKey, cacheTtlSeconds, build } = opts;
	const lockKey = `${cacheKey}:lock`;

	const cached = await redis.get(cacheKey);
	if (cached !== null) return cached as T;

	// Try to become the single builder. If we lose, poll the cache instead of
	// running the build ourselves.
	const acquired = await redis.set(lockKey, "1", "EX", LOCK_TTL_SECONDS, "NX");

	if (acquired === "OK") {
		try {
			const value = await build();
			await redis.set(cacheKey, value, "EX", cacheTtlSeconds);
			return value;
		} finally {
			// Best-effort release. If we crashed after building but before this
			// line, the TTL above handles it.
			await redis.del(lockKey).catch(() => {});
		}
	}

	// Lost the race — wait for the winner to populate the cache.
	const deadline = Date.now() + MAX_WAIT_MS;
	while (Date.now() < deadline) {
		await sleep(WAIT_POLL_MS);
		const value = await redis.get(cacheKey);
		if (value !== null) return value as T;
	}

	// Winner stalled or died without releasing. Build ourselves rather than
	// failing the request — accept the temporary herd to keep latency bounded.
	logger.warn({ cacheKey }, "[cache-lock] lock wait timed out, building locally");
	const value = await build();
	// Race-tolerant write: even if another process beat us here, both writes
	// produce the same value (build is deterministic for our use cases).
	await redis.set(cacheKey, value, "EX", cacheTtlSeconds);
	return value;
}
