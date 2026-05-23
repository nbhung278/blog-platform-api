import { prisma } from "../db";
import { redis } from "./redis";
import { logger } from "./logger";

// Single-instance cluster lock for cleanup jobs. Without this, every pod runs
// the same DELETE statements every hour and one of them wins while the others
// spew "0 rows affected" log noise — wasted DB cycles and confusing telemetry.
// The lock is short (90s) so a crashed leader doesn't lock out the cluster for
// long; the jobs themselves are idempotent (DELETE WHERE ... is the same
// answer on retry) so reacquiring early is safe.
const CRON_LOCK_TTL_SECONDS = 90;

const RELEASE_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
	const key = `cron:lock:${name}`;
	const token = `${process.pid}-${Date.now()}-${Math.random()}`;
	const acquired = await redis.set(key, token, "EX", CRON_LOCK_TTL_SECONDS, "NX");
	if (acquired !== "OK") return undefined;
	try {
		return await fn();
	} finally {
		await redis.eval(RELEASE_LOCK_LUA, 1, key, token).catch(() => {});
	}
}

// Refresh tokens hang around forever unless we clean them up — every login
// adds another row, and revoked tokens are useless after their original
// expiresAt. Drop anything fully expired by a 7-day grace window (matches
// the rotation window long-tail).
async function purgeExpiredRefreshTokens(): Promise<void> {
	const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
	const result = await prisma.refreshToken.deleteMany({
		where: { expiresAt: { lt: cutoff } },
	});
	if (result.count > 0) {
		logger.info({ count: result.count }, "[cron] purged expired refresh tokens");
	}
}

// Read notifications older than 90 days clutter user inboxes and grow the
// table unbounded. Unread notifications are kept forever — those are signal,
// not noise.
async function purgeOldReadNotifications(): Promise<void> {
	const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
	const result = await prisma.notification.deleteMany({
		where: { isRead: true, createdAt: { lt: cutoff } },
	});
	if (result.count > 0) {
		logger.info({ count: result.count }, "[cron] purged old read notifications");
	}
}

type Job = { name: string; run: () => Promise<void> };

const JOBS: Job[] = [
	{ name: "purge-expired-refresh-tokens", run: purgeExpiredRefreshTokens },
	{ name: "purge-old-read-notifications", run: purgeOldReadNotifications },
];

async function runCleanupCycle(): Promise<void> {
	await withLock("cleanup", async () => {
		for (const job of JOBS) {
			try {
				await job.run();
			} catch (err) {
				// Don't let one job's failure abort the rest of the cycle.
				logger.error({ err, job: job.name }, "[cron] job failed");
			}
		}
	});
}

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

// Run hourly. All current jobs target rows that age out over days/months, so
// hourly is plenty — the value is that this happens automatically, not that
// it's quick to react.
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export function startCronJobs(): void {
	if (cleanupTimer) return;

	// Delay the first run so concurrent pod startups don't dogpile the lock
	// at exactly the same second.
	const initialDelay = 30_000 + Math.floor(Math.random() * 30_000);
	setTimeout(() => {
		void runCleanupCycle().catch((err) =>
			logger.error({ err }, "[cron] initial cleanup cycle failed"),
		);
		cleanupTimer = setInterval(() => {
			void runCleanupCycle().catch((err) => logger.error({ err }, "[cron] cleanup cycle failed"));
		}, CLEANUP_INTERVAL_MS);
	}, initialDelay);

	logger.info("[cron] cleanup jobs scheduled (hourly)");
}

export function stopCronJobs(): void {
	if (cleanupTimer) {
		clearInterval(cleanupTimer);
		cleanupTimer = null;
	}
}
