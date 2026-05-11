import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env";

// Google's OpenID Connect endpoints. The discovery doc lives at
// https://accounts.google.com/.well-known/openid-configuration; we hardcode
// the URLs because the spec guarantees they stay stable and a runtime fetch
// would add an extra round-trip to every sign-in.
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

// Cap each outbound call. Without a deadline a slow Google response would tie
// up a worker indefinitely, and a deliberately slowloris'd connection could
// drain the backend's concurrency budget. 10s is well above Google's p99 and
// short enough that user-perceived hangs stay bounded.
const GOOGLE_FETCH_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), GOOGLE_FETCH_TIMEOUT_MS);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

export type GoogleOAuthConfig = {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
};

export function getGoogleConfig(): GoogleOAuthConfig | null {
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) {
		return null;
	}
	return {
		clientId: env.GOOGLE_CLIENT_ID,
		clientSecret: env.GOOGLE_CLIENT_SECRET,
		redirectUri: env.GOOGLE_REDIRECT_URI,
	};
}

// State token: HMAC(JWT_SECRET, randomNonce + ts). We embed the nonce + ts so
// `verifyState` can detect both tampering and stale states (older than 10
// minutes — well past any reasonable consent-screen dwell time). This guards
// the OAuth callback against CSRF: a third-party site can't forge a `state`
// that our server will accept.
const STATE_MAX_AGE_SECONDS = 10 * 60;

export function buildState(): string {
	const nonce = randomBytes(16).toString("base64url");
	const ts = Math.floor(Date.now() / 1000);
	const payload = `${nonce}.${ts}`;
	const sig = createHmac("sha256", env.JWT_SECRET).update(payload).digest("base64url");
	return `${payload}.${sig}`;
}

export function verifyState(state: string): boolean {
	const parts = state.split(".");
	if (parts.length !== 3) return false;
	const [nonce, tsStr, sig] = parts;
	const ts = Number(tsStr);
	if (!Number.isFinite(ts)) return false;
	const now = Math.floor(Date.now() / 1000);
	if (ts > now + 5) return false; // reject future-dated states
	if (now - ts > STATE_MAX_AGE_SECONDS) return false;

	const expected = createHmac("sha256", env.JWT_SECRET)
		.update(`${nonce}.${tsStr}`)
		.digest("base64url");
	const a = Buffer.from(sig);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

export function buildAuthUrl(config: GoogleOAuthConfig, state: string): string {
	const params = new URLSearchParams({
		client_id: config.clientId,
		redirect_uri: config.redirectUri,
		response_type: "code",
		// `openid` is required for OIDC; the other two grant the userinfo
		// endpoint access to email + name + picture. No offline access — we
		// don't need a Google refresh token because we issue our own session.
		scope: "openid email profile",
		state,
		prompt: "select_account",
		access_type: "online",
	});
	return `${AUTH_ENDPOINT}?${params.toString()}`;
}

type TokenResponse = {
	access_token: string;
	id_token: string;
	expires_in: number;
	token_type: string;
	scope: string;
};

export async function exchangeCode(
	config: GoogleOAuthConfig,
	code: string,
): Promise<TokenResponse> {
	const res = await fetchWithTimeout(TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			code,
			client_id: config.clientId,
			client_secret: config.clientSecret,
			redirect_uri: config.redirectUri,
			grant_type: "authorization_code",
		}),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Google token exchange failed: ${res.status} ${text}`);
	}
	return (await res.json()) as TokenResponse;
}

export type GoogleUserInfo = {
	sub: string; // unique Google account ID — what we store as google_id
	email: string;
	email_verified: boolean;
	name: string;
	given_name?: string;
	family_name?: string;
	picture?: string;
	locale?: string;
};

export async function fetchUserInfo(accessToken: string): Promise<GoogleUserInfo> {
	const res = await fetchWithTimeout(USERINFO_ENDPOINT, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Google userinfo fetch failed: ${res.status} ${text}`);
	}
	return (await res.json()) as GoogleUserInfo;
}
