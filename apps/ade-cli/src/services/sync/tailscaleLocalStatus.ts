import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  MachineTailscaleState,
  MachineTailscaleStatus,
} from "../../../../desktop/src/shared/types";
import { execFileOffThread, offThreadSpawnEnabled } from "../../../../desktop/src/main/services/shared/offThreadSpawn";
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

/** A MagicDNS name as ADE stores it: no trailing dot, lower case, `.ts.net` only. */
export function normalizeTailnetDnsName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\.$/, "").toLowerCase();
  return normalized.endsWith(".ts.net") ? normalized : null;
}

/**
 * One `tailscale status --json` run. Off the event loop where ADE spawns that
 * way (a Windows spawn on the loop blocked the brain ~100 ms per probe).
 */
type TailscaleStatusRun = {
  stdout: string;
  missing: boolean;
  /** Why the run gave no answer ADE could read, in one line; null when it answered. */
  failure: string | null;
};

const MAX_FAILURE_LENGTH = 200;
const LINE_BREAK = /\r?\n/;

/** One plain line for a run that failed: a timeout, then Tailscale's own words, then the error. */
function describeTailscaleRunFailure(args: { timedOut: boolean; stderr: string; error: unknown }): string | null {
  if (args.timedOut) return `Tailscale didn't answer within ${STATUS_TIMEOUT_MS / 1000} seconds.`;
  const said = args.stderr.split(LINE_BREAK).map((line) => line.trim()).find(Boolean);
  if (said) return said.slice(0, MAX_FAILURE_LENGTH);
  const message = args.error instanceof Error ? args.error.message.split(LINE_BREAK)[0]?.trim() : "";
  return message ? message.slice(0, MAX_FAILURE_LENGTH) : null;
}

async function runTailscaleStatus(): Promise<TailscaleStatusRun> {
  const cli = resolveTailscaleCliPath();
  const options = { timeoutMs: STATUS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 };
  if (offThreadSpawnEnabled()) {
    const result = await execFileOffThread(cli, ["status", "--json"], options);
    const failed = result.error != null || (result.exitCode != null && result.exitCode !== 0);
    return {
      stdout: result.stdout,
      missing: (result.error as NodeJS.ErrnoException | null)?.code === "ENOENT",
      failure: failed
        ? describeTailscaleRunFailure({ timedOut: result.timedOut === true, stderr: result.stderr, error: result.error })
        : null,
    };
  }
  try {
    const { stdout } = await execFileAsync(cli, ["status", "--json"], {
      timeout: STATUS_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: options.maxBuffer,
      // A stuck `tailscale` can ignore SIGTERM, and this read would then never
      // settle, holding back every later status read and shutdown.
      killSignal: "SIGKILL",
    });
    return { stdout, missing: false, failure: null };
  } catch (error) {
    // A signed-out or stopped Tailscale exits non-zero but still prints the
    // JSON; the caller reads it rather than calling a working install broken.
    const stdout = (error as { stdout?: unknown })?.stdout;
    const stderr = (error as { stderr?: unknown })?.stderr;
    return {
      stdout: typeof stdout === "string" ? stdout : "",
      missing: (error as NodeJS.ErrnoException | null)?.code === "ENOENT",
      failure: describeTailscaleRunFailure({
        timedOut: (error as { killed?: unknown })?.killed === true,
        stderr: typeof stderr === "string" ? stderr : "",
        error,
      }),
    };
  }
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

const MAX_HEALTH_MESSAGES = 4;
const MAX_HEALTH_LENGTH = 240;

/**
 * Tailscale's own warnings (`Health`): "key expired", "not connected to the
 * coordination server" and the like. Shown as Tailscale wrote them, since
 * they name the problem and usually the fix.
 */
function readTailscaleHealth(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const line = entry.replace(/\s+/g, " ").trim();
    if (!line || out.includes(line)) continue;
    out.push(line.slice(0, MAX_HEALTH_LENGTH));
    if (out.length >= MAX_HEALTH_MESSAGES) break;
  }
  return out;
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
      keyExpired: false,
      health: [],
      readError: "Tailscale answered with something ADE couldn't read.",
      checkedAt,
    };
  }
  const state = stateFromBackend(parsed.BackendState);
  const self = parsed.Self && typeof parsed.Self === "object"
    ? (parsed.Self as Record<string, unknown>)
    : null;
  const dnsName = normalizeTailnetDnsName(self?.DNSName);
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
  // An expired node key stops Tailscale until someone signs in again. It
  // says so with `Self.Expired`, and the date has passed.
  const expiryMs = keyExpiry ? Date.parse(keyExpiry) : Number.NaN;
  const checkedMs = Date.parse(checkedAt);
  const keyExpired = self?.Expired === true
    || (Number.isFinite(expiryMs) && Number.isFinite(checkedMs) && expiryMs <= checkedMs);
  return {
    state,
    dnsName: running ? dnsName : null,
    magicDnsEnabled: running ? magicDnsEnabled : null,
    httpsCertsEnabled: running ? (certDomains?.length ?? 0) > 0 : null,
    keyExpiry: running || keyExpired ? keyExpiry : null,
    keyExpired,
    health: readTailscaleHealth(parsed.Health),
    readError: null,
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
    const { stdout, missing, failure } = await runTailscaleStatus();
    if (!missing && stdout.trim().startsWith("{")) return parseTailscaleLocalStatus(stdout, checkedAt);
    return {
      state: missing ? "not_installed" : "unknown",
      dnsName: null,
      magicDnsEnabled: null,
      httpsCertsEnabled: null,
      keyExpiry: null,
      keyExpired: false,
      health: [],
      readError: missing ? null : failure ?? "Tailscale gave no answer.",
      checkedAt,
    };
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
