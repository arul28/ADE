import type {
  SyncAddressCandidate,
  SyncDeviceRecord,
  SyncPairingConnectInfo,
} from "../../../../desktop/src/shared/types";
import { DEFAULT_SYNC_HOST_PORT } from "./syncProtocol";
import { SYNC_HOST_BIND_LOOPBACK_ONLY } from "./sharedSyncListener";

function normalizeHost(host: string | null | undefined): string | null {
  if (!host) return null;
  const normalized = host.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

// The dialer parses each host with the WHATWG URL parser, which also reads
// 2130706433, 0x7f000001, 0177.0.0.1 and ::ffff:7f00:1 as this machine. So the
// check runs on the canonical form, not on the spelling a peer recorded.
export function isLoopbackHost(host: string): boolean {
  let canonical: string;
  try {
    const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    canonical = new URL(`ws://${authority}/`).hostname;
  } catch {
    return false;
  }
  const bare = canonical.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return bare === "localhost"
    || bare === "::1"
    || /^127(\.\d{1,3}){3}$/.test(bare)
    || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(bare);
}

export function tailscaleDnsNameFromDevice(
  localDevice: SyncDeviceRecord,
): string | null {
  const value = localDevice.metadata?.tailscaleDnsName;
  return typeof value === "string" && value.trim().toLowerCase().endsWith(".ts.net")
    ? value.trim().replace(/\.$/, "").toLowerCase()
    : null;
}

export function buildAddressCandidates(
  device: SyncDeviceRecord,
  options: {
    isLocalDevice: boolean;
    /**
     * The local listener serves its LAN addresses. False for a loopback-only
     * bind (ADE_SYNC_BIND_HOST=127.0.0.1): no peer can reach it on one, so no
     * pairing surface, directory row or QR code may offer one.
     */
    servesLan?: boolean;
  },
): SyncAddressCandidate[] {
  const servesLan = !options.isLocalDevice || options.servesLan !== false;
  const candidates: SyncAddressCandidate[] = [];
  const seen = new Set<string>();
  const append = (
    host: string | null | undefined,
    kind: SyncAddressCandidate["kind"],
  ) => {
    const normalized = normalizeHost(host);
    if (!normalized || seen.has(normalized)) return;
    // A remote device's loopback address still means this machine, whichever
    // source recorded it: a relay-bridged peer is seen from 127.0.0.1.
    if (!options.isLocalDevice && isLoopbackHost(normalized)) return;
    seen.add(normalized);
    candidates.push({ host: normalized, kind });
  };
  const preferredSavedHost = normalizeHost(device.lastHost);
  const preferredSavedHostKind: SyncAddressCandidate["kind"] | null = preferredSavedHost == null
    ? null
    : device.ipAddresses.some((host) => normalizeHost(host) === preferredSavedHost)
      ? "lan"
      : normalizeHost(device.tailscaleIp) === preferredSavedHost
        || tailscaleDnsNameFromDevice(device) === preferredSavedHost
        ? "tailscale"
        : "saved";
  if (preferredSavedHostKind && preferredSavedHostKind !== "saved" && (servesLan || preferredSavedHostKind !== "lan")) {
    append(device.lastHost, preferredSavedHostKind);
  }
  if (servesLan) {
    for (const lanAddress of device.ipAddresses) {
      append(lanAddress, "lan");
    }
  }
  if (preferredSavedHostKind === "saved") {
    append(device.lastHost, "saved");
  }
  append(tailscaleDnsNameFromDevice(device), "tailscale");
  append(device.tailscaleIp, "tailscale");
  // Loopback is this machine only for the local device; for any other device
  // the append guard above drops it, so the candidate list stays empty rather
  // than pointing at this machine's own listener.
  if (options.isLocalDevice) append("127.0.0.1", "loopback");
  return candidates;
}

/**
 * The port to advertise: the live one, whatever it is. A listener that had to
 * move to an OS-assigned port (every port above a taken one was busy) is
 * outside ADE's usual range, and clamping it back to 8787 would send phones
 * to the program that forced the move. What the listener may bind is bounded
 * where it binds (`buildSyncHostPortCandidates`).
 */
function normalizeSyncHostPort(port: number | null | undefined): number {
  if (!Number.isFinite(port)) return DEFAULT_SYNC_HOST_PORT;
  const parsed = Math.floor(Number(port));
  return parsed >= 1 && parsed <= 65_535 ? parsed : DEFAULT_SYNC_HOST_PORT;
}

export function buildPairingConnectInfo(argsIn: {
  localDevice: SyncDeviceRecord;
  relayWssUrl?: string | null;
}): SyncPairingConnectInfo {
  const port = normalizeSyncHostPort(argsIn.localDevice.lastPort);
  const addressCandidates = buildAddressCandidates(argsIn.localDevice, {
    isLocalDevice: true,
    servesLan: !SYNC_HOST_BIND_LOOPBACK_ONLY,
  });
  // The cloud relay is the lowest-priority path: phones try every direct
  // candidate first and fall back to the tunnel only when nothing answers.
  if (argsIn.relayWssUrl) {
    addressCandidates.push({ host: argsIn.relayWssUrl, kind: "relay" });
  }
  const hostIdentity = {
    deviceId: argsIn.localDevice.deviceId,
    siteId: argsIn.localDevice.siteId,
    name: argsIn.localDevice.name,
    platform: argsIn.localDevice.platform,
    deviceType: argsIn.localDevice.deviceType,
  };
  return {
    hostIdentity,
    port,
    addressCandidates,
  };
}
