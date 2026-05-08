import { prisma } from "../db";
import { publishToUser } from "./realtime";
import { logger } from "./logger";

export type NotificationType = "follow" | "post_published" | "post_updated" | "comment_reply";

export interface CreateNotificationInput {
	userId: string;
	actorId?: string;
	type: NotificationType;
	postId?: string;
	commentId?: string;
}

export async function createNotification(input: CreateNotificationInput) {
	// Don't notify yourself for actions you triggered.
	if (input.actorId && input.actorId === input.userId) return null;

	if (input.type === "comment_reply" && !input.commentId) {
		logger.warn({ input }, "[notifications] comment_reply missing commentId — skipping");
		return null;
	}

	const notif = await prisma.notification.create({
		data: {
			userId: input.userId,
			actorId: input.actorId,
			type: input.type,
			postId: input.postId,
			commentId: input.commentId,
		},
		include: {
			actor: { select: { id: true, name: true, username: true, avatarUrl: true } },
			post: { select: { id: true, slug: true, title: true, user: { select: { username: true } } } },
		},
	});

	publishToUser(input.userId, { kind: "notification", data: notif });
	return notif;
}

// Notify all followers (with notifications enabled) of a post event. Looks up
// follower IDs lazily so callers only pass authorId + post info. Skips when the
// author has no opted-in followers.
export async function notifyFollowersOfPost(
	authorId: string,
	postId: string,
	type: Extract<NotificationType, "post_published" | "post_updated">,
) {
	const followers = await prisma.follow.findMany({
		where: {
			followingId: authorId,
			emailEnabled: true,
			followerId: { not: authorId },
		},
		select: { followerId: true },
	});
	if (followers.length === 0) return;
	await fanoutNotification(
		followers.map((f) => f.followerId),
		{ actorId: authorId, postId, type },
	);
}

// Batch fan-out: deliver one notification to many recipients (for post publish).
// Uses createManyAndReturn so all rows are inserted in a single statement and
// we still get back the generated ids for realtime delivery. The actor and
// post relations are looked up once and merged in memory (they're identical
// across recipients), avoiding N relation joins.
export async function fanoutNotification(
	recipients: string[],
	input: Omit<CreateNotificationInput, "userId">,
) {
	if (recipients.length === 0) return;

	const [actor, post, created] = await Promise.all([
		input.actorId
			? prisma.user.findUnique({
					where: { id: input.actorId },
					select: { id: true, name: true, username: true, avatarUrl: true },
				})
			: Promise.resolve(null),
		input.postId
			? prisma.post.findUnique({
					where: { id: input.postId },
					select: {
						id: true,
						slug: true,
						title: true,
						user: { select: { username: true } },
					},
				})
			: Promise.resolve(null),
		prisma.notification.createManyAndReturn({
			data: recipients.map((userId) => ({
				userId,
				actorId: input.actorId,
				type: input.type,
				postId: input.postId,
				commentId: input.commentId,
			})),
		}),
	]);

	for (const notif of created) {
		publishToUser(notif.userId, {
			kind: "notification",
			data: { ...notif, actor, post },
		});
	}
}
