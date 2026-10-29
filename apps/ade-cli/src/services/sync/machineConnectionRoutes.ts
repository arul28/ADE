import type {
  MachineConnectionRoutes,
  MachineTailnetHttpsRoute,
} from "../../../../desktop/src/shared/types";
import type { SyncCloudRelayStore } from "./syncCloudRelayStore";
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

type RelayRouteSource = {
  store: Pick<SyncCloudRelayStore, "getMachineIdentity" | "getRelayPreference" | "setRelayEnabled">;
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

let relaySource: RelayRouteSource | null = null;
let tailnetSource: TailnetRouteSource | null = null;
const relayPreferenceListeners = new Set<() => void>();

export function registerMachineRelayRoute(source: RelayRouteSource): void {
  relaySource = source;
}

/** Returns an unregister function; a later host replaces an earlier one. */
export function registerMachineTailnetRoute(source: TailnetRouteSource): () => void {
  tailnetSource = source;
  return () => {
    if (tailnetSource === source) tailnetSource = null;
  };
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

const NO_TAILNET_HOST_ERROR = "This ADE process doesn't publish Tailscale routes.";

export async function readMachineConnectionRoutes(args: {
  /** The relay identity store to fall back on when no tunnel runs in this process. */
  fallbackStore: Pick<SyncCloudRelayStore, "getMachineIdentity" | "getRelayPreference">;
  /** Ask Tailscale again instead of reusing the last minute's answer. */
  refresh?: boolean;
}): Promise<MachineConnectionRoutes> {
  const tailnet = tailnetSource;
  if (args.refresh && tailnet) {
    await tailnet.recheckHttps().catch(() => {});
  }
  const tailscale = await readTailscaleLocalStatus(args.refresh ? { maxAgeMs: 2_000 } : undefined);
  const store = relaySource?.store ?? args.fallbackStore;
  const preference = store.getRelayPreference();
  const relayObserved = relaySource?.isRunning() === true;
  const tunnelStatus = relayObserved ? relaySource!.tunnel.getStatus() : null;
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
      observed: relayObserved,
      connected: preference.enabled && tunnelStatus?.connected === true,
      changedAt: preference.changedAt,
      error: relayError,
    },
  };
}

export async function setMachineRelayEnabled(args: {
  enabled: boolean;
  fallbackStore: Pick<SyncCloudRelayStore, "getMachineIdentity" | "getRelayPreference" | "setRelayEnabled">;
}): Promise<MachineConnectionRoutes> {
  const store = relaySource?.store ?? args.fallbackStore;
  store.setRelayEnabled(args.enabled);
  for (const listener of [...relayPreferenceListeners]) {
    try {
      listener();
    } catch {
      // A listener that throws must not undo a saved setting.
    }
  }
  return await readMachineConnectionRoutes({ fallbackStore: args.fallbackStore });
}
