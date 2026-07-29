/**
 * Rate limiting for failed PIN pairing attempts.
 *
 * Failures are charged to three independent buckets: the requesting device, the
 * requesting address, and one global circuit breaker. The per-device and
 * per-address buckets are the ones that describe a real user fumbling a 6-digit
 * code, so they keep the tight threshold. The global bucket used to share that
 * same threshold, which meant five bad PINs typed on ONE phone locked pairing
 * (and account adoption, which consults the same cooldown) for every device in
 * the house for ten minutes. It is a last-resort defence against guessing
 * distributed across many addresses, so it sits far above the point where an
 * honest household is still trying.
 *
 * A device id is self-asserted, so the per-device bucket alone would be trivial
 * to evade by minting a new one per attempt. That is what the per-address
 * bucket is for; the device bucket exists to make the cooldown land on the
 * device that actually failed.
 */

export const PAIR_FAILURE_THRESHOLD = 5;
export const PAIR_GLOBAL_FAILURE_THRESHOLD = 25;
export const PAIR_COOLDOWN_MS = 10 * 60_000;
export const PAIR_FAILURE_WINDOW_MS = 10 * 60_000;

export type PairFailureEntry = {
  count: number;
  cooldownUntilMs: number;
  updatedAtMs: number;
};

/** Who a pairing attempt came from. Both parts are optional and untrusted. */
export type PairFailureSubject = {
  ip?: string | null;
  deviceId?: string | null;
};

export type PairFailureTracker = ReturnType<typeof createPairFailureTracker>;

type PairFailureTrackerOptions = {
  now?: () => number;
};

const normalize = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

export function createPairFailureTracker(options: PairFailureTrackerOptions = {}) {
  const now = options.now ?? (() => Date.now());
  // Namespaced so an address can never collide with a device id.
  const buckets = new Map<string, PairFailureEntry>();
  const globalFailures: PairFailureEntry = {
    count: 0,
    cooldownUntilMs: 0,
    updatedAtMs: 0,
  };

  const keysFor = (subject: PairFailureSubject): string[] => {
    const keys: string[] = [];
    const ip = normalize(subject.ip);
    const deviceId = normalize(subject.deviceId);
    if (ip) keys.push(`ip:${ip}`);
    if (deviceId) keys.push(`device:${deviceId}`);
    return keys;
  };

  const reset = (entry: PairFailureEntry): void => {
    entry.count = 0;
    entry.cooldownUntilMs = 0;
    entry.updatedAtMs = 0;
  };

  const expired = (entry: PairFailureEntry, nowMs: number): boolean => {
    if (entry.updatedAtMs <= 0) return false;
    return (entry.cooldownUntilMs > 0 && entry.cooldownUntilMs <= nowMs)
      || entry.updatedAtMs + PAIR_FAILURE_WINDOW_MS <= nowMs;
  };

  const prune = (nowMs: number): void => {
    for (const [key, entry] of buckets) {
      if (expired(entry, nowMs)) buckets.delete(key);
    }
    if (expired(globalFailures, nowMs)) reset(globalFailures);
  };

  const increment = (entry: PairFailureEntry, nowMs: number, threshold: number): void => {
    entry.count += 1;
    entry.updatedAtMs = nowMs;
    if (entry.count >= threshold) {
      entry.cooldownUntilMs = nowMs + PAIR_COOLDOWN_MS;
      entry.count = 0;
    }
  };

  return {
    /**
     * Drops entries whose window has lapsed. Every other method prunes as it
     * goes; this exists so a host that is idle for hours does not hold buckets
     * for devices that stopped failing long ago.
     */
    pruneExpired(): void {
      prune(now());
    },

    cooldownMsRemaining(subject: PairFailureSubject): number {
      const nowMs = now();
      prune(nowMs);
      let remaining = Math.max(0, globalFailures.cooldownUntilMs - nowMs);
      for (const key of keysFor(subject)) {
        const entry = buckets.get(key);
        if (!entry) continue;
        remaining = Math.max(remaining, entry.cooldownUntilMs - nowMs);
      }
      return Math.max(0, remaining);
    },

    registerFailure(subject: PairFailureSubject): void {
      const nowMs = now();
      prune(nowMs);
      increment(globalFailures, nowMs, PAIR_GLOBAL_FAILURE_THRESHOLD);
      for (const key of keysFor(subject)) {
        const entry = buckets.get(key) ?? { count: 0, cooldownUntilMs: 0, updatedAtMs: nowMs };
        increment(entry, nowMs, PAIR_FAILURE_THRESHOLD);
        buckets.set(key, entry);
      }
    },

    /**
     * A correct PIN proves this attempt was legitimate, so it clears the
     * buckets it was charged against and relieves the global breaker.
     */
    clearAfterSuccess(subject: PairFailureSubject): void {
      reset(globalFailures);
      for (const key of keysFor(subject)) buckets.delete(key);
    },
  };
}
