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

export function tailscaleDnsNameFromDevice(
  localDevice: SyncDeviceRecord,
): string | null {
  const value = localDevice.metadata?.tailscaleDnsName;
  return typeof value === "string" && value.trim().toLowerCase().endsWith(".ts.net")
    ? value.trim().replace(/\.$/, "").toLowerCase()
    : null;
}

export function buildAddressCandidates(
  localDevice: SyncDeviceRecord,
): SyncAddressCandidate[] {
  const candidates: SyncAddressCandidate[] = [];
  const seen = new Set<string>();
  const append = (
    host: string | null | undefined,
    kind: SyncAddressCandidate["kind"],
  ) => {
    const normalized = normalizeHost(host);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push({ host: normalized, kind });
  };
  const preferredSavedHost = normalizeHost(localDevice.lastHost);
  const preferredSavedHostKind: SyncAddressCandidate["kind"] | null = preferredSavedHost == null
    ? null
    : localDevice.ipAddresses.some((host) => normalizeHost(host) === preferredSavedHost)
      ? "lan"
      : normalizeHost(localDevice.tailscaleIp) === preferredSavedHost
        || tailscaleDnsNameFromDevice(localDevice) === preferredSavedHost
        ? "tailscale"
        : "saved";
  if (preferredSavedHostKind && preferredSavedHostKind !== "saved") {
    append(localDevice.lastHost, preferredSavedHostKind);
  }
  for (const lanAddress of localDevice.ipAddresses) {
    append(lanAddress, "lan");
  }
  if (preferredSavedHostKind === "saved") {
    append(localDevice.lastHost, "saved");
  }
  append(tailscaleDnsNameFromDevice(localDevice), "tailscale");
  append(localDevice.tailscaleIp, "tailscale");
  append("127.0.0.1", "loopback");
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
  const addressCandidates = buildAddressCandidates(argsIn.localDevice);
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
