import fs from "node:fs";
import path from "node:path";
import {
  createAccountCacheStore,
  createStoreRegistry,
  type AccountCacheHealth,
  type AccountCacheLogger,
  type AccountCacheSyncListener,
  type AccountCacheSyncStatus,
} from "./accountCacheStore";
import { machineAccountStoreLogger } from "./accountCacheDiagnostics";
import { uploadAccountItems } from "./accountCacheUpload";
import { EncryptedFileCredentialStore } from "../credentials/credentialStore";
import {
  NEWER_VAULT_KINDS,
  isAccountVaultItemKind,
  type AccountStaleDelete,
  type AccountVaultItem,
  type AccountVaultItemKind,
  type AccountVaultWrite,
  type AccountWriteResult,
} from "../push/accountRelayRows";
import type { AccountVaultWriteOptions } from "../../../../desktop/src/shared/types/accountVault";

/**
 * The machine's copy of the vault.
 *
 * Same cache machinery as the settings store — it is literally the same helper
 * — and for the same reason: an agent that needed a network round trip to read
 * an API key would stall on every launch, and a laptop on a train would stop
 * working. The account makes credentials follow you; it does not make them
 * require a server.
 *
 * What is different, and therefore what lives here, is three things: a
 * `<scope, kind, key>` axis; the rule that the server's "I cannot read this"
 * must never overwrite a value that still works here; and sign-out behaviour.
 * The file holds credentials, so it is **purged on a deliberate sign-out** —
 * settings survive a sign-out, the vault does not. Resetting someone's theme
 * because their token expired reads as data loss; leaving synced API keys
 * readable on a machine they just signed out of is the wrong default for a
 * shared or handed-on laptop.
 */

const CACHE_FILE = "account-vault.json.enc";
const LEGACY_CACHE_FILE = "account-vault.json";
const CACHE_VERSION = 1;
const DEFAULT_SYNC_INTERVAL_MS = 30_000;
const CACHE_PAYLOAD_KEY = "account.vault.cache.v1";
/** The Worker's `MAX_ITEMS_PER_WRITE`; a longer batch is refused whole (413). */
const MAX_ITEMS_PER_PUT = 100;

/** Separator for the composite cache key. NUL cannot occur in any of the three. */
const KEY_SEPARATOR = "\u0000";

export type AccountVaultLogger = AccountCacheLogger;

type CachedItem = {
  value: string | null;
  updatedAt: string;
  writerDeviceId: string | null;
  refreshOwner: string | null;
  /** True on a tombstone: the key was deleted on some machine. */
  deleted?: boolean;
};

type PendingWrite = {
  scope: string;
  kind: AccountVaultItemKind;
  key: string;
  value: string | null;
  deleted: boolean;
  refreshOwner: string | null;
  /** Monotonic per cache; see `AccountCachePending` for why it is not a time. */
  seq: number;
  /** Cache-owned; see `AccountCachePending`. */
  queuedAt?: string;
  parked?: { reason: string; at: string };
};

type AccountVaultStoreWriteOptions = AccountVaultWriteOptions & {
  /** Relay metadata stays local to the brain store and is never a wire arg. */
  refreshOwner?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}


function readNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function decodeCachedItem(value: unknown): CachedItem | null {
  if (!isRecord(value)) return null;
  const updatedAt = nonEmptyString(value.updatedAt);
  const itemValue = value.value === null || typeof value.value === "string" ? value.value : undefined;
  const writerDeviceId = readNullableString(value.writerDeviceId);
  const refreshOwner = readNullableString(value.refreshOwner);
  if (!updatedAt || itemValue === undefined || writerDeviceId === undefined || refreshOwner === undefined) return null;
  if (value.deleted !== undefined && typeof value.deleted !== "boolean") return null;
  return {
    value: itemValue,
    updatedAt,
    writerDeviceId,
    refreshOwner,
    ...(value.deleted === true ? { deleted: true } : {}),
  };
}

function decodePendingWrite(value: unknown): PendingWrite | null {
  if (!isRecord(value)) return null;
  const scope = nonEmptyString(value.scope);
  const kind = isAccountVaultItemKind(value.kind) ? value.kind : null;
  const key = nonEmptyString(value.key);
  const itemValue = value.value === null || typeof value.value === "string" ? value.value : undefined;
  const refreshOwner = readNullableString(value.refreshOwner);
  if (
    !scope
    || !kind
    || !key
    || itemValue === undefined
    || typeof value.deleted !== "boolean"
    || refreshOwner === undefined
    || typeof value.seq !== "number"
    || !Number.isSafeInteger(value.seq)
    || value.seq <= 0
  ) return null;
  return {
    scope,
    kind,
    key,
    value: itemValue,
    deleted: value.deleted,
    refreshOwner,
    seq: value.seq,
  };
}

/** `<scope> <kind> <key>`, NUL-separated. */
function cacheKey(scope: string, kind: string, key: string): string {
  return `${scope}${KEY_SEPARATOR}${kind}${KEY_SEPARATOR}${key}`;
}

function splitCacheKey(
  composite: string,
): { scope: string; kind: AccountVaultItemKind; key: string } | null {
  const parts = composite.split(KEY_SEPARATOR);
  if (parts.length !== 3 || !parts[0] || !parts[2] || !isAccountVaultItemKind(parts[1])) return null;
  return {
    scope: parts[0]!,
    kind: parts[1],
    key: parts[2]!,
  };
}

export type AccountVaultRelay = {
  /**
   * Where the relay lives (the push relay client's `baseUrl`). What the cache
   * learned about the relay is kept against it, so a different relay is asked
   * again.
   */
  baseUrl?: string;
  getAccountVault(options?: { since?: string | null; scope?: string | null }): Promise<{
    items: AccountVaultItem[];
    cursor: string | null;
    truncated: boolean;
  } | null>;
  /** `results` only from a relay that answers per item; see `AccountWriteResult`. */
  putAccountVault(
    items: AccountVaultWrite[],
    deviceId: string | null,
  ): Promise<{ updatedAt: string | null; results?: AccountWriteResult<AccountVaultItem>[] } | null>;
  deleteAccountVaultItem(
    scope: string,
    kind: string,
    key: string,
    options?: { writtenAt?: string | null },
  ): Promise<boolean | AccountStaleDelete<AccountVaultItem> | null>;
};

export function createAccountVaultStore(args: {
  adeDir: string;
  relay: AccountVaultRelay | null;
  getAccountUserId: () => string | null;
  getDeviceId?: () => string | null;
  logger?: AccountVaultLogger;
  now?: () => number;
}) {
  const now = args.now ?? Date.now;
  const logger = args.logger ?? { info: () => {}, warn: () => {} };
  const cachePath = path.join(args.adeDir, CACHE_FILE);
  const legacyCachePath = path.join(args.adeDir, LEGACY_CACHE_FILE);
  // The cache payload uses the same machine key as credentials.json.enc, but
  // has its own encrypted envelope and path. Tests can point both paths at a
  // temporary directory without touching the user's live ADE state.
  const encryptedCacheStore = new EncryptedFileCredentialStore({
    credentialsPath: cachePath,
    machineKeyPath: path.join(args.adeDir, "secrets", ".machine-key"),
    lockPath: `${cachePath}.lock`,
  });
  let legacyCacheLoaded = false;

  const removeLegacyCache = (): void => {
    if (!fs.existsSync(legacyCachePath)) {
      legacyCacheLoaded = false;
      return;
    }
    try {
      fs.rmSync(legacyCachePath, { force: true });
      legacyCacheLoaded = false;
    } catch (error) {
      logger.warn("account.vault_legacy_cache_remove_failed", {
        error: error instanceof Error ? error.message : String(error ?? ""),
      });
    }
  };

  const readCacheFile = (targetPath: string): unknown | null => {
    if (fs.existsSync(targetPath)) {
      const encrypted = encryptedCacheStore.getSync(CACHE_PAYLOAD_KEY);
      if (!encrypted) return null;
      try {
        const parsed = JSON.parse(encrypted) as unknown;
        // A previous migration may have completed before its cleanup. Once a
        // valid encrypted copy is readable, the plaintext sibling is no longer
        // needed and must not remain as a second credential source.
        removeLegacyCache();
        return parsed;
      } catch {
        return null;
      }
    }
    if (!fs.existsSync(legacyCachePath)) return null;
    try {
      legacyCacheLoaded = true;
      return JSON.parse(fs.readFileSync(legacyCachePath, "utf8")) as unknown;
    } catch {
      legacyCacheLoaded = false;
      return null;
    }
  };

  const writeCacheFile = (_targetPath: string, contents: string): void => {
    // EncryptedFileCredentialStore performs the lock, atomic replacement, and
    // 0600 creation. The plaintext legacy file is removed only after this
    // encrypted write succeeds.
    encryptedCacheStore.setSync(CACHE_PAYLOAD_KEY, contents);
    if (legacyCacheLoaded || fs.existsSync(legacyCachePath)) removeLegacyCache();
  };

  const cache = createAccountCacheStore<CachedItem, PendingWrite, AccountVaultItem>({
    adeDir: args.adeDir,
    cacheFileName: CACHE_FILE,
    cacheVersion: CACHE_VERSION,
    rowsField: "items",
    getAccountUserId: args.getAccountUserId,
    logger,
    defaultSyncIntervalMs: DEFAULT_SYNC_INTERVAL_MS,
    changeMarkKind: "vault",
    flushOnWrite: true,
    now,
    events: {
      writeFailed: "account.vault_cache_write_failed",
      mutationDropped: "account.vault_mutation_dropped",
      uploadFailed: "account.vault_upload_failed",
      pullFailed: "account.vault_pull_failed",
      pullTruncated: "account.vault_pull_truncated",
      cacheEntryDropped: "account.vault_cache_entry_dropped",
      purgeFailed: "account.vault_purge_failed",
      itemsParked: "account.vault_items_parked",
      writesSuperseded: "account.vault_writes_superseded",
    },
    readFile: readCacheFile,
    writeFile: writeCacheFile,
    hasRelay: () => args.relay !== null,
    relayId: () => args.relay?.baseUrl ?? null,
    pendingMatches: (existing, write) =>
      existing.scope === write.scope
      && existing.kind === write.kind
      && existing.key === write.key,
    pendingKey: (entry) => cacheKey(entry.scope, entry.kind, entry.key),
    remoteKey: (item) => cacheKey(item.scope, item.kind, item.key),
    decodeRow: decodeCachedItem,
    decodePending: decodePendingWrite,
    async upload(pending) {
      const relay = args.relay!;
      const deviceId = args.getDeviceId?.() ?? null;
      const allWrites = pending.filter((entry) => !entry.deleted && entry.value != null);
      // Kinds newer than some deployed Workers go in their own batch, so an
      // older Worker refuses only those rows, never every other credential.
      // Within a group, one item a Worker will not take is set aside on its
      // own, never held against the rest.
      return await uploadAccountItems<PendingWrite, AccountVaultItem>({
        groups: [
          allWrites.filter((entry) => !NEWER_VAULT_KINDS.has(entry.kind)),
          allWrites.filter((entry) => NEWER_VAULT_KINDS.has(entry.kind)),
        ],
        deletes: pending.filter((entry) => entry.deleted),
        maxBatch: MAX_ITEMS_PER_PUT,
        put: (batch) => relay.putAccountVault(
          batch.map((entry) => ({
            scope: entry.scope,
            kind: entry.kind,
            key: entry.key,
            value: entry.value!,
            refreshOwner: entry.refreshOwner,
            ...(entry.queuedAt ? { writtenAt: entry.queuedAt } : {}),
          })),
          deviceId,
        ),
        del: (entry) => relay.deleteAccountVaultItem(entry.scope, entry.kind, entry.key, {
          writtenAt: entry.queuedAt ?? null,
        }),
      });
    },
    async pull(cursor) {
      const page = await args.relay!.getAccountVault({ since: cursor });
      if (!page) return null;
      return { rows: page.items, cursor: page.cursor, truncated: page.truncated };
    },
    toRow: (item, cached) => {
      // A tombstone is the one row that DOES have to replace a readable local
      // value: it says the credential was deleted on another machine, and the
      // consumer has to hear it.
      if (item.deleted) {
        return {
          value: null,
          updatedAt: item.updatedAt,
          writerDeviceId: item.writerDeviceId,
          refreshOwner: item.refreshOwner,
          deleted: true,
        };
      }
      // Otherwise a row the relay could not open keeps its old value visible on
      // the surface so it can say "ADE cannot read this"; do NOT let it
      // overwrite a value this machine still holds, or a key rotation on the
      // server would wipe a working local credential.
      if (item.value === null && cached?.value != null) return null;
      return {
        value: item.value,
        updatedAt: item.updatedAt,
        writerDeviceId: item.writerDeviceId,
        refreshOwner: item.refreshOwner,
      };
    },
  });

  return {
    /**
     * Every item this machine knows about, with values omitted.
     *
     * The list surface never needs the credentials themselves, and a list call
     * that returned them would be one careless log line away from printing
     * every key a user owns.
     */
    list(scope?: string): Array<{
      scope: string;
      kind: AccountVaultItemKind;
      key: string;
      updatedAt: string;
      /** False when the relay could not open the stored bytes. */
      readable: boolean;
      refreshOwner: string | null;
      /** True on a tombstone, so a consumer can drop its own copy of the key. */
      deleted?: boolean;
    }> {
      const current = cache.readCache();
      const rows = [];
      for (const [composite, item] of Object.entries(current.rows)) {
        const split = splitCacheKey(composite);
        if (!split) continue;
        if (scope && split.scope !== scope) continue;
        rows.push({
          ...split,
          updatedAt: item.updatedAt,
          readable: item.value !== null,
          refreshOwner: item.refreshOwner,
          ...(item.deleted === true ? { deleted: true } : {}),
        });
      }
      return rows.sort((left, right) => left.key.localeCompare(right.key));
    },

    /** The credential itself. Callers are the services that use it, not the UI. */
    get(scope: string, kind: AccountVaultItemKind, key: string): string | null {
      return cache.readCache().rows[cacheKey(scope, kind, key)]?.value ?? null;
    },

    set(
      scope: string,
      kind: AccountVaultItemKind,
      key: string,
      value: string,
      options?: AccountVaultStoreWriteOptions,
    ): boolean {
      const refreshOwner = options?.refreshOwner !== undefined
        ? options.refreshOwner
        : kind === "linear_refresh_token"
          ? (args.getDeviceId?.() ?? null)
          : null;
      return cache.mutate((current, queue) => {
        // Writing the key again is what un-deletes it: the tombstone goes.
        current.rows[cacheKey(scope, kind, key)] = {
          value,
          updatedAt: new Date(now()).toISOString(),
          writerDeviceId: args.getDeviceId?.() ?? null,
          refreshOwner,
        };
        queue({ scope, kind, key, value, deleted: false, refreshOwner });
      }, { expectedAccountUserId: options?.expectedAccountUserId });
    },

    remove(
      scope: string,
      kind: AccountVaultItemKind,
      key: string,
      options?: AccountVaultWriteOptions,
    ): boolean {
      return cache.mutate((current, queue) => {
        // Keep a local tombstone rather than dropping the row. It is what stops
        // a stale page from a cursor taken before this delete from resurrecting
        // the key here, and it is what the pull hands to a consumer on another
        // machine so it can drop its own copy too.
        current.rows[cacheKey(scope, kind, key)] = {
          value: null,
          updatedAt: new Date(now()).toISOString(),
          writerDeviceId: args.getDeviceId?.() ?? null,
          refreshOwner: null,
          deleted: true,
        };
        queue({ scope, kind, key, value: null, deleted: true, refreshOwner: null });
      }, { expectedAccountUserId: options?.expectedAccountUserId });
    },

    /**
     * Flush what is queued, then take what changed. Single-flight. With
     * `maxAgeMs`, answers from the cache when the last successful pull is
     * younger than that and nothing is queued, so a read path can ask for
     * freshness without paying a request per call.
     */
    sync(options?: { maxAgeMs?: number } | null): Promise<AccountCacheSyncStatus> {
      const maxAgeMs = options?.maxAgeMs;
      return typeof maxAgeMs === "number" && Number.isFinite(maxAgeMs)
        ? cache.syncIfStale(maxAgeMs)
        : cache.sync();
    },

    /**
     * How this machine's vault sync is doing, without the network. ADE MCP's
     * status and Settings show it: a vault that cannot sync never receives the
     * account's ADE MCP secret.
     */
    health(): AccountCacheHealth {
      return cache.health();
    },

    /** Keys in one scope and kind whose write from this machine has not reached the account yet. */
    pendingKeys(scope: string, kind: AccountVaultItemKind): string[] {
      return cache.pendingKeys()
        .map(splitCacheKey)
        .filter((split): split is NonNullable<typeof split> => split !== null && split.scope === scope && split.kind === kind)
        .map((split) => split.key);
    },

    /** Start (or join) the shared background sync. Refcounted; see the helper. */
    startPeriodicSync(intervalMs = DEFAULT_SYNC_INTERVAL_MS, onSync?: AccountCacheSyncListener): () => void {
      return cache.startPeriodicSync(intervalMs, onSync);
    },

    /**
     * Remove every account-held credential from this machine.
     *
     * Called on a deliberate sign-out. The cache file is deleted rather than
     * emptied, so nothing is left for a later reader to find, and any queued
     * upload goes with it — a signed-out machine has no business finishing a
     * write to an account it just left. A sync already in flight is abandoned
     * by the cache epoch rather than allowed to persist what it pulled.
     *
     * Device-only secrets are untouched: they never lived here.
     */
    purge(): void {
      cache.resetAndDelete();
      removeLegacyCache();
      logger.info("account.vault_purged", {});
    },

    /** Also log to `logger`; see `getSharedAccountVaultStore`. */
    attachLogger(logger: AccountVaultLogger): void {
      cache.attachLogger(logger);
    },

    cachePathForTests(): string {
      return cache.cachePath;
    },
  };
}

export type AccountVaultStore = ReturnType<typeof createAccountVaultStore>;

const registry = createStoreRegistry<AccountVaultStore>();

export function getSharedAccountVaultStore(
  adeDir: string,
  create: () => AccountVaultStore,
): AccountVaultStore {
  return registry.get(adeDir, () => {
    const store = create();
    // Machine-shared: its failures belong in the machine's log, whoever built it.
    const machineLogger = machineAccountStoreLogger(adeDir);
    if (machineLogger) store.attachLogger(machineLogger);
    return store;
  });
}

export function resetSharedAccountVaultStoresForTests(): void {
  registry.resetForTests();
}
