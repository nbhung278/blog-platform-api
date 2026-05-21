import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { hash } from "bcrypt";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { authMiddleware, requireViewOrManage, type JWTPayload } from "../middleware/auth";
import { PERMISSIONS, ROLE_KEYS } from "../lib/permissions";
import { bumpTokenVersion } from "../lib/tokens";
import { isUniqueViolation } from "../lib/prisma-errors";
import { passwordSchema } from "./auth";

export const usersRoutes = new Hono<{ Variables: { user: JWTPayload } }>();

usersRoutes.use(
	"*",
	authMiddleware,
	requireViewOrManage(PERMISSIONS.USER_VIEW, PERMISSIONS.USER_MANAGE),
);

const createUserSchema = z.object({
	email: z.string().email().max(254),
	password: passwordSchema,
	name: z.string().min(1).max(100),
	username: z
		.string()
		.min(3)
		.max(30)
		.regex(/^[a-z0-9-]+$/),
	roleIds: z.array(z.string().uuid()).max(20).default([]),
});

const updateUserSchema = z.object({
	email: z.string().email().max(254).optional(),
	name: z.string().min(1).max(100).optional(),
	username: z
		.string()
		.min(3)
		.max(30)
		.regex(/^[a-z0-9-]+$/)
		.optional(),
	password: passwordSchema.optional(),
	roleIds: z.array(z.string().uuid()).max(20).optional(),
});

usersRoutes.get("/", async (c) => {
	const users = await prisma.user.findMany({
		orderBy: { createdAt: "desc" },
		select: {
			id: true,
			email: true,
			name: true,
			username: true,
			plan: true,
			createdAt: true,
			roles: { include: { role: { select: { id: true, key: true, name: true } } } },
		},
	});
	return c.json(
		users.map((u) => ({
			id: u.id,
			email: u.email,
			name: u.name,
			username: u.username,
			plan: u.plan,
			createdAt: u.createdAt,
			roles: u.roles.map((ur) => ur.role),
		})),
	);
});

usersRoutes.post("/", zValidator("json", createUserSchema), async (c) => {
	const body = c.req.valid("json");

	const existing = await prisma.user.findFirst({
		where: { OR: [{ email: body.email }, { username: body.username }] },
	});
	if (existing) {
		return c.json({ error: "Email or username already taken" }, 400);
	}

	const passwordHash = await hash(body.password, 10);

	const user = await prisma.user.create({
		data: {
			email: body.email,
			passwordHash,
			name: body.name,
			username: body.username,
			mustChangePassword: true,
			roles: {
				create: body.roleIds.map((roleId) => ({ roleId })),
			},
		},
		select: { id: true },
	});

	return c.json({ id: user.id }, 201);
});

usersRoutes.patch("/:id", zValidator("json", updateUserSchema), async (c) => {
	const me = c.get("user");
	const id = c.req.param("id");
	const body = c.req.valid("json");

	const existing = await prisma.user.findUnique({
		where: { id },
		include: { roles: { select: { role: { select: { key: true } } } } },
	});
	if (!existing) return c.json({ error: "User not found" }, 404);

	const callerIsSuperAdmin = me.roles.includes(ROLE_KEYS.SUPER_ADMIN);
	const targetIsSuperAdmin = existing.roles.some((ur) => ur.role.key === ROLE_KEYS.SUPER_ADMIN);

	// Non-super_admin callers must never touch a super_admin account. Without this
	// guard a USER_MANAGE holder could PATCH the password (or email — which lets
	// them drive /forgot-password themselves) and take over the super_admin.
	// The roleIds check below handles the orthogonal case of escalating a
	// non-super_admin target into super_admin.
	if (targetIsSuperAdmin && !callerIsSuperAdmin) {
		return c.json({ error: "Only a super_admin can modify a super_admin account" }, 403);
	}

	// Hardening against privilege escalation by users with USER_MANAGE who
	// aren't super_admin themselves:
	//  - they can't edit their own roles (so they can't escalate themselves)
	//  - they can't grant the super_admin role to anyone
	// (Stripping super_admin from an existing super_admin is already blocked
	// by the targetIsSuperAdmin guard above.)
	if (body.roleIds && !callerIsSuperAdmin) {
		if (id === me.sub) {
			return c.json({ error: "You cannot change your own roles" }, 403);
		}
		const requestedRoles = await prisma.role.findMany({
			where: { id: { in: body.roleIds } },
			select: { key: true },
		});
		const wouldGrantSuperAdmin = requestedRoles.some((r) => r.key === ROLE_KEYS.SUPER_ADMIN);
		if (wouldGrantSuperAdmin) {
			return c.json({ error: "Only a super_admin can assign the super_admin role" }, 403);
		}
	}

	const data: Record<string, unknown> = {};
	if (body.email) data.email = body.email;
	if (body.name) data.name = body.name;
	if (body.username) data.username = body.username;
	if (body.password) {
		data.passwordHash = await hash(body.password, 10);
		data.mustChangePassword = true;
	}

	const rolesChanged = !!body.roleIds;
	const passwordChanged = !!body.password;

	try {
		await prisma.$transaction(async (tx) => {
			if (Object.keys(data).length > 0) {
				await tx.user.update({ where: { id }, data });
			}
			if (body.roleIds) {
				await tx.userRole.deleteMany({ where: { userId: id } });
				if (body.roleIds.length > 0) {
					await tx.userRole.createMany({
						data: body.roleIds.map((roleId) => ({ userId: id, roleId })),
					});
				}
			}
		});
	} catch (err) {
		// Translate the unique-constraint violation into a clean 409 instead of
		// bubbling up as a 500.
		if (isUniqueViolation(err)) {
			return c.json({ error: "Email or username already taken" }, 409);
		}
		throw err;
	}

	// Force re-login if roles or password changed — JWT carries cached
	// permissions, so bumping the version invalidates outstanding tokens.
	if (rolesChanged || passwordChanged) {
		await bumpTokenVersion(id);
	}

	return c.json({ success: true });
});

usersRoutes.delete("/:id", async (c) => {
	const id = c.req.param("id");
	const me = c.get("user");

	if (me.sub === id) {
		return c.json({ error: "Cannot delete your own account" }, 400);
	}

	// Non-super_admin callers can't delete a super_admin. Without this guard a
	// USER_MANAGE holder could wipe the only super_admin account and leave the
	// platform without a privileged operator.
	const callerIsSuperAdmin = me.roles.includes(ROLE_KEYS.SUPER_ADMIN);
	if (!callerIsSuperAdmin) {
		const targetRoles = await prisma.userRole.findMany({
			where: { userId: id },
			select: { role: { select: { key: true } } },
		});
		const targetIsSuperAdmin = targetRoles.some((ur) => ur.role.key === ROLE_KEYS.SUPER_ADMIN);
		if (targetIsSuperAdmin) {
			return c.json({ error: "Only a super_admin can delete a super_admin account" }, 403);
		}
	}

	try {
		await prisma.user.delete({ where: { id } });
		return c.json({ success: true });
	} catch (err) {
		if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
			return c.json({ error: "User not found" }, 404);
		}
		throw err;
	}
});
