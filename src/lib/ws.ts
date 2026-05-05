import type { ServerWebSocket } from "bun";
import { verify } from "hono/jwt";
import { addSubscriber, removeSubscriber } from "./realtime";
import { getCachedTokenVersion } from "./tokens";
import { env } from "./env";
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
		const payload = (await verify(token, env.JWT_SECRET, "HS256")) as JWTPayload;
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

// Inbound flood guard. Clients only ever need to send "ping" — anything more
// frequent than this is broken or hostile, so we drop the socket rather than
// burn CPU echoing pongs to abuse traffic.
const WS_INBOUND_MAX_PER_MINUTE = 120;
const WS_INBOUND_MAX_BYTES = 64;

type RateState = { count: number; windowStart: number };
const rateState = new WeakMap<ServerWebSocket<WSData>, RateState>();

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
		// Reject anything bigger than a ping. Bun's WS doesn't enforce a default
		// max payload length on most builds, so we cap it ourselves.
		const len = typeof raw === "string" ? raw.length : raw.byteLength;
		if (len > WS_INBOUND_MAX_BYTES) {
			ws.close(4003, "message too large");
			return;
		}

		const now = Date.now();
		const state = rateState.get(ws) ?? { count: 0, windowStart: now };
		if (now - state.windowStart > 60_000) {
			state.count = 0;
			state.windowStart = now;
		}
		state.count += 1;
		rateState.set(ws, state);
		if (state.count > WS_INBOUND_MAX_PER_MINUTE) {
			ws.close(4004, "rate limit exceeded");
			return;
		}

		// Lightweight ping/pong to keep proxy connections warm. Clients can send
		// "ping" and we'll echo "pong"; otherwise we ignore inbound messages.
		const text = typeof raw === "string" ? raw : raw.toString();
		if (text === "ping") {
			ws.send("pong");
		}
	},
	close(ws: ServerWebSocket<WSData>) {
		rateState.delete(ws);
		removeSubscriber(ws.data.userId, ws);
	},
};
