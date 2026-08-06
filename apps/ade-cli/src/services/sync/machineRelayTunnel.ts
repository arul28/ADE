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
  // The last account that owned this machine, remembered for exactly as long as
  // the process runs.
  //
  // A rejected refresh grant (`expired`) or an unreadable credential store
  // (`unreadable`) blanks `userId` in `getStatus()`, and the relay lease used to
  // read that as "nobody owns this machine" and tear the tunnel down. That is
  // the 2026-08-05 shape of the incident: a token accident silently removed
  // every remote route to a machine the user still owns and still has paired
  // devices for, and the only fix was to walk over to it. The relay control
  // socket authenticates with machine credentials, not the account token, so the
  // tunnel keeps working while the account is repaired. Only a deliberate
  // `signed_out` -- the user signing out, or a different user signing in --
  // drops it.
  let retainedAccountOwnerId: string | null = null;
  const accountOwnership = (): { userId: string | null; retained: boolean } => {
    const status = args.accountAuthService.getStatus();
    const userId = status.signedIn ? status.userId?.trim() || null : null;
    if (userId) {
      retainedAccountOwnerId = userId;
      return { userId, retained: false };
    }
    const sessionState = status.sessionState;
    if (sessionState === "expired" || sessionState === "unreadable") {
      return { userId: retainedAccountOwnerId, retained: true };
    }
    retainedAccountOwnerId = null;
    return { userId: null, retained: false };
  };

  const tunnel = getSharedSyncTunnelClientService(args.configPath, () =>
    createSyncTunnelClientService({
      logger: args.logger,
      configStore: args.configStore,
      isAccountSignedIn: () => Boolean(accountOwnership().userId),
      getAccountLease: async () => {
        const ownership = accountOwnership();
        if (!ownership.userId) return null;
        if (ownership.retained) {
          // No live token to prove with, and asking for one would only churn a
          // grant we already know is dead. The identity is unchanged, so the
          // lease is unchanged; `expiresAt: null` keeps the tunnel from
          // treating this as a fresh, long-lived grant.
          return { userId: ownership.userId, expiresAt: null };
        }
        const userId = ownership.userId;
        const token = (await args.accountAuthService.getAccessToken()).trim();
        const refreshed = args.accountAuthService.getStatus();
        if (token && refreshed.signedIn && refreshed.userId?.trim() === userId) {
          return { userId, expiresAt: refreshed.expiresAt };
        }
        // The token round trip can itself be what marks the session expired.
        // Re-read ownership so that lands as "retained", not as a lost lease.
        const after = accountOwnership();
        return after.userId && after.retained
          ? { userId: after.userId, expiresAt: null }
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
