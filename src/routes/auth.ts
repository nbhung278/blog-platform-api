import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { hash, compare } from "bcrypt";
import type { Context } from "hono";
import { prisma } from "../db";
import { authMiddleware, type JWTPayload } from "../middleware/auth";
import {
	loginRateLimit,
	ipRateLimit,
	recordLoginFailure,
	recordLoginSuccess,
	getClientIp,
} from "../middleware/rate-limit";
import { loadUserRolesAndPermissions } from "../lib/user-permissions";
import { ROLE_KEYS } from "../lib/permissions";
import {
	bumpTokenVersion,
	consumeAndRotateRefreshToken,
	issueAccessToken,
	issueTokenPair,
	revokeRefreshToken,
} from "../lib/tokens";

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

const refreshSchema = z.object({
	refreshToken: z.string().min(1),
});

const logoutSchema = z.object({
	refreshToken: z.string().min(1).optional(),
});

class SetupAlreadyCompletedError extends Error {}

function clientContext(c: Context) {
	const rawIp = getClientIp(c);
	const ip = rawIp === "unknown" ? null : rawIp;
	const userAgent = c.req.header("user-agent") || null;
	return { ip, userAgent };
}

// Public: check if setup wizard should be shown (no users yet)
authRoutes.get("/setup-status", async (c) => {
	const userCount = await prisma.user.count();
	return c.json({ needsSetup: userCount === 0 });
});

// Public: bootstrap first super_admin. Only works when DB has zero users.
authRoutes.post(
	"/setup",
	ipRateLimit({ keyPrefix: "setup", limit: 5, windowSeconds: 60 * 15 }),
	zValidator("json", setupSchema),
	async (c) => {
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
		return c.json(
			{
				accessToken: pair.accessToken,
				refreshToken: pair.refreshToken,
				refreshTokenExpiresAt: pair.refreshTokenExpiresAt,
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
	ipRateLimit({ keyPrefix: "register", limit: 5, windowSeconds: 60 * 15 }),
	zValidator("json", registerSchema),
	async (c) => {
		if (process.env.ALLOW_REGISTRATION !== "true") {
			return c.json({ error: "Registration is not open" }, 403);
		}

		const { email, password, name, username } = c.req.valid("json");

		const existing = await prisma.user.findFirst({
			where: { OR: [{ email }, { username }] },
		});
		if (existing) {
			return c.json({ error: "Email or username already taken" }, 400);
		}

		const passwordHash = await hash(password, 10);

		const user = await prisma.user.create({
			data: { email, passwordHash, name, username },
			select: { id: true, email: true, username: true, name: true, tokenVersion: true },
		});

		const pair = await issueTokenPair({ ...user, mustChangePassword: false }, clientContext(c));

		return c.json(
			{
				accessToken: pair.accessToken,
				refreshToken: pair.refreshToken,
				refreshTokenExpiresAt: pair.refreshTokenExpiresAt,
				user: {
					id: user.id,
					email: user.email,
					name: user.name,
					username: user.username,
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
	if (!user) {
		await recordLoginFailure(email);
		return c.json({ error: "Invalid credentials" }, 401);
	}

	const valid = await compare(password, user.passwordHash);
	if (!valid) {
		await recordLoginFailure(email);
		return c.json({ error: "Invalid credentials" }, 401);
	}

	await recordLoginSuccess(email);
	const pair = await issueTokenPair(user, clientContext(c));

	return c.json({
		accessToken: pair.accessToken,
		refreshToken: pair.refreshToken,
		refreshTokenExpiresAt: pair.refreshTokenExpiresAt,
		user: {
			id: user.id,
			email: user.email,
			name: user.name,
			username: user.username,
			roles: pair.roles,
			permissions: pair.permissions,
			mustChangePassword: user.mustChangePassword,
		},
	});
});

authRoutes.post(
	"/refresh",
	ipRateLimit({ keyPrefix: "refresh", limit: 60, windowSeconds: 60 * 15 }),
	zValidator("json", refreshSchema),
	async (c) => {
		const { refreshToken } = c.req.valid("json");

		const result = await consumeAndRotateRefreshToken(refreshToken, clientContext(c));
		if (!result.ok) {
			// Don't echo the reason — it gives an attacker a signal about whether
			// they hit a real-but-revoked token vs. a non-existent one.
			return c.json({ error: "Invalid refresh token" }, 401);
		}

		const user = await prisma.user.findUnique({
			where: { id: result.userId },
			select: {
				id: true,
				email: true,
				username: true,
				mustChangePassword: true,
				tokenVersion: true,
			},
		});
		if (!user) {
			return c.json({ error: "User not found" }, 401);
		}

		// User was flagged for forced password change — make /refresh reject too,
		// not just protected routes. Otherwise client could keep sliding access
		// tokens forward indefinitely.
		if (user.mustChangePassword) {
			await revokeRefreshToken(result.newRefreshToken);
			return c.json({ error: "Password change required", code: "PASSWORD_CHANGE_REQUIRED" }, 403);
		}

		const access = await issueAccessToken(user);

		return c.json({
			accessToken: access.token,
			refreshToken: result.newRefreshToken,
			refreshTokenExpiresAt: result.newRefreshTokenExpiresAt,
		});
	},
);

authRoutes.post(
	"/logout",
	ipRateLimit({ keyPrefix: "logout", limit: 30, windowSeconds: 60 * 15 }),
	zValidator("json", logoutSchema),
	async (c) => {
		const { refreshToken } = c.req.valid("json");
		if (refreshToken) {
			await revokeRefreshToken(refreshToken);
		}
		return c.json({ success: true });
	},
);

authRoutes.post("/logout-all", authMiddleware, async (c) => {
	const me = c.get("user");
	await bumpTokenVersion(me.sub);
	return c.json({ success: true });
});

authRoutes.get("/me", authMiddleware, async (c) => {
	const jwtPayload = c.get("user");

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
		},
	});

	if (!user) {
		return c.json({ error: "User not found" }, 404);
	}

	const { roles, permissions } = await loadUserRolesAndPermissions(user.id);

	return c.json({ ...user, roles, permissions });
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

		// Revoke all existing tokens — force re-login on all devices
		await bumpTokenVersion(user.id);

		return c.json({ success: true });
	},
);
