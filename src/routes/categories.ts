import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../db";
import { authMiddleware, requireAnyPermission } from "../middleware/auth";
import { PERMISSIONS } from "../lib/permissions";
import { ipRateLimit } from "../middleware/rate-limit";

const readLimit = ipRateLimit({ keyPrefix: "categories-read", limit: 60, windowSeconds: 60 });

export const categoriesRoutes = new Hono();

function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.trim();
}

const categorySchema = z.object({
	name: z.string().min(1).max(100),
	description: z.string().optional(),
});

// Public: list all categories (includes postCount)
categoriesRoutes.get("/", readLimit, async (c) => {
	c.header("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
	const categories = await prisma.category.findMany({
		orderBy: { name: "asc" },
		include: { _count: { select: { posts: true } } },
	});
	return c.json(categories.map((c) => ({ ...c, postCount: c._count.posts, _count: undefined })));
});

// Public: get single category by id
categoriesRoutes.get("/:id", async (c) => {
	const category = await prisma.category.findUnique({
		where: { id: c.req.param("id") },
	});
	if (!category) return c.json({ error: "Category not found" }, 404);
	return c.json(category);
});

// [auth] Create category — requires role:manage or post:write:any
categoriesRoutes.post(
	"/",
	authMiddleware,
	requireAnyPermission(PERMISSIONS.ROLE_MANAGE, PERMISSIONS.POST_WRITE_ANY),
	zValidator("json", categorySchema),
	async (c) => {
		const { name, description } = c.req.valid("json");
		const slug = slugify(name);

		const existing = await prisma.category.findFirst({
			where: { OR: [{ name }, { slug }] },
		});
		if (existing) return c.json({ error: "Category name already exists" }, 409);

		const category = await prisma.category.create({
			data: { name, slug, description },
		});
		return c.json(category, 201);
	},
);

// [auth] Update category
categoriesRoutes.patch(
	"/:id",
	authMiddleware,
	requireAnyPermission(PERMISSIONS.ROLE_MANAGE, PERMISSIONS.POST_WRITE_ANY),
	zValidator("json", categorySchema.partial()),
	async (c) => {
		const id = c.req.param("id");
		const body = c.req.valid("json");

		const existing = await prisma.category.findUnique({ where: { id } });
		if (!existing) return c.json({ error: "Category not found" }, 404);

		const data: { name?: string; slug?: string; description?: string } = {};
		if (body.name) {
			data.name = body.name;
			data.slug = slugify(body.name);
		}
		if (body.description !== undefined) data.description = body.description;

		const updated = await prisma.category.update({ where: { id }, data });
		return c.json(updated);
	},
);

// [auth] Delete category — blocked if any posts are still assigned
categoriesRoutes.delete(
	"/:id",
	authMiddleware,
	requireAnyPermission(PERMISSIONS.ROLE_MANAGE, PERMISSIONS.POST_WRITE_ANY),
	async (c) => {
		const id = c.req.param("id");
		const existing = await prisma.category.findUnique({
			where: { id },
			include: { _count: { select: { posts: true } } },
		});
		if (!existing) return c.json({ error: "Category not found" }, 404);

		if (existing._count.posts > 0) {
			return c.json(
				{
					error: `Cannot delete: ${existing._count.posts} post(s) are still assigned to this category.`,
				},
				409,
			);
		}

		await prisma.category.delete({ where: { id } });
		return c.json({ success: true });
	},
);
