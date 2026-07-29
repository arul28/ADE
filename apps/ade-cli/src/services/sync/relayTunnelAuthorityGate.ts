import {
  holdsSyncHostSingleton,
  onSyncHostSingletonAuthorityChanged,
} from "./syncHostSingleton";

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

export type RelayTunnelAuthorityGateDeps = {
  /** Test seams; production uses the process-wide lease registry. */
  holdsLease?: () => boolean;
  subscribe?: (handler: (held: boolean) => void) => () => void;
};

export function createRelayTunnelAuthorityGate(
  args: {
    hasSyncListener: boolean;
    tunnel: RelayTunnelGateTunnel;
    logger?: RelayTunnelGateLogger;
  },
  deps: RelayTunnelAuthorityGateDeps = {},
): RelayTunnelAuthorityGate {
  const holdsLease = deps.holdsLease ?? holdsSyncHostSingleton;
  const subscribe = deps.subscribe ?? onSyncHostSingletonAuthorityChanged;
  const log = args.logger;
  let running = false;

  const apply = (held: boolean): void => {
    const shouldRun = args.hasSyncListener && held;
    if (shouldRun === running) return;
    running = shouldRun;
    if (shouldRun) {
      // Winning the lease makes this runtime the legitimate owner, so an
      // earlier eviction no longer describes reality.
      args.tunnel.clearControlSuppression();
      void args.tunnel.start().catch((error) => {
        log?.warn?.("sync.tunnel_start_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    log?.info?.("sync.tunnel_stopped_without_sync_host_lease", {
      reason: "This runtime no longer holds the machine-wide sync host lease.",
    });
    void args.tunnel.stop().catch(() => {});
  };

  const release = subscribe(apply);
  const held = holdsLease();
  if (!(args.hasSyncListener && held)) {
    log?.info?.("sync.tunnel_start_skipped", {
      reason: args.hasSyncListener
        ? "This runtime does not hold the machine-wide sync host lease; another ADE process owns phone sync and the relay."
        : "This runtime does not host the shared sync listener.",
      hasSyncListener: args.hasSyncListener,
      holdsSyncHostLease: held,
    });
  }
  apply(held);

  return {
    isRunning: () => running,
    dispose: () => release(),
  };
}
