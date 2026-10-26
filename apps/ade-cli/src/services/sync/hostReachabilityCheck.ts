import { execFile } from "node:child_process";
import {
  diagnoseHostReachability,
  readTailscaleStatus,
  type HostReachabilityFacts,
  type HostReachabilityReport,
} from "../../../../desktop/src/shared/connectionDiagnosis";
import type { SyncRoleSnapshot } from "../../../../desktop/src/shared/types/sync";
import { readRecentHostStall } from "../runtime/hostStallRecord";
import { resolveTailscaleCliPath } from "./resolveTailscaleCliPath";

const TAILSCALE_STATUS_TIMEOUT_MS = 4_000;
/** The relay self-probe dials the relay like a phone would; cap the wait. */
const RELAY_SELF_PROBE_TIMEOUT_MS = 12_000;

async function readTailscale(): Promise<HostReachabilityFacts["tailscale"]> {
  return await new Promise((resolve) => {
    execFile(
      resolveTailscaleCliPath(),
      ["status", "--json"],
      { timeout: TAILSCALE_STATUS_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          resolve({ installed: false, backendState: null, exitNodeName: null });
          return;
        }
        let parsed: unknown = null;
        try {
          parsed = stdout ? JSON.parse(stdout) : null;
        } catch {
          parsed = null;
        }
        if (!parsed) {
          // Installed, but its daemon did not answer: that is "not connected".
          resolve({ installed: true, backendState: error ? "Stopped" : null, exitNodeName: null });
          return;
        }
        resolve({ installed: true, ...readTailscaleStatus(parsed) });
      },
    );
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * "Can my other devices reach this computer?", answered on this computer.
 *
 * The client side can only say a route failed; this side knows why: whether
 * ADE is listening, whether the relay connection is up and a test connection
 * through it comes back, whether Tailscale is connected or routes everything
 * through an exit node that blocks the relay, and whether ADE froze here.
 */
export async function checkHostReachability(args: {
  getStatus: () => Promise<SyncRoleSnapshot>;
  runSelfProbe: (() => Promise<{ ok: boolean; detail: string }>) | null;
  accountSignedIn: boolean;
  /** Test seam; production asks the `tailscale` CLI. */
  readTailscaleStatus?: () => Promise<HostReachabilityFacts["tailscale"]>;
}): Promise<HostReachabilityReport> {
  const status = await args.getStatus();
  const probeEligible = args.accountSignedIn
    && status.routeHealth.relay.enabled
    && status.routeHealth.relay.relayControlConnected
    && status.routeHealth.relay.relayBridgeValidated;
  const [relaySelfProbe, tailscale] = await Promise.all([
    probeEligible && args.runSelfProbe
      ? withTimeout(
          args.runSelfProbe().catch((error: unknown) => ({
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
          })),
          RELAY_SELF_PROBE_TIMEOUT_MS,
          { ok: false, detail: "The relay test connection timed out." },
        )
      : Promise.resolve(null),
    (args.readTailscaleStatus ?? readTailscale)().catch(() => null),
  ]);
  return diagnoseHostReachability({
    routeHealth: status.routeHealth,
    accountSignedIn: args.accountSignedIn,
    relaySelfProbe,
    tailscale,
    lastStall: readRecentHostStall(),
    machineName: status.localDevice?.name ?? null,
  });
}
