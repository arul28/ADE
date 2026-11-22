// Bind the sync host on all interfaces by default so phones on the same
// wifi/LAN can reach it without Tailscale. 0.0.0.0 is a superset of loopback,
// so local desktop clients (and the unix RPC socket, which is separate)
// keep working unchanged. Operators who want the old loopback-only posture can
// set ADE_SYNC_BIND_HOST=127.0.0.1; that mode also relaxes the PIN requirement
// for new bootstrap-token devices (see the hello handler in syncHostService)
// since loopback is already a trust boundary.
export const SYNC_HOST_BIND_HOST: string = process.env.ADE_SYNC_BIND_HOST?.trim() || "0.0.0.0";

/**
 * A loopback-only bind host: only local processes can connect, no LAN peer can
 * reach it, and no other address on the port can be shadowed.
 */
export function isLoopbackOnlyBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

// When the host is bound to loopback only, the OS already restricts connections
// to local processes, so first-pairing can fall back to the historical
// bootstrap-token behaviour. Any non-loopback bind (the LAN default) must gate
// new devices behind the PIN flow.
export const SYNC_HOST_BIND_LOOPBACK_ONLY: boolean = isLoopbackOnlyBindHost(SYNC_HOST_BIND_HOST);
