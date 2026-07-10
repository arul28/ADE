import type {
  SyncAddressCandidate,
  SyncAddressCandidateKind,
  SyncPairingConnectInfo,
  SyncPairingHostIdentity,
  SyncPairingQrPayload,
} from "./types/sync";

/**
 * Smart pairing URL codec. The QR encodes a single https URL whose fragment
 * carries the base64url JSON payload — scannable by the system camera, safe to
 * open in a browser (fragments never reach the server), and versioned so newer
 * payloads can add fields without breaking older scanners.
 */
export const PAIRING_QR_URL_BASE = "https://ade-app.dev/pair";
export const PAIRING_QR_PAYLOAD_VERSION = 3 as const;

const ADDRESS_CANDIDATE_KINDS: SyncAddressCandidateKind[] = ["lan", "saved", "tailscale", "loopback", "relay"];
const MAX_PAIRING_QR_PAYLOAD_BYTES = 8 * 1024;

function base64UrlEncodeUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = typeof btoa === "function"
    ? btoa(binary)
    : Buffer.from(bytes).toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecodeUtf8(value: string): string | null {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    if (typeof atob === "function") {
      const binary = atob(padded);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return new TextDecoder().decode(bytes);
    }
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

export function buildPairingQrPayload(args: {
  connectInfo: SyncPairingConnectInfo;
  relayUrl?: string | null;
  claimToken?: string | null;
  runtimeHostGrant?: string | null;
}): SyncPairingQrPayload {
  return {
    version: PAIRING_QR_PAYLOAD_VERSION,
    hostIdentity: args.connectInfo.hostIdentity,
    port: args.connectInfo.port,
    addressCandidates: args.connectInfo.addressCandidates,
    ...(args.relayUrl ? { relayUrl: args.relayUrl } : {}),
    ...(args.claimToken ? { claimToken: args.claimToken } : {}),
    ...(args.runtimeHostGrant ? { runtimeHostGrant: args.runtimeHostGrant } : {}),
  };
}

export function encodePairingQrUrl(payload: SyncPairingQrPayload): string {
  return `${PAIRING_QR_URL_BASE}#${base64UrlEncodeUtf8(JSON.stringify(payload))}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

function parseHostIdentity(value: unknown): SyncPairingHostIdentity | null {
  if (!isRecord(value)) return null;
  const deviceId = readString(value, "deviceId");
  const name = readString(value, "name");
  if (!deviceId || !name) return null;
  const platform = readString(value, "platform");
  const deviceType = readString(value, "deviceType");
  return {
    deviceId,
    siteId: readString(value, "siteId"),
    name,
    platform: (platform === "macOS" || platform === "iOS" || platform === "linux" || platform === "windows"
      ? platform
      : "unknown") as SyncPairingHostIdentity["platform"],
    deviceType: (deviceType === "desktop" || deviceType === "phone" || deviceType === "vps" || deviceType === "browser"
      ? deviceType
      : "unknown") as SyncPairingHostIdentity["deviceType"],
  };
}

function parseAddressCandidates(value: unknown): SyncAddressCandidate[] {
  if (!Array.isArray(value)) return [];
  const candidates: SyncAddressCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const host = readString(entry, "host");
    const kindRaw = readString(entry, "kind");
    if (!host || seen.has(host)) continue;
    const kind = (ADDRESS_CANDIDATE_KINDS as string[]).includes(kindRaw)
      ? (kindRaw as SyncAddressCandidateKind)
      : "lan";
    seen.add(host);
    candidates.push({ host, kind });
  }
  return candidates;
}

/**
 * Parses a scanned pairing QR string. Accepts the smart URL form (with the
 * payload in the fragment) and, defensively, a bare base64url/JSON payload.
 * Unknown future versions parse leniently: as long as the fields this build
 * understands are present, the scan works — that is the forward-compat story
 * for old apps scanning new QRs.
 */
export function parsePairingQrUrl(raw: string): SyncPairingQrPayload | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_PAIRING_QR_PAYLOAD_BYTES) return null;

  let encoded = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (url.pathname !== "/pair" && !url.pathname.endsWith("/pair")) return null;
    encoded = url.hash.startsWith("#") ? url.hash.slice(1) : "";
    if (!encoded) return null;
  }

  const json = encoded.startsWith("{") ? encoded : base64UrlDecodeUtf8(encoded);
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const version = Number(parsed.version);
  if (!Number.isFinite(version) || version < PAIRING_QR_PAYLOAD_VERSION) return null;
  const hostIdentity = parseHostIdentity(parsed.hostIdentity);
  if (!hostIdentity) return null;
  const port = Math.trunc(Number(parsed.port));
  if (!Number.isFinite(port) || port <= 0 || port > 65_535) return null;

  const relayUrl = readString(parsed, "relayUrl");
  const claimToken = readString(parsed, "claimToken");
  const runtimeHostGrant = readString(parsed, "runtimeHostGrant");
  return {
    version: PAIRING_QR_PAYLOAD_VERSION,
    hostIdentity,
    port,
    addressCandidates: parseAddressCandidates(parsed.addressCandidates),
    ...(relayUrl && /^wss:\/\//i.test(relayUrl) ? { relayUrl } : {}),
    ...(claimToken ? { claimToken } : {}),
    ...(runtimeHostGrant ? { runtimeHostGrant } : {}),
  };
}

export const parsePairingQrText = parsePairingQrUrl;
