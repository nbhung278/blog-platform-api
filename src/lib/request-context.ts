import type { Context } from "hono";
import { getClientIp } from "../middleware/rate-limit";

// Bundle of (ip, userAgent) extracted from a request, used wherever we need
// to attribute an action to a device — refresh-token issuance, KnownDevice
// fingerprint, audit logs. Both fields are nullable: getClientIp can return
// "unknown" when running without a trusted proxy, and the User-Agent header
// is optional.
export type ClientContext = { ip: string | null; userAgent: string | null };

export function clientContext(c: Context): ClientContext {
	const rawIp = getClientIp(c);
	const ip = rawIp === "unknown" ? null : rawIp;
	const userAgent = c.req.header("user-agent") || null;
	return { ip, userAgent };
}
