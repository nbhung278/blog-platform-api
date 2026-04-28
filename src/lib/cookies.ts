import type { Context } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import { randomBytes, timingSafeEqual } from "crypto";

export const ACCESS_COOKIE = "admin_at";
export const REFRESH_COOKIE = "admin_rt";
export const CSRF_COOKIE = "admin_csrf";
export const CSRF_HEADER = "x-csrf-token";

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
// CSRF lives as long as the refresh token: rotated together on login/refresh.
const CSRF_TTL_SECONDS = REFRESH_TTL_SECONDS;

const isProd = process.env.NODE_ENV === "production";

type CookieKind = "access" | "refresh" | "csrf";

const TTL_BY_KIND: Record<CookieKind, number> = {
	access: ACCESS_TTL_SECONDS,
	refresh: REFRESH_TTL_SECONDS,
	csrf: CSRF_TTL_SECONDS,
};

function baseOptions(kind: CookieKind) {
	return {
		// CSRF cookie must be readable by JS (double-submit pattern).
		httpOnly: kind !== "csrf",
		secure: isProd,
		sameSite: "Strict" as const,
		path: "/",
		maxAge: TTL_BY_KIND[kind],
	};
}

export function setAuthCookies(c: Context, tokens: { accessToken: string; refreshToken: string }) {
	setCookie(c, ACCESS_COOKIE, tokens.accessToken, baseOptions("access"));
	setCookie(c, REFRESH_COOKIE, tokens.refreshToken, baseOptions("refresh"));
	const csrf = randomBytes(32).toString("base64url");
	setCookie(c, CSRF_COOKIE, csrf, baseOptions("csrf"));
}

export function rotateAccessCookie(c: Context, accessToken: string) {
	setCookie(c, ACCESS_COOKIE, accessToken, baseOptions("access"));
}

export function rotateRefreshCookie(c: Context, refreshToken: string) {
	setCookie(c, REFRESH_COOKIE, refreshToken, baseOptions("refresh"));
}

export function rotateCsrfCookie(c: Context) {
	const csrf = randomBytes(32).toString("base64url");
	setCookie(c, CSRF_COOKIE, csrf, baseOptions("csrf"));
}

export function clearAuthCookies(c: Context) {
	const opts = { path: "/", secure: isProd, sameSite: "Strict" as const };
	deleteCookie(c, ACCESS_COOKIE, opts);
	deleteCookie(c, REFRESH_COOKIE, opts);
	deleteCookie(c, CSRF_COOKIE, opts);
}

export function csrfTokensMatch(headerValue: string | undefined, cookieValue: string | undefined) {
	if (!headerValue || !cookieValue) return false;
	const a = Buffer.from(headerValue);
	const b = Buffer.from(cookieValue);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}
