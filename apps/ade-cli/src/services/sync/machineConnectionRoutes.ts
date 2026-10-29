import path from "node:path";
import type {
  MachineConnectionRoutes,
  MachineTailnetHttpsRoute,
} from "../../../../desktop/src/shared/types";
import { resolveMachineAdeLayout } from "../projects/machineLayout";
import {
  createSyncCloudRelayStore,
  SYNC_CLOUD_RELAY_FILE_NAME,
  type SyncCloudRelayStore,
} from "./syncCloudRelayStore";
import type { SyncTunnelClientService } from "./syncTunnelClientService";
import { readTailscaleLocalStatus } from "./tailscaleLocalStatus";

/**
 * This computer's connection routes, in one place.
 *
 * The relay tunnel and the Tailscale Serve entries are machine-wide: one
 * relay client per machine, and one sync host holding the lease publishes
 * Serve. Each registers here when it starts, so `account.getConnectionRoutes`
 * answers the same thing whichever scope or RPC surface asks.
 */

type RelayStore = Pick<SyncCloudRelayStore, "getMachineIdentity" | "getRelayPreference" | "setRelayEnabled">;

type RelayRouteSource = {
  store: RelayStore;
  tunnel: Pick<SyncTunnelClientService, "getStatus">;
  /**
   * The tunnel runs in this process. A brain without the sync host lease
   * builds the client but never starts it, and its status means nothing.
   */
  isRunning: () => boolean;
};

type TailnetRouteSource = {
  tcp(): { published: boolean; error: string | null };
  https(): MachineTailnetHttpsRoute;
  /** Re-reads Tailscale and publishes the HTTPS route if it can now. */
  recheckHttps(): Promise<void>;
};

// One per project scope (or the projectless brain); they share one tunnel
// client, and at most one holds the sync lease that runs it.
const relaySources = new Set<RelayRouteSource>();
// One per sync host; at most one actually publishes Serve.
const tailnetSources = new Set<TailnetRouteSource>();
let lastAutoRecheckAtMs = 0;
const AUTO_RECHECK_MIN_INTERVAL_MS = 60_000;
let machineStore: RelayStore | null = null;
const relayPreferenceListeners = new Set<() => void>();

/**
 * The machine's relay identity store, for a process that runs no tunnel (a
 * one-shot `account.call`, a brain without the sync lease). Same file the
 * tunnel's store reads, so the setting is the same either way.
 */
function currentRelaySource(): RelayRouteSource | null {
  const sources = [...relaySources];
  return sources.find((source) => source.isRunning()) ?? sources.at(-1) ?? null;
}

function relayStore(): RelayStore {
  const source = currentRelaySource();
  if (source) return source.store;
  machineStore ??= createSyncCloudRelayStore({
    filePath: path.join(resolveMachineAdeLayout().secretsDir, SYNC_CLOUD_RELAY_FILE_NAME),
  });
  return machineStore;
}

/** Returns an unregister function. */
export function registerMachineRelayRoute(source: RelayRouteSource): () => void {
  relaySources.add(source);
  return () => {
    relaySources.delete(source);
  };
}

/** Returns an unregister function. */
export function registerMachineTailnetRoute(source: TailnetRouteSource): () => void {
  tailnetSources.add(source);
  return () => {
    tailnetSources.delete(source);
  };
}

function currentTailnetSource(): TailnetRouteSource | null {
  const sources = [...tailnetSources];
  return sources.find((source) => source.tcp().published) ?? sources.at(-1) ?? null;
}

/**
 * Called after the relay setting changes, so route health and the account
 * directory catch up at once instead of on the next heartbeat.
 */
export function onMachineRelayPreferenceChanged(listener: () => void): () => void {
  relayPreferenceListeners.add(listener);
  return () => {
    relayPreferenceListeners.delete(listener);
  };
}

/** The `enabled` argument of `setRelayEnabled`, from any caller. */
export function readRelayEnabledArg(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error("account.setRelayEnabled requires enabled to be true or false.");
  }
  return value;
}

const NO_TAILNET_HOST_ERROR = "This ADE process doesn't publish Tailscale routes.";

export async function readMachineConnectionRoutes(args: {
  /** Ask Tailscale again instead of reusing the last minute's answer. */
  refresh?: boolean;
} = {}): Promise<MachineConnectionRoutes> {
  const tailnet = currentTailnetSource();
  if (args.refresh && tailnet) await tailnet.recheckHttps();
  const tailscale = await readTailscaleLocalStatus(args.refresh ? { maxAgeMs: 2_000 } : undefined);
  // MagicDNS and certificates are switched on in Tailscale's admin page, not
  // here, so nothing else would notice. When Tailscale now says the route can
  // exist and it doesn't, try again (at most once a minute).
  if (
    !args.refresh
    && tailnet
    && tailscale.state === "running"
    && tailscale.magicDnsEnabled
    && tailscale.httpsCertsEnabled
    && !["published", "publishing"].includes(tailnet.https().state)
    && Date.now() - lastAutoRecheckAtMs >= AUTO_RECHECK_MIN_INTERVAL_MS
  ) {
    lastAutoRecheckAtMs = Date.now();
    void tailnet.recheckHttps();
  }
  const relay = currentRelaySource();
  const store = relayStore();
  const preference = store.getRelayPreference();
  const tunnelStatus = relay?.isRunning() ? relay.tunnel.getStatus() : null;
  const relayError = preference.enabled && tunnelStatus && !tunnelStatus.connected
    ? tunnelStatus.lastError ?? tunnelStatus.lastControlError ?? null
    : null;
  return {
    machineKey: store.getMachineIdentity().machineKey,
    checkedAt: new Date().toISOString(),
    tailscale,
    tailnet: tailnet
      ? { observed: true, ...tailnet.tcp() }
      : { observed: false, published: false, error: NO_TAILNET_HOST_ERROR },
    tailnetHttps: tailnet?.https() ?? { state: "unavailable", url: null, error: NO_TAILNET_HOST_ERROR },
    relay: {
      enabled: preference.enabled,
      observed: tunnelStatus != null,
      connected: preference.enabled && tunnelStatus?.connected === true,
      changedAt: preference.changedAt,
      error: relayError,
    },
  };
}

export async function setMachineRelayEnabled(enabled: boolean): Promise<MachineConnectionRoutes> {
  // Read everything slow first. Turning the relay off closes it within a
  // second, and a caller that came in over the relay must get its answer
  // before that, so nothing is awaited after the setting is saved.
  const before = await readMachineConnectionRoutes();
  const preference = relayStore().setRelayEnabled(enabled);
  // Each listener re-publishes for its own scope and handles its own errors.
  for (const listener of [...relayPreferenceListeners]) listener();
  return {
    ...before,
    relay: {
      ...before.relay,
      enabled,
      connected: enabled && before.relay.connected,
      changedAt: preference.changedAt,
      error: enabled ? before.relay.error : null,
    },
  };
}
