import { env } from "./env";
import { logger } from "./logger";

// IndexNow submission. Why this exists:
//
// Google's natural crawl cycle on a low-authority blog runs 3-14 days between
// publish and SERP appearance. IndexNow is an open protocol (Bing, Yandex,
// Seznam, Naver) that accepts a push notification per URL and crawls within
// hours instead. Google does not implement IndexNow directly — but the
// Bing/IndexNow ecosystem feeds several smaller engines and a couple of
// Google features (Bing Webmaster sometimes mirrors hints to Google's
// discovery pipeline), so the cost is near zero and the upside is real.
//
// Endpoint choice:
//   `api.indexnow.org` is the shared entry point — it fans the submission out
//   to all participating engines. Submitting directly to bing/yandex would
//   require N requests and we'd lose Seznam/Naver coverage.
//
// Failure mode:
//   This is fire-and-forget. Publish must NEVER fail because IndexNow had a
//   bad day. We catch everything, log, and return — the caller never awaits a
//   meaningful value. If submission drops, the URL still gets crawled
//   eventually via sitemap.
//
// Quotas:
//   IndexNow allows up to 10,000 URLs per request and has no documented daily
//   cap, but recommends throttling. Our publish rate is well below any cap we
//   could practically hit, so no rate limiting needed here.

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

// 3s timeout: long enough that a slow CDN handshake doesn't drop legit
// submissions, short enough that a totally dead endpoint doesn't pile up
// pending POSTs on the event loop during a publish burst.
const SUBMIT_TIMEOUT_MS = 3000;

function host(): string {
	// IndexNow requires the `host` field to match the URL host of the submitted
	// URLs (and the host serving the key file). Derive from APP_URL so a
	// staging deploy at a different host doesn't accidentally tell IndexNow
	// "I own strix-blog.uk".
	try {
		return new URL(env.APP_URL).host;
	} catch {
		return "";
	}
}

export function getIndexNowKey(): string | null {
	return env.INDEXNOW_KEY ?? null;
}

// Submit one or more URLs to IndexNow. Returns immediately; the actual HTTP
// call runs in the background. Pass a single URL or an array.
export function submitToIndexNow(urlOrUrls: string | string[]): void {
	const key = env.INDEXNOW_KEY;
	if (!key) return; // No key configured → quietly no-op.

	const urlList = Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls];
	if (urlList.length === 0) return;

	const h = host();
	if (!h) {
		logger.warn("[indexnow] APP_URL has no host, skipping submission");
		return;
	}

	// Sanity check: every URL must be on the same host as APP_URL. IndexNow
	// rejects mixed-host batches with 422 and the spec is explicit about it.
	// If any URL fails this check, drop only that URL — don't punish the rest.
	const sameHost = urlList.filter((u) => {
		try {
			return new URL(u).host === h;
		} catch {
			return false;
		}
	});
	if (sameHost.length === 0) {
		logger.warn({ urlList }, "[indexnow] no urls match APP_URL host, skipping");
		return;
	}

	// Fire-and-forget. We deliberately don't return the promise — callers must
	// not be blocked by network latency to indexnow.org.
	void postWithTimeout(sameHost, h, key);
}

async function postWithTimeout(urlList: string[], h: string, key: string): Promise<void> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);
	try {
		const res = await fetch(INDEXNOW_ENDPOINT, {
			method: "POST",
			headers: { "content-type": "application/json; charset=utf-8" },
			body: JSON.stringify({
				host: h,
				key,
				// `keyLocation` is required when the key file lives at a non-default
				// path. We host it at the document root (/<key>.txt), which is the
				// default the spec allows omitting — but we include it explicitly
				// so the contract is self-describing.
				keyLocation: `https://${h}/${key}.txt`,
				urlList,
			}),
			signal: controller.signal,
		});
		// 200 / 202 = accepted. 400 = bad request (likely key mismatch).
		// 403 = key file doesn't match. 422 = mixed-host. 429 = throttled.
		// Anything else: log and forget; the URL is still in sitemap.
		if (res.status >= 400) {
			const body = await res.text().catch(() => "");
			logger.warn(
				{ status: res.status, body, urlCount: urlList.length },
				"[indexnow] non-2xx response",
			);
		} else {
			logger.info({ status: res.status, urlCount: urlList.length }, "[indexnow] submitted");
		}
	} catch (err) {
		logger.warn({ err, urlCount: urlList.length }, "[indexnow] submission failed");
	} finally {
		clearTimeout(timer);
	}
}
