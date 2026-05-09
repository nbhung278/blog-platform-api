/**
 * One-time migration: rename Redis view-counter keys from the old
 * `viewcount:{postId}` prefix to `blog:vc:post:{postId}`.
 *
 * Run BEFORE deploying the view-counter refactor, or pending view counts
 * from the old keys will never be flushed to Postgres.
 *
 *   bun run scripts/migrate-viewcount-redis-keys.ts
 *
 * Safe to run multiple times — RENAME is atomic, and keys that already use
 * the new prefix are left untouched. The old lock key is deleted because the
 * new code uses `blog:vc:flush:lock`.
 */

import Redis from "ioredis";

const OLD_PREFIX = "viewcount:";
const NEW_PREFIX = "blog:vc:post:";
const OLD_LOCK = "viewcount:flush:lock";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

async function main() {
	let cursor = 0;
	let renamed = 0;
	const skipped = 0;

	do {
		const [next, keys] = await redis.scan(cursor, "MATCH", `${OLD_PREFIX}*`, "COUNT", 100);
		cursor = Number(next);

		for (const key of keys) {
			if (key === OLD_LOCK) {
				await redis.del(OLD_LOCK);
				console.log(`Deleted old lock key: ${OLD_LOCK}`);
				continue;
			}

			const postId = key.slice(OLD_PREFIX.length);
			const newKey = `${NEW_PREFIX}${postId}`;

			const newExists = await redis.exists(newKey);
			if (newExists) {
				// Both keys exist — merge counts so nothing is lost.
				const [oldVal, newVal] = await Promise.all([redis.get(key), redis.get(newKey)]);
				const merged = (Number(oldVal) || 0) + (Number(newVal) || 0);
				await redis.set(newKey, merged);
				await redis.del(key);
				console.log(`Merged ${key} (${oldVal}) + ${newKey} (${newVal}) → ${merged}`);
				renamed++;
			} else {
				await redis.rename(key, newKey);
				console.log(`Renamed ${key} → ${newKey}`);
				renamed++;
			}
		}
	} while (cursor !== 0);

	console.log(`\nDone. Renamed: ${renamed}, Skipped: ${skipped}`);
	await redis.quit();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
