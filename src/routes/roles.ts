import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../db";
import { authMiddleware, requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../lib/permissions";
import { bumpTokenVersion } from "../lib/tokens";

export const rolesRoutes = new Hono();

rolesRoutes.use("*", authMiddleware, requirePermission(PERMISSIONS.ROLE_MANAGE));

const upsertRoleSchema = z.object({
	key: z
		.string()
		.min(2)
		.max(40)
		.regex(/^[a-z0-9_]+$/),
	name: z.string().min(1),
	description: z.string().nullable().optional(),
	permissionKeys: z.array(z.string()).default([]),
});

rolesRoutes.get("/", async (c) => {
	const roles = await prisma.role.findMany({
		orderBy: [{ isSystem: "desc" }, { createdAt: "asc" }],
		include: {
			permissions: { include: { permission: { select: { key: true } } } },
			_count: { select: { users: true } },
		},
	});
	return c.json(
		roles.map((r) => ({
			id: r.id,
			key: r.key,
			name: r.name,
			description: r.description,
			isSystem: r.isSystem,
			userCount: r._count.users,
			permissions: r.permissions.map((rp) => rp.permission.key),
		})),
	);
});

rolesRoutes.get("/permissions", async (c) => {
	const perms = await prisma.permission.findMany({ orderBy: { key: "asc" } });
	return c.json(perms);
});

rolesRoutes.post("/", zValidator("json", upsertRoleSchema), async (c) => {
	const body = c.req.valid("json");

	const exists = await prisma.role.findUnique({ where: { key: body.key } });
	if (exists) return c.json({ error: "Role key already exists" }, 400);

	const perms = await prisma.permission.findMany({
		where: { key: { in: body.permissionKeys } },
		select: { id: true },
	});

	const role = await prisma.role.create({
		data: {
			key: body.key,
			name: body.name,
			description: body.description ?? null,
			permissions: { create: perms.map((p) => ({ permissionId: p.id })) },
		},
		select: { id: true },
	});

	return c.json({ id: role.id }, 201);
});

rolesRoutes.patch("/:id", zValidator("json", upsertRoleSchema.partial()), async (c) => {
	const id = c.req.param("id");
	const body = c.req.valid("json");

	const existing = await prisma.role.findUnique({ where: { id } });
	if (!existing) return c.json({ error: "Role not found" }, 404);

	if (existing.isSystem && body.key && body.key !== existing.key) {
		return c.json({ error: "Cannot change key of a system role" }, 400);
	}

	await prisma.$transaction(async (tx) => {
		await tx.role.update({
			where: { id },
			data: {
				...(body.key && !existing.isSystem ? { key: body.key } : {}),
				...(body.name ? { name: body.name } : {}),
				...(body.description !== undefined ? { description: body.description } : {}),
			},
		});

		if (body.permissionKeys) {
			const perms = await tx.permission.findMany({
				where: { key: { in: body.permissionKeys } },
				select: { id: true },
			});
			await tx.rolePermission.deleteMany({ where: { roleId: id } });
			if (perms.length > 0) {
				await tx.rolePermission.createMany({
					data: perms.map((p) => ({ roleId: id, permissionId: p.id })),
				});
			}
		}
	});

	// Permission set of a role changed — bump tokens for every user holding it
	// so their cached permissions in JWT get refreshed on next request.
	if (body.permissionKeys) {
		const affected = await prisma.userRole.findMany({
			where: { roleId: id },
			select: { userId: true },
		});
		await Promise.all(affected.map((u) => bumpTokenVersion(u.userId)));
	}

	return c.json({ success: true });
});

rolesRoutes.delete("/:id", async (c) => {
	const id = c.req.param("id");
	const existing = await prisma.role.findUnique({ where: { id } });
	if (!existing) return c.json({ error: "Role not found" }, 404);
	if (existing.isSystem) return c.json({ error: "Cannot delete system role" }, 400);

	await prisma.role.delete({ where: { id } });
	return c.json({ success: true });
});
