import { randomUUID } from "node:crypto";

/**
 * Turns on a lane's Apple device, for agents that share it.
 *
 * Several chats in one lane drive one simulator, and a build, a rotate and a
 * screenshot from three of them land on each other. A lease is the queue they
 * stand in: `acquire` waits its turn, the holder works, `release` hands the
 * device to the next in line. It is advisory: input from the pane, and from an
 * agent that never asked, still goes through, because a person must never be
 * locked out of their own device by an agent that forgot to let go. The TTL is
 * what makes forgetting safe: a lease nobody renews lapses.
 */

export const APPLE_DEVICE_LEASE_DEFAULT_TTL_MS = 10 * 60_000;
export const APPLE_DEVICE_LEASE_MAX_TTL_MS = 60 * 60_000;
/** Under the CLI's own 10-minute call timeout, so a wait ends with an answer. */
export const APPLE_DEVICE_LEASE_MAX_WAIT_MS = 9 * 60_000;

export type AppleDeviceLeaseHolder = {
  holder: string;
  token: string;
  acquiredAt: string;
  expiresAt: string;
};

/** Who has the device, as anyone else is told: never the token. */
export type AppleDeviceLeaseOther = Omit<AppleDeviceLeaseHolder, "token">;

export type AppleDeviceLeaseAcquireResult =
  | (AppleDeviceLeaseHolder & { acquired: true; waitedMs: number; renewed: boolean })
  | { acquired: false; current: AppleDeviceLeaseOther; queued: number };

type Lease = { holder: string; token: string; acquiredAtMs: number; expiresAtMs: number };
type Waiter = { holder: string; ttlMs: number; grant: (lease: Lease) => void };

export function createAppleDeviceLeases(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const leases = new Map<string, Lease>();
  const queues = new Map<string, Waiter[]>();
  const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const describe = (lease: Lease): AppleDeviceLeaseHolder => ({
    holder: lease.holder,
    token: lease.token,
    acquiredAt: new Date(lease.acquiredAtMs).toISOString(),
    expiresAt: new Date(lease.expiresAtMs).toISOString(),
  });

  /** The token is the holder's alone: whoever has it can release the lease. */
  const describeOther = (lease: Lease): AppleDeviceLeaseOther => {
    const { token: _token, ...rest } = describe(lease);
    return rest;
  };

  const clampTtl = (ttlMs: number | null | undefined): number => {
    const value = Number(ttlMs);
    if (!Number.isFinite(value) || value <= 0) return APPLE_DEVICE_LEASE_DEFAULT_TTL_MS;
    return Math.min(APPLE_DEVICE_LEASE_MAX_TTL_MS, Math.max(5_000, value));
  };

  const live = (key: string): Lease | null => {
    const lease = leases.get(key);
    if (!lease) return null;
    if (lease.expiresAtMs > now()) return lease;
    leases.delete(key);
    return null;
  };

  const armExpiry = (key: string, lease: Lease) => {
    clearTimeout(expiryTimers.get(key));
    const timer = setTimeout(() => {
      if (leases.get(key) === lease && lease.expiresAtMs <= now()) {
        leases.delete(key);
        handOn(key);
      }
    }, Math.max(0, lease.expiresAtMs - now()) + 5);
    (timer as { unref?: () => void }).unref?.();
    expiryTimers.set(key, timer);
  };

  const grant = (key: string, holder: string, ttlMs: number): Lease => {
    const at = now();
    const lease: Lease = { holder, token: randomUUID(), acquiredAtMs: at, expiresAtMs: at + ttlMs };
    leases.set(key, lease);
    armExpiry(key, lease);
    return lease;
  };

  /** The device is free: the next one in line gets it. */
  const handOn = (key: string) => {
    if (live(key)) return;
    const queue = queues.get(key);
    const next = queue?.shift();
    if (!queue?.length) queues.delete(key);
    if (next) next.grant(grant(key, next.holder, next.ttlMs));
    else clearTimeout(expiryTimers.get(key));
  };

  return {
    /**
     * Take the device, waiting up to `waitMs` for it. The same holder asking
     * again renews its lease instead of queueing behind itself.
     */
    async acquire(args: { key: string; holder: string; ttlMs?: number | null; waitMs?: number | null }): Promise<AppleDeviceLeaseAcquireResult> {
      const ttlMs = clampTtl(args.ttlMs);
      const waitMs = Math.min(APPLE_DEVICE_LEASE_MAX_WAIT_MS, Math.max(0, Number(args.waitMs) || 0));
      const current = live(args.key);
      if (current && current.holder === args.holder) {
        current.expiresAtMs = now() + ttlMs;
        armExpiry(args.key, current);
        return { acquired: true, renewed: true, waitedMs: 0, ...describe(current) };
      }
      if (!current) {
        const lease = grant(args.key, args.holder, ttlMs);
        return { acquired: true, renewed: false, waitedMs: 0, ...describe(lease) };
      }
      if (waitMs <= 0) {
        return { acquired: false, current: describeOther(current), queued: queues.get(args.key)?.length ?? 0 };
      }
      const startedAt = now();
      return new Promise((resolve) => {
        const waiter: Waiter = {
          holder: args.holder,
          ttlMs,
          grant: (lease) => {
            clearTimeout(giveUp);
            resolve({ acquired: true, renewed: false, waitedMs: now() - startedAt, ...describe(lease) });
          },
        };
        const giveUp = setTimeout(() => {
          const queue = queues.get(args.key);
          const index = queue?.indexOf(waiter) ?? -1;
          if (queue && index >= 0) queue.splice(index, 1);
          if (queue && !queue.length) queues.delete(args.key);
          const holderNow = live(args.key);
          if (holderNow) resolve({ acquired: false, current: describeOther(holderNow), queued: queues.get(args.key)?.length ?? 0 });
          else resolve({ acquired: true, renewed: false, waitedMs: now() - startedAt, ...describe(grant(args.key, args.holder, ttlMs)) });
        }, waitMs);
        const queue = queues.get(args.key) ?? [];
        queue.push(waiter);
        queues.set(args.key, queue);
      });
    },

    /** Let go. Only the token's holder can; a stale token is a no-op. */
    release(args: { key: string; token: string }): { released: boolean } {
      const current = live(args.key);
      if (!current || current.token !== args.token) return { released: false };
      leases.delete(args.key);
      handOn(args.key);
      return { released: true };
    },

    status(key: string): { held: boolean; current: AppleDeviceLeaseOther | null; queued: number } {
      const current = live(key);
      return { held: Boolean(current), current: current ? describeOther(current) : null, queued: queues.get(key)?.length ?? 0 };
    },

    dispose(): void {
      for (const timer of expiryTimers.values()) clearTimeout(timer);
      expiryTimers.clear();
      leases.clear();
      queues.clear();
    },
  };
}
