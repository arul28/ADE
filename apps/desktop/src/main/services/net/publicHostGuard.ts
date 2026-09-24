import http from "node:http";
import net from "node:net";

const publicIpv6Ranges = new net.BlockList();
publicIpv6Ranges.addSubnet("2000::", 3, "ipv6");
const nonPublicIpv6Ranges = new net.BlockList();
for (const [network, prefix] of [
  ["2001::", 32], // Teredo
  ["2001:2::", 48], // benchmarking
  ["2001:10::", 28], // ORCHID
  ["2001:20::", 28], // ORCHIDv2
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 can embed non-public IPv4 destinations
] as const) {
  nonPublicIpv6Ranges.addSubnet(network, prefix, "ipv6");
}
// Publicly assigned space is not all ordinary public unicast. Favicon fetches
// reject the IPv6 documentation and SRv6 SID blocks too; keep that stricter
// outbound policy separate so smart-link previews retain their existing rules.
const nonGlobalFaviconIpv6Ranges = new net.BlockList();
nonGlobalFaviconIpv6Ranges.addSubnet("3fff::", 20, "ipv6"); // documentation
nonGlobalFaviconIpv6Ranges.addSubnet("5f00::", 16, "ipv6"); // SRv6 SIDs

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168 || (b === 88 && parts[2] === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && parts[2] === 100)))
    || (a === 203 && b === 0 && parts[2] === 113)
    || a >= 224;
}

/** True for loopback, private, link-local, CGNAT, multicast and reserved IPs. */
export function isPrivateIpAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version !== 6) return true;
  // Be conservative: only ordinary global-unicast space is eligible, and
  // reject tunnelling/documentation ranges that can encode private IPv4.
  return !publicIpv6Ranges.check(address, "ipv6")
    || nonPublicIpv6Ranges.check(address, "ipv6");
}

/** True only for ordinary public unicast addresses. */
export function isPublicIpAddress(address: string): boolean {
  return !isPrivateIpAddress(address);
}

/** Strict public-unicast check for remote favicon fetches. */
export function isPublicFaviconAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) return !isPrivateIpv4(address);
  if (version !== 6) return false;
  return publicIpv6Ranges.check(address, "ipv6")
    && !nonPublicIpv6Ranges.check(address, "ipv6")
    && !nonGlobalFaviconIpv6Ranges.check(address, "ipv6");
}

/**
 * A `lookup` for `http(s).request` that always answers with an address already
 * vetted, so a second DNS answer cannot swap in between check and connect.
 * Node 20+ asks with `{ all: true }` (happy-eyeballs) and then requires an
 * array; answering that call with a bare address fails every request.
 */
export function pinnedLookup(address: string, family: 4 | 6): NonNullable<http.RequestOptions["lookup"]> {
  return ((_hostname: string, options: { all?: boolean } | undefined, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  }) as unknown as NonNullable<http.RequestOptions["lookup"]>;
}
