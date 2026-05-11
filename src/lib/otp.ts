import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { redis } from "./redis";

const OTP_TTL_SECONDS = 10 * 60;
const MAX_ATTEMPTS = 5;

// Atomic read-modify-write for the attempts counter. Without this script, two
// concurrent verify requests both read attempts=N, both increment to N+1, both
// write back — letting an attacker probe more codes than MAX_ATTEMPTS allows
// by parallelizing requests. The Lua script runs server-side and Redis
// guarantees single-threaded execution of scripts, so increment + check +
// delete + payload return are observably atomic.
//
// Returns: array [status, payloadJsonOrEmpty]
//   status: "match" | "miss" | "exhausted" | "not_found"
//   payloadJson: original record JSON on "match", empty string otherwise
const VERIFY_OTP_LUA = `
local key = KEYS[1]
local providedHash = ARGV[1]
local maxAttempts = tonumber(ARGV[2])

local raw = redis.call('GET', key)
if not raw then
  return {'not_found', ''}
end

local ok, record = pcall(cjson.decode, raw)
if not ok or type(record) ~= 'table' then
  redis.call('DEL', key)
  return {'not_found', ''}
end

local attempts = tonumber(record.attempts) or 0
if attempts >= maxAttempts then
  redis.call('DEL', key)
  return {'exhausted', ''}
end

if record.codeHash == providedHash then
  redis.call('DEL', key)
  return {'match', raw}
end

record.attempts = attempts + 1
local ttl = redis.call('TTL', key)
if ttl > 0 then
  redis.call('SET', key, cjson.encode(record), 'EX', ttl)
end

if record.attempts >= maxAttempts then
  redis.call('DEL', key)
  return {'exhausted', ''}
end

return {'miss', ''}
`;

export type OtpPurpose = "signup" | "login" | "forgot";

export type OtpPayload = Record<string, string | number | boolean | null>;

function hashCode(code: string): string {
	return createHash("sha256").update(code).digest("hex");
}

function generateNumericCode(): string {
	// Reject-sample 6 digits from random bytes. Using `% 1_000_000` on a random
	// int introduces modulo bias for the high end; rejecting values above the
	// largest multiple of 1_000_000 keeps the distribution uniform.
	const MAX = 0xffffffff;
	const limit = MAX - (MAX % 1_000_000);
	for (;;) {
		const n = randomBytes(4).readUInt32BE(0);
		if (n <= limit) return String(n % 1_000_000).padStart(6, "0");
	}
}

function generateOpaqueToken(): string {
	return randomBytes(24).toString("base64url");
}

function key(purpose: OtpPurpose, token: string): string {
	return `otp:${purpose}:${token}`;
}

export type IssueResult = { token: string; code: string };

export async function issueOtp(purpose: OtpPurpose, payload: OtpPayload): Promise<IssueResult> {
	const token = generateOpaqueToken();
	const code = generateNumericCode();
	const codeHash = hashCode(code);

	const record = {
		...payload,
		codeHash,
		attempts: 0,
		issuedAt: Date.now(),
	};

	await redis.set(key(purpose, token), JSON.stringify(record), "EX", OTP_TTL_SECONDS);
	return { token, code };
}

export type VerifyResult<T extends OtpPayload> =
	| { ok: true; payload: T }
	| { ok: false; reason: "not_found" | "expired" | "invalid" | "exhausted" };

export async function verifyOtp<T extends OtpPayload>(
	purpose: OtpPurpose,
	token: string,
	code: string,
): Promise<VerifyResult<T>> {
	const providedHash = hashCode(code);
	const k = key(purpose, token);

	// Atomic verify-and-increment via Lua so parallel requests can't bypass
	// MAX_ATTEMPTS. On match, the script also returns the original record JSON
	// so we can extract the payload without a second round-trip.
	const result = (await redis.eval(VERIFY_OTP_LUA, 1, k, providedHash, String(MAX_ATTEMPTS))) as [
		string,
		string,
	];
	const [status, payloadJson] = result;

	if (status === "not_found") return { ok: false, reason: "not_found" };
	if (status === "exhausted") return { ok: false, reason: "exhausted" };
	if (status === "miss") {
		// Spend a little time on a no-op timing-safe comparison so the "wrong
		// code" path doesn't measurably differ from a hypothetical "missing
		// record" path. Lua already did the real check; this is cosmetic.
		const dummy = Buffer.alloc(32);
		timingSafeEqual(dummy, dummy);
		return { ok: false, reason: "invalid" };
	}

	// status === "match"
	let record: { codeHash: string; attempts: number; issuedAt: number } & T;
	try {
		record = JSON.parse(payloadJson);
	} catch {
		// Should never happen — Lua only returns JSON it just successfully
		// decoded. Treat as not_found to fail closed.
		return { ok: false, reason: "not_found" };
	}
	const { codeHash: _ch, attempts: _a, issuedAt: _i, ...rest } = record;
	return { ok: true, payload: rest as unknown as T };
}

// Track resend frequency per (purpose, identifier) so a misbehaving client
// can't drain the daily email quota. Identifier is usually email or userId.
const RESEND_WINDOW_SECONDS = 60 * 60;
const RESEND_LIMIT = 5;

export async function canResend(purpose: OtpPurpose, identifier: string): Promise<boolean> {
	const k = `otp:resend:${purpose}:${identifier.toLowerCase()}`;
	await redis.set(k, "0", "EX", RESEND_WINDOW_SECONDS, "NX");
	const count = await redis.incr(k);
	return count <= RESEND_LIMIT;
}

// Invalidate every outstanding OTP of `purpose` whose payload matches the
// given email. Called when we're about to issue a fresh OTP for that email
// so a previously-mailed code can't be used out of a stale tab. SCAN is
// cursor-based and safe to run against Redis under load.
export async function invalidateOtpsForEmail(purpose: OtpPurpose, email: string): Promise<void> {
	const target = email.toLowerCase();
	let cursor = "0";
	const toDelete: string[] = [];
	do {
		const [nextCursor, keys] = await redis.scan(cursor, "MATCH", `otp:${purpose}:*`, "COUNT", 100);
		cursor = nextCursor;
		for (const k of keys) {
			const raw = await redis.get(k);
			if (!raw) continue;
			try {
				const payload = JSON.parse(raw) as { email?: string };
				if (payload.email?.toLowerCase() === target) {
					toDelete.push(k);
				}
			} catch {
				// Malformed payload — drop it; it's already useless.
				toDelete.push(k);
			}
		}
	} while (cursor !== "0");

	if (toDelete.length > 0) {
		await redis.del(...toDelete);
	}
}
