import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { hash } from "bcrypt";
import { prisma } from "../db";
import { authMiddleware, requirePermission, type JWTPayload } from "../middleware/auth";
import { PERMISSIONS } from "../lib/permissions";

export const usersRoutes = new Hono<{ Variables: { user: JWTPayload } }>();

usersRoutes.use("*", authMiddleware, requirePermission(PERMISSIONS.USER_MANAGE));

const createUserSchema = z.object({
	email: z.string().email(),
	password: z.string().min(8),
	name: z.string().min(1),
	username: z
		.string()
		.min(3)
		.max(30)
		.regex(/^[a-z0-9-]+$/),
	roleIds: z.array(z.string().uuid()).default([]),
});

const updateUserSchema = z.object({
	email: z.string().email().optional(),
	name: z.string().min(1).optional(),
	username: z
		.string()
		.min(3)
		.max(30)
		.regex(/^[a-z0-9-]+$/)
		.optional(),
	password: z.string().min(8).optional(),
	roleIds: z.array(z.string().uuid()).optional(),
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
	const id = c.req.param("id");
	const body = c.req.valid("json");

	const existing = await prisma.user.findUnique({ where: { id } });
	if (!existing) return c.json({ error: "User not found" }, 404);

	const data: Record<string, unknown> = {};
	if (body.email) data.email = body.email;
	if (body.name) data.name = body.name;
	if (body.username) data.username = body.username;
	if (body.password) {
		data.passwordHash = await hash(body.password, 10);
		data.mustChangePassword = true;
	}

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

	return c.json({ success: true });
});

usersRoutes.delete("/:id", async (c) => {
	const id = c.req.param("id");
	const me = c.get("user");

	if (me.sub === id) {
		return c.json({ error: "Cannot delete your own account" }, 400);
	}

	try {
		await prisma.user.delete({ where: { id } });
		return c.json({ success: true });
	} catch {
		return c.json({ error: "User not found" }, 404);
	}
});
