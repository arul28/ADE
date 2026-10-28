import { randomUUID, timingSafeEqual } from "node:crypto";

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
 *
 * Who gets a device someone let go of is decided in one place, `handOn`: a
 * release and an expiry (noticed by its timer or by a read) both go through
 * it, so the device is never free while someone waits for it.
 *
 * A turn is its token, not its holder name. Subagents of one chat share the
 * chat's id, so a name cannot tell them apart: with `distinct` (every current
 * CLI), an acquire without the token is a new turn that queues, and only the
 * token renews or releases. Without `distinct` (an older CLI) the same name
 * still renews, as it always did, but the answer does not carry the token:
 * a name is not proof of holding the turn, and the token releases it.
 *
 * A waiter whose caller went away (`signal`: its connection closed) leaves the
 * line at once, so a killed `ade apple lease --wait` never wins a turn nobody
 * will use or release.
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
  /** Renewed by holder name alone (an older CLI): the token stays with whoever got it. */
  | (AppleDeviceLeaseOther & { acquired: true; waitedMs: number; renewed: true; token: null })
  | {
    acquired: false;
    current: AppleDeviceLeaseOther;
    queued: number;
    /**
     * The device is held under the asker's own holder name, by another turn:
     * another agent of the same chat, or the asker itself without its token.
     */
    sameHolder?: boolean;
  };

/** `chat`: the chat that took it (stamped by the server), whatever holder name it gave. */
type Lease = { holder: string; chat: string | null; token: string; acquiredAtMs: number; expiresAtMs: number };
type Waiter = {
  holder: string;
  chat: string | null;
  ttlMs: number;
  handOff: (lease: Lease) => void;
  /** Out of line without a turn: the brain is stopping, or the holder's chat ended. */
  fail: (error: Error) => void;
};

/** Equal tokens, compared in constant time. */
function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

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

  const queueLength = (key: string) => queues.get(key)?.length ?? 0;

  /** Take one waiter out of its line; false when it was no longer in it. */
  const leaveLine = (key: string, waiter: Waiter): boolean => {
    const line = queues.get(key);
    const index = line?.indexOf(waiter) ?? -1;
    if (!line || index < 0) return false;
    line.splice(index, 1);
    if (!line.length) queues.delete(key);
    return true;
  };

  /**
   * The lease that holds the device now. One that has run out is let go here,
   * and the device passes to the next in line, whether the expiry timer or a
   * read noticed first.
   */
  const live = (key: string): Lease | null => {
    const lease = leases.get(key);
    if (!lease) return null;
    if (lease.expiresAtMs > now()) return lease;
    leases.delete(key);
    handOn(key);
    return leases.get(key) ?? null;
  };

  const armExpiry = (key: string, lease: Lease) => {
    clearTimeout(expiryTimers.get(key));
    const timer = setTimeout(() => {
      if (leases.get(key) === lease) live(key);
    }, Math.max(0, lease.expiresAtMs - now()) + 5);
    (timer as { unref?: () => void }).unref?.();
    expiryTimers.set(key, timer);
  };

  const grant = (key: string, holder: string, chat: string | null, ttlMs: number): Lease => {
    const at = now();
    const lease: Lease = { holder, chat, token: randomUUID(), acquiredAtMs: at, expiresAtMs: at + ttlMs };
    leases.set(key, lease);
    armExpiry(key, lease);
    return lease;
  };

  /** The device is free: the next one in line gets it. */
  const handOn = (key: string) => {
    if (leases.has(key)) return;
    const queue = queues.get(key);
    const next = queue?.shift();
    if (!queue?.length) queues.delete(key);
    if (next) next.handOff(grant(key, next.holder, next.chat, next.ttlMs));
    else {
      clearTimeout(expiryTimers.get(key));
      expiryTimers.delete(key);
    }
  };

  /** Let go of the lease on `key` and pass the device on. */
  const letGo = (key: string) => {
    leases.delete(key);
    handOn(key);
  };

  /** Stand in line for up to `waitMs`; a turn or the current holder answers. */
  const waitForTurn = (args: {
    key: string;
    holder: string;
    chat: string | null;
    ttlMs: number;
    waitMs: number;
    signal?: AbortSignal | null;
  }): Promise<AppleDeviceLeaseAcquireResult> => {
    const startedAt = now();
    return new Promise((resolve, reject) => {
      let giveUp: ReturnType<typeof setTimeout> | null = null;
      const settle = () => {
        if (giveUp) clearTimeout(giveUp);
        giveUp = null;
        args.signal?.removeEventListener("abort", onAbort);
      };
      const notGranted = (): AppleDeviceLeaseAcquireResult => {
        const holderNow = live(args.key);
        return holderNow
          ? { acquired: false, current: describeOther(holderNow), queued: queueLength(args.key) }
          // Nobody has it, nobody else is waiting for it: ours.
          : { acquired: true, renewed: false, waitedMs: now() - startedAt, ...describe(grant(args.key, args.holder, args.chat, args.ttlMs)) };
      };
      const waiter: Waiter = {
        holder: args.holder,
        chat: args.chat,
        ttlMs: args.ttlMs,
        handOff: (lease) => {
          settle();
          resolve({ acquired: true, renewed: false, waitedMs: now() - startedAt, ...describe(lease) });
        },
        fail: (error) => {
          settle();
          reject(error);
        },
      };
      // The caller is gone: out of line, and no turn is granted to nobody.
      const onAbort = () => {
        if (!leaveLine(args.key, waiter)) return;
        settle();
        const holderNow = live(args.key);
        resolve(holderNow
          ? { acquired: false, current: describeOther(holderNow), queued: queueLength(args.key) }
          : { acquired: false, current: { holder: "", acquiredAt: "", expiresAt: "" }, queued: queueLength(args.key) });
      };
      const queue = queues.get(args.key) ?? [];
      queue.push(waiter);
      queues.set(args.key, queue);
      args.signal?.addEventListener("abort", onAbort, { once: true });
      giveUp = setTimeout(() => {
        if (!leaveLine(args.key, waiter)) return;
        settle();
        resolve(notGranted());
      }, args.waitMs);
    });
  };

  return {
    /**
     * Take the device, waiting up to `waitMs` for it. The token of the turn
     * renews it instead of queueing behind itself.
     */
    async acquire(args: {
      key: string;
      holder: string;
      /** The asking chat, as the server knows it; `endChat` ends its turns. */
      chat?: string | null;
      ttlMs?: number | null;
      waitMs?: number | null;
      /** The token of the turn to renew. A token that no longer holds the device asks for a new turn. */
      token?: string | null;
      /** Only the token renews; the same holder name without it queues like anyone else. */
      distinct?: boolean | null;
      /** The caller went away: leave the line. */
      signal?: AbortSignal | null;
    }): Promise<AppleDeviceLeaseAcquireResult> {
      const ttlMs = clampTtl(args.ttlMs);
      const chat = args.chat?.trim() || null;
      const waitMs = Math.min(APPLE_DEVICE_LEASE_MAX_WAIT_MS, Math.max(0, Number(args.waitMs) || 0));
      const token = args.token?.trim() || null;
      const current = live(args.key);
      const byToken = Boolean(current && token && sameToken(current.token, token));
      const byName = Boolean(current && !token && args.distinct !== true && current.holder === args.holder);
      if (current && (byToken || byName)) {
        current.expiresAtMs = now() + ttlMs;
        armExpiry(args.key, current);
        return byToken
          ? { acquired: true, renewed: true, waitedMs: 0, ...describe(current) }
          : { acquired: true, renewed: true, waitedMs: 0, ...describeOther(current), token: null };
      }
      // Free means nobody is waiting either: every release and expiry hands
      // the device straight to the next in line (`handOn`).
      if (!current) {
        return { acquired: true, renewed: false, waitedMs: 0, ...describe(grant(args.key, args.holder, chat, ttlMs)) };
      }
      if (waitMs <= 0 || args.signal?.aborted) {
        return {
          acquired: false,
          current: describeOther(current),
          queued: queueLength(args.key),
          ...(current.holder === args.holder ? { sameHolder: true } : {}),
        };
      }
      return waitForTurn({ key: args.key, holder: args.holder, chat, ttlMs, waitMs, signal: args.signal }).then((result) => (
        !result.acquired && result.current.holder === args.holder ? { ...result, sameHolder: true } : result
      ));
    },

    /** Let go. Only the token's holder can; a stale token is a no-op. */
    release(args: { key: string; token: string }): { released: boolean } {
      const current = live(args.key);
      if (!current || !sameToken(current.token, args.token)) return { released: false };
      letGo(args.key);
      return { released: true };
    },

    /** Which of `keys` the token holds now, if any. */
    keyOfToken(token: string, keys: (key: string) => boolean): string | null {
      for (const key of [...leases.keys()]) {
        if (!keys(key)) continue;
        const current = live(key);
        if (current && sameToken(current.token, token)) return key;
      }
      return null;
    },

    status(key: string): { held: boolean; current: AppleDeviceLeaseOther | null; queued: number } {
      const current = live(key);
      return { held: Boolean(current), current: current ? describeOther(current) : null, queued: queueLength(key) };
    },

    /** Whether the lease on `key` was taken by this chat, under any holder name. */
    heldByChat(key: string, chatSessionId: string): boolean {
      const current = live(key);
      return Boolean(current && (current.chat === chatSessionId || current.holder === chatSessionId));
    },

    /**
     * A chat ended (archived or deleted): the turns it took, under any holder
     * name, go to the next in line, and its waiters leave the line. Answers
     * how many leases it let go.
     */
    endChat(chatSessionId: string): number {
      const ours = (entry: { holder: string; chat: string | null }) => entry.chat === chatSessionId || entry.holder === chatSessionId;
      for (const [key, line] of [...queues.entries()]) {
        for (const waiter of [...line]) {
          if (!ours(waiter) || !leaveLine(key, waiter)) continue;
          waiter.fail(new Error(`The chat ${chatSessionId} ended, so its place in line for the device was given up.`));
        }
      }
      let ended = 0;
      for (const [key, lease] of [...leases.entries()]) {
        if (!ours(lease)) continue;
        letGo(key);
        ended += 1;
      }
      return ended;
    },

    dispose(): void {
      for (const timer of expiryTimers.values()) clearTimeout(timer);
      expiryTimers.clear();
      leases.clear();
      const waiting = [...queues.values()].flat();
      queues.clear();
      // Every wait gets an answer: the brain is stopping, the line goes with it.
      for (const waiter of waiting) waiter.fail(new Error("The ADE brain is stopping; ask for the lease again once it is back."));
    },
  };
}
