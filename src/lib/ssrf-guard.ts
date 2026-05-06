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

/**
 * Resolve `host` and return true if any A/AAAA record falls into a blocked
 * range. If `host` is already an IP literal, classify it directly.
 *
 * Note: this is a TOCTOU race against the actual fetch — the resolver could
 * return a public IP here and an internal one milliseconds later (DNS
 * rebinding). For full protection we'd need to resolve once, pin to the IP, and
 * fetch with a custom socket. Acceptable here because the worst case is
 * leaking that an internal service exists/responds, not arbitrary code exec.
 */
export async function isPrivateOrLocalHost(host: string): Promise<boolean> {
	const literalKind = isIP(host);
	if (literalKind === 4) return isBlockedV4(host);
	if (literalKind === 6) return isBlockedV6(host);

	const records = await lookup(host, { all: true, verbatim: true });
	for (const r of records) {
		if (r.family === 4 && isBlockedV4(r.address)) return true;
		if (r.family === 6 && isBlockedV6(r.address)) return true;
	}
	return false;
}
