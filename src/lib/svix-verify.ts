import { createHmac, timingSafeEqual } from "node:crypto";

// Svix-style webhook signature verification, used by Resend. Format:
//   svix-id:        unique message id (request header)
//   svix-timestamp: unix seconds (request header)
//   svix-signature: space-separated "v1,<base64-hmac>" pairs (request header)
//
// Signed payload = `${id}.${timestamp}.${rawBody}` keyed with the secret.
// The secret comes as `whsec_<base64>`; the base64 part is the raw key bytes.

const TOLERANCE_SECONDS = 5 * 60;

export type VerifyInput = {
	svixId: string | null | undefined;
	svixTimestamp: string | null | undefined;
	svixSignature: string | null | undefined;
	rawBody: string;
	secret: string;
};

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verifyResendWebhook(input: VerifyInput): VerifyResult {
	const { svixId, svixTimestamp, svixSignature, rawBody, secret } = input;

	if (!svixId || !svixTimestamp || !svixSignature) {
		return { ok: false, reason: "missing headers" };
	}

	if (!secret.startsWith("whsec_")) {
		return { ok: false, reason: "secret malformed" };
	}

	const ts = Number(svixTimestamp);
	if (!Number.isFinite(ts)) {
		return { ok: false, reason: "timestamp not numeric" };
	}

	const now = Math.floor(Date.now() / 1000);
	if (Math.abs(now - ts) > TOLERANCE_SECONDS) {
		return { ok: false, reason: "timestamp outside tolerance" };
	}

	let keyBytes: Buffer;
	try {
		keyBytes = Buffer.from(secret.slice("whsec_".length), "base64");
	} catch {
		return { ok: false, reason: "secret decode failed" };
	}

	const signedPayload = `${svixId}.${svixTimestamp}.${rawBody}`;
	const expected = createHmac("sha256", keyBytes).update(signedPayload).digest("base64");

	// svix-signature header can carry multiple "v1,<sig>" pairs separated by
	// spaces — secret rotation publishes both old and new for a window. Match
	// any of them.
	const candidates = svixSignature.split(" ");
	const expectedBuf = Buffer.from(expected);
	for (const candidate of candidates) {
		const [version, sig] = candidate.split(",");
		if (version !== "v1" || !sig) continue;
		const candidateBuf = Buffer.from(sig);
		if (candidateBuf.length !== expectedBuf.length) continue;
		if (timingSafeEqual(candidateBuf, expectedBuf)) return { ok: true };
	}

	return { ok: false, reason: "no signature matched" };
}
