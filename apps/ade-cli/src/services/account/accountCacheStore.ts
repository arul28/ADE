import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../../../desktop/src/main/services/state/durableFile";
import {
  readAccountChangeMarks,
  subscribeAccountChangeMarks,
  type AccountChangeMarkKind,
} from "./accountChangeMarks";

/** Marks older than this mean the heartbeat stopped carrying them: poll. */
const CHANGE_MARK_FRESH_MS = 90_000;
/** Even with fresh marks, pull at least this often as a safety net. */
const CHANGE_MARK_SAFETY_SYNC_MS = 5 * 60_000;
/**
 * A local write uploads this long after it lands instead of on the next tick.
 * Long enough to fold a burst (an .env import, a settings drag) into one PUT.
 */
const LOCAL_WRITE_FLUSH_DELAY_MS = 250;
/** First wait after a failed sync; doubles per consecutive failure. */
const FAILURE_BACKOFF_BASE_MS = 30_000;
const FAILURE_BACKOFF_MAX_MS = 10 * 60_000;
/** A relay that answered 429 asked to be left alone for at least this long. */
const RATE_LIMITED_BACKOFF_MIN_MS = 60_000;

/**
 * The machine-local half of an account-synced store.
 *
 * Settings and the vault are the same machine: a `0600` JSON cache that answers
 * reads without the network, a queue of local intents, and a single-flight
 * push-then-pull against the account Worker. Only three things actually differ
 * between them — the key axes, what a pulled row becomes, and what sign-out
 * does to the file — so those are the seams below and everything else lives
 * here once.
 *
 * Reads never touch the network. A settings page or an agent's API key that
 * waited on a Worker would be unusable on a train, and ADE is a local-first
 * product: the account makes state follow you, it does not make it require a
 * server. So a write lands in the cache and is answered immediately, then
 * queues for upload; a pull merges the server's rows back in. The machine is
 * always the fast path and the Worker is always the authority.
 */

export type AccountCacheLogger = {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
};

/** The minimum a cached row must carry for last-writer-wins to be decidable. */
export type AccountCacheRow = {
  updatedAt: string;
  /**
   * Present on a tombstone: a key deleted on some machine, kept here so the
   * consumers on THIS machine can drop their own copies.
   *
   * The record is retained rather than dropped because it is the only evidence
   * a delete ever happened. Without it a value deleted on one machine lived on
   * forever on every other one, since there is nothing to pull that says so.
   */
  deleted?: boolean;
};

/**
 * The minimum a queued intent must carry.
 *
 * `seq` is monotonic per cache and is the identity a completed upload clears
 * by. A timestamp cannot do that job: two writes to the same key inside one
 * millisecond carry the same stamp, so clearing by it would discard an edit the
 * user made while the previous upload was still in flight. A counter has no
 * resolution to run out of.
 */
export type AccountCachePending = { seq: number; deleted: boolean };

/** Result of a cache pass, including whether the remote authority answered. */
export type AccountCacheSyncStatus = "ready" | "unavailable" | "failed";

export type AccountCacheSyncListener = (status: AccountCacheSyncStatus) => void;

/** One Worker page is 500 rows. Fifty pages is far past any real vault. */
const MAX_PULL_PAGES = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export type AccountCacheFile<TRow extends AccountCacheRow, TPending extends AccountCachePending> = {
  version: number;
  /** Source of `seq`. Persisted so it survives a restart. */
  seqCounter: number;
  /**
   * Whose state this is. A cache with no owner recorded, or one belonging to a
   * different account, is discarded rather than merged — one user's theme (or
   * worse, their credential) appearing after another signs in would be a leak,
   * not a convenience.
   */
  accountUserId: string | null;
  cursor: string | null;
  rows: Record<string, TRow>;
  pending: TPending[];
};

export type AccountCacheStoreConfig<
  TRow extends AccountCacheRow,
  TPending extends AccountCachePending,
  TRemote extends { updatedAt: string; deleted?: boolean },
> = {
  adeDir: string;
  /** File name under `adeDir`, e.g. `account-settings.json`. */
  cacheFileName: string;
  cacheVersion: number;
  /**
   * The on-disk name of the rows map (`settings`, `items`). Kept configurable
   * so the extraction does not silently invalidate every existing cache file.
   */
  rowsField: string;
  getAccountUserId: () => string | null;
  logger: AccountCacheLogger;
  defaultSyncIntervalMs: number;
  /**
   * Which relay change mark covers this store. When set, a periodic tick pulls
   * only when that mark moved, local writes are queued, the marks have gone
   * stale, or the safety interval passed; see `shouldPullOnTick`.
   */
  changeMarkKind?: AccountChangeMarkKind;
  /** Log event names, so each store keeps the telemetry it already emits. */
  events: {
    writeFailed: string;
    mutationDropped: string;
    uploadFailed: string;
    pullFailed: string;
    pullTruncated: string;
    cacheEntryDropped: string;
    /** Only the vault deletes its file, so only the vault needs this. */
    purgeFailed?: string;
  };
  /** True when there is a relay to sync against at all. */
  hasRelay(): boolean;
  /** One queue entry per key: which existing entries a new write supersedes. */
  pendingMatches(existing: TPending, write: Omit<TPending, "seq">): boolean;
  /** Cache key for a queued intent, so a pull can skip keys we still owe. */
  pendingKey(entry: TPending): string;
  /** Cache key for a pulled row. */
  remoteKey(row: TRemote): string;
  /** Decode one persisted row; invalid entries are ignored instead of cast. */
  decodeRow(value: unknown): TRow | null;
  /** Decode one persisted pending write; invalid entries are ignored instead of cast. */
  decodePending(value: unknown): TPending | null;
  /**
   * Flush the queue. `null` means "could not ask" — the queue stays and the
   * pull is skipped. Throwing means the same, and is logged.
   *
   * `completedSeqs` is what actually landed. A PUT that succeeded followed by
   * a DELETE that could not be sent must drop the PUT seqs immediately, or the
   * next pass replays them with a fresh Worker timestamp and last-writer-wins
   * over a newer remote edit.
   */
  upload(pending: TPending[]): Promise<{
    updatedAt: string | null;
    completedSeqs?: readonly number[];
  } | null>;
  pull(cursor: string | null): Promise<
    { rows: TRemote[]; cursor: string | null; truncated: boolean } | null
  >;
  /**
   * Turn a pulled row into a cached one, or return `null` to keep what is
   * already here. Only called once the row is known to be newer.
   */
  toRow(remote: TRemote, cached: TRow | undefined): TRow | null;
  /** Optional codec for stores whose cache file is encrypted at rest. */
  readFile?: (cachePath: string) => unknown | null;
  writeFile?: (cachePath: string, contents: string) => void;
};

export type AccountCacheStore<
  TRow extends AccountCacheRow,
  TPending extends AccountCachePending,
> = {
  readCache(): AccountCacheFile<TRow, TPending>;
  /** Apply a local mutation only while its owner and cache generation remain current. */
  mutate(
    mutator: (
      current: AccountCacheFile<TRow, TPending>,
      queue: (write: Omit<TPending, "seq">) => void,
    ) => void,
    options?: { expectedAccountUserId?: string },
  ): boolean;
  sync(): Promise<AccountCacheSyncStatus>;
  /**
   * Sync only when the last successful pull for this account is older than
   * `maxAgeMs` or local writes are still queued; otherwise answer `ready` from
   * the cache without the network. For reads that must not miss a change made
   * on another machine moments ago (an agent asking for a secret by name).
   */
  syncIfStale(maxAgeMs: number): Promise<AccountCacheSyncStatus>;
  /** Cache keys of local writes that have not reached the Worker yet. */
  pendingKeys(): string[];
  startPeriodicSync(intervalMs?: number, onSync?: AccountCacheSyncListener): () => void;
  /** Empty the cache and write the empty file. */
  reset(): void;
  /** Empty the cache and delete the file, leaving nothing for a later reader. */
  resetAndDelete(): void;
  cachePath: string;
};

export function createAccountCacheStore<
  TRow extends AccountCacheRow,
  TPending extends AccountCachePending,
  TRemote extends { updatedAt: string; deleted?: boolean },
>(config: AccountCacheStoreConfig<TRow, TPending, TRemote>): AccountCacheStore<TRow, TPending> {
  const cachePath = path.join(config.adeDir, config.cacheFileName);
  const { logger, rowsField } = config;
  let cache: AccountCacheFile<TRow, TPending> | null = null;
  let corruptEntryLogged = false;
  let syncInFlight: Promise<AccountCacheSyncStatus> | null = null;
  let syncTimer: ReturnType<typeof setInterval> | null = null;
  const syncListeners = new Set<AccountCacheSyncListener>();
  /**
   * What the last sync covered: its status, the change mark it pulled up to,
   * when it finished, and for which account. A tick may skip the network only
   * when all of these still describe the signed-in account.
   */
  let lastSyncedMark: string | null | undefined;
  let lastReadySyncAtMs = 0;
  let lastSyncStatus: AccountCacheSyncStatus | null = null;
  let lastSyncedAccountUserId: string | null = null;
  let lastSyncedEpoch = -1;
  /** The mark the most recent sync attempt started from, whatever its outcome. */
  let lastAttemptedMark: string | null | undefined;
  let lastAttemptedAccountUserId: string | null = null;
  /**
   * Background syncs wait until this time after failures. Without it a relay
   * that is down or rate-limiting gets the same request every 30 seconds from
   * every machine, which is exactly the traffic that keeps it rate-limiting.
   */
  let consecutiveFailures = 0;
  let backoffUntilMs = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushAfterInFlight = false;
  const forgetLastSync = (): void => {
    consecutiveFailures = 0;
    backoffUntilMs = 0;
    lastAttemptedMark = undefined;
    lastAttemptedAccountUserId = null;
    lastSyncedMark = undefined;
    lastReadySyncAtMs = 0;
    lastSyncStatus = null;
    lastSyncedAccountUserId = null;
    lastSyncedEpoch = -1;
  };
  /**
   * True when the last sync was a successful pull for this account into the
   * cache that is loaded now. Reads the cache first: that is what notices an
   * owner change and bumps the epoch, so an A→B→A switch (which empties A's
   * cache) never counts as already synced.
   */
  const lastSyncWasReadyFor = (accountUserId: string): boolean => {
    readCache();
    return lastSyncStatus === "ready"
      && lastSyncedAccountUserId === accountUserId
      && lastSyncedEpoch === epoch;
  };
  let unsubscribeChangeMarks: (() => void) | null = null;
  /**
   * How many callers asked for the background sync.
   *
   * The brain builds one store per machine but reaches it from every project
   * scope, so the timer is shared. Without a count, the first project torn down
   * would stop the beat for every project still running.
   */
  let syncHolders = 0;
  /**
   * Bumped by every reset. A sync captures it on entry and abandons if it
   * changed, so a pull that resolves after a sign-out purge cannot re-persist
   * the state the purge just removed.
   */
  let epoch = 0;

  const logCorruptEntry = (kind: "row" | "pending"): void => {
    if (corruptEntryLogged) return;
    corruptEntryLogged = true;
    logger.warn(config.events.cacheEntryDropped, { kind, rowsField });
  };

  function emptyCache(accountUserId: string | null): AccountCacheFile<TRow, TPending> {
    return {
      version: config.cacheVersion,
      seqCounter: 0,
      accountUserId,
      cursor: null,
      rows: {},
      pending: [],
    };
  }

  function readCache(): AccountCacheFile<TRow, TPending> {
    const accountUserId = config.getAccountUserId();
    if (cache && cache.accountUserId === accountUserId) return cache;
    if (cache && cache.accountUserId !== accountUserId) {
      // The signed-in account changed under us. Start clean rather than merge.
      epoch += 1;
      if (!accountUserId) {
        // Sign-out is not an account switch. Settings are supposed to survive
        // it; persisting an empty file here would erase the owner's cache and
        // look like data loss when they sign back in. Vault callers purge
        // explicitly.
        cache = null;
        return emptyCache(null);
      }
      cache = emptyCache(accountUserId);
      persist();
      return cache;
    }
    let parsed: unknown = null;
    try {
      parsed = config.readFile
        ? config.readFile(cachePath)
        : JSON.parse(fs.readFileSync(cachePath, "utf8"));
    } catch {
      // Missing or unreadable is a cold cache, not an error. The Worker is the
      // authority; the worst case is one pull.
      parsed = null;
    }
    const loaded = isRecord(parsed) ? parsed : null;
    const loadedAccountUserId = loaded?.accountUserId;
    const persistedOwnerChanged =
      typeof loadedAccountUserId === "string" && loadedAccountUserId !== accountUserId;
    if (
      !loaded
      || loaded.version !== config.cacheVersion
      || !(
        loadedAccountUserId === undefined
        || loadedAccountUserId === null
        || typeof loadedAccountUserId === "string"
      )
      || (loadedAccountUserId ?? null) !== accountUserId
    ) {
      if (persistedOwnerChanged) epoch += 1;
      cache = emptyCache(accountUserId);
      return cache;
    }
    const loadedRows = loaded[rowsField];
    const rows: Record<string, TRow> = {};
    if (isRecord(loadedRows)) {
      for (const [key, value] of Object.entries(loadedRows)) {
        const decoded = config.decodeRow(value);
        if (decoded) rows[key] = decoded;
        else logCorruptEntry("row");
      }
    } else if (loadedRows !== undefined) {
      logCorruptEntry("row");
    }
    const pending: TPending[] = [];
    if (Array.isArray(loaded.pending)) {
      for (const value of loaded.pending) {
        const decoded = config.decodePending(value);
        if (decoded) pending.push(decoded);
        else logCorruptEntry("pending");
      }
    } else if (loaded.pending !== undefined) {
      logCorruptEntry("pending");
    }
    cache = {
      version: config.cacheVersion,
      seqCounter: typeof loaded.seqCounter === "number"
        && Number.isSafeInteger(loaded.seqCounter)
        && loaded.seqCounter >= 0
        ? loaded.seqCounter
        : 0,
      accountUserId,
      cursor: typeof loaded.cursor === "string" ? loaded.cursor : null,
      rows,
      pending,
    };
    return cache;
  }

  function snapshotCache(
    current: AccountCacheFile<TRow, TPending>,
  ): AccountCacheFile<TRow, TPending> {
    return {
      version: current.version,
      seqCounter: current.seqCounter,
      accountUserId: current.accountUserId,
      cursor: current.cursor,
      rows: { ...current.rows },
      pending: current.pending.map((entry) => ({ ...entry })),
    };
  }

  function persist(): boolean {
    if (!cache) return true;
    const { rows, ...rest } = cache;
    const serialized = { ...rest, [rowsField]: rows };
    try {
      fs.mkdirSync(config.adeDir, { recursive: true });
      // 0600, like every other file ADE keeps account state in.
      const contents = `${JSON.stringify(serialized, null, 2)}\n`;
      if (config.writeFile) {
        config.writeFile(cachePath, contents);
      } else {
        writeFileAtomic(cachePath, contents, { mode: 0o600 });
      }
      return true;
    } catch (error) {
      logger.warn(config.events.writeFailed, {
        error: error instanceof Error ? error.message : String(error ?? ""),
      });
      return false;
    }
  }

  function queueInto(
    current: AccountCacheFile<TRow, TPending>,
    write: Omit<TPending, "seq">,
  ): void {
    current.seqCounter += 1;
    const entry = { ...write, seq: current.seqCounter } as TPending;
    // One entry per key: only the newest local intent is worth uploading, and
    // replaying an older one would resurrect a value the user already replaced.
    current.pending = current.pending.filter((existing) => !config.pendingMatches(existing, write));
    current.pending.push(entry);
  }

  function dropMutation(reason: "signed_out" | "owner_changed" | "epoch_changed"): void {
    logger.warn(config.events.mutationDropped, { reason });
  }

  function mutate(
    mutator: (
      current: AccountCacheFile<TRow, TPending>,
      queue: (write: Omit<TPending, "seq">) => void,
    ) => void,
    options?: { expectedAccountUserId?: string },
  ): boolean {
    const ownerAtEntry = config.getAccountUserId();
    if (!ownerAtEntry) {
      dropMutation("signed_out");
      return false;
    }
    if (
      options?.expectedAccountUserId !== undefined
      && ownerAtEntry !== options.expectedAccountUserId
    ) {
      dropMutation("owner_changed");
      return false;
    }

    // Read first, then take the epoch. `readCache()` bumps the epoch itself
    // when it discards a cache persisted by another account, and that bump is
    // meant to invalidate work captured *before* the discard — not this
    // mutation, which is the first legitimate write of the new owner. Taking
    // the epoch after the read keeps the guard for a collaborator's reset
    // during the mutator without rejecting that first write.
    const current = readCache();
    const epochAtEntry = epoch;
    const ownerAfterRead = config.getAccountUserId();
    if (ownerAfterRead !== ownerAtEntry || current.accountUserId !== ownerAtEntry) {
      dropMutation("owner_changed");
      return false;
    }

    const before = snapshotCache(current);
    mutator(current, (write) => queueInto(current, write));

    // The callback is synchronous today, but keep the check on both sides of
    // it so a future mutation cannot persist a cache after a synchronous
    // account switch/reset performed by a collaborator.
    if (epoch !== epochAtEntry || config.getAccountUserId() !== ownerAtEntry) {
      if (cache === current) cache = null;
      dropMutation(epoch !== epochAtEntry ? "epoch_changed" : "owner_changed");
      return false;
    }
    if (!persist()) {
      cache = before;
      return false;
    }
    if (current.pending.length > 0) scheduleFlush();
    return true;
  }

  /**
   * Upload a local write now rather than on the next tick, so another machine
   * can see it within one of its own heartbeats instead of two. A write that
   * lands while a sync is in flight runs one more pass after it: the in-flight
   * pass took its queue snapshot before this write existed.
   */
  function scheduleFlush(): void {
    if (!config.hasRelay()) return;
    if (syncInFlight) {
      flushAfterInFlight = true;
      return;
    }
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      syncAndNotify();
    }, LOCAL_WRITE_FLUSH_DELAY_MS);
    flushTimer.unref?.();
  }

  function syncAndNotify(): void {
    void store.sync()
      .then(notifySyncListeners)
      .catch(() => {
        // `sync` already logs and already keeps the queue. A rejection here
        // would be an unhandled one on a timer, which takes the brain down
        // for a condition that resolves itself.
      });
  }

  function recordSyncOutcome(status: AccountCacheSyncStatus, rateLimited: boolean): void {
    if (status !== "failed") {
      if (status === "ready") {
        consecutiveFailures = 0;
        backoffUntilMs = 0;
      }
      return;
    }
    consecutiveFailures += 1;
    let waitMs = Math.min(
      FAILURE_BACKOFF_MAX_MS,
      FAILURE_BACKOFF_BASE_MS * 2 ** Math.min(consecutiveFailures - 1, 10),
    );
    if (rateLimited) waitMs = Math.max(waitMs, RATE_LIMITED_BACKOFF_MIN_MS);
    backoffUntilMs = Date.now() + waitMs;
  }

  const stopPeriodicSync = (): void => {
    if (syncHolders > 0) syncHolders -= 1;
    if (syncHolders > 0) return;
    unsubscribeChangeMarks?.();
    unsubscribeChangeMarks = null;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!syncTimer) return;
    clearInterval(syncTimer);
    syncTimer = null;
  };

  /**
   * Whether a periodic tick needs the network. Polling stays the default: any
   * doubt (no mark kind, no account, queued local writes, no fresh mark from
   * the relay, a mark that moved, or the safety interval elapsed) pulls, so a
   * relay or publisher that never sends marks behaves exactly as before.
   */
  const shouldPullOnTick = (nowMs: number): boolean => {
    const kind = config.changeMarkKind;
    if (!kind) return true;
    const accountUserId = config.getAccountUserId();
    if (!accountUserId) return true;
    if (!lastSyncWasReadyFor(accountUserId)) return true;
    if (readCache().pending.length > 0) return true;
    if (nowMs - lastReadySyncAtMs >= CHANGE_MARK_SAFETY_SYNC_MS) return true;
    const entry = readAccountChangeMarks(accountUserId);
    if (!entry || nowMs - entry.receivedAtMs > CHANGE_MARK_FRESH_MS) return true;
    return entry.marks[kind] !== lastSyncedMark;
  };

  /**
   * Each listener runs behind its own boundary: one that throws must neither
   * silence the rest nor escape a timer callback, where it would be uncaught.
   */
  const notifySyncListeners = (status: AccountCacheSyncStatus): void => {
    for (const listener of syncListeners) {
      try {
        listener(status);
      } catch {
        // Contained like the network tick's `.catch`: the listener owns its
        // own reporting, and the cache has nothing to add.
      }
    }
  };

  let lastErrorRateLimited = false;
  const noteError = (error: unknown): void => {
    lastErrorRateLimited = isRecord(error) && (error as { status?: unknown }).status === 429;
  };

  async function runSync(): Promise<AccountCacheSyncStatus> {
    lastErrorRateLimited = false;
    if (!config.hasRelay()) return "unavailable";
    const entryAccountUserId = config.getAccountUserId();
    if (!entryAccountUserId) return "unavailable";
    const entryEpoch = epoch;
    /**
     * A purge or an account switch during an in-flight request invalidates
     * everything this pass is holding. Persisting after one would put a
     * signed-out user's credentials back on disk.
     */
    const abandoned = (): boolean =>
      epoch !== entryEpoch || config.getAccountUserId() !== entryAccountUserId;

    const current = readCache();

    // Push first. A pull that ran first would hand back the server's older
    // value for a key this machine has already changed, and the user would
    // watch their own edit revert.
    const pending = current.pending.slice();
    if (pending.length) {
      let uploadedAt: string | null = null;
      let completedSeqs: ReadonlySet<number> = new Set(pending.map((entry) => entry.seq));
      try {
        const result = await config.upload(pending);
        // `null` means there was no token to ask with. The queue stays.
        if (result === null) return "unavailable";
        uploadedAt = result.updatedAt;
        if (result.completedSeqs) completedSeqs = new Set(result.completedSeqs);
      } catch (error) {
        // Keep the queue. An upload that failed is work still to do, and
        // dropping it would silently lose a change the user believes is saved.
        noteError(error);
        logger.warn(config.events.uploadFailed, {
          pending: pending.length,
          error: error instanceof Error ? error.message : String(error ?? ""),
        });
        return "failed";
      }
      if (abandoned()) return "unavailable";
      // Clear only what was actually sent, matched by sequence rather than by
      // key: an edit made while the upload was in flight carries a newer seq
      // for the same key, and dropping it would lose a change the user believes
      // is saved. Persist immediately so a later pull failure cannot resurrect
      // a PUT the Worker already accepted.
      const after = readCache();
      after.pending = after.pending.filter((entry) => !completedSeqs.has(entry.seq));
      // Adopt the server's stamp for everything that landed. Without this the
      // cached row still carries a local provisional time, and the pull below —
      // which asks from a cursor taken BEFORE this upload — would hand back the
      // older server row and revert the user's own edit.
      if (uploadedAt) {
        for (const entry of pending) {
          if (entry.deleted || !completedSeqs.has(entry.seq)) continue;
          const cached = after.rows[config.pendingKey(entry)];
          if (cached) cached.updatedAt = uploadedAt;
        }
      }
      if (!persist()) return "failed";
    }

    // Then pull, page by page. A truncated page is not a finished cache:
    // migration starts on `ready`, and treating a partial vault as complete
    // would upload this machine's older copies of keys that still live on
    // later pages.
    try {
      for (let pageIndex = 0; pageIndex < MAX_PULL_PAGES; pageIndex += 1) {
        if (abandoned()) return "unavailable";
        const before = readCache();
        const cursorAtPull = before.cursor;
        const page = await config.pull(cursorAtPull);
        if (!page) return "unavailable";
        if (abandoned()) return "unavailable";
        const after = readCache();
        const stillPending = new Set(after.pending.map((entry) => config.pendingKey(entry)));
        for (const remote of page.rows) {
          const key = config.remoteKey(remote);
          // A key this machine has queued is not the server's to answer yet.
          if (stillPending.has(key)) continue;
          // Nor is a row older than what this machine already holds — a
          // tombstone included. A page fetched from a cursor taken before our
          // own upload legitimately contains stale rows, and applying one would
          // revert the user's edit in front of them.
          const cached = after.rows[key];
          if (cached && Date.parse(remote.updatedAt) <= Date.parse(cached.updatedAt)) {
            // Two tombstones agree the key is gone, so the stamp that decides
            // anything later is the relay's. A tombstone this machine wrote
            // carries its own clock, and leaving that in place would make a key
            // another machine re-adds lose to it for as long as the clock runs
            // ahead.
            if (cached.deleted && remote.deleted) {
              const tombstone = config.toRow(remote, cached);
              if (tombstone !== null) after.rows[key] = tombstone;
            }
            continue;
          }
          const next = config.toRow(remote, cached);
          if (next === null) continue;
          after.rows[key] = next;
        }
        if (page.cursor) after.cursor = page.cursor;
        if (!persist()) return "failed";
        if (!page.truncated) return "ready";
        logger.info(config.events.pullTruncated, { cursor: after.cursor, page: pageIndex + 1 });
        if ((page.cursor ?? null) === (cursorAtPull ?? null)) return "unavailable";
      }
      return "unavailable";
    } catch (error) {
      noteError(error);
      logger.warn(config.events.pullFailed, {
        error: error instanceof Error ? error.message : String(error ?? ""),
      });
      return "failed";
    }
  }

  const store: AccountCacheStore<TRow, TPending> = {
    readCache,
    mutate,
    cachePath,

    /**
     * Flush what is queued, then take what changed.
     *
     * Single-flight: the caller is a 30-second timer plus whatever a user
     * action triggers, and two overlapping syncs would race the cursor.
     */
    async sync(): Promise<AccountCacheSyncStatus> {
      if (syncInFlight) return syncInFlight;
      // Take the mark before pulling: a change that lands mid-pull moves the
      // mark past this value, so the next tick pulls again.
      const accountUserId = config.getAccountUserId();
      const markAtStart = config.changeMarkKind && accountUserId
        ? readAccountChangeMarks(accountUserId)?.marks[config.changeMarkKind]
        : undefined;
      readCache();
      const epochAtStart = epoch;
      lastAttemptedMark = markAtStart;
      lastAttemptedAccountUserId = accountUserId;
      syncInFlight = runSync()
        .then((status) => {
          lastSyncStatus = status;
          lastSyncedAccountUserId = accountUserId;
          lastSyncedEpoch = epochAtStart;
          if (status === "ready") {
            lastSyncedMark = markAtStart;
            lastReadySyncAtMs = Date.now();
          }
          recordSyncOutcome(status, lastErrorRateLimited);
          return status;
        })
        .finally(() => {
          syncInFlight = null;
          if (flushAfterInFlight) {
            flushAfterInFlight = false;
            if (readCache().pending.length > 0) scheduleFlush();
          }
        });
      return syncInFlight;
    },

    async syncIfStale(maxAgeMs: number): Promise<AccountCacheSyncStatus> {
      if (syncInFlight) return await syncInFlight;
      // Inside a failure backoff a read answers from the cache: every agent
      // read retrying a relay that just refused would be the flood the
      // backoff exists to stop. An explicit `sync()` still goes through.
      if (Date.now() < backoffUntilMs) return "failed";
      const accountUserId = config.getAccountUserId();
      if (
        accountUserId
        && lastSyncWasReadyFor(accountUserId)
        && readCache().pending.length === 0
        && Date.now() - lastReadySyncAtMs <= Math.max(0, maxAgeMs)
      ) {
        return "ready";
      }
      return await store.sync();
    },

    pendingKeys(): string[] {
      return readCache().pending.map((entry) => config.pendingKey(entry));
    },

    /**
     * Start the background sync, or join the running one.
     *
     * Idempotent because the brain builds one store per machine but reaches it
     * from every project scope; a second caller must join the existing loop
     * rather than start a competing one that races the cursor. Refcounted for
     * the mirror-image reason: the stop function each caller is handed releases
     * only that caller's hold, so tearing one project down cannot silence the
     * beat for the projects still running.
     *
     * The interval matches the account-directory heartbeat, so a machine that
     * is awake and signed in converges within one beat and an idle one costs a
     * single `since`-filtered query.
     */
    startPeriodicSync(intervalMs = config.defaultSyncIntervalMs, onSync?: AccountCacheSyncListener): () => void {
      syncHolders += 1;
      if (onSync) syncListeners.add(onSync);
      let released = false;
      const release = (): void => {
        // Each caller's stop is its own. Calling it twice must not release a
        // hold that belongs to another project scope.
        if (released) return;
        released = true;
        if (onSync) syncListeners.delete(onSync);
        stopPeriodicSync();
      };
      if (syncTimer) return release;
      syncTimer = setInterval(() => {
        // Failing or rate-limited: stay quiet until the backoff passes, and do
        // not tell listeners "ready" about a cache that could not be refreshed.
        if (!syncInFlight && Date.now() < backoffUntilMs) return;
        // A sync already running (sign-in, a user action) is joined, never
        // pre-empted by a synthetic "ready" that would land before its pull.
        if (syncInFlight || shouldPullOnTick(Date.now())) {
          syncAndNotify();
          return;
        }
        // Nothing moved remotely and nothing is queued: the cache is as fresh
        // as a pull would make it. Listeners still get their tick so local
        // follow-up work (applying vault secrets, migration) keeps its cadence.
        notifySyncListeners("ready");
      }, Math.max(1_000, Math.trunc(intervalMs)));
      // A moved mark pulls at once instead of waiting for the next tick, so a
      // change on another machine lands as fast as it did with polling.
      if (config.changeMarkKind && !unsubscribeChangeMarks) {
        const kind = config.changeMarkKind;
        unsubscribeChangeMarks = subscribeAccountChangeMarks((accountUserId, marks) => {
          if (accountUserId !== config.getAccountUserId()) return;
          // Only a mark that moved since the last attempt pulls early. Retries
          // after a failed sync stay on the tick's cadence, so failures never
          // double the traffic.
          if (marks[kind] === lastAttemptedMark && lastAttemptedAccountUserId === accountUserId) return;
          if (Date.now() < backoffUntilMs) return;
          syncAndNotify();
        });
      }
      // Never hold the process open for a cache refresh.
      syncTimer.unref?.();
      return release;
    },

    reset(): void {
      epoch += 1;
      forgetLastSync();
      cache = emptyCache(config.getAccountUserId());
      persist();
    },

    resetAndDelete(): void {
      epoch += 1;
      forgetLastSync();
      cache = emptyCache(config.getAccountUserId());
      try {
        fs.rmSync(cachePath, { force: true });
      } catch (error) {
        logger.warn(config.events.purgeFailed ?? config.events.writeFailed, {
          error: error instanceof Error ? error.message : String(error ?? ""),
        });
      }
    },
  };
  return store;
}

/**
 * One store per machine ADE directory.
 *
 * The brain reaches these from every project scope, and two stores over one
 * cache file would race each other's cursor and queue. Keyed by directory
 * rather than by project for the same reason the push publisher is: the account
 * is a property of the machine, not of whatever repository happens to be open.
 */
export function createStoreRegistry<T>(): {
  get(adeDir: string, create: () => T): T;
  resetForTests(): void;
} {
  const stores = new Map<string, T>();
  return {
    get(adeDir: string, create: () => T): T {
      const key = path.resolve(adeDir);
      const existing = stores.get(key);
      if (existing) return existing;
      const store = create();
      stores.set(key, store);
      return store;
    },
    /** Test seam: drops the singletons so one test cannot see another's store. */
    resetForTests(): void {
      stores.clear();
    },
  };
}
