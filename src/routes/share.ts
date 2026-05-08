import { Hono } from "hono";
import { prisma } from "../db";
import { env } from "../lib/env";
import { ipRateLimit } from "../middleware/rate-limit";

export const shareRoutes = new Hono();

// Why this route exists:
//
// Social crawlers (facebookexternalhit, Twitterbot, LinkedInBot, Slackbot,
// Discordbot, WhatsApp, Telegram) fetch a URL with a plain HTTP GET and read
// only the static HTML response. Our public blog is a Vite SPA: the static
// HTML is an empty shell, so post-specific OG tags set in `useEffect` are
// invisible to crawlers and shared links unfurl as a blank card.
//
// This route returns a tiny HTML page with the right meta tags for the post,
// plus a meta-refresh + JS redirect so any human who lands on it is bounced
// to the actual SPA page. The frontend's ShareModal points share URLs at this
// route instead of the canonical SPA URL.

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
	return escapeHtml(s);
}

function renderShareHtml(opts: {
	title: string;
	description: string;
	url: string;
	image: string | null;
	authorName: string;
}): string {
	const { title, description, url, image, authorName } = opts;
	const safeTitle = escapeAttr(title);
	const safeDesc = escapeAttr(description);
	const safeUrl = escapeAttr(url);
	const safeAuthor = escapeAttr(authorName);
	const imageTags = image
		? `<meta property="og:image" content="${escapeAttr(image)}" />
		<meta name="twitter:image" content="${escapeAttr(image)}" />
		<meta name="twitter:card" content="summary_large_image" />`
		: `<meta name="twitter:card" content="summary" />`;

	// `0;url=...` makes the browser navigate immediately. The inline script is a
	// belt-and-suspenders fallback for the rare browser that ignores meta refresh.
	// The visible body content is just for users with JS disabled.
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>${safeTitle}</title>
	<meta name="description" content="${safeDesc}" />
	<meta property="og:type" content="article" />
	<meta property="og:title" content="${safeTitle}" />
	<meta property="og:description" content="${safeDesc}" />
	<meta property="og:url" content="${safeUrl}" />
	<meta property="article:author" content="${safeAuthor}" />
	<meta name="twitter:title" content="${safeTitle}" />
	<meta name="twitter:description" content="${safeDesc}" />
	${imageTags}
	<link rel="canonical" href="${safeUrl}" />
	<meta http-equiv="refresh" content="0;url=${safeUrl}" />
	<script>window.location.replace(${JSON.stringify(url)});</script>
</head>
<body>
	<p>Redirecting to <a href="${safeUrl}">${safeTitle}</a>…</p>
</body>
</html>`;
}

shareRoutes.get(
	"/:username/:slug",
	ipRateLimit({ keyPrefix: "share-preview", limit: 120, windowSeconds: 60 }),
	async (c) => {
		const username = c.req.param("username");
		const slug = c.req.param("slug");

		const post = await prisma.post.findFirst({
			where: { slug, status: "published", deletedAt: null, user: { username } },
			select: {
				title: true,
				excerpt: true,
				coverUrl: true,
				slug: true,
				user: { select: { name: true, username: true } },
			},
		});

		// Even on miss we send HTML, not JSON — crawlers handle missing OG tags
		// gracefully but a JSON 404 would look broken to a human who somehow
		// reached this URL. The redirect still bounces them to the SPA's own
		// not-found handling.
		const canonical = `${env.APP_URL}/blog/${username}/${slug}`;

		if (!post) {
			// Don't cache 404s — a freshly published post would otherwise look
			// missing to crawlers for up to a minute after publish.
			c.header("Content-Type", "text/html; charset=utf-8");
			c.header("Cache-Control", "no-store");
			return c.body(
				`<!doctype html><html><head>
					<meta http-equiv="refresh" content="0;url=${escapeAttr(canonical)}" />
					<script>window.location.replace(${JSON.stringify(canonical)});</script>
				</head><body></body></html>`,
				404,
			);
		}

		const description = post.excerpt ?? `Read "${post.title}" by @${post.user.username} on Strix.`;

		const html = renderShareHtml({
			title: post.title,
			description,
			url: canonical,
			image: post.coverUrl,
			authorName: post.user.name ?? post.user.username,
		});

		c.header("Content-Type", "text/html; charset=utf-8");
		c.header("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
		// Override the global X-Frame-Options:DENY for this route only — some
		// preview crawlers fetch in iframes; it's a static redirect page so the
		// clickjacking concern doesn't apply.
		c.header("X-Frame-Options", "SAMEORIGIN");
		return c.body(html);
	},
);
