import type {
  SyncAddressCandidate,
  SyncDeviceRecord,
  SyncPairingConnectInfo,
} from "../../../../desktop/src/shared/types";
import { DEFAULT_SYNC_HOST_PORT, SYNC_HOST_MAX_PORT } from "./syncProtocol";

function normalizeHost(host: string | null | undefined): string | null {
  if (!host) return null;
  const normalized = host.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function isLoopbackHost(normalized: string): boolean {
  return normalized === "localhost"
    || normalized === "::1"
    || normalized.startsWith("127.")
    || normalized.startsWith("::ffff:127.");
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
  options: { isLocalDevice: boolean },
): SyncAddressCandidate[] {
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
  if (preferredSavedHostKind && preferredSavedHostKind !== "saved") {
    append(device.lastHost, preferredSavedHostKind);
  }
  for (const lanAddress of device.ipAddresses) {
    append(lanAddress, "lan");
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

function normalizeSyncHostPort(port: number | null | undefined): number {
  const parsed = Number.isFinite(port)
    ? Math.max(1, Math.min(65_535, Math.floor(Number(port))))
    : DEFAULT_SYNC_HOST_PORT;
  return parsed >= DEFAULT_SYNC_HOST_PORT && parsed <= SYNC_HOST_MAX_PORT
    ? parsed
    : DEFAULT_SYNC_HOST_PORT;
}

export function buildPairingConnectInfo(argsIn: {
  localDevice: SyncDeviceRecord;
  relayWssUrl?: string | null;
}): SyncPairingConnectInfo {
  const port = normalizeSyncHostPort(argsIn.localDevice.lastPort);
  const addressCandidates = buildAddressCandidates(argsIn.localDevice, { isLocalDevice: true });
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
