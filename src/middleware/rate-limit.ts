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
	// When TRUST_PROXY=true the server sits behind a trusted reverse proxy
	// (Cloudflare, nginx, etc.) that strips and re-sets forwarded headers.
	// Priority: CF-Connecting-IP (set exclusively by Cloudflare, most reliable)
	// → X-Real-IP (set by nginx) → X-Forwarded-For → socket IP fallback.
	// When false, always use the actual TCP socket IP injected at the Bun.serve
	// level (see index.ts), which clients cannot spoof.
	if (process.env.TRUST_PROXY === "true") {
		return (
			c.req.header("cf-connecting-ip") ||
			c.req.header("x-real-ip") ||
			c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
			c.req.header("x-real-socket-ip") ||
			"unknown"
		);
	}
	return c.req.header("x-real-socket-ip") || "unknown";
}

export function ipRateLimit({ keyPrefix, limit, windowSeconds, keyExtractor }: Options) {
	return createMiddleware(async (c, next) => {
		const ip = getClientIp(c);
		const extra = keyExtractor ? `:${keyExtractor(c)}` : "";
		const key = `ratelimit:${keyPrefix}:${ip}${extra}`;

		const count = await redis.incr(key);
		if (count === 1) {
			await redis.expire(key, windowSeconds);
		}

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

		const count = await redis.incr(key);
		if (count === 1) {
			await redis.expire(key, windowSeconds);
		}

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

		const ipCount = await redis.incr(ipKey(ip));
		if (ipCount === 1) await redis.expire(ipKey(ip), LOGIN_IP_WINDOW);
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
