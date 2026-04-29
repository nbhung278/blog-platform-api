import { prisma } from "../db";
import { publishToUser } from "./realtime";

export type NotificationType = "follow" | "post_published" | "post_updated";

export interface CreateNotificationInput {
	userId: string;
	actorId?: string;
	type: NotificationType;
	postId?: string;
}

export async function createNotification(input: CreateNotificationInput) {
	const notif = await prisma.notification.create({
		data: {
			userId: input.userId,
			actorId: input.actorId,
			type: input.type,
			postId: input.postId,
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
// Creates per-recipient inside a transaction so each row's id is captured —
// otherwise concurrent fan-outs sharing actor/type/post can confuse a re-query
// and broadcast the wrong row to a recipient.
export async function fanoutNotification(
	recipients: string[],
	input: Omit<CreateNotificationInput, "userId">,
) {
	if (recipients.length === 0) return;

	const created = await prisma.$transaction(
		recipients.map((userId) =>
			prisma.notification.create({
				data: {
					userId,
					actorId: input.actorId,
					type: input.type,
					postId: input.postId,
				},
				include: {
					actor: { select: { id: true, name: true, username: true, avatarUrl: true } },
					post: {
						select: {
							id: true,
							slug: true,
							title: true,
							user: { select: { username: true } },
						},
					},
				},
			}),
		),
	);

	for (const notif of created) {
		publishToUser(notif.userId, { kind: "notification", data: notif });
	}
}
