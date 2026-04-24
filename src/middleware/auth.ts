import { createMiddleware } from "hono/factory";
import { verify } from "hono/jwt";
import type { PermissionKey } from "../lib/permissions";

export type JWTPayload = {
	sub: string;
	email: string;
	username: string;
	roles: string[];
	permissions: PermissionKey[];
	mustChangePassword: boolean;
	exp: number;
};

const PASSWORD_CHANGE_EXEMPT_PATHS = new Set([
	"/api/auth/me",
	"/api/auth/change-password",
	"/api/auth/logout",
]);

export const authMiddleware = createMiddleware<{
	Variables: {
		user: JWTPayload;
	};
}>(async (c, next) => {
	const authHeader = c.req.header("Authorization");
	if (!authHeader?.startsWith("Bearer ")) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const token = authHeader.slice(7);

	try {
		const payload = (await verify(token, process.env.JWT_SECRET!, "HS256")) as JWTPayload;

		// Reject tokens issued before RBAC was introduced (missing fields).
		// Forces clients to re-login to get a token with roles/permissions.
		if (!Array.isArray(payload.permissions) || !Array.isArray(payload.roles)) {
			return c.json({ error: "Token outdated, please log in again" }, 401);
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
