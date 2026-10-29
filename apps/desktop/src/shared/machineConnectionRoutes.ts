import type {
  MachineConnectionRoutes,
  MachineTailnetHttpsState,
  MachineTailscaleState,
} from "./types/account";

/** Where to turn on MagicDNS and HTTPS certificates for a tailnet. */
export const TAILSCALE_DNS_ADMIN_URL = "https://login.tailscale.com/admin/dns";
export const TAILSCALE_DOWNLOAD_URL = "https://tailscale.com/download";
export const TAILSCALE_HTTPS_DOCS_URL = "https://tailscale.com/kb/1153/enabling-https";

const TAILSCALE_STATES: readonly MachineTailscaleState[] = [
  "running",
  "needs_login",
  "stopped",
  "starting",
  "not_installed",
  "unknown",
];
const HTTPS_STATES: readonly MachineTailnetHttpsState[] = [
  "published",
  "publishing",
  "needs_https_certs",
  "needs_magic_dns",
  "unavailable",
  "failed",
];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max = 512): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function flag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * Reads a `account.getConnectionRoutes` answer from any machine. Another
 * computer's ADE may be older or newer than this one, so every field is
 * checked and a missing one degrades instead of throwing.
 */
export function parseMachineConnectionRoutes(value: unknown): MachineConnectionRoutes | null {
  const root = record(value);
  if (!root) return null;
  const machineKey = text(root.machineKey, 128);
  if (!machineKey) return null;
  const tailscale = record(root.tailscale) ?? {};
  const tailnet = record(root.tailnet) ?? {};
  const https = record(root.tailnetHttps) ?? {};
  const relay = record(root.relay) ?? {};
  const tailscaleState = TAILSCALE_STATES.includes(tailscale.state as MachineTailscaleState)
    ? (tailscale.state as MachineTailscaleState)
    : "unknown";
  const httpsState = HTTPS_STATES.includes(https.state as MachineTailnetHttpsState)
    ? (https.state as MachineTailnetHttpsState)
    : "unavailable";
  const httpsUrl = text(https.url, 300);
  return {
    machineKey,
    checkedAt: text(root.checkedAt, 64) ?? new Date(0).toISOString(),
    tailscale: {
      state: tailscaleState,
      dnsName: text(tailscale.dnsName, 253),
      magicDnsEnabled: flag(tailscale.magicDnsEnabled),
      httpsCertsEnabled: flag(tailscale.httpsCertsEnabled),
      keyExpiry: text(tailscale.keyExpiry, 64),
      checkedAt: text(tailscale.checkedAt, 64) ?? new Date(0).toISOString(),
    },
    tailnet: {
      observed: tailnet.observed !== false,
      published: tailnet.published === true,
      error: text(tailnet.error),
    },
    tailnetHttps: {
      state: httpsState,
      url: httpsUrl && /^wss:\/\//i.test(httpsUrl) ? httpsUrl : null,
      error: text(https.error),
    },
    relay: {
      // Anything but an explicit `false` is the default: on.
      enabled: relay.enabled !== false,
      observed: relay.observed !== false,
      connected: relay.connected === true,
      changedAt: text(relay.changedAt, 64),
      error: text(relay.error),
    },
  };
}

/** Days until a Tailscale sign-in expires, or null when it does not expire. */
export function tailscaleKeyExpiryDays(keyExpiry: string | null, nowMs: number): number | null {
  if (!keyExpiry) return null;
  const at = Date.parse(keyExpiry);
  if (!Number.isFinite(at)) return null;
  return Math.floor((at - nowMs) / 86_400_000);
}
