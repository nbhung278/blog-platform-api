import { createHmac } from "node:crypto";
import { prisma } from "../db";
import { env } from "./env";

export type DeviceContext = { ip: string | null; userAgent: string | null };

// Fingerprint = HMAC(JWT_SECRET, ip + "|" + userAgent). HMAC instead of plain
// SHA256 so the on-disk value can't be brute-forced back to the IP/UA pair
// without the server secret. Re-uses JWT_SECRET — these fingerprints have the
// same trust scope as session tokens, so a leak of one implies the other.
export function fingerprintDevice(ctx: DeviceContext): string {
	const ip = ctx.ip ?? "";
	const ua = ctx.userAgent ?? "";
	return createHmac("sha256", env.JWT_SECRET).update(`${ip}|${ua}`).digest("hex");
}

export async function isKnownDevice(userId: string, ctx: DeviceContext): Promise<boolean> {
	const fp = fingerprintDevice(ctx);
	const row = await prisma.knownDevice.findUnique({
		where: { userId_fingerprint: { userId, fingerprint: fp } },
		select: { id: true },
	});
	return row !== null;
}

export async function trustDevice(userId: string, ctx: DeviceContext): Promise<void> {
	const fp = fingerprintDevice(ctx);
	// Upsert so a re-login from a known device just bumps lastUsedAt instead of
	// creating duplicate rows. The unique constraint on (userId, fingerprint)
	// makes this race-safe.
	await prisma.knownDevice.upsert({
		where: { userId_fingerprint: { userId, fingerprint: fp } },
		create: {
			userId,
			fingerprint: fp,
			userAgent: ctx.userAgent,
			ip: ctx.ip,
		},
		update: {
			lastUsedAt: new Date(),
			userAgent: ctx.userAgent,
			ip: ctx.ip,
		},
	});
}
