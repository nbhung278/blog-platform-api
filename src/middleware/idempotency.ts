import { createMiddleware } from "hono/factory";
import { createHash } from "node:crypto";
import { redis } from "../lib/redis";

type Options = {
	keyPrefix: string;
	ttlSeconds?: number;
};

const DEFAULT_TTL = 60 * 60 * 24; // 24h matches Stripe's idempotency window
const MAX_RESPONSE_BYTES = 64 * 1024; // 64KB — comments/posts/claps responses are well under this

type CachedResponse = {
	status: number;
	body: string;
};

// Lua: claim a key only if no value exists yet. Returns:
//   "claimed"        — first caller; proceed
//   "in_progress"    — another request holds the lease; return 409
//   <cached JSON>    — a prior request already finished; replay it
//
// Doing the "create-or-read" in Lua means two concurrent requests with the
// same Idempotency-Key can never both pass the "no entry yet" check.
const CLAIM_LUA = `
local existing = redis.call('GET', KEYS[1])
if existing then
  return existing
end
redis.call('SET', KEYS[1], '__pending__', 'EX', ARGV[1])
return 'claimed'
`;

// Returns "claimed" | "in_progress" | a serialized CachedResponse string.
async function claim(key: string, ttl: number): Promise<string> {
	const raw = (await redis.eval(CLAIM_LUA, 1, key, String(ttl))) as string;
	if (raw === "claimed") return "claimed";
	if (raw === "__pending__") return "in_progress";
	return raw;
}

async function store(key: string, value: CachedResponse, ttl: number): Promise<void> {
	const serialized = JSON.stringify(value);
	if (serialized.length > MAX_RESPONSE_BYTES) {
		// Response too big to safely cache — drop the entry so a retry isn't
		// forced to wait 24h for the lease to expire.
		await redis.del(key);
		return;
	}
	await redis.set(key, serialized, "EX", ttl);
}

async function release(key: string): Promise<void> {
	// Used on error paths so a transient 5xx doesn't lock the key for 24h.
	await redis.del(key);
}

function hashBody(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// Hono middleware. Requires `authMiddleware` upstream so we can scope keys per
// user — otherwise two different users sending the same Idempotency-Key would
// collide.
//
// Usage:
//   route.post("/...", authMiddleware, idempotency({ keyPrefix: "comment-create" }), handler)
//
// Clients opt in by sending `Idempotency-Key: <opaque-string>`. When absent
// the middleware is a no-op — only safe-to-retry mutations need it, and we
// don't want to force every client to plumb the header through.
export function idempotency({ keyPrefix, ttlSeconds = DEFAULT_TTL }: Options) {
	return createMiddleware(async (c, next) => {
		const idemKey = c.req.header("idempotency-key");
		if (!idemKey) {
			await next();
			return;
		}
		if (idemKey.length < 8 || idemKey.length > 200) {
			return c.json({ error: "Invalid Idempotency-Key" }, 400);
		}

		const user = c.get("user") as { sub?: string } | undefined;
		if (!user?.sub) {
			// Without an identity, an attacker could replay another user's
			// successful response by guessing their Idempotency-Key. Hard-fail
			// rather than silently degrade to no-op.
			return c.json({ error: "Unauthorized" }, 401);
		}

		// Bind the cached response to the exact request body so a client can't
		// retry with the same key but different content and have us replay the
		// first response. POSTs are JSON; the body has been buffered by Hono
		// by the time validators run, so re-reading text() is cheap.
		let bodyHash = "";
		try {
			const text = await c.req.raw.clone().text();
			bodyHash = hashBody(text);
		} catch {
			bodyHash = "no-body";
		}

		const key = `idem:${keyPrefix}:${user.sub}:${idemKey}:${bodyHash}`;
		const state = await claim(key, ttlSeconds);

		if (state === "in_progress") {
			return c.json({ error: "Duplicate request in progress, retry shortly" }, 409);
		}

		if (state !== "claimed") {
			try {
				const cached = JSON.parse(state) as CachedResponse;
				c.header("Idempotent-Replayed", "true");
				return c.body(cached.body, cached.status as 200, {
					"Content-Type": "application/json; charset=UTF-8",
				});
			} catch {
				// Corrupt cache entry — drop and re-run.
				await release(key);
			}
		}

		await next();

		const res = c.res;
		// Only cache successful JSON responses. 4xx/5xx are usually
		// "validation failed" or "DB down" — replaying them is rarely useful
		// and could mask a now-fixed issue.
		if (res.status >= 200 && res.status < 300) {
			try {
				const text = await res.clone().text();
				await store(key, { status: res.status, body: text }, ttlSeconds);
			} catch {
				await release(key);
			}
		} else {
			await release(key);
		}
	});
}
