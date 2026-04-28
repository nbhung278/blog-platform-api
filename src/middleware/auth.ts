import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { verify } from "hono/jwt";
import { getCookie } from "hono/cookie";
import type { PermissionKey } from "../lib/permissions";
import { getCachedTokenVersion } from "../lib/tokens";
import { ACCESS_COOKIE, CSRF_COOKIE, CSRF_HEADER, csrfTokensMatch } from "../lib/cookies";

export type JWTPayload = {
	sub: string;
	email: string;
	username: string;
	roles: string[];
	permissions: PermissionKey[];
	mustChangePassword: boolean;
	tokenVersion: number;
	exp: number;
};

const PASSWORD_CHANGE_EXEMPT_PATHS = new Set([
	"/api/auth/me",
	"/api/auth/change-password",
	"/api/auth/logout",
	"/api/auth/logout-all",
]);

const CSRF_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function extractAccessToken(c: Context): string | null {
	const cookieToken = getCookie(c, ACCESS_COOKIE);
	if (cookieToken) return cookieToken;
	const authHeader = c.req.header("Authorization");
	if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
	return null;
}

export const authMiddleware = createMiddleware<{
	Variables: {
		user: JWTPayload;
	};
}>(async (c, next) => {
	const token = extractAccessToken(c);
	if (!token) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	// CSRF: we enforce whenever an access cookie is present on a state-changing
	// request, even if the caller also sent a Bearer header. Browsers attach
	// cookies automatically, so a cookie in the request is the signal that the
	// origin we care about (XHR/fetch from the SPA) is in play. Pure header-
	// only clients (mobile / CLI) won't carry the cookie and are exempt.
	const cameFromCookie = !!getCookie(c, ACCESS_COOKIE);
	if (cameFromCookie && !CSRF_SAFE_METHODS.has(c.req.method)) {
		const headerToken = c.req.header(CSRF_HEADER);
		const cookieToken = getCookie(c, CSRF_COOKIE);
		if (!csrfTokensMatch(headerToken, cookieToken)) {
			return c.json({ error: "CSRF token missing or invalid" }, 403);
		}
	}

	try {
		const payload = (await verify(token, process.env.JWT_SECRET!, "HS256")) as JWTPayload;

		// Reject tokens issued before RBAC was introduced (missing fields).
		// Forces clients to re-login to get a token with roles/permissions.
		if (!Array.isArray(payload.permissions) || !Array.isArray(payload.roles)) {
			return c.json({ error: "Token outdated, please log in again" }, 401);
		}

		if (typeof payload.tokenVersion !== "number") {
			return c.json({ error: "Token outdated, please log in again" }, 401);
		}

		const currentVersion = await getCachedTokenVersion(payload.sub);
		if (currentVersion === null || payload.tokenVersion !== currentVersion) {
			return c.json({ error: "Token revoked", code: "TOKEN_REVOKED" }, 401);
		}

		if (payload.mustChangePassword && !PASSWORD_CHANGE_EXEMPT_PATHS.has(c.req.path)) {
			return c.json({ error: "Password change required", code: "PASSWORD_CHANGE_REQUIRED" }, 403);
		}

		c.set("user", payload);
		await next();
	} catch {
		return c.json({ error: "Invalid token" }, 401);
	}
});

export function requirePermission(...required: PermissionKey[]) {
	return createMiddleware<{ Variables: { user: JWTPayload } }>(async (c, next) => {
		const user = c.get("user");
		if (!user) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		const has = required.every((p) => user.permissions.includes(p));
		if (!has) {
			return c.json({ error: "Forbidden", required }, 403);
		}
		await next();
	});
}

export function requireAnyPermission(...allowed: PermissionKey[]) {
	return createMiddleware<{ Variables: { user: JWTPayload } }>(async (c, next) => {
		const user = c.get("user");
		if (!user) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		const has = allowed.some((p) => user.permissions.includes(p));
		if (!has) {
			return c.json({ error: "Forbidden", allowed }, 403);
		}
		await next();
	});
}
