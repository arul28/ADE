import fs from "node:fs";
import path from "node:path";
import {
  createAccountCacheStore,
  createStoreRegistry,
  type AccountCacheLogger,
} from "./accountCacheStore";
import { EncryptedFileCredentialStore } from "../credentials/credentialStore";
import type {
  AccountVaultItem,
  AccountVaultItemKind,
  AccountVaultWrite,
} from "../push/accountRelayRows";

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

/** Separator for the composite cache key. NUL cannot occur in any of the three. */
const KEY_SEPARATOR = "\u0000";

export type AccountVaultLogger = AccountCacheLogger;

type CachedItem = {
  value: string | null;
  updatedAt: string;
  writerDeviceId: string | null;
  refreshOwner: string | null;
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
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isAccountVaultItemKind(value: unknown): value is AccountVaultItemKind {
  return value === "secret"
    || value === "provider_key"
    || value === "integration"
    || value === "provider_api_key"
    || value === "linear_refresh_token"
    || value === "project_secret";
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
  return { value: itemValue, updatedAt, writerDeviceId, refreshOwner };
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
  getAccountVault(options?: { since?: string | null; scope?: string | null }): Promise<{
    items: AccountVaultItem[];
    cursor: string | null;
    truncated: boolean;
  } | null>;
  putAccountVault(
    items: AccountVaultWrite[],
    deviceId: string | null,
  ): Promise<{ updatedAt: string | null } | null>;
  deleteAccountVaultItem(scope: string, kind: string, key: string): Promise<boolean | null>;
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
    events: {
      writeFailed: "account.vault_cache_write_failed",
      mutationDropped: "account.vault_mutation_dropped",
      uploadFailed: "account.vault_upload_failed",
      pullFailed: "account.vault_pull_failed",
      pullTruncated: "account.vault_pull_truncated",
      cacheEntryDropped: "account.vault_cache_entry_dropped",
      purgeFailed: "account.vault_purge_failed",
    },
    readFile: readCacheFile,
    writeFile: writeCacheFile,
    hasRelay: () => args.relay !== null,
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
      const writes = pending.filter((entry) => !entry.deleted && entry.value != null);
      let uploadedAt: string | null = null;
      if (writes.length) {
        const result = await relay.putAccountVault(
          writes.map((entry) => ({
            scope: entry.scope,
            kind: entry.kind,
            key: entry.key,
            value: entry.value!,
            refreshOwner: entry.refreshOwner,
          })),
          args.getDeviceId?.() ?? null,
        );
        // `null` means there was no token to ask with. The queue stays.
        if (result === null) return null;
        uploadedAt = result.updatedAt;
      }
      for (const entry of pending.filter((item) => item.deleted)) {
        const deleted = await relay.deleteAccountVaultItem(entry.scope, entry.kind, entry.key);
        if (deleted === null) return null;
      }
      return { updatedAt: uploadedAt };
    },
    async pull(cursor) {
      const page = await args.relay!.getAccountVault({ since: cursor });
      if (!page) return null;
      return { rows: page.items, cursor: page.cursor, truncated: page.truncated };
    },
    toRow: (item, cached) => {
      // A null value means the relay could not open its own stored bytes. Keep
      // the row so the surface can say "ADE cannot read this"; do NOT let it
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
      options?: { refreshOwner?: string | null },
    ): boolean {
      const refreshOwner = options?.refreshOwner ?? null;
      return cache.mutate((current, queue) => {
        current.rows[cacheKey(scope, kind, key)] = {
          value,
          updatedAt: new Date(now()).toISOString(),
          writerDeviceId: args.getDeviceId?.() ?? null,
          refreshOwner,
        };
        queue({ scope, kind, key, value, deleted: false, refreshOwner });
      });
    },

    remove(scope: string, kind: AccountVaultItemKind, key: string): boolean {
      return cache.mutate((current, queue) => {
        delete current.rows[cacheKey(scope, kind, key)];
        queue({ scope, kind, key, value: null, deleted: true, refreshOwner: null });
      });
    },

    /** Flush what is queued, then take what changed. Single-flight. */
    sync(): Promise<void> {
      return cache.sync();
    },

    /** Start (or join) the shared background sync. Refcounted; see the helper. */
    startPeriodicSync(intervalMs = DEFAULT_SYNC_INTERVAL_MS): () => void {
      return cache.startPeriodicSync(intervalMs);
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
  return registry.get(adeDir, create);
}

export function resetSharedAccountVaultStoresForTests(): void {
  registry.resetForTests();
}
