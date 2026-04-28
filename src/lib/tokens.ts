import { randomBytes, createHash } from "crypto";
import { sign } from "hono/jwt";
import { prisma } from "../db";
import { redis } from "./redis";
import { loadUserRolesAndPermissions } from "./user-permissions";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export type AccessTokenUser = {
	id: string;
	email: string;
	username: string;
	mustChangePassword: boolean;
	tokenVersion: number;
};

export async function issueAccessToken(user: AccessTokenUser) {
	const { roles, permissions } = await loadUserRolesAndPermissions(user.id);
	const token = await sign(
		{
			sub: user.id,
			email: user.email,
			username: user.username,
			roles,
			permissions,
			mustChangePassword: user.mustChangePassword,
			tokenVersion: user.tokenVersion,
			exp: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
		},
		process.env.JWT_SECRET!,
	);
	return { token, roles, permissions };
}

function hashRefreshToken(raw: string) {
	return createHash("sha256").update(raw).digest("hex");
}

function tokenVersionKey(userId: string) {
	return `tokenversion:${userId}`;
}

export async function getCachedTokenVersion(userId: string): Promise<number | null> {
	const cached = await redis.get(tokenVersionKey(userId));
	if (cached !== null) return parseInt(cached, 10);

	const user = await prisma.user.findUnique({
		where: { id: userId },
		select: { tokenVersion: true },
	});
	if (!user) return null;

	await redis.set(tokenVersionKey(userId), user.tokenVersion, "EX", 300);
	return user.tokenVersion;
}

export async function bumpTokenVersion(userId: string) {
	const updated = await prisma.user.update({
		where: { id: userId },
		data: { tokenVersion: { increment: 1 } },
		select: { tokenVersion: true },
	});
	await redis.set(tokenVersionKey(userId), updated.tokenVersion, "EX", 300);
	await prisma.refreshToken.updateMany({
		where: { userId, revokedAt: null },
		data: { revokedAt: new Date() },
	});
	return updated.tokenVersion;
}

export async function issueRefreshToken(opts: {
	userId: string;
	userAgent?: string | null;
	ip?: string | null;
}) {
	const raw = randomBytes(48).toString("base64url");
	const tokenHash = hashRefreshToken(raw);
	const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);

	const record = await prisma.refreshToken.create({
		data: {
			userId: opts.userId,
			tokenHash,
			expiresAt,
			userAgent: opts.userAgent ?? null,
			ip: opts.ip ?? null,
		},
		select: { id: true },
	});

	return { raw, id: record.id, expiresAt };
}

export async function issueTokenPair(
	user: AccessTokenUser,
	context: { userAgent?: string | null; ip?: string | null },
) {
	const access = await issueAccessToken(user);
	const refresh = await issueRefreshToken({
		userId: user.id,
		userAgent: context.userAgent,
		ip: context.ip,
	});
	return {
		accessToken: access.token,
		refreshToken: refresh.raw,
		refreshTokenExpiresAt: refresh.expiresAt,
		roles: access.roles,
		permissions: access.permissions,
	};
}

export type RotateResult =
	| {
			ok: true;
			userId: string;
			newRefreshToken: string;
			newRefreshTokenExpiresAt: Date;
	  }
	| { ok: false; reason: "not_found" | "expired" | "revoked" | "reused" };

// Atomic "consume + rotate" in two phases:
//   1. Look up token by hash (read-only).
//   2. Issue new refresh token, then mark old one revoked **with a guard
//      condition** (`revokedAt: null`) so concurrent /refresh calls compete on
//      a single row update. Only the winner gets to keep the new token; the
//      loser's new row is rolled back via a delete.
//
// If the token is found but already revoked, that means either:
//   (a) a legitimate parallel /refresh just won the race, or
//   (b) an attacker is replaying a stolen, already-rotated token.
// We can't tell the two apart, so we burn ONLY the descendants of this token
// (the compromised chain) — never the user's other sessions. That keeps the
// blast radius contained and prevents abuse of reuse-detection as a DoS.
export async function consumeAndRotateRefreshToken(
	rawToken: string,
	context: { userAgent?: string | null; ip?: string | null },
): Promise<RotateResult> {
	const tokenHash = hashRefreshToken(rawToken);
	const record = await prisma.refreshToken.findUnique({ where: { tokenHash } });
	if (!record) return { ok: false, reason: "not_found" };
	if (record.expiresAt < new Date()) return { ok: false, reason: "expired" };
	if (record.revokedAt) {
		await revokeChainFrom(record.id);
		return { ok: false, reason: "reused" };
	}

	// Issue the next token first so we have an ID to point `replacedBy` at.
	const next = await issueRefreshToken({
		userId: record.userId,
		userAgent: context.userAgent,
		ip: context.ip,
	});

	// Atomic: only the request that finds revokedAt still NULL wins. updateMany
	// returns count=1 for the winner, 0 for losers.
	const update = await prisma.refreshToken.updateMany({
		where: { id: record.id, revokedAt: null },
		data: { revokedAt: new Date(), replacedBy: next.id },
	});

	if (update.count === 0) {
		// Lost the race. Roll back the new token we just issued.
		await prisma.refreshToken.delete({ where: { id: next.id } });
		return { ok: false, reason: "revoked" };
	}

	return {
		ok: true,
		userId: record.userId,
		newRefreshToken: next.raw,
		newRefreshTokenExpiresAt: next.expiresAt,
	};
}

// Walk the replacedBy chain from `startId` and revoke every descendant.
async function revokeChainFrom(startId: string) {
	const visited = new Set<string>();
	let cursor: string | null = startId;
	while (cursor && !visited.has(cursor)) {
		visited.add(cursor);
		const node: { id: string; replacedBy: string | null } | null =
			await prisma.refreshToken.findUnique({
				where: { id: cursor },
				select: { id: true, replacedBy: true },
			});
		if (!node) break;
		cursor = node.replacedBy;
	}
	if (visited.size === 0) return;
	await prisma.refreshToken.updateMany({
		where: { id: { in: Array.from(visited) }, revokedAt: null },
		data: { revokedAt: new Date() },
	});
}

export async function revokeRefreshToken(rawToken: string) {
	const tokenHash = hashRefreshToken(rawToken);
	await prisma.refreshToken.updateMany({
		where: { tokenHash, revokedAt: null },
		data: { revokedAt: new Date() },
	});
}
