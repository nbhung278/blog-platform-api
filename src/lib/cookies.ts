import type { Context } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import { randomBytes, timingSafeEqual } from "crypto";

// Two SPAs share this backend on localhost: the public client at :5173 and
// the admin panel at :5174. Both talk to :3000 so cookies are scoped to a
// single host. To let a user be logged in to *both* apps simultaneously
// (e.g. testing as an author in the client while moderating as an admin),
// we partition the cookie names by app kind. The kind is signaled by the
// X-App-Client request header set by each SPA.
//
// ╔════════════════════════════════════════════════════════════════════╗
// ║ KEEP IN SYNC — these names appear in THREE places:                  ║
// ║   1. THIS FILE (backend authoritative source)                       ║
// ║   2. blog-platform-frontend/src/lib/authConstants.ts (web partition)║
// ║   3. blog-platform-admin/src/lib/authConstants.ts    (admin)        ║
// ║ Plus the parser in blog-platform-backend/src/lib/ws.ts which reads  ║
// ║ `admin_at` / `web_at` directly off the WS upgrade Cookie header.    ║
// ║ Changing a cookie name without updating the matching SPA constant   ║
// ║ silently breaks login for that SPA — the request still has cookies  ║
// ║ but the backend reads them under the wrong key.                     ║
// ╚════════════════════════════════════════════════════════════════════╝
export type AppKind = "admin" | "web";

const APP_HEADER = "x-app-client";
export const CSRF_HEADER = "x-csrf-token";

const COOKIE_NAMES: Record<AppKind, { access: string; refresh: string; csrf: string }> = {
	admin: { access: "admin_at", refresh: "admin_rt", csrf: "admin_csrf" },
	web: { access: "web_at", refresh: "web_rt", csrf: "web_csrf" },
};

// Backward-compatible exports — admin scheme is the default kind.
export const ACCESS_COOKIE = COOKIE_NAMES.admin.access;
export const REFRESH_COOKIE = COOKIE_NAMES.admin.refresh;
export const CSRF_COOKIE = COOKIE_NAMES.admin.csrf;

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const CSRF_TTL_SECONDS = REFRESH_TTL_SECONDS;

const isProd = process.env.NODE_ENV === "production";

// In prod, SPAs and the API live on different subdomains
// (e.g. admin.example.com and api.example.com), so cookies must be sent
// cross-site. SameSite=None requires Secure=true. COOKIE_DOMAIN scopes the
// cookie to the parent domain so both subdomains receive it.
// In dev (everything on localhost), keep Strict for stronger CSRF protection.
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || undefined;

type CookieRole = "access" | "refresh" | "csrf";

const TTL_BY_ROLE: Record<CookieRole, number> = {
	access: ACCESS_TTL_SECONDS,
	refresh: REFRESH_TTL_SECONDS,
	csrf: CSRF_TTL_SECONDS,
};

function baseOptions(role: CookieRole) {
	return {
		// CSRF cookie must be readable by JS (double-submit pattern).
		httpOnly: role !== "csrf",
		secure: isProd,
		sameSite: isProd ? ("None" as const) : ("Strict" as const),
		path: "/",
		maxAge: TTL_BY_ROLE[role],
		...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
	};
}

export function getAppKind(c: Context): AppKind {
	const header = c.req.header(APP_HEADER);
	if (header === "web") return "web";
	return "admin";
}

export function getAccessCookie(c: Context): string | undefined {
	return getCookie(c, COOKIE_NAMES[getAppKind(c)].access);
}

export function getRefreshCookie(c: Context): string | undefined {
	return getCookie(c, COOKIE_NAMES[getAppKind(c)].refresh);
}

export function getCsrfCookie(c: Context): string | undefined {
	return getCookie(c, COOKIE_NAMES[getAppKind(c)].csrf);
}

export function setAuthCookies(
	c: Context,
	tokens: { accessToken: string; refreshToken: string },
	// Browser-driven flows (e.g. OAuth callback redirects) don't carry the
	// X-App-Client header that getAppKind() relies on, so the caller can pin
	// the partition explicitly. Defaults to whatever the request header says,
	// which falls back to "admin" — wrong for the SPA at strix-blog.uk.
	override?: AppKind,
) {
	const kind = override ?? getAppKind(c);
	const names = COOKIE_NAMES[kind];
	setCookie(c, names.access, tokens.accessToken, baseOptions("access"));
	setCookie(c, names.refresh, tokens.refreshToken, baseOptions("refresh"));
	const csrf = randomBytes(32).toString("base64url");
	setCookie(c, names.csrf, csrf, baseOptions("csrf"));
}

export function rotateAccessCookie(c: Context, accessToken: string) {
	const names = COOKIE_NAMES[getAppKind(c)];
	setCookie(c, names.access, accessToken, baseOptions("access"));
}

export function rotateRefreshCookie(c: Context, refreshToken: string) {
	const names = COOKIE_NAMES[getAppKind(c)];
	setCookie(c, names.refresh, refreshToken, baseOptions("refresh"));
}

export function rotateCsrfCookie(c: Context) {
	const names = COOKIE_NAMES[getAppKind(c)];
	const csrf = randomBytes(32).toString("base64url");
	setCookie(c, names.csrf, csrf, baseOptions("csrf"));
}

export function clearAuthCookies(c: Context) {
	const names = COOKIE_NAMES[getAppKind(c)];
	const opts = {
		path: "/",
		secure: isProd,
		sameSite: isProd ? ("None" as const) : ("Strict" as const),
		...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
	};
	deleteCookie(c, names.access, opts);
	deleteCookie(c, names.refresh, opts);
	deleteCookie(c, names.csrf, opts);
}

export function csrfTokensMatch(headerValue: string | undefined, cookieValue: string | undefined) {
	if (!headerValue || !cookieValue) return false;
	const a = Buffer.from(headerValue);
	const b = Buffer.from(cookieValue);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}
