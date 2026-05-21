import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { redis } from "../lib/redis";

type Options = {
	keyPrefix: string;
	limit: number;
	windowSeconds: number;
	keyExtractor?: (c: Context) => string;
};

export function getClientIp(c: Context): string {
	// Production chain is User → Cloudflare → nginx → backend. Only
	// CF-Connecting-IP is safe to trust:
	//   - CF overwrites any client-supplied CF-Connecting-IP at the edge
	//   - X-Forwarded-For is appended by nginx ($proxy_add_x_forwarded_for) on
	//     top of whatever the client sent, so its head can be attacker-spoofed
	//   - X-Real-IP set by nginx equals $remote_addr, which from nginx's view
	//     is the Cloudflare edge IP, not the real user. Useless for rate limit.
	//
	// When TRUST_PROXY=false (no CF in front, e.g. local dev), fall back to the
	// TCP socket IP injected at the Bun.serve level (see index.ts), which
	// clients cannot spoof.
	//
	// We deliberately do NOT fall back from CF-Connecting-IP to other headers
	// when TRUST_PROXY=true. If CF is misconfigured and the header is missing,
	// returning "unknown" collapses every such request into a single bucket —
	// noisy but safe. Falling back to a spoofable header would silently let an
	// attacker bypass every IP-keyed limit (login backoff, OTP throttle, etc.).
	if (process.env.TRUST_PROXY === "true") {
		return c.req.header("cf-connecting-ip") || "unknown";
	}
	return c.req.header("x-real-socket-ip") || "unknown";
}

export function ipRateLimit({ keyPrefix, limit, windowSeconds, keyExtractor }: Options) {
	return createMiddleware(async (c, next) => {
		const ip = getClientIp(c);
		const extra = keyExtractor ? `:${keyExtractor(c)}` : "";
		const key = `ratelimit:${keyPrefix}:${ip}${extra}`;

		// SET NX EX is atomic: creates the key with TTL in one operation so a
		// crash between INCR and EXPIRE can never leave a key without an expiry.
		await redis.set(key, "0", "EX", windowSeconds, "NX");
		const count = await redis.incr(key);

		if (count > limit) {
			const ttl = await redis.ttl(key);
			c.header("Retry-After", String(ttl));
			return c.json({ error: "Too many requests", retryAfter: ttl }, 429);
		}

		await next();
	});
}

// Per-user rate limit. Use after `authMiddleware` so `c.get("user").sub` is
// populated. Anonymous fallthrough returns 401 — never silently un-limited.
// Stack with ipRateLimit when you also want to throttle pre-auth abuse.
export function userRateLimit({ keyPrefix, limit, windowSeconds }: Omit<Options, "keyExtractor">) {
	return createMiddleware(async (c, next) => {
		const user = c.get("user") as { sub?: string } | undefined;
		if (!user?.sub) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		const key = `ratelimit:${keyPrefix}:user:${user.sub}`;

		await redis.set(key, "0", "EX", windowSeconds, "NX");
		const count = await redis.incr(key);

		if (count > limit) {
			const ttl = await redis.ttl(key);
			c.header("Retry-After", String(ttl));
			return c.json({ error: "Quota exceeded", retryAfter: ttl }, 429);
		}

		await next();
	});
}

// ---------------------------------------------------------------------------
// Login rate limiter — two layers + exponential backoff.
//
// Layer 1: per-IP (catch botnets / shared NAT abuse).
// Layer 2: per-account (catch distributed credential stuffing on one email).
// On failure, the next allowed attempt window grows exponentially.
//
// On successful login, the caller must invoke `recordLoginSuccess` to clear
// counters so a legitimate user isn't locked out by their own past mistakes.
// ---------------------------------------------------------------------------

const LOGIN_IP_LIMIT = 20;
const LOGIN_IP_WINDOW = 60 * 15;

const LOGIN_ACCOUNT_BASE_WINDOW = 60; // seconds
const LOGIN_ACCOUNT_MAX_WINDOW = 60 * 60; // cap at 1 hour
const LOGIN_ACCOUNT_FREE_ATTEMPTS = 3; // first N failures don't lock
const LOGIN_ACCOUNT_MAX_FAILURES = 12; // hard ceiling

function ipKey(ip: string) {
	return `loginlimit:ip:${ip}`;
}
function accountKey(email: string) {
	return `loginlimit:account:${email.toLowerCase()}`;
}

type AccountState = {
	failures: number;
	lockedUntil: number; // epoch seconds, 0 if not locked
};

async function readAccountState(email: string): Promise<AccountState> {
	const raw = await redis.hgetall(accountKey(email));
	return {
		failures: parseInt(raw.failures || "0", 10),
		lockedUntil: parseInt(raw.lockedUntil || "0", 10),
	};
}

export function loginRateLimit() {
	return createMiddleware(async (c, next) => {
		const ip = getClientIp(c);

		await redis.set(ipKey(ip), "0", "EX", LOGIN_IP_WINDOW, "NX");
		const ipCount = await redis.incr(ipKey(ip));
		if (ipCount > LOGIN_IP_LIMIT) {
			const ttl = await redis.ttl(ipKey(ip));
			c.header("Retry-After", String(ttl));
			return c.json({ error: "Too many requests from this IP", retryAfter: ttl }, 429);
		}

		// Peek at body for account-level limits without consuming the original
		// request body (zValidator needs to read it again downstream).
		let email: string | undefined;
		try {
			const cloned = c.req.raw.clone();
			const body = await cloned.json();
			if (body && typeof body.email === "string") email = body.email;
		} catch {
			// Not JSON or empty — let zValidator reject downstream.
		}

		if (email) {
			const state = await readAccountState(email);
			const now = Math.floor(Date.now() / 1000);
			if (state.lockedUntil > now) {
				const retryAfter = state.lockedUntil - now;
				c.header("Retry-After", String(retryAfter));
				// Return the same shape as a wrong-password 401 to avoid leaking
				// whether the email exists. Retry-After header is the only signal.
				return c.json({ error: "Invalid credentials" }, 401);
			}
		}

		await next();
	});
}

export async function recordLoginFailure(email: string) {
	const key = accountKey(email);

	// Atomic increment — concurrent failed logins all get counted.
	const failures = await redis.hincrby(key, "failures", 1);

	let lockedUntil = 0;
	if (failures > LOGIN_ACCOUNT_FREE_ATTEMPTS) {
		const overage = Math.min(failures - LOGIN_ACCOUNT_FREE_ATTEMPTS, 10);
		const window = Math.min(
			LOGIN_ACCOUNT_BASE_WINDOW * Math.pow(2, overage - 1),
			LOGIN_ACCOUNT_MAX_WINDOW,
		);
		lockedUntil = Math.floor(Date.now() / 1000) + window;
		await redis.hset(key, { lockedUntil });
	}

	await redis.expire(key, LOGIN_ACCOUNT_MAX_WINDOW * 2);

	return {
		failures,
		lockedUntil,
		exceededHardCeiling: failures >= LOGIN_ACCOUNT_MAX_FAILURES,
	};
}

export async function recordLoginSuccess(email: string) {
	await redis.del(accountKey(email));
}
