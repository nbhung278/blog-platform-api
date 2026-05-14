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

// Target length for auto-generated meta descriptions. Google truncates around
// 155–160 chars on desktop, less on mobile, so we aim slightly below that.
const DESC_TARGET_LEN = 155;

// Strip the most common Markdown structural noise so a meta description built
// from contentMd reads as plain prose. Intentionally surgical — fully parsing
// Markdown to plain text would pull in a parser; this regex sweep is enough
// for descriptions, where some residual punctuation is harmless.
function stripMarkdown(md: string): string {
	return (
		md
			// Fenced/inline code: drop the backticks (and language hint on fences).
			.replace(/```[\w-]*\n[\s\S]*?```/g, " ")
			.replace(/`([^`]+)`/g, "$1")
			// Images: drop entirely (alt text is rarely useful prose).
			.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
			// Links: keep the link text, drop the URL.
			.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
			// Headings / blockquotes / list markers at line start.
			.replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
			// Emphasis markers.
			.replace(/(\*\*|__|\*|_|~~)/g, "")
			// HTML tags (rare in our content but possible).
			.replace(/<[^>]+>/g, " ")
			// Collapse whitespace.
			.replace(/\s+/g, " ")
			.trim()
	);
}

// Below this length an author-supplied excerpt is treated as "just the title
// restated" rather than a useful description, and we prefer body content for
// SEO. Authors who write a real excerpt (≥80 chars) keep authority over the
// meta description. 80 was chosen from observing the spread of existing
// excerpts: most useful summaries clear 100 chars; placeholder ones don't.
const MIN_USEFUL_EXCERPT_LEN = 80;

function buildDescription(post: {
	metaDesc: string | null;
	excerpt: string | null;
	contentMd: string;
	title: string;
	user: { username: string };
}): string {
	// Priority:
	//   1. metaDesc (explicit SEO field, trusted at any length)
	//   2. excerpt — but only if long enough to be useful
	//   3. first ~155 chars of body, with markdown stripped
	//   4. generic byline so we always emit *something*
	const metaDesc = post.metaDesc?.trim();
	if (metaDesc) return metaDesc;

	const excerpt = post.excerpt?.trim();
	if (excerpt && excerpt.length >= MIN_USEFUL_EXCERPT_LEN) return excerpt;

	const plain = stripMarkdown(post.contentMd);
	if (plain.length >= 40) {
		if (plain.length <= DESC_TARGET_LEN) return plain;
		// Cut at the last word boundary before the target length to avoid
		// truncating mid-word, and append an ellipsis.
		const slice = plain.slice(0, DESC_TARGET_LEN);
		const lastSpace = slice.lastIndexOf(" ");
		const trimmed = lastSpace > 60 ? slice.slice(0, lastSpace) : slice;
		return `${trimmed.replace(/[.,;:!?-]+$/, "")}…`;
	}

	// Short excerpt + no usable body: fall back to the (short) excerpt rather
	// than the generic byline. A 31-char real summary still beats "Read X by @y".
	if (excerpt) return excerpt;

	return `Read "${post.title}" by @${post.user.username} on Strix.`;
}

function renderShareHtml(opts: {
	title: string;
	description: string;
	url: string;
	image: string | null;
	authorName: string;
	authorUsername: string;
	publishedAt: Date | null;
	updatedAt: Date | null;
	// When true, omit the <meta refresh> + JS redirect. Used when the worker
	// proxies this HTML in response to a bot UA — the bot is already on the
	// canonical URL, so a redirect loops back to itself and Facebook bails on
	// the unfurl instead of parsing OG tags.
	skipRedirect?: boolean;
}): string {
	const {
		title,
		description,
		url,
		image,
		authorName,
		authorUsername,
		publishedAt,
		updatedAt,
		skipRedirect,
	} = opts;
	const safeTitle = escapeAttr(title);
	const safeDesc = escapeAttr(description);
	const safeUrl = escapeAttr(url);

	// Image meta: og:image + alt. Twitter uses `twitter:image:src` (not
	// `twitter:image`) — older convention but the only one Facebook's parser
	// reliably honours when both blocks coexist.
	const ogImageTag = image
		? `<meta property="og:image" content="${escapeAttr(image)}" />
	<meta property="og:image:alt" content="${escapeAttr(title)}" />`
		: "";
	const twitterImageTag = image
		? `<meta name="twitter:image:src" content="${escapeAttr(image)}" />`
		: "";
	const twitterCard = image ? "summary_large_image" : "summary";

	const publishedIso = publishedAt?.toISOString() ?? null;
	const modifiedIso = updatedAt?.toISOString() ?? null;
	const articleTags = [
		`<meta property="article:author" content="${escapeAttr(authorName)}" />`,
		publishedIso
			? `<meta property="article:published_time" content="${escapeAttr(publishedIso)}" />`
			: "",
		modifiedIso
			? `<meta property="article:modified_time" content="${escapeAttr(modifiedIso)}" />`
			: "",
		`<meta name="author" content="${escapeAttr(authorName)}" />`,
	]
		.filter(Boolean)
		.join("\n\t");

	// JSON-LD BlogPosting — what powers the author + date row that Google
	// shows under SERP results. Build the object then JSON.stringify so we
	// don't have to escape values manually.
	const jsonLd: Record<string, unknown> = {
		"@context": "https://schema.org",
		"@type": "BlogPosting",
		headline: title,
		description,
		mainEntityOfPage: { "@type": "WebPage", "@id": url },
		url,
		author: {
			"@type": "Person",
			name: authorName,
			url: `${env.APP_URL}/author/${authorUsername}`,
		},
		publisher: {
			"@type": "Organization",
			name: "Strix",
			logo: {
				"@type": "ImageObject",
				url: `${env.APP_URL}/favicon.svg`,
			},
		},
	};
	if (image) jsonLd.image = image;
	if (publishedIso) jsonLd.datePublished = publishedIso;
	if (modifiedIso) jsonLd.dateModified = modifiedIso;
	// Embed via a <script> with type=application/ld+json. We escape `</` to
	// prevent a closing tag inside any string field from breaking out of the
	// script block. (`<` alone is safe inside JSON strings.)
	const ldJsonHtml = JSON.stringify(jsonLd).replace(/<\//g, "<\\/");

	// `0;url=...` makes the browser navigate immediately. The inline script is a
	// belt-and-suspenders fallback for the rare browser that ignores meta refresh.
	// The visible body content is just for users with JS disabled.
	//
	// When skipRedirect is true (worker-proxied bot request), we omit both —
	// the bot is on the canonical URL already, so any redirect just loops.
	const redirectTags = skipRedirect
		? ""
		: `<meta http-equiv="refresh" content="0;url=${safeUrl}" />
	<script>window.location.replace(${JSON.stringify(url)});</script>`;
	const redirectBody = skipRedirect
		? ""
		: `<p>Redirecting to <a href="${safeUrl}">${safeTitle}</a>…</p>`;

	// Meta order: core OG → article → twitter → canonical → JSON-LD.
	//
	// Known FB debugger quirk we deliberately accept:
	//   When `article:published_time` / `article:modified_time` are present,
	//   the FB debugger renders the following `twitter:*` tags as
	//   `og:temporal:twitter:*` in its "Open Graph properties" table.
	//   Despite that, the live unfurl on Facebook itself works correctly —
	//   image, title, description all render. We keep `article:*` because:
	//     - Google reads it for the SERP author/date row
	//     - LinkedIn and Slack honour it for "published on" labels
	//     - JSON-LD below is a parallel signal (Google primary), but several
	//       smaller crawlers only read meta, not LD.
	//   So the trade is: noisy FB debugger vs. correct rich previews elsewhere.
	//   Don't try to "fix" this by removing `article:*` — it just loses signal
	//   for the platforms that read it correctly.
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>${safeTitle}</title>
	<meta name="description" content="${safeDesc}" />

	<meta property="og:type" content="article" />
	<meta property="og:url" content="${safeUrl}" />
	<meta property="og:title" content="${safeTitle}" />
	${ogImageTag}
	<meta property="og:description" content="${safeDesc}" />
	<meta property="og:site_name" content="Strix" />

	${articleTags}

	<meta name="twitter:card" content="${twitterCard}" />
	<meta name="twitter:title" content="${safeTitle}" />
	<meta name="twitter:description" content="${safeDesc}" />
	${twitterImageTag}

	<link rel="canonical" href="${safeUrl}" />
	${redirectTags}
	<script type="application/ld+json">${ldJsonHtml}</script>
</head>
<body>
	${redirectBody}
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
				metaDesc: true,
				contentMd: true,
				coverUrl: true,
				slug: true,
				publishedAt: true,
				updatedAt: true,
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

		const description = buildDescription(post);

		// ?bot=1 is set by the Cloudflare Worker when proxying for a crawler:
		// the request is on the canonical URL, so a redirect would loop and
		// some scrapers (Facebook in particular) bail on the unfurl rather than
		// parsing the OG tags. Strip the redirect for those requests.
		const skipRedirect = c.req.query("bot") === "1";

		const html = renderShareHtml({
			title: post.title,
			description,
			url: canonical,
			image: post.coverUrl,
			authorName: post.user.name ?? post.user.username,
			authorUsername: post.user.username,
			publishedAt: post.publishedAt,
			updatedAt: post.updatedAt,
			skipRedirect,
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
