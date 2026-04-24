import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { sign } from "hono/jwt";
import { hash, compare } from "bcrypt";
import { prisma } from "../db";
import { authMiddleware, type JWTPayload } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import { loadUserRolesAndPermissions } from "../lib/user-permissions";
import { ROLE_KEYS } from "../lib/permissions";

export const authRoutes = new Hono<{ Variables: { user: JWTPayload } }>();

const passwordSchema = z
	.string()
	.min(12, "Password must be at least 12 characters")
	.regex(/[A-Z]/, "Must contain an uppercase letter")
	.regex(/[a-z]/, "Must contain a lowercase letter")
	.regex(/[0-9]/, "Must contain a number");

const registerSchema = z.object({
	email: z.string().email(),
	password: z.string().min(8),
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

async function issueToken(user: {
	id: string;
	email: string;
	username: string;
	mustChangePassword: boolean;
}) {
	const { roles, permissions } = await loadUserRolesAndPermissions(user.id);
	return sign(
		{
			sub: user.id,
			email: user.email,
			username: user.username,
			roles,
			permissions,
			mustChangePassword: user.mustChangePassword,
			exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
		},
		process.env.JWT_SECRET!,
	);
}

// Public: check if setup wizard should be shown (no users yet)
authRoutes.get("/setup-status", async (c) => {
	const userCount = await prisma.user.count();
	return c.json({ needsSetup: userCount === 0 });
});

// Public: bootstrap first super_admin. Only works when DB has zero users.
// Rate-limited to prevent abuse during the brief window before first user exists.
authRoutes.post(
	"/setup",
	rateLimit({ keyPrefix: "setup", limit: 5, windowSeconds: 60 * 15 }),
	zValidator("json", setupSchema),
	async (c) => {
		const userCount = await prisma.user.count();
		if (userCount > 0) {
			return c.json({ error: "Setup already completed" }, 410);
		}

		const body = c.req.valid("json");
		const superRole = await prisma.role.findUnique({
			where: { key: ROLE_KEYS.SUPER_ADMIN },
		});
		if (!superRole) {
			return c.json({ error: "super_admin role missing — run db:seed first" }, 500);
		}

		const passwordHash = await hash(body.password, 10);
		const user = await prisma.user.create({
			data: {
				email: body.email,
				username: body.username,
				name: body.name,
				passwordHash,
				roles: { create: [{ roleId: superRole.id }] },
			},
			select: { id: true, email: true, username: true },
		});

		const token = await issueToken({ ...user, mustChangePassword: false });
		const { roles, permissions } = await loadUserRolesAndPermissions(user.id);
		return c.json(
			{
				token,
				user: {
					id: user.id,
					email: user.email,
					username: user.username,
					name: body.name,
					roles,
					permissions,
					mustChangePassword: false,
				},
			},
			201,
		);
	},
);

authRoutes.post("/register", zValidator("json", registerSchema), async (c) => {
	const { email, password, name, username } = c.req.valid("json");

	const existing = await prisma.user.findUnique({ where: { email } });
	if (existing) {
		return c.json({ error: "Email already registered" }, 400);
	}

	const passwordHash = await hash(password, 10);

	const user = await prisma.user.create({
		data: { email, passwordHash, name, username },
		select: { id: true, email: true, username: true, name: true },
	});

	const token = await issueToken({ ...user, mustChangePassword: false });

	return c.json({ token, user }, 201);
});

authRoutes.post(
	"/login",
	rateLimit({ keyPrefix: "login", limit: 10, windowSeconds: 60 * 15 }),
	zValidator("json", loginSchema),
	async (c) => {
		const { email, password } = c.req.valid("json");

		const user = await prisma.user.findUnique({ where: { email } });
		if (!user) {
			return c.json({ error: "Invalid credentials" }, 401);
		}

		const valid = await compare(password, user.passwordHash);
		if (!valid) {
			return c.json({ error: "Invalid credentials" }, 401);
		}

		const token = await issueToken(user);
		const { roles, permissions } = await loadUserRolesAndPermissions(user.id);

		return c.json({
			token,
			user: {
				id: user.id,
				email: user.email,
				name: user.name,
				username: user.username,
				roles,
				permissions,
				mustChangePassword: user.mustChangePassword,
			},
		});
	},
);

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

		return c.json({ success: true });
	},
);
