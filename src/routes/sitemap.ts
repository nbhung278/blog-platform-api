import { Hono } from "hono";
import { prisma } from "../db";
import { redis } from "../lib/redis";
import { env } from "../lib/env";

export const sitemapRoutes = new Hono();

const CACHE_KEY = "sitemap:xml";
const CACHE_TTL = 3600; // 1 hour

const APP_URL = env.APP_URL.replace(/\/$/, "");

function buildSitemap(
	posts: { slug: string; updatedAt: Date; user: { username: string } }[],
	categories: { name: string }[],
): string {
	// `/search` is excluded: it's a query-driven page with no canonical content,
	// so listing it just wastes crawl budget without ever ranking. Same reason
	// we omit `/login`, `/register`, etc. (they're already in robots.txt
	// Disallow). The homepage `lastmod` mirrors the newest post so crawlers
	// re-fetch when content actually changes.
	const newestPostLastmod = posts[0]?.updatedAt.toISOString().split("T")[0];

	type Entry = { loc: string; lastmod?: string; changefreq: string; priority: string };

	const staticUrls: Entry[] = [
		{
			loc: APP_URL,
			lastmod: newestPostLastmod,
			changefreq: "daily",
			priority: "1.0",
		},
	];

	const categoryUrls: Entry[] = categories.map((c) => ({
		loc: `${APP_URL}/category/${encodeURIComponent(c.name)}`,
		lastmod: newestPostLastmod,
		changefreq: "weekly",
		priority: "0.6",
	}));

	const postUrls: Entry[] = posts.map((p) => ({
		loc: `${APP_URL}/blog/${p.user.username}/${p.slug}`,
		lastmod: p.updatedAt.toISOString().split("T")[0],
		changefreq: "weekly",
		priority: "0.8",
	}));

	const allUrls = [...staticUrls, ...categoryUrls, ...postUrls];

	const urlEntries = allUrls
		.map((u) => {
			const lastmod = u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : "";
			return `  <url>\n    <loc>${u.loc}</loc>${lastmod}\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`;
		})
		.join("\n");

	return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlEntries}\n</urlset>`;
}

sitemapRoutes.get("/", async (c) => {
	const cached = await redis.get(CACHE_KEY);
	if (cached) {
		return c.text(cached, 200, { "Content-Type": "application/xml" });
	}

	const [posts, categories] = await Promise.all([
		prisma.post.findMany({
			where: { status: "published", deletedAt: null },
			select: { slug: true, updatedAt: true, user: { select: { username: true } } },
			orderBy: { updatedAt: "desc" },
		}),
		prisma.category.findMany({
			select: { name: true },
			orderBy: { name: "asc" },
		}),
	]);

	const xml = buildSitemap(posts, categories);
	await redis.set(CACHE_KEY, xml, "EX", CACHE_TTL);

	return c.text(xml, 200, { "Content-Type": "application/xml" });
});
