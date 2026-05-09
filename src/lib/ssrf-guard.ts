import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// CIDR ranges that should never be fetchable from a server-side rehost endpoint.
// Anything resolving inside these ranges could be an internal service, cloud
// metadata endpoint, or loopback — fetching them lets an attacker turn our
// server into an SSRF probe.
const BLOCKED_V4 = [
	{ net: "0.0.0.0", bits: 8 }, // unspecified
	{ net: "10.0.0.0", bits: 8 }, // RFC1918 private
	{ net: "127.0.0.0", bits: 8 }, // loopback
	{ net: "169.254.0.0", bits: 16 }, // link-local incl. AWS metadata 169.254.169.254
	{ net: "172.16.0.0", bits: 12 }, // RFC1918 private
	{ net: "192.0.0.0", bits: 24 }, // IETF protocol assignments
	{ net: "192.168.0.0", bits: 16 }, // RFC1918 private
	{ net: "224.0.0.0", bits: 4 }, // multicast
	{ net: "240.0.0.0", bits: 4 }, // reserved
];

function ipv4ToInt(ip: string): number {
	const parts = ip.split(".").map(Number);
	if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
		return -1;
	}
	return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isBlockedV4(ip: string): boolean {
	const addr = ipv4ToInt(ip);
	if (addr < 0) return true;
	for (const { net, bits } of BLOCKED_V4) {
		const netInt = ipv4ToInt(net);
		const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
		if ((addr & mask) === (netInt & mask)) return true;
	}
	return false;
}

function isBlockedV6(ip: string): boolean {
	const lower = ip.toLowerCase();
	// Loopback ::1, unspecified ::, link-local fe80::/10, unique-local fc00::/7,
	// IPv4-mapped ::ffff:0:0/96 (delegate to v4 check), site-local fec0::/10.
	if (lower === "::1" || lower === "::") return true;
	if (
		lower.startsWith("fe80:") ||
		lower.startsWith("fe9") ||
		lower.startsWith("fea") ||
		lower.startsWith("feb")
	) {
		return true;
	}
	if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
	if (
		lower.startsWith("fec") ||
		lower.startsWith("fed") ||
		lower.startsWith("fee") ||
		lower.startsWith("fef")
	) {
		return true;
	}
	const v4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (v4Mapped) return isBlockedV4(v4Mapped[1]);
	return false;
}

export type SafeHost = { ip: string; family: 4 | 6 };

/**
 * Resolve `host`, verify every returned record is outside all blocked ranges,
 * and return the first address to use as a pinned connection target.
 *
 * The caller must pass this IP directly to the HTTP/S request (bypassing DNS
 * at the socket level) so a DNS-rebinding attack — where the resolver returns
 * a public IP for the SSRF check and a private IP for the actual TCP connect —
 * is closed. Using `node:http`/`node:https` with `host: pinnedIp` and
 * `servername: hostname` achieves this: Node connects to the IP we verified
 * and TLS still validates the cert against the original hostname.
 *
 * Throws if the host is blocked, unresolvable, or returns no records.
 */
export async function resolveHostSafe(host: string): Promise<SafeHost> {
	const literalKind = isIP(host);
	if (literalKind === 4) {
		if (isBlockedV4(host)) throw new Error("blocked");
		return { ip: host, family: 4 };
	}
	if (literalKind === 6) {
		if (isBlockedV6(host)) throw new Error("blocked");
		return { ip: host, family: 6 };
	}

	const records = await lookup(host, { all: true, verbatim: true });
	if (records.length === 0) throw new Error("no records");

	// Reject if ANY record resolves to a blocked range — an attacker could
	// register a domain with both a public and a private A record and hope
	// the check hits the public one while the fetch hits the private one.
	for (const r of records) {
		if (r.family === 4 && isBlockedV4(r.address)) throw new Error("blocked");
		if (r.family === 6 && isBlockedV6(r.address)) throw new Error("blocked");
	}

	const first = records[0];
	return { ip: first.address, family: first.family as 4 | 6 };
}
