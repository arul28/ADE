/**
 * The other machines' live quota, held in memory for this machine's views.
 *
 * Quota belongs to the login, not the machine, so every screen shows each
 * login's freshest reading from any machine on the ADE account
 * (`poolPeerQuota`). This module holds what the peers last said and pulls it
 * again while someone is looking.
 *
 * Deliberately in memory and never stored: a quota window moves every poll, so
 * a stored copy would churn the CRR clock and reopen the self-feeding refresh
 * loop the rollup store's no-op detection exists to prevent.
 *
 * Two feeds write here: the quota-only pull below (`usage.getLiveQuota`, while
 * limits are on screen) and the live side channel of a full rollup fetch.
 */
import type { UsageSnapshot } from "../../../shared/types";
import { poolPeerQuota, type PeerLiveQuota } from "../../../shared/usageLiveQuota";
import { getErrorMessage } from "../shared/utils";

/**
 * Asks each online machine on the ADE account for its live quota only — its
 * own windows and accounts, no history. The full rollup carries every day x
 * provider x model row the machine has; the limits view refreshes far more
 * often than the stats page and needs none of that. A peer too old to answer
 * is left out.
 */
export type AccountLiveQuotaFetcher = (options: { timeoutMs: number; signal: AbortSignal }) => Promise<PeerLiveQuota[]>;

/** Floor between quota-only pulls while limits are on screen. */
const MIN_REFRESH_INTERVAL_MS = 60_000;
/**
 * A peer reading held longer than this is dropped. A machine not heard from in
 * this long may be gone; its windows also carry their own reset times, so this
 * is a backstop, not the freshness rule.
 */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

type HeldQuota = PeerLiveQuota & { fetchedAtMs: number };

export function createPeerLiveQuota({
  logger,
  localMachineKey,
  timeoutMs,
  onChanged,
}: {
  logger: { warn: (message: string, meta?: Record<string, unknown>) => void };
  localMachineKey: () => string | null;
  timeoutMs: number;
  /** A peer's reading changed what this machine shows and picks. */
  onChanged: () => void;
}) {
  const byMachine = new Map<string, HeldQuota>();
  let fetcher: AccountLiveQuotaFetcher | null = null;
  let inFlight: Promise<void> | null = null;
  let lastStartedAtMs = 0;
  // Bumped on every real change, so a cached view knows when to rebuild.
  let version = 0;
  let memo: {
    source: UsageSnapshot;
    version: number;
    /** The first moment the pooled answer could differ with nothing new arriving. */
    validUntilMs: number;
    forPicking: UsageSnapshot;
    forDisplay: UsageSnapshot;
  } | null = null;

  /**
   * Store what one machine said; true when it changes the readings. The label
   * is not part of the comparison: the rollup and the quota-only feed name a
   * renamed machine differently, and that alone must not republish.
   */
  function set(quota: PeerLiveQuota, nowMs: number): boolean {
    if (quota.machineKey === localMachineKey()) return false;
    const previous = byMachine.get(quota.machineKey);
    const changed = !previous
      || JSON.stringify(previous.windows) !== JSON.stringify(quota.windows)
      || JSON.stringify(previous.accounts) !== JSON.stringify(quota.accounts);
    byMachine.set(quota.machineKey, { ...quota, fetchedAtMs: nowMs });
    if (changed) version += 1;
    return changed;
  }

  function get(machineKey: string): PeerLiveQuota | undefined {
    return byMachine.get(machineKey);
  }

  /**
   * When the pooled answer next changes on its own: a window (local or a
   * peer's) passes its reset, which flips who has the usable reading, or a
   * held peer ages out.
   */
  function nextChangeAtMs(snapshot: UsageSnapshot, held: readonly HeldQuota[], nowMs: number): number {
    let next = Number.POSITIVE_INFINITY;
    const consider = (atMs: number): void => {
      if (Number.isFinite(atMs) && atMs > nowMs && atMs < next) next = atMs;
    };
    for (const window of snapshot.windows) consider(Date.parse(window.resetsAt));
    for (const quota of held) {
      consider(quota.fetchedAtMs + MAX_AGE_MS);
      for (const window of quota.windows) consider(Date.parse(window.resetsAt));
    }
    return next;
  }

  /**
   * `snapshot` pooled with the peers. Built once per (snapshot, peer readings)
   * pair and kept until the answer could change on its own, so every read of
   * one published snapshot returns the same view — a view rebuilt per read
   * would change under an unchanged revision — without serving a window past
   * its reset.
   */
  function views(snapshot: UsageSnapshot): { forPicking: UsageSnapshot; forDisplay: UsageSnapshot } {
    if (byMachine.size === 0) return { forPicking: snapshot, forDisplay: snapshot };
    const nowMs = Date.now();
    if (memo && memo.source === snapshot && memo.version === version && nowMs < memo.validUntilMs) return memo;
    const held = [...byMachine.values()].filter((quota) => nowMs - quota.fetchedAtMs < MAX_AGE_MS);
    const pooled = poolPeerQuota(snapshot, held, nowMs);
    memo = { source: snapshot, version, validUntilMs: nextChangeAtMs(snapshot, held, nowMs), ...pooled };
    return pooled;
  }

  /**
   * Pull every reachable machine's live quota in the background. Never awaited
   * by a read: the current view returns at once and a change lands through
   * `onChanged`.
   */
  function refresh({ force = false }: { force?: boolean } = {}): void {
    if (!fetcher || inFlight) return;
    const startedAtMs = Date.now();
    if (!force && startedAtMs - lastStartedAtMs < MIN_REFRESH_INTERVAL_MS) return;
    lastStartedAtMs = startedAtMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    inFlight = fetcher({ timeoutMs, signal: controller.signal })
      .then((results) => {
        let changed = false;
        for (const result of results) {
          if (set(result, startedAtMs)) changed = true;
        }
        if (changed) onChanged();
      })
      .catch((error) => {
        logger.warn("usage.account.live_quota_refresh_failed", { error: getErrorMessage(error) });
      })
      .finally(() => {
        clearTimeout(timer);
        inFlight = null;
      });
  }

  return {
    set,
    get,
    views,
    refresh,
    setFetcher: (next: AccountLiveQuotaFetcher | null): void => {
      fetcher = next;
    },
  };
}

export type PeerLiveQuotaStore = ReturnType<typeof createPeerLiveQuota>;
