import type { TunnelHostListener } from "./syncTunnelClientService";

/**
 * Decides whether THIS runtime may hold the machine's relay tunnel.
 *
 * The relay Durable Object keeps one host control socket per machineKey and
 * evicts the previous holder (close code 4505). So when two brains on a machine
 * both dial it, each eviction triggers the other's reconnect and relay stays
 * down for both — silently, since nothing but `ade doctor` reported it.
 *
 * The gate is the machine-wide sync host LEASE, not the presence of a listener.
 * Gating on the listener was the original bug: a dev `serve` or an embedded
 * fallback binds an ephemeral listener without ever winning the lease, so it
 * passed the check and dialed anyway. The lease is acquired later in the
 * process lifetime (when the sync host starts) and can be released again, so
 * this subscribes to transitions instead of sampling once.
 */

export type RelayTunnelGateTunnel = {
  start(): Promise<void>;
  stop(): Promise<void>;
  attachHostListener(listener: TunnelHostListener | null): void;
  clearControlSuppression(): void;
};

export type RelayTunnelGateLogger = {
  info?: (event: string, data?: Record<string, unknown>) => void;
  warn?: (event: string, data?: Record<string, unknown>) => void;
};

export type RelayTunnelAuthorityGate = {
  /** True when the tunnel is running under this gate. */
  isRunning(): boolean;
  /** Detach the lease subscription. Never stops a running tunnel: the client is machine-level and shared across project scopes. */
  dispose(): void;
};

/**
 * How long authority must stay lost before the tunnel is torn down.
 *
 * A project switch deactivates the previous sync host BEFORE activating the
 * target (ProjectScopeRegistry.performSyncHostSwitch), so within one brain the
 * lease legitimately reads "not held" for the width of that handoff. Reacting
 * to that transient would stop and restart the machine's relay tunnel — and
 * churn the account-directory publisher — on every project switch. A real loss
 * of authority outlives this window; a handoff never does.
 */
export const SYNC_HOST_AUTHORITY_RELEASE_GRACE_MS = 5_000;

export type RelayTunnelAuthorityGateArgs = {
  /**
   * The brain-level shared listener the relay bridges into, or null for a
   * runtime that does not host phone sync at all.
   */
  hostListener: TunnelHostListener | null;
  tunnel: RelayTunnelGateTunnel;
  holdsLease: () => boolean;
  subscribe: (handler: (held: boolean) => void) => () => void;
  logger?: RelayTunnelGateLogger;
  /** Test seam. */
  releaseGraceMs?: number;
};

export function createRelayTunnelAuthorityGate(
  args: RelayTunnelAuthorityGateArgs,
): RelayTunnelAuthorityGate {
  const log = args.logger;
  const graceMs = args.releaseGraceMs ?? SYNC_HOST_AUTHORITY_RELEASE_GRACE_MS;
  const hasSyncListener = args.hostListener != null;
  let running = false;
  let releaseTimer: NodeJS.Timeout | null = null;
  // Bumped by every start/stop. `stop()` and `start()` are async, so a lease
  // reacquired mid-teardown could otherwise be shut down by the stop that was
  // already in flight.
  let lifecycleGeneration = 0;
  // Whether this gate has ever seen authority go away. A gate constructed while
  // the lease is already held (opening a second project) must not re-arm the
  // eviction suppression: that would reset the 4505 re-attempt budget and let
  // the war restart on every project open.
  let observedRelease = false;

  const clearReleaseTimer = (): void => {
    if (!releaseTimer) return;
    clearTimeout(releaseTimer);
    releaseTimer = null;
  };

  const startTunnel = (): void => {
    running = true;
    const generation = ++lifecycleGeneration;
    // Re-attach on every start. `stop()` drops the listener reference, and it
    // is otherwise attached exactly once per runtime at construction — so a
    // gate-driven stop/start cycle would come back with a live control socket
    // and no bridge, rejecting every phone connect with "host sync listener
    // unavailable" until the brain restarted.
    args.tunnel.attachHostListener(args.hostListener);
    if (observedRelease) {
      // Re-winning the lease makes this runtime the legitimate owner again, so
      // an earlier eviction no longer describes reality.
      args.tunnel.clearControlSuppression();
    }
    void args.tunnel.start().catch((error) => {
      if (generation !== lifecycleGeneration) return;
      log?.warn?.("sync.tunnel_start_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const stopTunnel = (): void => {
    running = false;
    const generation = ++lifecycleGeneration;
    log?.info?.("sync.tunnel_stopped_without_sync_host_lease", {
      reason: "This runtime no longer holds the machine-wide sync host lease.",
    });
    void args.tunnel.stop().then(
      () => {
        // A start that landed while this stop was in flight owns the tunnel
        // now; finishing the stop would tear down the live one.
        if (generation !== lifecycleGeneration || !running) return;
        args.tunnel.attachHostListener(args.hostListener);
        void args.tunnel.start().catch(() => {});
      },
      () => {},
    );
  };

  const apply = (held: boolean): void => {
    const shouldRun = hasSyncListener && held;
    if (shouldRun) {
      clearReleaseTimer();
      if (running) return;
      startTunnel();
      return;
    }
    if (!held) observedRelease = true;
    if (!running || releaseTimer) return;
    releaseTimer = setTimeout(() => {
      releaseTimer = null;
      if (args.holdsLease() && hasSyncListener) return;
      stopTunnel();
    }, graceMs);
    releaseTimer.unref?.();
  };

  const release = args.subscribe(apply);
  const held = args.holdsLease();
  if (!(hasSyncListener && held)) {
    log?.info?.("sync.tunnel_start_skipped", {
      reason: hasSyncListener
        ? "This runtime does not hold the machine-wide sync host lease; another ADE process owns phone sync and the relay."
        : "This runtime does not host the shared sync listener.",
      hasSyncListener,
      holdsSyncHostLease: held,
    });
  }
  apply(held);

  return {
    isRunning: () => running,
    dispose: () => {
      clearReleaseTimer();
      release();
    },
  };
}
