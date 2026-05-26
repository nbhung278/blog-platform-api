import { Hono } from "hono";
import { prisma } from "../db";
import { env } from "../lib/env";
import { cachedOrBuild } from "../lib/cache-lock";

export const sitemapRoutes = new Hono();

const CACHE_KEY = "sitemap:xml";
const CACHE_TTL = 3600; // 1 hour

const APP_URL = env.APP_URL.replace(/\/$/, "");

function buildSitemap(
	posts: { slug: string; updatedAt: Date; user: { username: string } }[],
	categories: { name: string }[],
	authors: { username: string; latestPostAt: Date | null }[],
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
		// Evergreen marketing/legal pages. No `lastmod` — they only change when
		// we edit the source, which is rare and not signalled to a crawler by
		// post activity. Low priority so they don't crowd out content URLs.
		{ loc: `${APP_URL}/about`, changefreq: "yearly", priority: "0.3" },
		{ loc: `${APP_URL}/contact`, changefreq: "yearly", priority: "0.3" },
		{ loc: `${APP_URL}/privacy`, changefreq: "yearly", priority: "0.3" },
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

	// Author profile pages. Only authors who have at least one *published*
	// post — otherwise the page would be empty and Google would re-mark it as
	// soft-404. `lastmod` reflects their newest post so re-crawls trigger when
	// they publish.
	const authorUrls: Entry[] = authors.map((a) => ({
		loc: `${APP_URL}/author/${a.username}`,
		lastmod: a.latestPostAt?.toISOString().split("T")[0],
		changefreq: "weekly",
		priority: "0.5",
	}));

	const allUrls = [...staticUrls, ...categoryUrls, ...authorUrls, ...postUrls];

	const urlEntries = allUrls
		.map((u) => {
			const lastmod = u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : "";
			return `  <url>\n    <loc>${u.loc}</loc>${lastmod}\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`;
		})
		.join("\n");

	return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlEntries}\n</urlset>`;
}

sitemapRoutes.get("/", async (c) => {
	const xml = await cachedOrBuild({
		cacheKey: CACHE_KEY,
		cacheTtlSeconds: CACHE_TTL,
		build: async () => {
			const [posts, categories, authorRows] = await Promise.all([
				prisma.post.findMany({
					where: { status: "published" },
					select: { slug: true, updatedAt: true, user: { select: { username: true } } },
					orderBy: { updatedAt: "desc" },
				}),
				prisma.category.findMany({
					select: { name: true },
					orderBy: { name: "asc" },
				}),
				// One row per author who has ≥1 published post, with the publish
				// time of their newest post for `lastmod`. groupBy keeps this a
				// single query — important because the sitemap rebuilds hourly
				// and is also fetched directly by Googlebot via the worker proxy.
				prisma.post.groupBy({
					by: ["userId"],
					where: { status: "published" },
					_max: { publishedAt: true },
				}),
			]);

			// groupBy returns userIds; we need usernames. Single follow-up
			// findMany keyed by the ids we just saw.
			const authorIds = authorRows.map((r) => r.userId);
			const users =
				authorIds.length > 0
					? await prisma.user.findMany({
							where: { id: { in: authorIds } },
							select: { id: true, username: true },
						})
					: [];
			const usernameById = new Map(users.map((u) => [u.id, u.username]));
			const authors = authorRows
				.map((r) => ({
					username: usernameById.get(r.userId) ?? null,
					latestPostAt: r._max.publishedAt,
				}))
				.filter((a): a is { username: string; latestPostAt: Date | null } => !!a.username)
				.sort((a, b) => a.username.localeCompare(b.username));

			return buildSitemap(posts, categories, authors);
		},
	});
	return c.text(xml, 200, { "Content-Type": "application/xml" });
});
