import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../../../desktop/src/main/services/state/durableFile";

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
export type AccountCacheRow = { updatedAt: string };

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
  TRemote extends { updatedAt: string },
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
  /** Log event names, so each store keeps the telemetry it already emits. */
  events: {
    writeFailed: string;
    uploadFailed: string;
    pullFailed: string;
    pullTruncated: string;
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
  /**
   * Flush the queue. `null` means "could not ask" — the queue stays and the
   * pull is skipped. Throwing means the same, and is logged.
   */
  upload(pending: TPending[]): Promise<{ updatedAt: string | null } | null>;
  pull(cursor: string | null): Promise<
    { rows: TRemote[]; cursor: string | null; truncated: boolean } | null
  >;
  /**
   * Turn a pulled row into a cached one, or return `null` to keep what is
   * already here. Only called once the row is known to be newer.
   */
  toRow(remote: TRemote, cached: TRow | undefined): TRow | null;
};

export type AccountCacheStore<
  TRow extends AccountCacheRow,
  TPending extends AccountCachePending,
> = {
  readCache(): AccountCacheFile<TRow, TPending>;
  persist(): void;
  queue(write: Omit<TPending, "seq">): void;
  sync(): Promise<void>;
  startPeriodicSync(intervalMs?: number): () => void;
  /** Empty the cache and write the empty file. */
  reset(): void;
  /** Empty the cache and delete the file, leaving nothing for a later reader. */
  resetAndDelete(): void;
  cachePath: string;
};

export function createAccountCacheStore<
  TRow extends AccountCacheRow,
  TPending extends AccountCachePending,
  TRemote extends { updatedAt: string },
>(config: AccountCacheStoreConfig<TRow, TPending, TRemote>): AccountCacheStore<TRow, TPending> {
  const cachePath = path.join(config.adeDir, config.cacheFileName);
  const { logger, rowsField } = config;
  let cache: AccountCacheFile<TRow, TPending> | null = null;
  let syncInFlight: Promise<void> | null = null;
  let syncTimer: ReturnType<typeof setInterval> | null = null;
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
      cache = emptyCache(accountUserId);
      persist();
      return cache;
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    } catch {
      // Missing or unreadable is a cold cache, not an error. The Worker is the
      // authority; the worst case is one pull.
      parsed = null;
    }
    const loaded = parsed as Record<string, unknown> | null;
    if (
      !loaded
      || loaded.version !== config.cacheVersion
      || ((loaded.accountUserId as string | null | undefined) ?? null) !== accountUserId
    ) {
      cache = emptyCache(accountUserId);
      return cache;
    }
    const loadedRows = loaded[rowsField];
    cache = {
      version: config.cacheVersion,
      seqCounter: typeof loaded.seqCounter === "number" ? loaded.seqCounter : 0,
      accountUserId,
      cursor: typeof loaded.cursor === "string" ? loaded.cursor : null,
      rows: loadedRows && typeof loadedRows === "object"
        ? loadedRows as Record<string, TRow>
        : {},
      pending: Array.isArray(loaded.pending) ? loaded.pending as TPending[] : [],
    };
    return cache;
  }

  function persist(): void {
    if (!cache) return;
    const { rows, ...rest } = cache;
    const serialized = { ...rest, [rowsField]: rows };
    try {
      fs.mkdirSync(config.adeDir, { recursive: true });
      // 0600, like every other file ADE keeps account state in.
      writeFileAtomic(cachePath, `${JSON.stringify(serialized, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      // A cache that cannot be written still serves this process correctly, so
      // failing the user's change would be worse than losing the copy.
      logger.warn(config.events.writeFailed, {
        error: error instanceof Error ? error.message : String(error ?? ""),
      });
    }
  }

  function queue(write: Omit<TPending, "seq">): void {
    const current = readCache();
    current.seqCounter += 1;
    const entry = { ...write, seq: current.seqCounter } as TPending;
    // One entry per key: only the newest local intent is worth uploading, and
    // replaying an older one would resurrect a value the user already replaced.
    current.pending = current.pending.filter((existing) => !config.pendingMatches(existing, write));
    current.pending.push(entry);
  }

  const stopPeriodicSync = (): void => {
    if (syncHolders > 0) syncHolders -= 1;
    if (syncHolders > 0) return;
    if (!syncTimer) return;
    clearInterval(syncTimer);
    syncTimer = null;
  };

  async function runSync(): Promise<void> {
    if (!config.hasRelay()) return;
    const entryAccountUserId = config.getAccountUserId();
    if (!entryAccountUserId) return;
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
      try {
        const result = await config.upload(pending);
        // `null` means there was no token to ask with. The queue stays.
        if (result === null) return;
        uploadedAt = result.updatedAt;
      } catch (error) {
        // Keep the queue. An upload that failed is work still to do, and
        // dropping it would silently lose a change the user believes is saved.
        logger.warn(config.events.uploadFailed, {
          pending: pending.length,
          error: error instanceof Error ? error.message : String(error ?? ""),
        });
        return;
      }
      if (abandoned()) return;
      // Clear only what was actually sent, matched by sequence rather than by
      // key: an edit made while the upload was in flight carries a newer seq
      // for the same key, and dropping it would lose a change the user believes
      // is saved.
      const sentSeqs = new Set(pending.map((entry) => entry.seq));
      const after = readCache();
      after.pending = after.pending.filter((entry) => !sentSeqs.has(entry.seq));
      // Adopt the server's stamp for everything that landed. Without this the
      // cached row still carries a local provisional time, and the pull below —
      // which asks from a cursor taken BEFORE this upload — would hand back the
      // older server row and revert the user's own edit.
      if (uploadedAt) {
        for (const entry of pending) {
          if (entry.deleted) continue;
          const cached = after.rows[config.pendingKey(entry)];
          if (cached) cached.updatedAt = uploadedAt;
        }
      }
    }

    // Then pull.
    try {
      if (abandoned()) return;
      const before = readCache();
      const page = await config.pull(before.cursor);
      if (!page) return;
      if (abandoned()) return;
      const after = readCache();
      const stillPending = new Set(after.pending.map((entry) => config.pendingKey(entry)));
      for (const remote of page.rows) {
        const key = config.remoteKey(remote);
        // A key this machine has queued is not the server's to answer yet.
        if (stillPending.has(key)) continue;
        // Nor is a row older than what this machine already holds. A page
        // fetched from a cursor taken before our own upload legitimately
        // contains stale rows, and applying one would revert the user's edit in
        // front of them.
        const cached = after.rows[key];
        if (cached && Date.parse(remote.updatedAt) <= Date.parse(cached.updatedAt)) continue;
        const next = config.toRow(remote, cached);
        if (next === null) continue;
        after.rows[key] = next;
      }
      if (page.cursor) after.cursor = page.cursor;
      persist();
      if (page.truncated) {
        logger.info(config.events.pullTruncated, { cursor: after.cursor });
      }
    } catch (error) {
      logger.warn(config.events.pullFailed, {
        error: error instanceof Error ? error.message : String(error ?? ""),
      });
    }
  }

  return {
    readCache,
    persist,
    queue,
    cachePath,

    /**
     * Flush what is queued, then take what changed.
     *
     * Single-flight: the caller is a 30-second timer plus whatever a user
     * action triggers, and two overlapping syncs would race the cursor.
     */
    async sync(): Promise<void> {
      if (syncInFlight) return syncInFlight;
      syncInFlight = runSync().finally(() => {
        syncInFlight = null;
      });
      return syncInFlight;
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
    startPeriodicSync(intervalMs = config.defaultSyncIntervalMs): () => void {
      syncHolders += 1;
      let released = false;
      const release = (): void => {
        // Each caller's stop is its own. Calling it twice must not release a
        // hold that belongs to another project scope.
        if (released) return;
        released = true;
        stopPeriodicSync();
      };
      if (syncTimer) return release;
      syncTimer = setInterval(() => {
        void this.sync().catch(() => {
          // `sync` already logs and already keeps the queue. A rejection here
          // would be an unhandled one on a timer, which takes the brain down
          // for a condition that resolves itself.
        });
      }, Math.max(1_000, Math.trunc(intervalMs)));
      // Never hold the process open for a cache refresh.
      syncTimer.unref?.();
      return release;
    },

    reset(): void {
      epoch += 1;
      cache = emptyCache(config.getAccountUserId());
      persist();
    },

    resetAndDelete(): void {
      epoch += 1;
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
