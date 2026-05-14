import type { ServerWebSocket } from "bun";

type WSData = { userId: string };
type WS = ServerWebSocket<WSData>;

export type RealtimeMessage =
	| { kind: "notification"; data: unknown }
	| { kind: "unread_count"; count: number }
	| { kind: "chat_message"; data: unknown }
	| { kind: "message_reaction"; data: unknown }
	| { kind: "message_edit"; data: unknown }
	| { kind: "message_delete"; data: unknown };

const subscribers = new Map<string, Set<WS>>();

// Cap concurrent sockets per user. A real client only needs one (multiple
// tabs share via SharedWorker is the future), so 8 is plenty of headroom for
// duplicate tabs while preventing a logged-in attacker from exhausting memory
// by opening thousands of sockets.
const MAX_SOCKETS_PER_USER = 8;

export function addSubscriber(userId: string, ws: WS): boolean {
	let set = subscribers.get(userId);
	if (!set) {
		set = new Set();
		subscribers.set(userId, set);
	}
	if (set.size >= MAX_SOCKETS_PER_USER) {
		return false;
	}
	set.add(ws);
	return true;
}

export function removeSubscriber(userId: string, ws: WS) {
	const set = subscribers.get(userId);
	if (!set) return;
	set.delete(ws);
	if (set.size === 0) subscribers.delete(userId);
}

// Drop sends to clients whose outbound buffer is already this far behind. The
// threshold is generous (~1 MB) — typical notification payloads are <1 KB, so
// hitting this means the socket is dead/stuck and Bun is queueing pending
// writes in memory. Letting it grow unbounded is how a single slow client OOMs
// the process.
const WS_BACKPRESSURE_DROP_BYTES = 1_000_000;

export function publishToUser(userId: string, message: RealtimeMessage) {
	const set = subscribers.get(userId);
	if (!set) return;
	const payload = JSON.stringify(message);
	for (const ws of set) {
		try {
			// Bun exposes the OS-level send-buffer fill via `getBufferedAmount()`.
			// When a client stops reading, this number grows; sending more just
			// enlarges the queue. Skipping the send here keeps memory bounded —
			// the next publish either succeeds (buffer drained) or the socket is
			// reaped by the close handler. We don't close the socket here because
			// legitimate short stalls (mobile network handover) recover within
			// seconds.
			if (ws.getBufferedAmount() > WS_BACKPRESSURE_DROP_BYTES) continue;
			ws.send(payload);
		} catch {
			// Ignore — client likely disconnected; the close handler will clean up.
		}
	}
}

// Forcefully close all sockets for a user. Called when the user logs out or
// their tokenVersion is bumped, so existing sockets can't outlive the session.
export function disconnectUser(userId: string, reason = "session ended") {
	const set = subscribers.get(userId);
	if (!set) return;
	for (const ws of set) {
		try {
			ws.close(4001, reason);
		} catch {
			// Ignore.
		}
	}
	subscribers.delete(userId);
}
