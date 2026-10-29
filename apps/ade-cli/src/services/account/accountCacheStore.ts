import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../../../desktop/src/main/services/state/durableFile";
import { createFileLogger } from "../../../../desktop/src/main/services/logging/logger";
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
 * A write the relay refused for itself (not the batch) is parked: kept on this
 * machine with its reason and retried this often, in case a newer relay takes
 * it. A new local write to the same key replaces it and goes up at once.
 */
const PARKED_RETRY_MS = 60 * 60_000;
/**
 * A queued write older than this may predate rows another machine wrote while
 * this one could not sync. Before sending one to a relay that does not check
 * that itself, the store reads what changed since and drops the writes a newer
 * row supersedes. A write flushed right after it was made never waits this long.
 */
const STALE_WRITE_CHECK_AGE_MS = 60_000;
/**
 * That check compares the relay's stamps with this machine's clock, so it only
 * calls a write superseded when the row is newer by more than this. A relay
 * that checks itself corrects for the clock exactly (`sentAt`).
 */
const STALE_WRITE_CLOCK_TOLERANCE_MS = 2 * 60_000;
/** The same failure is logged once per this window, with a count of repeats. */
const FAILURE_LOG_REPEAT_MS = 10 * 60_000;

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
export type AccountCachePending = {
  seq: number;
  deleted: boolean;
  /**
   * When this machine queued the write, on its own clock. Stamped by the cache;
   * entries queued before it existed fall back to their row's local stamp. It
   * is what lets the relay (or this store, for an older relay) refuse a write
   * that a newer row on the account has already replaced.
   */
  queuedAt?: string;
  /** Set when the relay refused this one write; see `PARKED_RETRY_MS`. */
  parked?: AccountCacheParked;
};

/** Why and when the relay refused a write. The reason is the relay's, never a value. */
export type AccountCacheParked = { reason: string; at: string };

/** What a store's `upload` reports back; see `AccountCacheStoreConfig.upload`. */
export type AccountCacheUploadResult<TRemote> = {
  updatedAt: string | null;
  completedSeqs?: readonly number[];
  /** Writes the relay refused for themselves: parked with the reason. */
  rejected?: ReadonlyArray<{ seq: number; reason: string }>;
  /** Writes a newer row on the account replaced: dropped, and `current` adopted. */
  superseded?: ReadonlyArray<{ seq: number; current: TRemote | null }>;
  /** The relay checked each write against newer rows itself. */
  checkedConflicts?: boolean;
  /** A request failed partway, for a reason not one item's. The rest stays queued. */
  error?: unknown;
};

/** How this machine's account sync is doing, for Settings, ADE MCP and `ade doctor`. */
export type AccountCacheHealth = {
  state: "ok" | "failing" | "unavailable";
  /** When the last full sync (upload and pull) finished, in this process. */
  lastSyncedAt: string | null;
  /** Local changes still waiting to reach the account. */
  pendingChanges: number;
  /** Local changes the account service refused; kept here and retried hourly. */
  parked: number;
  /** One plain sentence when not ok. Never a value or a key. */
  lastError: string | null;
};

/** Result of a cache pass, including whether the remote authority answered. */
export type AccountCacheSyncStatus = "ready" | "unavailable" | "failed";

export type AccountCacheSyncListener = (status: AccountCacheSyncStatus) => void;
export type AccountCacheRemoteRowsAppliedListener = () => void;

/** One Worker page is 500 rows. Fifty pages is far past any real vault. */
const MAX_PULL_PAGES = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

function hasUnparked(pending: readonly AccountCachePending[]): boolean {
  return pending.some((entry) => !entry.parked);
}

function isIsoTime(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

/** Restores the cache-owned fields a store's own decoder does not know about. */
function withQueueMetadata<TPending extends AccountCachePending>(decoded: TPending, raw: unknown): TPending {
  if (!isRecord(raw)) return decoded;
  const next = { ...decoded };
  if (isIsoTime(raw.queuedAt)) next.queuedAt = raw.queuedAt;
  const parked = raw.parked;
  if (isRecord(parked) && typeof parked.reason === "string" && isIsoTime(parked.at)) {
    next.parked = { reason: parked.reason.slice(0, 120), at: parked.at };
  }
  return next;
}

function errorStatus(error: unknown): number | null {
  return isRecord(error) && typeof error.status === "number" ? error.status : null;
}

/**
 * The relay refused something about the items in a request, not the request:
 * 400 (an item it will not store) or 413 (too many, or too large). Splitting
 * the batch finds which item. An older relay answers this way for a whole
 * batch; a newer one answers per item instead (`itemResults`).
 */
export function isAccountItemRejection(error: unknown): boolean {
  const status = errorStatus(error);
  return status === 400 || status === 413;
}

/** The relay's reason for refusing one item: its short error text, never a value. */
export function accountItemRejectionReason(error: unknown): string {
  const reason = isRecord(error) && typeof error.reason === "string" ? error.reason.trim() : "";
  return (reason || `HTTP ${errorStatus(error) ?? "error"}`).slice(0, 120);
}

export type IsolatedPutResult<T, R> = {
  /** Each request that landed, with the items it carried, in order. */
  landed: Array<{ batch: T[]; result: R }>;
  /** Items the relay refused one by one, with its reason. */
  rejected: Array<{ item: T; reason: string }>;
  /** A request failed for a reason that is not one item's; later items were not sent. */
  error?: unknown;
  /** There was no token to ask with; later items were not sent. */
  couldNotAsk: boolean;
};

/**
 * Sends `items` in batches of at most `maxBatch`, so one item the relay will
 * not take can never hold back the rest. A batch the relay refuses as a whole
 * for an item's sake (an older relay's all-or-nothing 400) is split in halves
 * until the refused items stand alone; the others are sent. A batch-level
 * failure (network, 5xx, 429) stops and leaves the rest for the next pass.
 */
export async function putIsolated<T, R>(
  items: readonly T[],
  maxBatch: number,
  put: (batch: T[]) => Promise<R | null>,
): Promise<IsolatedPutResult<T, R>> {
  const outcome: IsolatedPutResult<T, R> = { landed: [], rejected: [], couldNotAsk: false };
  const attempt = async (batch: T[]): Promise<boolean> => {
    let result: R | null;
    try {
      result = await put(batch);
    } catch (error) {
      if (!isAccountItemRejection(error)) {
        outcome.error = error;
        return false;
      }
      if (batch.length === 1) {
        outcome.rejected.push({ item: batch[0]!, reason: accountItemRejectionReason(error) });
        return true;
      }
      const middle = Math.ceil(batch.length / 2);
      return (await attempt(batch.slice(0, middle))) && (await attempt(batch.slice(middle)));
    }
    if (result === null) {
      outcome.couldNotAsk = true;
      return false;
    }
    outcome.landed.push({ batch, result });
    return true;
  };
  const size = Math.max(1, Math.trunc(maxBatch));
  for (let index = 0; index < items.length; index += size) {
    if (!(await attempt(items.slice(index, index + size)))) break;
  }
  return outcome;
}

/**
 * A failed sync as one sentence a person can act on. Built from the status and
 * the relay's short error text only: never a value, a key, or a token.
 */
function describeSyncFailure(error: unknown, phase: "upload" | "pull"): string {
  const what = phase === "upload" ? "send this computer's changes to" : "get changes from";
  if (isRecord(error) && error.name === "PushRelayUnreachableError" && typeof error.message === "string") {
    return `ADE couldn't ${what} your account: ${error.message}`;
  }
  const status = errorStatus(error);
  if (status === 429) return `Your account service asked ADE to slow down, so it couldn't ${what} your account yet. It retries on its own.`;
  if (status !== null && status >= 500) {
    return `ADE couldn't ${what} your account: the account service is unavailable (HTTP ${status}). It retries on its own.`;
  }
  if (status !== null) {
    const reason = isRecord(error) && typeof error.reason === "string" ? `: ${error.reason.slice(0, 120)}` : "";
    return `Your account service refused to let ADE ${what} your account (HTTP ${status}${reason}).`;
  }
  return `ADE couldn't ${what} your account. It retries on its own.`;
}

/**
 * The relay itself is down or rate-limiting: a pull right after would fail the
 * same way. 507 (the account's vault or settings are full) is not: it refuses
 * writes only, and reads must keep flowing.
 */
function relayUnhealthy(error: unknown): boolean {
  const status = errorStatus(error);
  return status === null || status === 429 || (status >= 500 && status !== 507);
}

const machineLoggers = new Map<string, AccountCacheLogger | null>();

/**
 * `brain.jsonl` under a machine ADE directory, for the machine-shared account
 * stores. They are built by whichever caller reaches them first, often a
 * project runtime whose logger writes that project's log (or none at all), so
 * a vault stuck for days left no trace in the machine's own log. One logger per
 * path; file only, never stderr, since a CLI process can own a store too.
 */
export function machineAccountStoreLogger(adeDir: string): AccountCacheLogger | null {
  const logPath = path.join(path.resolve(adeDir), "runtime", "brain.jsonl");
  if (!machineLoggers.has(logPath)) {
    try {
      machineLoggers.set(logPath, createFileLogger(logPath));
    } catch {
      machineLoggers.set(logPath, null);
    }
  }
  return machineLoggers.get(logPath) ?? null;
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
  /**
   * Upload a local write right away instead of on the next tick. The vault
   * sets it: a secret saved on one machine is wanted on the next one now.
   * Settings keep the tick (see accountSettingsFlush.ts).
   */
  flushOnWrite?: boolean;
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
    /** The relay refused writes for themselves; they are parked. */
    itemsParked?: string;
    /** Queued writes a newer row on the account replaced; they were dropped. */
    writesSuperseded?: string;
  };
  /** Clock for `queuedAt` and parking. */
  now?: () => number;
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
   * pull is skipped. Throwing means nothing landed, and is logged; the pull
   * still runs unless the relay itself is down or rate-limiting.
   *
   * Each entry arrives with `queuedAt` filled in where it is known.
   *
   * `completedSeqs` is what actually landed (all of them when absent, minus
   * `rejected` and `superseded`). A PUT that succeeded followed by a DELETE
   * that could not be sent must drop the PUT seqs immediately, or the next pass
   * replays them with a fresh Worker timestamp and last-writer-wins over a
   * newer remote edit.
   */
  upload(pending: TPending[]): Promise<AccountCacheUploadResult<TRemote> | null>;
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
  /** Cache keys of local writes that have not reached the Worker yet (parked ones included). */
  pendingKeys(): string[];
  /** How this machine's sync is doing; reads the cache, never the network. */
  health(): AccountCacheHealth;
  /**
   * Also send this store's log events to `logger`. The store is one per
   * machine and built by whichever caller comes first; this is how its
   * failures reach the machine's own log whoever that was.
   */
  attachLogger(logger: AccountCacheLogger): void;
  startPeriodicSync(
    intervalMs?: number,
    onSync?: AccountCacheSyncListener,
    onRemoteRowsApplied?: AccountCacheRemoteRowsAppliedListener,
  ): () => void;
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
  const { rowsField } = config;
  const now = config.now ?? Date.now;
  /** The creator's logger plus any attached since (the machine log). */
  const loggers = new Set<AccountCacheLogger>([config.logger]);
  const log: AccountCacheLogger = {
    info: (message, meta) => {
      for (const target of loggers) target.info(message, meta);
    },
    warn: (message, meta) => {
      for (const target of loggers) target.warn(message, meta);
    },
  };
  /**
   * A failure that repeats every backoff would fill the log with one line; it
   * is logged once per window per event and reason, with the repeats counted.
   */
  const failureLogs = new Map<string, { atMs: number; repeated: number }>();
  const warnLimited = (event: string, meta: Record<string, unknown>, reason: string): void => {
    const id = `${event}\u0000${reason}`;
    const nowMs = Date.now();
    const previous = failureLogs.get(id);
    if (previous && nowMs - previous.atMs < FAILURE_LOG_REPEAT_MS) {
      previous.repeated += 1;
      return;
    }
    if (failureLogs.size > 64) failureLogs.clear();
    failureLogs.set(id, { atMs: nowMs, repeated: 0 });
    log.warn(event, previous?.repeated ? { ...meta, repeated: previous.repeated } : meta);
  };
  /** The last failure, as a sentence for `health()`; cleared by a clean pass. */
  let lastError: string | null = null;
  /**
   * The relay answered per item and checked writes against newer rows itself
   * (`itemResults`). Until it has, an old queued write is checked here first.
   */
  let relayChecksConflicts = false;
  let cache: AccountCacheFile<TRow, TPending> | null = null;
  let corruptEntryLogged = false;
  let syncInFlight: Promise<AccountCacheSyncStatus> | null = null;
  let syncTimer: ReturnType<typeof setInterval> | null = null;
  const syncListeners = new Set<AccountCacheSyncListener>();
  const remoteRowsAppliedListeners = new Set<AccountCacheRemoteRowsAppliedListener>();
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
  let consecutiveFailures = 0;
  /**
   * Background syncs wait until this time after failures. Without it a relay
   * that is down or rate-limiting gets the same request every 30 seconds from
   * every machine, which is exactly the traffic that keeps it rate-limiting.
   */
  let backoffUntilMs = 0;
  /** The account the backoff was earned by; another account is not held by it. */
  let backoffAccountUserId: string | null = null;
  /** Whether the current sync attempt failed with a 429 (sets a longer backoff). */
  let lastErrorRateLimited = false;
  /** The pending post-write upload, and whether one is owed after the sync in flight. */
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushAfterInFlight = false;
  const forgetLastSync = (): void => {
    consecutiveFailures = 0;
    backoffUntilMs = 0;
    backoffAccountUserId = null;
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
    log.warn(config.events.cacheEntryDropped, { kind, rowsField });
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
        if (decoded) pending.push(withQueueMetadata(decoded, value));
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
      log.warn(config.events.writeFailed, {
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
    // `queuedAt` and `parked` are the cache's own: a new write is never parked.
    const { parked: _parked, ...fresh } = write as Omit<TPending, "seq"> & { parked?: unknown };
    const entry = { ...fresh, seq: current.seqCounter, queuedAt: new Date(now()).toISOString() } as TPending;
    // One entry per key: only the newest local intent is worth uploading, and
    // replaying an older one would resurrect a value the user already replaced.
    current.pending = current.pending.filter((existing) => !config.pendingMatches(existing, write));
    current.pending.push(entry);
  }

  function dropMutation(reason: "signed_out" | "owner_changed" | "epoch_changed"): void {
    log.warn(config.events.mutationDropped, { reason });
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
    if (config.flushOnWrite && hasUnparked(current.pending)) scheduleFlush();
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
    // Inside a backoff the write waits it out; the tick would retry it then
    // anyway, and a burst of writes must not become a burst of refused PUTs.
    const delayMs = Math.max(LOCAL_WRITE_FLUSH_DELAY_MS, backoffRemainingMs());
    flushTimer = setTimeout(() => {
      flushTimer = null;
      syncAndNotify();
    }, delayMs);
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

  function backoffRemainingMs(): number {
    if (backoffAccountUserId !== config.getAccountUserId()) return 0;
    return Math.max(0, backoffUntilMs - Date.now());
  }

  function recordSyncOutcome(status: AccountCacheSyncStatus, rateLimited: boolean): void {
    if (status === "ready") {
      consecutiveFailures = 0;
      backoffUntilMs = 0;
      return;
    }
    if (status !== "failed") return;
    const accountUserId = config.getAccountUserId();
    if (backoffAccountUserId !== accountUserId) consecutiveFailures = 0;
    backoffAccountUserId = accountUserId;
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
    flushAfterInFlight = false;
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
    // Parked writes do not count: they retry on their own hourly cadence, and
    // counting them would pull on every tick for as long as one is parked.
    if (hasUnparked(readCache().pending)) return true;
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

  const noteError = (error: unknown): void => {
    lastErrorRateLimited = isRecord(error) && error.status === 429;
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
    const nowMs = now();
    // Entries queued before `queuedAt` existed carry their write time on the
    // row: a pull never replaces a row whose key is still queued.
    const writtenAtOf = (entry: TPending): string | undefined => {
      if (entry.queuedAt) return entry.queuedAt;
      const stamp = current.rows[config.pendingKey(entry)]?.updatedAt;
      return isIsoTime(stamp) ? stamp : undefined;
    };
    let due = current.pending
      .filter((entry) => !entry.parked || nowMs - Date.parse(entry.parked.at) >= PARKED_RETRY_MS)
      .map((entry) => {
        const queuedAt = writtenAtOf(entry);
        return (queuedAt ? { ...entry, queuedAt } : { ...entry }) as TPending;
      });
    let appliedRemoteRows = false;
    let uploadFailure: unknown = undefined;

    // A write that waited (offline, a backoff, a stuck queue) may be older
    // than rows other machines wrote meanwhile. Until the relay is known to
    // refuse those itself, read what changed since and drop what is replaced.
    if (!relayChecksConflicts && due.some((entry) => isOldWrite(entry, nowMs))) {
      let checked: { superseded: Array<{ seq: number; current: TRemote }> } | "unavailable" | "abandoned";
      try {
        checked = await findSupersededWrites(due, abandoned);
      } catch (error) {
        noteError(error);
        lastError = describeSyncFailure(error, "pull");
        warnLimited(config.events.pullFailed, { phase: "stale_check", error: errorText(error) }, errorText(error));
        return "failed";
      }
      if (checked === "abandoned") return "unavailable";
      if (checked === "unavailable") return "unavailable";
      if (checked.superseded.length) {
        const dropped = new Set(checked.superseded.map((entry) => entry.seq));
        appliedRemoteRows = applySuperseded(checked.superseded) || appliedRemoteRows;
        if (!persist()) return "failed";
        due = due.filter((entry) => !dropped.has(entry.seq));
      }
    }

    // Push first. A pull that ran first would hand back the server's older
    // value for a key this machine has already changed, and the user would
    // watch their own edit revert.
    if (due.length) {
      let result: AccountCacheUploadResult<TRemote> | null = null;
      try {
        result = await config.upload(due);
        // `null` means there was no token to ask with. The queue stays.
        if (result === null) return "unavailable";
      } catch (error) {
        // Keep the queue. An upload that failed is work still to do, and
        // dropping it would silently lose a change the user believes is saved.
        uploadFailure = error;
      }
      if (abandoned()) return "unavailable";
      if (result) {
        if (result.checkedConflicts) relayChecksConflicts = true;
        appliedRemoteRows = applyUploadResult(due, result) || appliedRemoteRows;
        // Persist immediately so a later pull failure cannot resurrect a PUT
        // the Worker already accepted.
        if (!persist()) return "failed";
        if (result.error !== undefined) uploadFailure = result.error;
      }
      if (uploadFailure !== undefined) {
        noteError(uploadFailure);
        lastError = describeSyncFailure(uploadFailure, "upload");
        warnLimited(config.events.uploadFailed, {
          pending: due.length,
          error: errorText(uploadFailure),
        }, errorText(uploadFailure));
        // Still pull, unless the relay itself is down or rate-limiting: one
        // write the relay keeps refusing must never stop this machine from
        // receiving everything else (a stuck queue once cost a machine eight
        // days of the account's changes). A pull skips keys still queued, so
        // it cannot revert them.
        if (relayUnhealthy(uploadFailure)) return "failed";
      }
    }
    if (appliedRemoteRows) notifyRemoteRowsApplied();

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
        appliedRemoteRows = false;
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
          appliedRemoteRows = true;
        }
        if (page.cursor) after.cursor = page.cursor;
        if (!persist()) return "failed";
        if (appliedRemoteRows) notifyRemoteRowsApplied();
        if (!page.truncated) {
          if (uploadFailure !== undefined) return "failed";
          lastError = null;
          return "ready";
        }
        log.info(config.events.pullTruncated, { cursor: after.cursor, page: pageIndex + 1 });
        if ((page.cursor ?? null) === (cursorAtPull ?? null)) return "unavailable";
      }
      return "unavailable";
    } catch (error) {
      noteError(error);
      lastError = describeSyncFailure(error, "pull");
      warnLimited(config.events.pullFailed, { error: errorText(error) }, errorText(error));
      return "failed";
    }
  }

  function notifyRemoteRowsApplied(): void {
    for (const listener of [...remoteRowsAppliedListeners]) {
      try {
        listener();
      } catch (error) {
        log.warn(config.events.pullFailed, { error: errorText(error) });
      }
    }
  }

  function isOldWrite(entry: TPending, nowMs: number): boolean {
    return entry.queuedAt !== undefined && nowMs - Date.parse(entry.queuedAt) > STALE_WRITE_CHECK_AGE_MS;
  }

  /**
   * The queued writes a newer row on the account replaces, for a relay that
   * does not refuse them itself. Reads every row changed since the oldest
   * queued write (a legacy bare-stamp `since`, which such a relay accepts),
   * without moving the cache's own cursor. Writes with no known time are left
   * to upload as before.
   */
  async function findSupersededWrites(
    due: TPending[],
    abandoned: () => boolean,
  ): Promise<{ superseded: Array<{ seq: number; current: TRemote }> } | "unavailable" | "abandoned"> {
    const byKey = new Map<string, TPending>();
    let oldestMs = Number.POSITIVE_INFINITY;
    for (const entry of due) {
      const writtenMs = entry.queuedAt ? Date.parse(entry.queuedAt) : Number.NaN;
      if (Number.isNaN(writtenMs)) continue;
      byKey.set(config.pendingKey(entry), entry);
      oldestMs = Math.min(oldestMs, writtenMs);
    }
    const superseded: Array<{ seq: number; current: TRemote }> = [];
    if (!byKey.size) return { superseded };
    let since: string | null = new Date(oldestMs - STALE_WRITE_CLOCK_TOLERANCE_MS).toISOString();
    for (let pageIndex = 0; pageIndex < MAX_PULL_PAGES; pageIndex += 1) {
      const page = await config.pull(since);
      if (!page) return "unavailable";
      if (abandoned()) return "abandoned";
      for (const remote of page.rows) {
        const key = config.remoteKey(remote);
        const entry = byKey.get(key);
        if (!entry) continue;
        if (Date.parse(remote.updatedAt) > Date.parse(entry.queuedAt!) + STALE_WRITE_CLOCK_TOLERANCE_MS) {
          superseded.push({ seq: entry.seq, current: remote });
          byKey.delete(key);
        }
      }
      if (!page.truncated || !page.cursor || page.cursor === since) break;
      since = page.cursor;
    }
    return { superseded };
  }

  /**
   * Drops writes a newer row replaced and adopts that row, so the consumers
   * on this machine see what the account holds. The row is adopted here
   * because the pull will not bring it: the key was skipped while queued, and
   * the cursor has moved past it. True when a row was applied.
   */
  function applySuperseded(superseded: ReadonlyArray<{ seq: number; current: TRemote | null }>): boolean {
    if (!superseded.length) return false;
    const after = readCache();
    const seqs = new Set(superseded.map((entry) => entry.seq));
    const dropped = after.pending.filter((entry) => seqs.has(entry.seq));
    after.pending = after.pending.filter((entry) => !seqs.has(entry.seq));
    let applied = false;
    for (const { current } of superseded) {
      if (!current) continue;
      const key = config.remoteKey(current);
      const next = config.toRow(current, after.rows[key]);
      if (next === null) continue;
      after.rows[key] = next;
      applied = true;
    }
    log.info(config.events.writesSuperseded ?? config.events.uploadFailed, {
      superseded: dropped.length,
      deletes: dropped.filter((entry) => entry.deleted).length,
    });
    return applied;
  }

  /** Clears what landed, parks what the relay refused, adopts what a newer row replaced. */
  function applyUploadResult(due: TPending[], result: AccountCacheUploadResult<TRemote>): boolean {
    const rejected = new Map((result.rejected ?? []).map((entry) => [entry.seq, entry.reason]));
    const superseded = result.superseded ?? [];
    const supersededSeqs = new Set(superseded.map((entry) => entry.seq));
    const completed = new Set(
      (result.completedSeqs ?? due.map((entry) => entry.seq))
        .filter((seq) => !rejected.has(seq) && !supersededSeqs.has(seq)),
    );
    const after = readCache();
    // Matched by sequence rather than by key: an edit made while the upload
    // was in flight carries a newer seq for the same key, and dropping it
    // would lose a change the user believes is saved.
    const parkedAt = new Date(now()).toISOString();
    after.pending = after.pending.flatMap((entry) => {
      if (completed.has(entry.seq)) return [];
      const reason = rejected.get(entry.seq);
      return reason === undefined ? [entry] : [{ ...entry, parked: { reason, at: parkedAt } }];
    });
    // Adopt the server's stamp for everything that landed. Without this the
    // cached row still carries a local provisional time, and the pull — which
    // asks from a cursor taken BEFORE this upload — would hand back the older
    // server row and revert the user's own edit.
    if (result.updatedAt) {
      for (const entry of due) {
        if (entry.deleted || !completed.has(entry.seq)) continue;
        const cached = after.rows[config.pendingKey(entry)];
        if (cached) cached.updatedAt = result.updatedAt;
      }
    }
    if (rejected.size) {
      const reasons = [...new Set(rejected.values())].sort();
      warnLimited(config.events.itemsParked ?? config.events.uploadFailed, {
        parked: rejected.size,
        reasons,
      }, reasons.join(","));
    }
    return applySuperseded(superseded);
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
          // A reset during the pass (sign-out, account switch) owns the state
          // now; this pass's failure must not hold the next owner back.
          if (epoch === epochAtStart) recordSyncOutcome(status, lastErrorRateLimited);
          return status;
        })
        .finally(() => {
          syncInFlight = null;
          if (flushAfterInFlight) {
            flushAfterInFlight = false;
            if (hasUnparked(readCache().pending)) scheduleFlush();
          }
        });
      return syncInFlight;
    },

    async syncIfStale(maxAgeMs: number): Promise<AccountCacheSyncStatus> {
      if (syncInFlight) return await syncInFlight;
      // Inside a failure backoff a read answers from the cache: every agent
      // read retrying a relay that just refused would be the flood the
      // backoff exists to stop. An explicit `sync()` still goes through.
      if (backoffRemainingMs() > 0) return "failed";
      const accountUserId = config.getAccountUserId();
      if (
        accountUserId
        && lastSyncWasReadyFor(accountUserId)
        && !hasUnparked(readCache().pending)
        && Date.now() - lastReadySyncAtMs <= Math.max(0, maxAgeMs)
      ) {
        return "ready";
      }
      return await store.sync();
    },

    pendingKeys(): string[] {
      return readCache().pending.map((entry) => config.pendingKey(entry));
    },

    health(): AccountCacheHealth {
      const accountUserId = config.getAccountUserId();
      const pending = accountUserId ? readCache().pending : [];
      const parked = pending.filter((entry) => entry.parked).length;
      const pendingChanges = pending.length - parked;
      const synced = accountUserId !== null
        && lastSyncedAccountUserId === accountUserId
        && lastSyncedEpoch === epoch;
      const status = synced ? lastSyncStatus : null;
      const lastSyncedAt = synced && lastReadySyncAtMs > 0 ? new Date(lastReadySyncAtMs).toISOString() : null;
      const base = { lastSyncedAt, pendingChanges, parked };
      if (!config.hasRelay()) {
        return { ...base, state: "unavailable", lastError: "This computer has no account service to sync with." };
      }
      if (!accountUserId) return { ...base, state: "unavailable", lastError: "This computer is signed out of its ADE account." };
      if (status === "failed") {
        return { ...base, state: "failing", lastError: lastError ?? "Syncing with your account failed. It retries on its own." };
      }
      if (parked > 0) {
        const reasons = [...new Set(pending.flatMap((entry) => (entry.parked ? [entry.parked.reason] : [])))].sort();
        return {
          ...base,
          state: "failing",
          lastError: `Your account service refused ${parked === 1 ? "1 change" : `${parked} changes`} from this computer (${reasons.join(", ")}). `
            + "ADE keeps them on this computer and tries again every hour.",
        };
      }
      if (status === "ready") return { ...base, state: "ok", lastError: null };
      if (status === "unavailable") {
        return { ...base, state: "unavailable", lastError: "ADE couldn't ask your account service yet (no sign-in token, or the service can't store secrets right now)." };
      }
      return { ...base, state: "unavailable", lastError: "ADE hasn't synced with your account yet." };
    },

    attachLogger(extra: AccountCacheLogger): void {
      loggers.add(extra);
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
    startPeriodicSync(
      intervalMs = config.defaultSyncIntervalMs,
      onSync?: AccountCacheSyncListener,
      onRemoteRowsApplied?: AccountCacheRemoteRowsAppliedListener,
    ): () => void {
      syncHolders += 1;
      if (onSync) syncListeners.add(onSync);
      if (onRemoteRowsApplied) remoteRowsAppliedListeners.add(onRemoteRowsApplied);
      let released = false;
      const release = (): void => {
        // Each caller's stop is its own. Calling it twice must not release a
        // hold that belongs to another project scope.
        if (released) return;
        released = true;
        if (onSync) syncListeners.delete(onSync);
        if (onRemoteRowsApplied) remoteRowsAppliedListeners.delete(onRemoteRowsApplied);
        stopPeriodicSync();
      };
      if (syncTimer) return release;
      syncTimer = setInterval(() => {
        // Failing or rate-limited: stay quiet until the backoff passes, and do
        // not tell listeners "ready" about a cache that could not be refreshed.
        if (!syncInFlight && backoffRemainingMs() > 0) return;
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
          if (backoffRemainingMs() > 0) return;
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
        log.warn(config.events.purgeFailed ?? config.events.writeFailed, {
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
