import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MachineTailnetHttpsRoute } from "../../../../desktop/src/shared/types";
import { resolveTailscaleCliPath } from "./resolveTailscaleCliPath";
import {
  DEFAULT_SYNC_HOST_PORT,
  SYNC_EPHEMERAL_PORT_FLOOR,
  SYNC_HOST_MAX_PORT,
  SYNC_PORT_SCAN_ABOVE,
} from "./syncProtocol";
import { readTailscaleLocalStatus } from "./tailscaleLocalStatus";

const execFileAsync = promisify(execFile);

/**
 * One queue for every `tailscale serve` change ADE makes on this machine.
 * Serve is machine-global and two commands for one port (a publish to the
 * side door, then back to the sync port) must land in the order they were
 * issued, or the older one can win and forward to a port nothing serves.
 */
let serveQueue: Promise<unknown> = Promise.resolve();
export function enqueueTailscaleServe<T>(work: () => Promise<T>): Promise<T> {
  const run = serveQueue.then(work, work);
  serveQueue = run.catch(() => undefined);
  return run;
}

/** A stuck `tailscale` can ignore SIGTERM, so a timeout kills it outright. */
const runServe = (serveArgs: string[], timeoutMs: number) => enqueueTailscaleServe(() => execFileAsync(
  resolveTailscaleCliPath(),
  ["serve", ...serveArgs],
  { timeout: timeoutMs, windowsHide: true, killSignal: "SIGKILL" },
));

/**
 * The loopback port an ADE serve entry for `syncPort` forwards to, or null when
 * the forward is not one ADE makes: `127.0.0.1:<syncPort>` itself, or the side
 * door the listener opens while another program holds that address (a few
 * ports above it, or an OS-assigned one). Anything else is never treated as
 * ADE's. A stale side door cannot be identity-probed, so this is a shape
 * match: a hand-set serve of exactly this shape is treated as ADE's too, and
 * reclaim removes it only while nothing serves at either end.
 */
export function adeLoopbackForwardPort(syncPort: number, forward: unknown): number | null {
  if (typeof forward !== "string") return null;
  const match = /^(?:http:\/\/)?127\.0\.0\.1:(\d{1,5})$/.exec(forward);
  if (!match) return null;
  const target = Number(match[1]);
  if (!(target > 0 && target <= 65_535)) return null;
  const isSideDoor = (target > syncPort && target <= syncPort + SYNC_PORT_SCAN_ABOVE)
    || target >= SYNC_EPHEMERAL_PORT_FLOOR;
  return target === syncPort || isSideDoor ? target : null;
}

/**
 * The secure Tailscale route sits this far above the sync port, so each ADE
 * channel on a machine (each with its own sync port) gets its own HTTPS port,
 * and none of them can land inside the range the sync listener binds.
 */
export const SYNC_TAILNET_HTTPS_PORT_OFFSET = 10_000;

export function tailnetHttpsPortFor(syncPort: number): number {
  return syncPort + SYNC_TAILNET_HTTPS_PORT_OFFSET;
}

/**
 * HTTPS Serve entries ADE published for an earlier sync port and never tore
 * down. Same rule as the TCP ones: only ADE's shape (an HTTPS port in ADE's
 * offset range proxying `/` to 127.0.0.1, on the matching sync port or the
 * side door the listener opened while another program held that port).
 * Returns each entry with the loopback port it forwards to.
 */
export function staleAdeTailnetHttpsEntries(
  serveStatusJson: string,
  currentHttpsPort: number | null,
): Array<{ port: number; target: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serveStatusJson);
  } catch {
    return [];
  }
  const root = parsed as { TCP?: unknown; Web?: unknown } | null;
  const tcp = root?.TCP;
  const web = root?.Web;
  if (!tcp || typeof tcp !== "object" || !web || typeof web !== "object") return [];
  const stale: Array<{ port: number; target: number }> = [];
  for (const [key, value] of Object.entries(tcp as Record<string, unknown>)) {
    const port = Number.parseInt(key, 10);
    if (!Number.isInteger(port) || port === currentHttpsPort) continue;
    const syncPort = port - SYNC_TAILNET_HTTPS_PORT_OFFSET;
    if (syncPort < DEFAULT_SYNC_HOST_PORT || syncPort > SYNC_HOST_MAX_PORT) continue;
    if ((value as { HTTPS?: unknown } | null)?.HTTPS !== true) continue;
    let target: number | null = null;
    for (const [hostPort, entry] of Object.entries(web as Record<string, unknown>)) {
      if (!hostPort.endsWith(`:${port}`)) continue;
      const handlers = (entry as { Handlers?: Record<string, { Proxy?: unknown }> } | null)?.Handlers;
      target = adeLoopbackForwardPort(syncPort, handlers?.["/"]?.Proxy);
      if (target != null) break;
    }
    if (target != null) stale.push({ port, target });
  }
  return stale.sort((left, right) => left.port - right.port);
}

/** The HTTPS ports of {@link staleAdeTailnetHttpsEntries}. */
export function staleAdeTailnetHttpsPorts(
  serveStatusJson: string,
  currentHttpsPort: number | null,
): number[] {
  return staleAdeTailnetHttpsEntries(serveStatusJson, currentHttpsPort).map((entry) => entry.port);
}

type Logger = {
  info: (event: string, data?: Record<string, unknown>) => void;
  warn: (event: string, data?: Record<string, unknown>) => void;
};

export type TailnetHttpsServe = {
  route(): MachineTailnetHttpsRoute;
  /**
   * Publish for this sync port, or say which tailnet switch is missing.
   * `targetPort` is where 127.0.0.1 reaches ADE (the sync port, or the
   * listener's side door); the HTTPS port still follows the sync port.
   */
  publish(syncPort: number, options?: { force?: boolean; targetPort?: number }): Promise<void>;
  unpublish(): Promise<void>;
  /** Tear down ADE's HTTPS entries for earlier sync ports, from one `serve status --json` read. */
  reclaimStale(serveStatusJson: string): Promise<void>;
};

/**
 * `tailscale serve --https` in front of the sync listener, so a browser on
 * the tailnet can open `wss://<name>.ts.net:<port>`. Needs MagicDNS and HTTPS
 * certificates on the tailnet; when either is off the route says which, so
 * the Account page can link straight to the switch.
 */
export function createTailnetHttpsServe(args: {
  logger: Logger;
  /** The sync port the TCP route is published for right now, or null. */
  currentSyncPort: () => number | null;
  isDisposed: () => boolean;
  isLocalPortServing: (port: number) => Promise<boolean>;
  onChanged: () => void;
}): TailnetHttpsServe {
  let route: MachineTailnetHttpsRoute = {
    state: "unavailable",
    url: null,
    error: "Tailscale has not been checked yet.",
  };
  let servedPort: number | null = null;
  let servedTarget: number | null = null;
  // The HTTPS port the newest publish is for; null after an unpublish. A
  // publish that finishes after it was superseded removes what it added
  // unless a newer publish wants the same port.
  let wantedPort: number | null = null;
  let sequence = 0;

  const setRoute = (next: MachineTailnetHttpsRoute): void => {
    const changed = next.state !== route.state || next.url !== route.url || next.error !== route.error;
    route = next;
    if (changed) args.onChanged();
  };

  const publish = async (syncPort: number, options?: { force?: boolean; targetPort?: number }): Promise<void> => {
    const targetPort = options?.targetPort ?? syncPort;
    const attempt = ++sequence;
    // A newer attempt that stops before `serve` must still let an older one
    // in flight take its entry back, so only an attempt that reaches `serve`
    // claims a port.
    wantedPort = null;
    const isCurrent = () => !args.isDisposed() && attempt === sequence && args.currentSyncPort() === syncPort;
    let status: Awaited<ReturnType<typeof readTailscaleLocalStatus>>;
    try {
      status = await readTailscaleLocalStatus(options?.force ? { maxAgeMs: 2_000 } : undefined);
    } catch (error: unknown) {
      args.logger.warn("sync_host.tailnet_https_status_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!isCurrent()) return;
    if (status.state === "not_installed") {
      setRoute({ state: "unavailable", url: null, error: "Tailscale isn't installed on this computer." });
      return;
    }
    if (status.state !== "running") {
      setRoute({ state: "unavailable", url: null, error: "Tailscale isn't connected on this computer." });
      return;
    }
    if (!status.dnsName || status.magicDnsEnabled === false) {
      setRoute({ state: "needs_magic_dns", url: null, error: "MagicDNS is off for your tailnet." });
      return;
    }
    if (!status.httpsCertsEnabled) {
      setRoute({ state: "needs_https_certs", url: null, error: "HTTPS certificates are off for your tailnet." });
      return;
    }
    const httpsPort = tailnetHttpsPortFor(syncPort);
    const url = `wss://${status.dnsName}:${httpsPort}`;
    if (
      !options?.force
      && servedPort === httpsPort
      && servedTarget === targetPort
      && route.state === "published"
      && route.url === url
    ) return;
    setRoute({ state: "publishing", url: null, error: null });
    wantedPort = httpsPort;
    try {
      await runServe(["--bg", `--https=${httpsPort}`, `http://127.0.0.1:${targetPort}`], 15_000);
      if (!isCurrent()) {
        // Unpublished (or moved to another port) while this ran: take back the
        // entry it just added, so the computer isn't left reachable on it.
        if (wantedPort !== httpsPort) {
          await turnOff(httpsPort);
          if (servedPort === httpsPort) servedPort = null;
        }
        return;
      }
      servedPort = httpsPort;
      servedTarget = targetPort;
      setRoute({ state: "published", url, error: null });
      args.logger.info("sync_host.tailnet_https_published", { httpsPort, syncPort });
    } catch (error: unknown) {
      if (!isCurrent()) return;
      const stderr = typeof (error as { stderr?: unknown })?.stderr === "string"
        ? String((error as { stderr?: string }).stderr).trim()
        : "";
      const message = error instanceof Error ? error.message : String(error);
      // Tailscale refuses `--https` with a pointer to the admin page when the
      // tailnet has certificates off, even if `CertDomains` said otherwise a
      // minute ago. Read stderr only: the message repeats the command line,
      // which always says `--https`.
      const certsOff = /https/i.test(stderr) && /(not enabled|disabled|enable https|certificate)/i.test(stderr);
      setRoute(certsOff
        ? { state: "needs_https_certs", url: null, error: "HTTPS certificates are off for your tailnet." }
        : { state: "failed", url: null, error: stderr || message });
      args.logger.warn("sync_host.tailnet_https_publish_failed", {
        httpsPort,
        syncPort,
        error: message,
        stderr: stderr || null,
      });
    }
  };

  const turnOff = async (port: number): Promise<void> => {
    try {
      await runServe([`--https=${port}`, "off"], 10_000);
    } catch (error: unknown) {
      args.logger.warn("sync_host.tailnet_https_unpublish_failed", {
        httpsPort: port,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const unpublish = async (): Promise<void> => {
    sequence += 1;
    wantedPort = null;
    const port = servedPort;
    servedPort = null;
    setRoute({ state: "unavailable", url: null, error: null });
    if (port != null) await turnOff(port);
  };

  // An HTTPS entry left by an earlier sync port proxies into nothing. Probe
  // before each teardown so a sibling ADE's live entry is never removed.
  const reclaimStale = async (serveStatusJson: string): Promise<void> => {
    const syncPort = args.currentSyncPort();
    const stale = staleAdeTailnetHttpsEntries(serveStatusJson, syncPort == null ? null : tailnetHttpsPortFor(syncPort));
    let reclaimed = 0;
    for (const { port: httpsPort, target } of stale) {
      if (args.isDisposed() || httpsPort === servedPort) continue;
      // A sibling ADE's live entry has something serving behind it, on its
      // sync port or on the side door it forwards to.
      if (await args.isLocalPortServing(httpsPort - SYNC_TAILNET_HTTPS_PORT_OFFSET)) continue;
      if (target !== httpsPort - SYNC_TAILNET_HTTPS_PORT_OFFSET && await args.isLocalPortServing(target)) continue;
      try {
        await runServe([`--https=${httpsPort}`, "off"], 10_000);
        reclaimed += 1;
      } catch {
        // One stubborn entry must not stop the rest; the count below says so.
      }
    }
    if (stale.length > 0) {
      args.logger.info("sync_host.tailnet_https_reclaimed", {
        staleCount: stale.length,
        reclaimed,
        ports: stale.slice(0, 20).map((entry) => entry.port),
      });
    }
  };

  return { route: () => ({ ...route }), publish, unpublish, reclaimStale };
}
