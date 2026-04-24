import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { redis } from "../lib/redis";

type Options = {
	keyPrefix: string;
	limit: number;
	windowSeconds: number;
	keyExtractor?: (c: Context) => string;
};

export function rateLimit({ keyPrefix, limit, windowSeconds, keyExtractor }: Options) {
	return createMiddleware(async (c, next) => {
		const ip =
			c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
			c.req.header("x-real-ip") ||
			"unknown";
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

export async function clearRateLimit(keyPrefix: string, ip: string, extra?: string) {
	const key = `ratelimit:${keyPrefix}:${ip}${extra ? `:${extra}` : ""}`;
	await redis.del(key);
}
