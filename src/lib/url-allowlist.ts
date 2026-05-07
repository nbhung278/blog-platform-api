import { env } from "./env";

// Hostnames that user-supplied media URLs (post coverUrl, DM imageUrl) are
// allowed to reference. Anything else is rejected at write time so an attacker
// can't:
//   - point images at attacker-controlled IPs to harvest reader IPs/UA
//   - probe internal network endpoints (SSRF) via <img src>
//   - drain outbound bandwidth or get the origin blocklisted
//
// Derived from S3_PUBLIC_URL by default; can be widened via env if you ship
// images from a CDN that fronts the bucket.
function buildAllowedHosts(): Set<string> {
	const hosts = new Set<string>();
	if (env.S3_PUBLIC_URL) {
		try {
			hosts.add(new URL(env.S3_PUBLIC_URL).hostname.toLowerCase());
		} catch {
			// ignore — env validator already checked the format
		}
	}
	if (env.CDN_PUBLIC_URL) {
		try {
			hosts.add(new URL(env.CDN_PUBLIC_URL).hostname.toLowerCase());
		} catch {
			// ignore
		}
	}
	// Fall back to the bare bucket hostname pattern so dev (with only
	// S3_BUCKET set) still works.
	if (env.S3_BUCKET && env.S3_REGION) {
		hosts.add(`${env.S3_BUCKET}.s3.${env.S3_REGION}.amazonaws.com`.toLowerCase());
	}
	return hosts;
}

const ALLOWED_HOSTS = buildAllowedHosts();

/**
 * True if the URL is http(s) and hosted on one of the allowlisted media hosts.
 * Returns false for any malformed URL, non-http(s) scheme, or off-allowlist
 * hostname.
 */
export function isAllowedMediaUrl(input: string | null | undefined): boolean {
	if (!input) return false;
	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		return false;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
	return ALLOWED_HOSTS.has(parsed.hostname.toLowerCase());
}
