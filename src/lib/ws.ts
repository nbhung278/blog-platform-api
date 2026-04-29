import type { ServerWebSocket } from "bun";
import { verify } from "hono/jwt";
import { addSubscriber, removeSubscriber } from "./realtime";
import { getCachedTokenVersion } from "./tokens";
import type { JWTPayload } from "../middleware/auth";

export type WSData = { userId: string };

// Verify the access cookie carried on the WebSocket upgrade request. We mirror
// `authMiddleware`'s checks (signature, RBAC fields, tokenVersion) so an
// upgraded socket can't outlive a force-logout.
export async function authenticateUpgradeRequest(req: Request): Promise<string | null> {
	const cookieHeader = req.headers.get("cookie");
	if (!cookieHeader) return null;

	const appKind = req.headers.get("x-app-client") === "admin" ? "admin" : "web";
	const cookieName = appKind === "admin" ? "admin_at" : "web_at";

	const cookies = parseCookies(cookieHeader);
	const token = cookies[cookieName];
	if (!token) return null;

	try {
		const payload = (await verify(token, process.env.JWT_SECRET!, "HS256")) as JWTPayload;
		if (!payload.sub) return null;
		if (typeof payload.tokenVersion !== "number") return null;
		const currentVersion = await getCachedTokenVersion(payload.sub);
		if (currentVersion === null || payload.tokenVersion !== currentVersion) return null;
		return payload.sub;
	} catch {
		return null;
	}
}

function parseCookies(header: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of header.split(";")) {
		const [k, ...rest] = part.trim().split("=");
		if (!k) continue;
		out[k] = decodeURIComponent(rest.join("="));
	}
	return out;
}

export const wsHandlers = {
	open(ws: ServerWebSocket<WSData>) {
		const ok = addSubscriber(ws.data.userId, ws);
		if (!ok) {
			ws.close(4002, "connection limit exceeded");
			return;
		}
		ws.send(JSON.stringify({ kind: "ready" }));
	},
	message(ws: ServerWebSocket<WSData>, raw: string | Buffer) {
		// Lightweight ping/pong to keep proxy connections warm. Clients can send
		// "ping" and we'll echo "pong"; otherwise we ignore inbound messages.
		const text = typeof raw === "string" ? raw : raw.toString();
		if (text === "ping") {
			ws.send("pong");
		}
	},
	close(ws: ServerWebSocket<WSData>) {
		removeSubscriber(ws.data.userId, ws);
	},
};
