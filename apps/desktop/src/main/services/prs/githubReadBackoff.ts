/**
 * Failure backoff for GitHub reads.
 *
 * ADE caches successful GitHub reads, so a success buys a known window of quiet.
 * Failures used to buy nothing: once GitHub throttled us, every UI-driven caller
 * that a warm cache would have served locally turned back into a live request
 * and ADE asked *faster* while degraded than while healthy. This module is the
 * shared ladder that closes that gap, used both for the whole-repo PR snapshot
 * and for per-lane-branch PR lookups.
 */

export const GITHUB_READ_FAILURE_BACKOFF_BASE_MS = 20_000;
export const GITHUB_READ_FAILURE_BACKOFF_MAX_MS = 15 * 60_000;

/**
 * How long a failed GitHub read buys before the same read may be attempted
 * again: a 20s -> 40s -> 80s -> ... ladder capped at 15 minutes, then floored at
 * the window a *success* would have bought.
 *
 * That floor is the load-bearing part, not a rounding detail — without it a
 * failure buys less quiet than a success and the amplification spiral above is
 * exactly what you get. Because the floor usually dominates the early rungs
 * (with a 120s success TTL the first four rungs are 120s, 120s, 120s, 160s),
 * the doubling only becomes visible once the ladder climbs past the TTL.
 */
export function githubReadFailureBackoffMs(attempts: number, successTtlMs: number): number {
  const ladder = GITHUB_READ_FAILURE_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1);
  return Math.max(successTtlMs, Math.min(ladder, GITHUB_READ_FAILURE_BACKOFF_MAX_MS));
}

const GITHUB_REQUEST_ERROR = Symbol.for("ade.prs.githubRequestError");

/**
 * Tag an error as "GitHub said no", so the ladder is only armed by GitHub.
 *
 * A snapshot rebuild also reads lanes and the local database. Without this tag
 * a transient `laneService.list()` or SQLite failure would silence GitHub reads
 * for minutes and replay a local error to the UI as though the API had failed.
 */
export function markGithubRequestError<T>(error: T): T {
  if (error && (typeof error === "object" || typeof error === "function")) {
    try {
      Object.defineProperty(error, GITHUB_REQUEST_ERROR, {
        value: true,
        configurable: true,
        enumerable: false,
      });
    } catch {
      // Frozen or exotic error object — fall through untagged, which only costs
      // us the backoff, never correctness.
    }
  }
  return error;
}

export function isGithubRequestError(error: unknown): boolean {
  return Boolean(
    error
    && (typeof error === "object" || typeof error === "function")
    && (error as Record<PropertyKey, unknown>)[GITHUB_REQUEST_ERROR] === true,
  );
}

export type GithubReadBackoff = {
  /** True while `key` is inside its cooldown. Expired entries are dropped. */
  isBackedOff: (key: string, nowMs?: number) => boolean;
  /** The failure to replay for `key`, or null when it is not backed off. */
  lastError: (key: string, nowMs?: number) => Error | null;
  /** Arms (or climbs) the ladder for `key`. Returns the applied cooldown. */
  record: (key: string, error: unknown, successTtlMs: number, nowMs?: number) => {
    attempts: number;
    cooldownMs: number;
  };
  /** Clears one key, or every key when called with no argument. */
  clear: (key?: string) => void;
};

type BackoffEntry = {
  attempts: number;
  untilMs: number;
  error: Error;
};

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(typeof error === "string" && error ? error : String(error));
}

export function createGithubReadBackoff(): GithubReadBackoff {
  const entries = new Map<string, BackoffEntry>();

  const read = (key: string, nowMs: number): BackoffEntry | null => {
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.untilMs <= nowMs) {
      entries.delete(key);
      return null;
    }
    return entry;
  };

  return {
    isBackedOff: (key, nowMs = Date.now()) => read(key, nowMs) !== null,
    lastError: (key, nowMs = Date.now()) => read(key, nowMs)?.error ?? null,
    record: (key, error, successTtlMs, nowMs = Date.now()) => {
      // Keys are per repo and per branch, so a long-lived process accumulates
      // one entry per branch it ever failed on. Expired entries are only
      // dropped when something asks about that exact key again, which never
      // happens once a lane is archived — so sweep on every write instead.
      // The sweep includes `key`: a lapsed cooldown must restart the ladder at
      // rung 1 whether or not anything happened to read it first.
      for (const [existingKey, existing] of entries) {
        if (existing.untilMs <= nowMs) entries.delete(existingKey);
      }
      const attempts = (entries.get(key)?.attempts ?? 0) + 1;
      const cooldownMs = githubReadFailureBackoffMs(attempts, successTtlMs);
      entries.set(key, { attempts, untilMs: nowMs + cooldownMs, error: toError(error) });
      return { attempts, cooldownMs };
    },
    clear: (key) => {
      if (key === undefined) entries.clear();
      else entries.delete(key);
    },
  };
}
