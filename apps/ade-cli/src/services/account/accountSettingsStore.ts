import {
  createAccountCacheStore,
  createStoreRegistry,
  type AccountCacheLogger,
  type AccountCacheSyncStatus,
} from "./accountCacheStore";
import type {
  AccountSettingRecord,
  AccountSettingWrite,
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

/** Separator for the composite cache key. NUL cannot occur in either half. */
const KEY_SEPARATOR = "\u0000";

export type AccountSettingsLogger = AccountCacheLogger;

type CachedSetting = {
  value: unknown;
  updatedAt: string;
  changedAt: string | null;
  writerDeviceId: string | null;
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
  return { value: value.value, updatedAt, changedAt, writerDeviceId };
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
  putAccountSettings(
    settings: AccountSettingWrite[],
    deviceId: string | null,
  ): Promise<{ updatedAt: string | null } | null>;
  deleteAccountSetting(scope: string, key: string): Promise<boolean | null>;
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
    events: {
      writeFailed: "account.settings_cache_write_failed",
      mutationDropped: "account.settings_mutation_dropped",
      uploadFailed: "account.settings_upload_failed",
      pullFailed: "account.settings_pull_failed",
      pullTruncated: "account.settings_pull_truncated",
      cacheEntryDropped: "account.settings_cache_entry_dropped",
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
      const writes = pending.filter((entry) => !entry.deleted);
      let uploadedAt: string | null = null;
      if (writes.length) {
        const result = await relay.putAccountSettings(
          writes.map((entry) => ({
            scope: entry.scope,
            key: entry.key,
            value: entry.value,
            changedAt: entry.changedAt,
          })),
          args.getDeviceId?.() ?? null,
        );
        // `null` means there was no token to ask with. The queue stays.
        if (result === null) return null;
        uploadedAt = result.updatedAt;
      }
      for (const entry of pending.filter((item) => item.deleted)) {
        const deleted = await relay.deleteAccountSetting(entry.scope, entry.key);
        if (deleted === null) return null;
      }
      return { updatedAt: uploadedAt };
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
    }),
  });

  return {
    /** The whole cached view, optionally narrowed to one scope. */
    list(scope?: string): AccountSettingRecord[] {
      const current = cache.readCache();
      const rows: AccountSettingRecord[] = [];
      for (const [composite, setting] of Object.entries(current.rows)) {
        const split = splitCacheKey(composite);
        if (!split) continue;
        if (scope && split.scope !== scope) continue;
        rows.push({ ...split, ...setting });
      }
      return rows.sort((left, right) => left.key.localeCompare(right.key));
    },

    get(scope: string, key: string): unknown {
      return cache.readCache().rows[cacheKey(scope, key)]?.value;
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
        delete current.rows[cacheKey(scope, key)];
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
    startPeriodicSync(intervalMs = DEFAULT_SYNC_INTERVAL_MS): () => void {
      return cache.startPeriodicSync(intervalMs);
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
  return registry.get(adeDir, create);
}

/** Test seam: drops the singletons so one test cannot see another's store. */
export function resetSharedAccountSettingsStoresForTests(): void {
  registry.resetForTests();
}
