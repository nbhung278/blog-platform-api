import { Hono } from "hono";
import { prisma } from "../db";
import { redis } from "../lib/redis";
import { env } from "../lib/env";

export const feedRoutes = new Hono();

// Atom + RSS feeds for blog readers. Cached in Redis like the sitemap so the
// public endpoint is cheap; CACHE_TTL is long because we also bake fresh
// copies into the SPA bucket at deploy time (see scripts/deploy-frontend.sh).
const ATOM_CACHE_KEY = "feed:atom";
const RSS_CACHE_KEY = "feed:rss";
const CACHE_TTL = 600; // 10 minutes
const FEED_POST_LIMIT = 30;

const APP_URL = env.APP_URL.replace(/\/$/, "");

function escapeXml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

// Wrap content in <![CDATA[...]]> for HTML-ish payloads (post bodies). The
// only character we have to defend against is the literal "]]>" sequence,
// which we split with a `]]><![CDATA[` joiner.
function cdata(s: string): string {
	return `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

type FeedPost = {
	title: string;
	slug: string;
	excerpt: string | null;
	contentHtml: string;
	publishedAt: Date | null;
	updatedAt: Date;
	user: { username: string; name: string | null };
};

async function loadFeedPosts(): Promise<FeedPost[]> {
	return prisma.post.findMany({
		where: { status: "published", deletedAt: null },
		orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }],
		take: FEED_POST_LIMIT,
		select: {
			title: true,
			slug: true,
			excerpt: true,
			contentHtml: true,
			publishedAt: true,
			updatedAt: true,
			user: { select: { username: true, name: true } },
		},
	});
}

function postUrl(p: FeedPost): string {
	return `${APP_URL}/blog/${p.user.username}/${p.slug}`;
}

function buildAtom(posts: FeedPost[]): string {
	// `updated` at the feed level should be the newest entry's timestamp.
	// Atom requires a stable feed `id` URN — we use the site URL.
	const feedUpdated = posts[0]?.updatedAt.toISOString() ?? new Date().toISOString();

	const entries = posts
		.map((p) => {
			const url = postUrl(p);
			const published = (p.publishedAt ?? p.updatedAt).toISOString();
			const updated = p.updatedAt.toISOString();
			const author = p.user.name ?? p.user.username;
			const summary = p.excerpt ?? "";

			return `  <entry>
    <id>${escapeXml(url)}</id>
    <title>${escapeXml(p.title)}</title>
    <link rel="alternate" type="text/html" href="${escapeXml(url)}" />
    <published>${published}</published>
    <updated>${updated}</updated>
    <author>
      <name>${escapeXml(author)}</name>
      <uri>${escapeXml(`${APP_URL}/author/${p.user.username}`)}</uri>
    </author>${summary ? `\n    <summary>${escapeXml(summary)}</summary>` : ""}
    <content type="html">${cdata(p.contentHtml)}</content>
  </entry>`;
		})
		.join("\n");

	return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${escapeXml(APP_URL)}/</id>
  <title>Strix — Code as Craft</title>
  <subtitle>A blog about software engineering, code craftsmanship, and the art of building great products.</subtitle>
  <link rel="self" type="application/atom+xml" href="${escapeXml(APP_URL)}/feed.atom" />
  <link rel="alternate" type="text/html" href="${escapeXml(APP_URL)}/" />
  <updated>${feedUpdated}</updated>
  <author>
    <name>Strix</name>
  </author>
${entries}
</feed>`;
}

function buildRss(posts: FeedPost[]): string {
	// RSS 2.0 needs RFC-822 dates ("Tue, 13 May 2025 13:25:00 GMT"). Date.toUTCString()
	// emits exactly that format.
	const pubDate = (posts[0]?.updatedAt ?? new Date()).toUTCString();

	const items = posts
		.map((p) => {
			const url = postUrl(p);
			const published = (p.publishedAt ?? p.updatedAt).toUTCString();
			const author = p.user.name ?? p.user.username;
			const description = p.excerpt ?? "";

			return `    <item>
      <title>${escapeXml(p.title)}</title>
      <link>${escapeXml(url)}</link>
      <guid isPermaLink="true">${escapeXml(url)}</guid>
      <pubDate>${published}</pubDate>
      <dc:creator>${escapeXml(author)}</dc:creator>${description ? `\n      <description>${escapeXml(description)}</description>` : ""}
      <content:encoded>${cdata(p.contentHtml)}</content:encoded>
    </item>`;
		})
		.join("\n");

	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:atom="http://www.w3.org/2005/Atom"
     xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Strix — Code as Craft</title>
    <link>${escapeXml(APP_URL)}/</link>
    <atom:link href="${escapeXml(APP_URL)}/feed.xml" rel="self" type="application/rss+xml" />
    <description>A blog about software engineering, code craftsmanship, and the art of building great products.</description>
    <language>en</language>
    <lastBuildDate>${pubDate}</lastBuildDate>
${items}
  </channel>
</rss>`;
}

feedRoutes.get("/feed.atom", async (c) => {
	const cached = await redis.get(ATOM_CACHE_KEY);
	if (cached) {
		return c.text(cached, 200, { "Content-Type": "application/atom+xml; charset=utf-8" });
	}
	const xml = buildAtom(await loadFeedPosts());
	await redis.set(ATOM_CACHE_KEY, xml, "EX", CACHE_TTL);
	return c.text(xml, 200, { "Content-Type": "application/atom+xml; charset=utf-8" });
});

feedRoutes.get("/feed.xml", async (c) => {
	const cached = await redis.get(RSS_CACHE_KEY);
	if (cached) {
		return c.text(cached, 200, { "Content-Type": "application/rss+xml; charset=utf-8" });
	}
	const xml = buildRss(await loadFeedPosts());
	await redis.set(RSS_CACHE_KEY, xml, "EX", CACHE_TTL);
	return c.text(xml, 200, { "Content-Type": "application/rss+xml; charset=utf-8" });
});
