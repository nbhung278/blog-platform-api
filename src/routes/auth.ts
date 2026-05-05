import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { hash, compare } from "bcrypt";
import type { Context } from "hono";
import { prisma } from "../db";
import { authMiddleware, tryGetUser, type JWTPayload } from "../middleware/auth";
import { disconnectUser } from "../lib/realtime";
import {
	loginRateLimit,
	ipRateLimit,
	recordLoginFailure,
	recordLoginSuccess,
	getClientIp,
} from "../middleware/rate-limit";
import { ROLE_KEYS } from "../lib/permissions";
import { env } from "../lib/env";
import {
	bumpTokenVersion,
	consumeAndRotateRefreshToken,
	issueAccessToken,
	issueTokenPair,
	revokeRefreshToken,
} from "../lib/tokens";
import {
	CSRF_HEADER,
	clearAuthCookies,
	csrfTokensMatch,
	getCsrfCookie,
	getRefreshCookie,
	rotateAccessCookie,
	rotateCsrfCookie,
	rotateRefreshCookie,
	setAuthCookies,
} from "../lib/cookies";

export const authRoutes = new Hono<{ Variables: { user: JWTPayload } }>();

const passwordSchema = z
	.string()
	.min(12, "Password must be at least 12 characters")
	.regex(/[A-Z]/, "Must contain an uppercase letter")
	.regex(/[a-z]/, "Must contain a lowercase letter")
	.regex(/[0-9]/, "Must contain a number");

const registerSchema = z.object({
	email: z.string().email(),
	password: passwordSchema,
	name: z.string().min(1),
	username: z
		.string()
		.min(3)
		.max(30)
		.regex(/^[a-z0-9-]+$/),
});

const loginSchema = z.object({
	email: z.string().email(),
	password: z.string(),
});

const setupSchema = z.object({
	email: z.string().email(),
	password: passwordSchema,
	name: z.string().min(1),
	username: z
		.string()
		.min(3)
		.max(30)
		.regex(/^[a-z0-9-]+$/),
});

const changePasswordSchema = z.object({
	currentPassword: z.string(),
	newPassword: passwordSchema,
});

class SetupAlreadyCompletedError extends Error {}

function clientContext(c: Context) {
	const rawIp = getClientIp(c);
	const ip = rawIp === "unknown" ? null : rawIp;
	const userAgent = c.req.header("user-agent") || null;
	return { ip, userAgent };
}

// Pre-computed bcrypt hash of a random string. Used to make /login spend the
// same wall-time on a missing-user path as on a wrong-password path. Without
// this, `bcrypt.compare` only runs when the user exists, leaking ~30ms of
// timing signal that lets attackers enumerate accounts.
const DUMMY_PASSWORD_HASH = "$2b$10$CwTycUXWue0Thq9StjUM0uJ8cLh5GxqCkB5rIo1NYHSZv1VfM0vBu";

// Public: check if setup wizard should be shown (no users yet)
authRoutes.get("/setup-status", async (c) => {
	const userCount = await prisma.user.count();
	return c.json({ needsSetup: userCount === 0 });
});

// Public: bootstrap first super_admin. Only works when DB has zero users AND
// (if SETUP_TOKEN is configured) the caller echoes the install token so
// whoever lands on the endpoint after a DB reset can't win a race.
authRoutes.post(
	"/setup",
	ipRateLimit({ keyPrefix: "setup", limit: 5, windowSeconds: 60 * 15 }),
	zValidator("json", setupSchema),
	async (c) => {
		if (env.SETUP_TOKEN) {
			const provided = c.req.header("x-setup-token");
			if (!provided || provided !== env.SETUP_TOKEN) {
				return c.json({ error: "Setup not allowed" }, 403);
			}
		}
		const body = c.req.valid("json");
		const superRole = await prisma.role.findUnique({
			where: { key: ROLE_KEYS.SUPER_ADMIN },
		});
		if (!superRole) {
			return c.json({ error: "super_admin role missing — run db:seed first" }, 500);
		}

		const passwordHash = await hash(body.password, 10);

		// Serializable transaction: count + create must be atomic so two
		// concurrent /setup requests can't both succeed when DB is empty.
		let user: { id: string; email: string; username: string; tokenVersion: number };
		try {
			user = await prisma.$transaction(
				async (tx) => {
					const count = await tx.user.count();
					if (count > 0) {
						throw new SetupAlreadyCompletedError();
					}
					return tx.user.create({
						data: {
							email: body.email,
							username: body.username,
							name: body.name,
							passwordHash,
							roles: { create: [{ roleId: superRole.id }] },
						},
						select: { id: true, email: true, username: true, tokenVersion: true },
					});
				},
				{ isolationLevel: "Serializable" },
			);
		} catch (err) {
			if (err instanceof SetupAlreadyCompletedError) {
				return c.json({ error: "Setup already completed" }, 410);
			}
			throw err;
		}

		const pair = await issueTokenPair({ ...user, mustChangePassword: false }, clientContext(c));
		setAuthCookies(c, { accessToken: pair.accessToken, refreshToken: pair.refreshToken });
		return c.json(
			{
				user: {
					id: user.id,
					email: user.email,
					username: user.username,
					name: body.name,
					roles: pair.roles,
					permissions: pair.permissions,
					mustChangePassword: false,
				},
			},
			201,
		);
	},
);

authRoutes.post(
	"/register",
	ipRateLimit({ keyPrefix: "register", limit: 5, windowSeconds: 60 * 60 }),
	zValidator("json", registerSchema),
	async (c) => {
		if (process.env.ALLOW_REGISTRATION !== "true") {
			return c.json({ error: "Registration is not open" }, 403);
		}

		const { email, password, name, username } = c.req.valid("json");

		const passwordHash = await hash(password, 10);

		const authorRole = await prisma.role.findUnique({
			where: { key: ROLE_KEYS.AUTHOR },
			select: { id: true },
		});
		if (!authorRole) {
			return c.json({ error: "author role missing — run db:seed first" }, 500);
		}

		// Race-free uniqueness: relying on the DB unique constraint instead of a
		// findFirst+create pair, which has a window where two parallel requests
		// both pass the lookup. We catch P2002 (unique violation) and turn it
		// into a 400 — same UX as the old check, no race.
		let user;
		try {
			user = await prisma.user.create({
				data: {
					email,
					passwordHash,
					name,
					username,
					roles: { create: [{ roleId: authorRole.id }] },
				},
				select: {
					id: true,
					email: true,
					username: true,
					name: true,
					bio: true,
					avatarUrl: true,
					tokenVersion: true,
				},
			});
		} catch (err) {
			if (
				err &&
				typeof err === "object" &&
				"code" in err &&
				(err as { code?: string }).code === "P2002"
			) {
				return c.json({ error: "Email or username already taken" }, 400);
			}
			throw err;
		}

		const pair = await issueTokenPair({ ...user, mustChangePassword: false }, clientContext(c));
		setAuthCookies(c, { accessToken: pair.accessToken, refreshToken: pair.refreshToken });
		return c.json(
			{
				user: {
					id: user.id,
					email: user.email,
					name: user.name,
					username: user.username,
					bio: user.bio,
					avatarUrl: user.avatarUrl,
					roles: pair.roles,
					permissions: pair.permissions,
					mustChangePassword: false,
				},
			},
			201,
		);
	},
);

authRoutes.post("/login", loginRateLimit(), zValidator("json", loginSchema), async (c) => {
	const { email, password } = c.req.valid("json");

	const user = await prisma.user.findUnique({ where: { email } });

	// Always run bcrypt against *something*, even when the user doesn't exist.
	// This keeps the response time on the missing-user path within the same
	// distribution as the wrong-password path, blocking timing-based account
	// enumeration. Bool result on missing-user branch is discarded.
	const valid = await compare(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);

	if (!user || !valid) {
		await recordLoginFailure(email);
		return c.json({ error: "Invalid credentials" }, 401);
	}

	await recordLoginSuccess(email);
	const pair = await issueTokenPair(user, clientContext(c));
	setAuthCookies(c, { accessToken: pair.accessToken, refreshToken: pair.refreshToken });

	return c.json({
		user: {
			id: user.id,
			email: user.email,
			name: user.name,
			username: user.username,
			bio: user.bio,
			avatarUrl: user.avatarUrl,
			roles: pair.roles,
			permissions: pair.permissions,
			mustChangePassword: user.mustChangePassword,
		},
	});
});

// Refresh endpoint: reads refresh token from HttpOnly cookie. CSRF is enforced
// here too because in prod cookies are SameSite=None (cross-subdomain SPA), so
// without the double-submit check a cross-site POST could trigger token
// rotation and DoS the legitimate session by revoking the previous refresh.
authRoutes.post(
	"/refresh",
	ipRateLimit({ keyPrefix: "refresh", limit: 60, windowSeconds: 60 * 15 }),
	async (c) => {
		// Double-submit CSRF: the cookie is sent automatically; the JS-readable
		// copy must be echoed in the X-CSRF-Token header. A cross-site form has
		// no way to read the cookie, so it can't replay this header.
		const csrfHeader = c.req.header(CSRF_HEADER);
		const csrfCookie = getCsrfCookie(c);
		if (!csrfTokensMatch(csrfHeader, csrfCookie)) {
			return c.json({ error: "CSRF token mismatch" }, 403);
		}

		const refreshToken = getRefreshCookie(c);
		if (!refreshToken) {
			return c.json({ error: "Missing refresh token" }, 401);
		}

		const result = await consumeAndRotateRefreshToken(refreshToken, clientContext(c));
		if (!result.ok) {
			// Don't echo the reason — it gives an attacker a signal about whether
			// they hit a real-but-revoked token vs. a non-existent one. Also clear
			// stale cookies so the client falls back to a clean login.
			clearAuthCookies(c);
			return c.json({ error: "Invalid refresh token" }, 401);
		}

		const user = await prisma.user.findUnique({
			where: { id: result.userId },
			select: {
				id: true,
				email: true,
				username: true,
				name: true,
				mustChangePassword: true,
				tokenVersion: true,
			},
		});
		if (!user) {
			clearAuthCookies(c);
			return c.json({ error: "User not found" }, 401);
		}

		// User was flagged for forced password change — make /refresh reject too,
		// not just protected routes. Otherwise client could keep sliding access
		// tokens forward indefinitely.
		if (user.mustChangePassword) {
			await revokeRefreshToken(result.newRefreshToken);
			clearAuthCookies(c);
			return c.json({ error: "Password change required", code: "PASSWORD_CHANGE_REQUIRED" }, 403);
		}

		const access = await issueAccessToken(user);
		rotateAccessCookie(c, access.token);
		rotateRefreshCookie(c, result.newRefreshToken);
		// Rotate CSRF too so a stolen CSRF cookie can't outlive the access token
		// it was paired with. Client's `invalidateCsrfCache` after /refresh
		// re-reads the new value lazily.
		rotateCsrfCookie(c);

		return c.json({
			user: {
				id: user.id,
				email: user.email,
				name: user.name,
				username: user.username,
				roles: access.roles,
				permissions: access.permissions,
				mustChangePassword: false,
			},
		});
	},
);

authRoutes.post(
	"/logout",
	ipRateLimit({ keyPrefix: "logout", limit: 30, windowSeconds: 60 * 15 }),
	async (c) => {
		const refreshToken = getRefreshCookie(c);
		const me = await tryGetUser(c);
		if (refreshToken) {
			await revokeRefreshToken(refreshToken);
		}
		clearAuthCookies(c);
		if (me) disconnectUser(me.sub, "logged out");
		return c.json({ success: true });
	},
);

authRoutes.post("/logout-all", authMiddleware, async (c) => {
	const me = c.get("user");
	await bumpTokenVersion(me.sub);
	clearAuthCookies(c);
	disconnectUser(me.sub, "logged out from all devices");
	return c.json({ success: true });
});

authRoutes.get("/me", authMiddleware, async (c) => {
	const jwtPayload = c.get("user");

	// Single round-trip: pull profile fields and the role→permission graph at
	// once. Previously this fired two queries back-to-back per /me call.
	const user = await prisma.user.findUnique({
		where: { id: jwtPayload.sub },
		select: {
			id: true,
			email: true,
			name: true,
			username: true,
			bio: true,
			avatarUrl: true,
			plan: true,
			mustChangePassword: true,
			roles: {
				select: {
					role: {
						select: {
							key: true,
							permissions: { select: { permission: { select: { key: true } } } },
						},
					},
				},
			},
		},
	});

	if (!user) {
		return c.json({ error: "User not found" }, 404);
	}

	const roles = user.roles.map((ur) => ur.role.key);
	const permSet = new Set<string>();
	for (const ur of user.roles) {
		for (const rp of ur.role.permissions) permSet.add(rp.permission.key);
	}

	const { roles: _userRoles, ...profile } = user;
	return c.json({ ...profile, roles, permissions: Array.from(permSet) });
});

const updateMeSchema = z.object({
	name: z.string().min(1).max(100).optional(),
	bio: z.string().max(500).nullable().optional(),
	avatarUrl: z.string().url().nullable().optional(),
});

authRoutes.patch("/me", authMiddleware, zValidator("json", updateMeSchema), async (c) => {
	const me = c.get("user");
	const body = c.req.valid("json");

	const data: Record<string, unknown> = {};
	if (body.name !== undefined) data.name = body.name;
	if ("bio" in body) data.bio = body.bio;
	if ("avatarUrl" in body) data.avatarUrl = body.avatarUrl;

	if (Object.keys(data).length === 0) {
		return c.json({ error: "Nothing to update" }, 400);
	}

	const user = await prisma.user.update({
		where: { id: me.sub },
		data,
		select: { id: true, email: true, name: true, username: true, bio: true, avatarUrl: true },
	});

	return c.json(user);
});

authRoutes.post(
	"/change-password",
	authMiddleware,
	zValidator("json", changePasswordSchema),
	async (c) => {
		const me = c.get("user");
		const { currentPassword, newPassword } = c.req.valid("json");

		const user = await prisma.user.findUnique({ where: { id: me.sub } });
		if (!user) return c.json({ error: "User not found" }, 404);

		const valid = await compare(currentPassword, user.passwordHash);
		if (!valid) return c.json({ error: "Current password is incorrect" }, 400);

		if (currentPassword === newPassword) {
			return c.json({ error: "New password must differ from current" }, 400);
		}

		const passwordHash = await hash(newPassword, 10);
		await prisma.user.update({
			where: { id: user.id },
			data: { passwordHash, mustChangePassword: false },
		});

		// Revoke all existing tokens — force re-login on all devices.
		await bumpTokenVersion(user.id);
		clearAuthCookies(c);
		disconnectUser(user.id, "password changed");

		return c.json({ success: true });
	},
);
