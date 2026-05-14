/**
 * Nightly cleanup for reading_progress rows.
 *
 * Strategy:
 *   1. Drop rows where the user already finished reading (progress >= 0.95)
 *      more than 7 days ago — keeping these adds noise to "Continue reading"
 *      and serves no UI purpose.
 *   2. Drop any row not touched in 30 days — at that point the user has
 *      clearly moved on.
 *   3. Drop drive-by rows (progress < 0.10) older than 3 days — these are
 *      usually accidental opens or pre-bounces.
 *
 * Per-user row cap is enforced inline by the upsert handler in
 * routes/reading-progress.ts, so this job only handles time-based decay.
 *
 * Run via:
 *   bun run scripts/cleanup-reading-progress.ts
 *
 * Wire to a system cron on the host (suggested 03:00 UTC daily). Safe to
 * run multiple times; deletes are idempotent.
 */

import { prisma } from "../src/db";

async function main() {
	const now = new Date();
	const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
	const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
	const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

	const [finished, stale, driveBy] = await Promise.all([
		prisma.readingProgress.deleteMany({
			where: { progress: { gte: 0.95 }, updatedAt: { lt: sevenDaysAgo } },
		}),
		prisma.readingProgress.deleteMany({
			where: { updatedAt: { lt: thirtyDaysAgo } },
		}),
		prisma.readingProgress.deleteMany({
			where: { progress: { lt: 0.1 }, updatedAt: { lt: threeDaysAgo } },
		}),
	]);

	console.log(
		`[reading-progress cleanup] deleted finished=${finished.count} stale=${stale.count} driveBy=${driveBy.count}`,
	);
}

main()
	.catch((err) => {
		console.error("[reading-progress cleanup] failed:", err);
		process.exit(1);
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
