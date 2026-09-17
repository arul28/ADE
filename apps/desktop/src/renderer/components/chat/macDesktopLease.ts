import { MAC_DESKTOP_LEASE_TTL_MS } from "../../../shared/types/macDesktop";

/**
 * The takeover heartbeat, as a plain object with no React in it.
 *
 * The lease is a deadline on the host, not a flag: it lapses unless somebody
 * renews it, which is exactly what makes a closed laptop or a dropped tunnel
 * give the lane back to the agent. That means the renewal loop is the load
 * bearing part of takeover, and it has three ways to go wrong that are all
 * invisible in a running app — renewing after control was returned, renewing
 * from two components at once, and holding the interval open after the view
 * unmounted so a hidden tab keeps a lane hostage.
 *
 * Extracted here so all three are testable with fake timers and no DOM.
 *
 * The period is a third of the TTL: one lost renewal (a hiccup on the RPC, a
 * sleeping remote) must not end the takeover, and two are enough of a signal
 * that the viewer is gone.
 */

export const MAC_DESKTOP_LEASE_HEARTBEAT_MS = Math.max(1_000, Math.floor(MAC_DESKTOP_LEASE_TTL_MS / 3));

export type MacDesktopLeaseHeartbeat = {
  start: () => void;
  /** Idempotent: stopping a stopped heartbeat is a no-op, never a second release. */
  stop: () => void;
  readonly running: boolean;
};

export type MacDesktopLeaseHeartbeatOptions = {
  /** Renews the lease. Resolving `null` means the host no longer holds it. */
  renew: () => Promise<{ expiresAt: string } | null>;
  /** Called once when a renewal says the lease is gone, or throws. */
  onLost: (reason: string) => void;
  periodMs?: number;
  setInterval?: (handler: () => void, ms: number) => number;
  clearInterval?: (handle: number) => void;
};

export function createMacDesktopLeaseHeartbeat(
  options: MacDesktopLeaseHeartbeatOptions,
): MacDesktopLeaseHeartbeat {
  const period = options.periodMs ?? MAC_DESKTOP_LEASE_HEARTBEAT_MS;
  const start = options.setInterval ?? ((handler, ms) => globalThis.setInterval(handler, ms) as unknown as number);
  const clear = options.clearInterval ?? ((handle) => globalThis.clearInterval(handle));
  let handle: number | null = null;

  const lose = (reason: string): void => {
    if (handle == null) return;
    stop();
    options.onLost(reason);
  };

  const beat = (): void => {
    void options
      .renew()
      .then((lease) => {
        // A null lease is the host saying somebody else holds it now — most
        // often the user's other window, or the TTL lapsing while this one was
        // suspended. Either way this view is no longer the controller and must
        // stop drawing the amber banner.
        if (!lease) lose("The control lease lapsed.");
      })
      .catch((error: unknown) => {
        lose(error instanceof Error ? error.message : String(error));
      });
  };

  function stop(): void {
    if (handle == null) return;
    clear(handle);
    handle = null;
  }

  return {
    start() {
      // Guarding rather than restarting: two `start`s from a re-render must not
      // leave an orphaned interval renewing a lease nothing will ever release.
      if (handle != null) return;
      handle = start(beat, period);
    },
    stop,
    get running() {
      return handle != null;
    },
  };
}

/**
 * Whether this client is the one holding the lease.
 *
 * A string compare, but it is the rule the whole takeover UI turns on — the
 * amber banner, the forwarded input, and whether "Take over" or "Return to
 * agent" is on the strip — and `holder === "user"` alone is not it: another
 * window of the same user holding control must look like somebody else's
 * control from here, not like our own.
 */
export function macDesktopUserHasControl(
  lease: { holder: string; holderId: string } | null | undefined,
  controllerId: string,
): boolean {
  return Boolean(lease && lease.holder === "user" && lease.holderId === controllerId);
}

/** True when an agent is driving right now, which is what greys out the view. */
export function macDesktopAgentHasControl(
  lease: { holder: string } | null | undefined,
): boolean {
  return lease?.holder === "agent";
}
