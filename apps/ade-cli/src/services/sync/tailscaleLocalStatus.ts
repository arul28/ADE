import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  MachineTailscaleState,
  MachineTailscaleStatus,
} from "../../../../desktop/src/shared/types";
import { resolveTailscaleCliPath } from "./resolveTailscaleCliPath";

const execFileAsync = promisify(execFile);

/**
 * How long one `tailscale status --json` answer is reused. The Account page
 * reads every 30 seconds and the HTTPS route asks on every publish; on macOS
 * the app-bundle CLI can raise a privacy prompt, so it must not run per read.
 */
const STATUS_TTL_MS = 60_000;
const STATUS_TIMEOUT_MS = 5_000;

function nowIso(): string {
  return new Date().toISOString();
}

function stateFromBackend(value: unknown): MachineTailscaleState {
  switch (value) {
    case "Running":
      return "running";
    case "NeedsLogin":
    case "NeedsMachineAuth":
      return "needs_login";
    case "Stopped":
      return "stopped";
    case "Starting":
    case "NoState":
      return "starting";
    default:
      return "unknown";
  }
}

/** Reads what ADE needs from `tailscale status --json`. Tolerates any shape. */
export function parseTailscaleLocalStatus(
  stdout: string,
  checkedAt: string = nowIso(),
): MachineTailscaleStatus {
  let parsed: Record<string, unknown> | null = null;
  try {
    const value: unknown = JSON.parse(stdout);
    parsed = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return {
      state: "unknown",
      dnsName: null,
      magicDnsEnabled: null,
      httpsCertsEnabled: null,
      keyExpiry: null,
      checkedAt,
    };
  }
  const state = stateFromBackend(parsed.BackendState);
  const self = parsed.Self && typeof parsed.Self === "object"
    ? (parsed.Self as Record<string, unknown>)
    : null;
  const rawDnsName = typeof self?.DNSName === "string"
    ? self.DNSName.trim().replace(/\.$/, "").toLowerCase()
    : "";
  const tailnet = parsed.CurrentTailnet && typeof parsed.CurrentTailnet === "object"
    ? (parsed.CurrentTailnet as Record<string, unknown>)
    : null;
  const magicDnsEnabled = typeof tailnet?.MagicDNSEnabled === "boolean"
    ? tailnet.MagicDNSEnabled
    : null;
  // `CertDomains` lists the names this node may get certificates for. It is
  // only filled in when the tailnet has HTTPS certificates turned on.
  const certDomains = Array.isArray(parsed.CertDomains) ? parsed.CertDomains : null;
  const running = state === "running";
  const keyExpiry = typeof self?.KeyExpiry === "string" && self.KeyExpiry.trim()
    ? self.KeyExpiry.trim()
    : null;
  return {
    state,
    dnsName: running && rawDnsName.endsWith(".ts.net") ? rawDnsName : null,
    magicDnsEnabled: running ? magicDnsEnabled : null,
    httpsCertsEnabled: running ? (certDomains?.length ?? 0) > 0 : null,
    keyExpiry: running ? keyExpiry : null,
    checkedAt,
  };
}

let cached: { status: MachineTailscaleStatus; atMs: number } | null = null;
let inFlight: Promise<MachineTailscaleStatus> | null = null;

/**
 * This computer's Tailscale, cached for a minute. `maxAgeMs` lets a caller
 * that just changed something (a "Check again" press) ask for a fresher read.
 */
export async function readTailscaleLocalStatus(options?: {
  maxAgeMs?: number;
}): Promise<MachineTailscaleStatus> {
  const maxAgeMs = options?.maxAgeMs ?? STATUS_TTL_MS;
  if (cached && Date.now() - cached.atMs <= maxAgeMs) return cached.status;
  if (inFlight) return await inFlight;
  const read = (async (): Promise<MachineTailscaleStatus> => {
    const checkedAt = nowIso();
    try {
      const { stdout } = await execFileAsync(
        resolveTailscaleCliPath(),
        ["status", "--json"],
        { timeout: STATUS_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      );
      return parseTailscaleLocalStatus(stdout, checkedAt);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null | undefined)?.code ?? null;
      // A signed-out or stopped Tailscale exits non-zero but still prints the
      // JSON; read it rather than calling a working install broken.
      const stdout = typeof (error as { stdout?: unknown })?.stdout === "string"
        ? (error as { stdout: string }).stdout
        : "";
      if (code !== "ENOENT" && stdout.trim().startsWith("{")) {
        return parseTailscaleLocalStatus(stdout, checkedAt);
      }
      return {
        state: code === "ENOENT" ? "not_installed" : "unknown",
        dnsName: null,
        magicDnsEnabled: null,
        httpsCertsEnabled: null,
        keyExpiry: null,
        checkedAt,
      };
    }
  })();
  inFlight = read;
  try {
    const status = await read;
    cached = { status, atMs: Date.now() };
    return status;
  } finally {
    if (inFlight === read) inFlight = null;
  }
}
