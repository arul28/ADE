import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MachineTailnetHttpsRoute } from "../../../../desktop/src/shared/types";
import { resolveTailscaleCliPath } from "./resolveTailscaleCliPath";
import { DEFAULT_SYNC_HOST_PORT, SYNC_HOST_MAX_PORT } from "./syncProtocol";
import { readTailscaleLocalStatus } from "./tailscaleLocalStatus";

const execFileAsync = promisify(execFile);

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
 * down. Same rule as the TCP ones: only ADE's exact shape (an HTTPS port in
 * ADE's offset range proxying `/` to 127.0.0.1 on the matching sync port).
 */
export function staleAdeTailnetHttpsPorts(
  serveStatusJson: string,
  currentHttpsPort: number | null,
): number[] {
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
  const stale: number[] = [];
  for (const [key, value] of Object.entries(tcp as Record<string, unknown>)) {
    const port = Number.parseInt(key, 10);
    if (!Number.isInteger(port) || port === currentHttpsPort) continue;
    const syncPort = port - SYNC_TAILNET_HTTPS_PORT_OFFSET;
    if (syncPort < DEFAULT_SYNC_HOST_PORT || syncPort > SYNC_HOST_MAX_PORT) continue;
    if ((value as { HTTPS?: unknown } | null)?.HTTPS !== true) continue;
    const proxiesToAde = Object.entries(web as Record<string, unknown>).some(([hostPort, entry]) => {
      if (!hostPort.endsWith(`:${port}`)) return false;
      const handlers = (entry as { Handlers?: Record<string, { Proxy?: unknown }> } | null)?.Handlers;
      return handlers?.["/"]?.Proxy === `http://127.0.0.1:${syncPort}`;
    });
    if (proxiesToAde) stale.push(port);
  }
  return stale.sort((left, right) => left - right);
}

type Logger = {
  info: (event: string, data?: Record<string, unknown>) => void;
  warn: (event: string, data?: Record<string, unknown>) => void;
};

export type TailnetHttpsServe = {
  route(): MachineTailnetHttpsRoute;
  /** Publish for this sync port, or say which tailnet switch is missing. */
  publish(syncPort: number, options?: { force?: boolean }): Promise<void>;
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

  const publish = async (syncPort: number, options?: { force?: boolean }): Promise<void> => {
    const attempt = ++sequence;
    const isCurrent = () => !args.isDisposed() && attempt === sequence && args.currentSyncPort() === syncPort;
    const status = await readTailscaleLocalStatus(options?.force ? { maxAgeMs: 2_000 } : undefined);
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
    if (!options?.force && servedPort === httpsPort && route.state === "published" && route.url === url) return;
    setRoute({ state: "publishing", url: null, error: null });
    wantedPort = httpsPort;
    try {
      await execFileAsync(
        resolveTailscaleCliPath(),
        ["serve", "--bg", `--https=${httpsPort}`, `http://127.0.0.1:${syncPort}`],
        { timeout: 15_000, windowsHide: true },
      );
      if (!isCurrent()) {
        // Unpublished (or moved to another port) while this ran: take back the
        // entry it just added, so the computer isn't left reachable on it.
        if (wantedPort !== httpsPort) await turnOff(httpsPort);
        return;
      }
      servedPort = httpsPort;
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
      await execFileAsync(resolveTailscaleCliPath(), ["serve", `--https=${port}`, "off"], {
        timeout: 10_000,
        windowsHide: true,
      });
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
    const stale = staleAdeTailnetHttpsPorts(serveStatusJson, syncPort == null ? null : tailnetHttpsPortFor(syncPort));
    let reclaimed = 0;
    for (const httpsPort of stale) {
      if (args.isDisposed() || httpsPort === servedPort) continue;
      if (await args.isLocalPortServing(httpsPort - SYNC_TAILNET_HTTPS_PORT_OFFSET)) continue;
      try {
        await execFileAsync(resolveTailscaleCliPath(), ["serve", `--https=${httpsPort}`, "off"], {
          timeout: 10_000,
          windowsHide: true,
        });
        reclaimed += 1;
      } catch {
        // One stubborn entry must not stop the rest; the count below says so.
      }
    }
    if (stale.length > 0) {
      args.logger.info("sync_host.tailnet_https_reclaimed", { staleCount: stale.length, reclaimed, ports: stale.slice(0, 20) });
    }
  };

  return { route: () => ({ ...route }), publish, unpublish, reclaimStale };
}
