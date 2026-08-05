import type { AccountAuthService } from "../account/accountAuthService";
import type { RelayTunnelAuthorityGate } from "./relayTunnelAuthorityGate";
import type { SyncTunnelClientService, TunnelHostListener } from "./syncTunnelClientService";

/**
 * The machine's ONE relay tunnel client, plus the lease gate that decides
 * whether this process may run it.
 *
 * Both brains that can host phone sync build this: `createAdeRuntime`, for a
 * project scope, and `runServe`'s projectless path, for a machine with nothing
 * registered. They must produce the same thing — the relay Durable Object keeps
 * one host control socket per machineKey and evicts the previous holder with
 * close code 4505, so two clients on one machine evict each other in a loop and
 * relay stays down for both.
 *
 * Only the reaction to a publication-state change genuinely differs between the
 * two, so that stays a parameter.
 */

type SyncTunnelClientArgs = Parameters<
  typeof import("./syncTunnelClientService")["createSyncTunnelClientService"]
>[0];

export type MachineRelayTunnelArgs = {
  logger?: SyncTunnelClientArgs["logger"];
  configStore: SyncTunnelClientArgs["configStore"];
  /**
   * The relay config file. It doubles as the machine-wide cache key, so a
   * project scope that boots after the projectless brain adopts that brain's
   * client instead of registering the same machineKey a second time.
   */
  configPath: string;
  /** Relay is usable only while the host has a current ADE account session. */
  accountAuthService: Pick<AccountAuthService, "getStatus" | "getAccessToken">;
  /**
   * The shared sync listener the relay bridges into, or null for a runtime that
   * does not host phone sync at all.
   */
  hostListener: TunnelHostListener | null;
  onPublicationStateChanged: NonNullable<SyncTunnelClientArgs["onPublicationStateChanged"]>;
  captureAnalytics: NonNullable<SyncTunnelClientArgs["captureAnalytics"]>;
};

export async function createMachineRelayTunnel(args: MachineRelayTunnelArgs): Promise<{
  tunnel: SyncTunnelClientService;
  gate: RelayTunnelAuthorityGate;
}> {
  const [
    { createSyncTunnelClientService, getSharedSyncTunnelClientService },
    { createRelayTunnelAuthorityGate },
    { holdsSyncHostSingleton, onSyncHostSingletonAuthorityChanged },
  ] = await Promise.all([
    import("./syncTunnelClientService"),
    import("./relayTunnelAuthorityGate"),
    import("./syncHostSingleton"),
  ]);
  const tunnel = getSharedSyncTunnelClientService(args.configPath, () =>
    createSyncTunnelClientService({
      logger: args.logger,
      configStore: args.configStore,
      isAccountSignedIn: () => {
        const status = args.accountAuthService.getStatus();
        return status.signedIn && Boolean(status.userId?.trim());
      },
      getAccountLease: async () => {
        const status = args.accountAuthService.getStatus();
        const userId = status.signedIn ? status.userId?.trim() || null : null;
        if (!userId) return null;
        const token = (await args.accountAuthService.getAccessToken()).trim();
        const refreshed = args.accountAuthService.getStatus();
        return token && refreshed.signedIn && refreshed.userId?.trim() === userId
          ? { userId, expiresAt: refreshed.expiresAt }
          : null;
      },
      onPublicationStateChanged: args.onPublicationStateChanged,
      // The analytics sink is machine-scoped and shared, so capturing it in this
      // one-per-machine factory closure is safe — unlike listener accessors,
      // which is why those go through attachHostListener below.
      captureAnalytics: args.captureAnalytics,
    }),
  );
  // Bind the listener OUTSIDE the factory, and before the gate. The client is
  // cached one-per-machine and built by whichever runtime bootstrapped first,
  // which is regularly a scope with no listener (headless one-shot, embedded
  // fallback); attaching here means the runtime that actually owns the listener
  // wins regardless of who created the instance. Attaching before the gate also
  // means the gate's very first `start()` already has a bridge to validate
  // against, since no later event would re-trigger validation.
  if (args.hostListener) tunnel.attachHostListener(args.hostListener);
  // Only the runtime holding the machine-wide sync host lease may register the
  // tunnel. See relayTunnelAuthorityGate for why the old "has a listener" gate
  // let secondary brains evict the real host.
  const gate = createRelayTunnelAuthorityGate({
    hostListener: args.hostListener,
    tunnel,
    holdsLease: holdsSyncHostSingleton,
    subscribe: onSyncHostSingletonAuthorityChanged,
    logger: args.logger,
  });
  return { tunnel, gate };
}
