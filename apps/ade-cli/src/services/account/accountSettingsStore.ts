import {
  accountItemRejectionReason,
  createAccountCacheStore,
  createStoreRegistry,
  isAccountItemRejection,
  machineAccountStoreLogger,
  putIsolated,
  type AccountCacheHealth,
  type AccountCacheLogger,
  type AccountCacheSyncStatus,
} from "./accountCacheStore";
import type {
  AccountSettingRecord,
  AccountSettingWrite,
  AccountStaleDelete,
  AccountWriteResult,
} from "../push/accountRelayRows";
import type { AccountSettingsWriteOptions } from "../../../../desktop/src/shared/types/accountSettings";

/**
 * The machine's copy of the account settings store.
 *
 * All of the cache machinery — the `0600` file, the queue, single-flight
 * push-then-pull, the shared timer — lives in `accountCacheStore`. What is here
 * is only what is settings-shaped: a `<scope, key>` axis, values of any JSON
 * type, and the fact that settings SURVIVE a sign-out (the vault does not).
 *
 * Reads never touch the network: a write lands in the cache and is answered
 * immediately, then queues for upload. The machine is the fast path, the Worker
 * is the authority.
 */

const CACHE_FILE = "account-settings.json";
const CACHE_VERSION = 1;

/** Matches the account-directory heartbeat, so the two converge together. */
const DEFAULT_SYNC_INTERVAL_MS = 30_000;

/**
 * The Worker's cap on one setting's JSON (`MAX_SETTING_VALUE_BYTES` in
 * `push-relay/src/accountSettings.ts`). It rejects a whole batch for one value
 * over it, so such a value is dropped from the queue instead of sent.
 */
const MAX_UPLOAD_VALUE_CHARS = 16_000;
/** The Worker's `MAX_SETTINGS_PER_WRITE`; a longer batch is refused whole (413). */
const MAX_SETTINGS_PER_PUT = 200;

/** Separator for the composite cache key. NUL cannot occur in either half. */
const KEY_SEPARATOR = "\u0000";

export type AccountSettingsLogger = AccountCacheLogger;

type CachedSetting = {
  value: unknown;
  updatedAt: string;
  changedAt: string | null;
  writerDeviceId: string | null;
  /** True on a tombstone: this key was deleted on some machine. */
  deleted?: boolean;
};

type PendingWrite = {
  scope: string;
  key: string;
  /** `undefined` means "delete this", which is why it is a distinct field. */
  value: unknown;
  deleted: boolean;
  changedAt: string;
  /** Monotonic per cache; see `AccountCachePending` for why it is not a time. */
  seq: number;
  /** Cache-owned; see `AccountCachePending`. */
  queuedAt?: string;
  parked?: { reason: string; at: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function decodeCachedSetting(value: unknown): CachedSetting | null {
  if (!isRecord(value) || !("value" in value)) return null;
  const updatedAt = nonEmptyString(value.updatedAt);
  const changedAt = value.changedAt === null || typeof value.changedAt === "string"
    ? value.changedAt
    : undefined;
  const writerDeviceId = value.writerDeviceId === null || typeof value.writerDeviceId === "string"
    ? value.writerDeviceId
    : undefined;
  if (!updatedAt || changedAt === undefined || writerDeviceId === undefined) return null;
  if (value.deleted !== undefined && typeof value.deleted !== "boolean") return null;
  return {
    value: value.value,
    updatedAt,
    changedAt,
    writerDeviceId,
    ...(value.deleted === true ? { deleted: true } : {}),
  };
}

function decodePendingWrite(value: unknown): PendingWrite | null {
  if (!isRecord(value)) return null;
  const scope = nonEmptyString(value.scope);
  const key = nonEmptyString(value.key);
  const changedAt = nonEmptyString(value.changedAt);
  if (
    !scope
    || !key
    || !changedAt
    || typeof value.deleted !== "boolean"
    || typeof value.seq !== "number"
    || !Number.isSafeInteger(value.seq)
    || value.seq <= 0
    || (!value.deleted && !("value" in value))
  ) return null;
  return {
    scope,
    key,
    value: value.value,
    deleted: value.deleted,
    changedAt,
    seq: value.seq,
  };
}

function cacheKey(scope: string, key: string): string {
  return `${scope}${KEY_SEPARATOR}${key}`;
}

function splitCacheKey(composite: string): { scope: string; key: string } | null {
  const index = composite.indexOf(KEY_SEPARATOR);
  if (index <= 0) return null;
  return { scope: composite.slice(0, index), key: composite.slice(index + 1) };
}

export type AccountSettingsRelay = {
  getAccountSettings(options?: { since?: string | null; scope?: string | null }): Promise<{
    settings: AccountSettingRecord[];
    cursor: string | null;
    truncated: boolean;
  } | null>;
  /** `results` only from a relay that answers per item; see `AccountWriteResult`. */
  putAccountSettings(
    settings: AccountSettingWrite[],
    deviceId: string | null,
  ): Promise<{ updatedAt: string | null; results?: AccountWriteResult<AccountSettingRecord>[] } | null>;
  deleteAccountSetting(
    scope: string,
    key: string,
    options?: { writtenAt?: string | null },
  ): Promise<boolean | AccountStaleDelete<AccountSettingRecord> | null>;
};

export function createAccountSettingsStore(args: {
  /** The machine ADE directory; the cache is a sibling of `projects.json`. */
  adeDir: string;
  relay: AccountSettingsRelay | null;
  /** The signed-in account, or null. Re-read on every call, never captured. */
  getAccountUserId: () => string | null;
  getDeviceId?: () => string | null;
  logger?: AccountSettingsLogger;
  now?: () => number;
}) {
  const now = args.now ?? Date.now;
  const logger = args.logger ?? { info: () => {}, warn: () => {} };

  const cache = createAccountCacheStore<CachedSetting, PendingWrite, AccountSettingRecord>({
    adeDir: args.adeDir,
    cacheFileName: CACHE_FILE,
    cacheVersion: CACHE_VERSION,
    rowsField: "settings",
    getAccountUserId: args.getAccountUserId,
    logger,
    defaultSyncIntervalMs: DEFAULT_SYNC_INTERVAL_MS,
    changeMarkKind: "settings",
    now,
    events: {
      writeFailed: "account.settings_cache_write_failed",
      mutationDropped: "account.settings_mutation_dropped",
      uploadFailed: "account.settings_upload_failed",
      pullFailed: "account.settings_pull_failed",
      pullTruncated: "account.settings_pull_truncated",
      cacheEntryDropped: "account.settings_cache_entry_dropped",
      itemsParked: "account.settings_items_parked",
      writesSuperseded: "account.settings_writes_superseded",
    },
    hasRelay: () => args.relay !== null,
    pendingMatches: (existing, write) =>
      existing.scope === write.scope && existing.key === write.key,
    pendingKey: (entry) => cacheKey(entry.scope, entry.key),
    remoteKey: (row) => cacheKey(row.scope, row.key),
    decodeRow: decodeCachedSetting,
    decodePending: decodePendingWrite,
    async upload(pending) {
      const relay = args.relay!;
      const completedSeqs: number[] = [];
      const writes = pending.filter((entry) => {
        if (entry.deleted) return false;
        if ((JSON.stringify(entry.value) ?? "").length <= MAX_UPLOAD_VALUE_CHARS) return true;
        // Retrying it can never succeed, and while it waits in the batch every
        // other setting this machine changes stays off the account too. It
        // stays in this machine's cache; the next smaller write replaces it.
        logger.warn("account.settings_value_too_large", { scope: entry.scope, key: entry.key });
        completedSeqs.push(entry.seq);
        return false;
      });
      const rejected: Array<{ seq: number; reason: string }> = [];
      const superseded: Array<{ seq: number; current: AccountSettingRecord | null }> = [];
      let uploadedAt: string | null = null;
      let checkedConflicts = false;
      let couldNotAsk = false;
      let error: unknown = undefined;
      // One setting the Worker will not take is set aside on its own
      // (`putIsolated`), never held against the rest of the batch.
      const outcome = await putIsolated(writes, MAX_SETTINGS_PER_PUT, (batch) => relay.putAccountSettings(
        batch.map((entry) => ({
          scope: entry.scope,
          key: entry.key,
          value: entry.value,
          changedAt: entry.changedAt,
          writtenAt: entry.queuedAt ?? entry.changedAt,
        })),
        args.getDeviceId?.() ?? null,
      ));
      for (const { batch, result } of outcome.landed) {
        if (result.results) checkedConflicts = true;
        let wrote = false;
        batch.forEach((entry, index) => {
          const answer = result.results ? result.results[index] : { status: "written" as const };
          if (answer?.status === "written") {
            completedSeqs.push(entry.seq);
            wrote = true;
          } else if (answer?.status === "rejected") {
            rejected.push({ seq: entry.seq, reason: answer.reason });
          } else if (answer?.status === "stale") {
            superseded.push({ seq: entry.seq, current: answer.current });
          }
        });
        if (wrote) uploadedAt ??= result.updatedAt;
      }
      rejected.push(...outcome.rejected.map(({ item, reason }) => ({ seq: item.seq, reason })));
      couldNotAsk = outcome.couldNotAsk;
      error = outcome.error;
      if (!couldNotAsk && error === undefined) {
        for (const entry of pending.filter((item) => item.deleted)) {
          let answer: boolean | AccountStaleDelete<AccountSettingRecord> | null;
          try {
            answer = await relay.deleteAccountSetting(entry.scope, entry.key, {
              writtenAt: entry.queuedAt ?? entry.changedAt,
            });
          } catch (deleteError) {
            if (isAccountItemRejection(deleteError)) {
              rejected.push({ seq: entry.seq, reason: accountItemRejectionReason(deleteError) });
              continue;
            }
            error = deleteError;
            break;
          }
          if (answer === null) {
            couldNotAsk = true;
            break;
          }
          if (typeof answer === "object") superseded.push({ seq: entry.seq, current: answer.current });
          else completedSeqs.push(entry.seq);
        }
      }
      if (couldNotAsk && !completedSeqs.length && !rejected.length && !superseded.length) return null;
      return {
        updatedAt: uploadedAt,
        completedSeqs,
        rejected,
        superseded,
        checkedConflicts,
        ...(error !== undefined ? { error } : {}),
      };
    },
    async pull(cursor) {
      const page = await args.relay!.getAccountSettings({ since: cursor });
      if (!page) return null;
      return { rows: page.settings, cursor: page.cursor, truncated: page.truncated };
    },
    toRow: (row) => ({
      value: row.value,
      updatedAt: row.updatedAt,
      changedAt: row.changedAt,
      writerDeviceId: row.writerDeviceId,
      // A delete is a row here, not an absence. Dropping it would leave the
      // value readable on this machine after it was deleted on another one.
      ...(row.deleted === true ? { deleted: true } : {}),
    }),
  });

  return {
    /** The whole cached view, optionally narrowed to one scope. */
    list(scope?: string): AccountSettingRecord[] {
      const current = cache.readCache();
      const rows: AccountSettingRecord[] = [];
      for (const [composite, setting] of Object.entries(current.rows)) {
        // A tombstone is bookkeeping, not a setting. Callers list settings.
        if (setting.deleted) continue;
        const split = splitCacheKey(composite);
        if (!split) continue;
        if (scope && split.scope !== scope) continue;
        rows.push({ ...split, ...setting });
      }
      return rows.sort((left, right) => left.key.localeCompare(right.key));
    },

    /**
     * Keys in one scope that some machine deleted. `list` hides tombstones;
     * a copy between scopes needs them so it does not bring a deleted row back.
     */
    deletedKeys(scope: string): Array<{ key: string; updatedAt: string }> {
      const keys: Array<{ key: string; updatedAt: string }> = [];
      for (const [composite, setting] of Object.entries(cache.readCache().rows)) {
        if (!setting.deleted) continue;
        const split = splitCacheKey(composite);
        if (split && split.scope === scope) keys.push({ key: split.key, updatedAt: setting.updatedAt });
      }
      return keys.sort((left, right) => left.key.localeCompare(right.key));
    },

    get(scope: string, key: string): unknown {
      const row = cache.readCache().rows[cacheKey(scope, key)];
      // A key deleted on another machine reads as absent here too, which is what
      // makes an account-scoped setting match on every machine.
      return row?.deleted ? undefined : row?.value;
    },

    /**
     * Record a change. Answers from the cache immediately; the upload is the
     * store's problem, not the caller's.
     */
    set(
      scope: string,
      key: string,
      value: unknown,
      options?: AccountSettingsWriteOptions,
    ): boolean {
      const changedAt = new Date(now()).toISOString();
      return cache.mutate((current, queue) => {
        current.rows[cacheKey(scope, key)] = {
          value,
          // Provisional until the relay stamps it. Marked with the local clock so
          // a later pull, whose stamps come from the Worker, always wins a tie.
          updatedAt: changedAt,
          changedAt,
          writerDeviceId: args.getDeviceId?.() ?? null,
        };
        queue({ scope, key, value, deleted: false, changedAt });
      }, { expectedAccountUserId: options?.expectedAccountUserId });
    },

    remove(scope: string, key: string, options?: AccountSettingsWriteOptions): boolean {
      return cache.mutate((current, queue) => {
        // Keep a tombstone rather than dropping the row, for the same reason the
        // vault store does: a dropped row leaves nothing for a stale page from a
        // pre-delete cursor to lose against, so the key comes back.
        const stamp = new Date(now()).toISOString();
        current.rows[cacheKey(scope, key)] = {
          value: undefined,
          updatedAt: stamp,
          changedAt: stamp,
          writerDeviceId: args.getDeviceId?.() ?? null,
          deleted: true,
        };
        queue({
          scope,
          key,
          value: undefined,
          deleted: true,
          changedAt: new Date(now()).toISOString(),
        });
      }, { expectedAccountUserId: options?.expectedAccountUserId });
    },

    /** Flush what is queued, then take what changed. Single-flight. */
    sync(): Promise<AccountCacheSyncStatus> {
      return cache.sync();
    },

    /**
     * Drop every cached account setting. Called on an account switch.
     *
     * Settings survive sign-out by design — the vault does not. Resetting a
     * user's theme and keybindings because their token expired would read as
     * data loss for values that were never secret. So this is only for the
     * account-switch path, where the alternative is showing one user another
     * user's configuration.
     */
    clearForAccountSwitch(): void {
      cache.reset();
    },

    /** Start (or join) the shared background sync. Refcounted; see the helper. */
    startPeriodicSync(intervalMs = DEFAULT_SYNC_INTERVAL_MS, onRemoteRowsApplied?: () => void): () => void {
      return cache.startPeriodicSync(intervalMs, undefined, onRemoteRowsApplied);
    },

    /** How this machine's settings sync is doing, without the network. */
    health(): AccountCacheHealth {
      return cache.health();
    },

    /** Also log to `logger`; see `getSharedAccountSettingsStore`. */
    attachLogger(logger: AccountSettingsLogger): void {
      cache.attachLogger(logger);
    },

    /** Test seam; never used in production. */
    cachePathForTests(): string {
      return cache.cachePath;
    },
  };
}

export type AccountSettingsStore = ReturnType<typeof createAccountSettingsStore>;

/**
 * One store per machine ADE directory: two stores over one cache file would
 * race each other's cursor and queue.
 */
const registry = createStoreRegistry<AccountSettingsStore>();

export function getSharedAccountSettingsStore(
  adeDir: string,
  create: () => AccountSettingsStore,
): AccountSettingsStore {
  return registry.get(adeDir, () => {
    const store = create();
    // Machine-shared: its failures belong in the machine's log, whoever built it.
    const machineLogger = machineAccountStoreLogger(adeDir);
    if (machineLogger) store.attachLogger(machineLogger);
    return store;
  });
}

/** Test seam: drops the singletons so one test cannot see another's store. */
export function resetSharedAccountSettingsStoresForTests(): void {
  registry.resetForTests();
}
