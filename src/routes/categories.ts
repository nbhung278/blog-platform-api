import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../db";
import { authMiddleware, requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../lib/permissions";
import { ipRateLimit } from "../middleware/rate-limit";
import { isUniqueViolation } from "../lib/prisma-errors";

const readLimit = ipRateLimit({ keyPrefix: "categories-read", limit: 60, windowSeconds: 60 });

export const categoriesRoutes = new Hono();

// Category slugs are stable — `Tech News` always becomes `tech-news`, no
// timestamp suffix. The DB enforces uniqueness on (name) and (slug) so a
// rename collision surfaces as P2002 in the create/update handler.
// Post slugs use slugifyPostTitle in posts.ts which adds a timestamp.
function slugifyCategoryName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.trim();
}

const categorySchema = z.object({
	name: z.string().min(1).max(100),
	description: z.string().max(500).optional(),
});

// Public: list all categories (includes postCount)
categoriesRoutes.get("/", readLimit, async (c) => {
	c.header("Cache-Control", "public, s-maxage=300, stale-while-revalidate=60");
	const categories = await prisma.category.findMany({
		orderBy: { name: "asc" },
		include: { _count: { select: { posts: true } } },
	});
	return c.json(categories.map((c) => ({ ...c, postCount: c._count.posts, _count: undefined })));
});

// Public: get single category by id
categoriesRoutes.get("/:id", readLimit, async (c) => {
	const category = await prisma.category.findUnique({
		where: { id: c.req.param("id") },
	});
	if (!category) return c.json({ error: "Category not found" }, 404);
	return c.json(category);
});

// [auth] Create category — requires category:manage
categoriesRoutes.post(
	"/",
	authMiddleware,
	requirePermission(PERMISSIONS.CATEGORY_MANAGE),
	zValidator("json", categorySchema),
	async (c) => {
		const { name, description } = c.req.valid("json");
		const slug = slugifyCategoryName(name);

		// Use the unique constraint as the source of truth: two concurrent
		// admins racing to create the same category would both pass a pre-check
		// findFirst, then one would still hit P2002 from the @unique on name +
		// slug. Skip the pre-check and let the catch path return 409 either way.
		try {
			const category = await prisma.category.create({
				data: { name, slug, description },
			});
			return c.json(category, 201);
		} catch (err) {
			if (isUniqueViolation(err)) {
				return c.json({ error: "Category name already exists" }, 409);
			}
			throw err;
		}
	},
);

// [auth] Update category
categoriesRoutes.patch(
	"/:id",
	authMiddleware,
	requirePermission(PERMISSIONS.CATEGORY_MANAGE),
	zValidator("json", categorySchema.partial()),
	async (c) => {
		const id = c.req.param("id");
		const body = c.req.valid("json");

		const existing = await prisma.category.findUnique({ where: { id } });
		if (!existing) return c.json({ error: "Category not found" }, 404);

		const data: { name?: string; slug?: string; description?: string } = {};
		if (body.name) {
			data.name = body.name;
			data.slug = slugifyCategoryName(body.name);
		}
		if (body.description !== undefined) data.description = body.description;

		try {
			const updated = await prisma.category.update({ where: { id }, data });
			return c.json(updated);
		} catch (err) {
			if (isUniqueViolation(err)) {
				return c.json({ error: "Category name already exists" }, 409);
			}
			throw err;
		}
	},
);

// [auth] Delete category — hard-deletes all posts in the category first
categoriesRoutes.delete(
	"/:id",
	authMiddleware,
	requirePermission(PERMISSIONS.CATEGORY_MANAGE),
	async (c) => {
		const id = c.req.param("id");
		const existing = await prisma.category.findUnique({ where: { id } });
		if (!existing) return c.json({ error: "Category not found" }, 404);

		await prisma.$transaction([
			prisma.post.deleteMany({
				where: { categories: { some: { categoryId: id } } },
			}),
			prisma.category.delete({ where: { id } }),
		]);

		return c.json({ success: true });
	},
);
