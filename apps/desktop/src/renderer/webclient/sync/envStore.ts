import type {
  SyncAddressCandidate,
  SyncMobileProjectSummary,
  SyncPairingHostIdentity,
} from "../../../shared/types/sync";

export type WebClientStorageArea = "environments" | "meta" | "account" | "catalogs";

export type WebClientStorage = {
  get<T>(area: WebClientStorageArea, key: string): Promise<T | null>;
  put<T>(area: WebClientStorageArea, key: string, value: T): Promise<void>;
  delete(area: WebClientStorageArea, key: string): Promise<void>;
  list<T>(area: WebClientStorageArea): Promise<T[]>;
  transaction<T>(
    areas: WebClientStorageArea[],
    mode: IDBTransactionMode,
    operation: (transaction: WebClientStorageTransaction) => Promise<T>,
  ): Promise<T>;
  setVersionChangeHandler?(handler: () => void): void;
};

export type WebClientStorageTransaction = {
  get<T>(area: WebClientStorageArea, key: string): Promise<T | null>;
  put<T>(area: WebClientStorageArea, key: string, value: T): void;
  delete(area: WebClientStorageArea, key: string): void;
  list<T>(area: WebClientStorageArea): Promise<T[]>;
};

export type WebClientEnvironmentRecord = {
  envId: string;
  machineName: string;
  hostDeviceId: string;
  /** Account that created this browser pairing. Missing/null means user-paired. */
  accountOwnerUserId?: string | null;
  machineKeyUrl?: string | null;
  relayUrl?: string | null;
  addressCandidates: SyncAddressCandidate[];
  explicitWssEndpoints?: string[];
  port: number;
  pairedDeviceId: string;
  secret: string;
  dpopKeys: CryptoKeyPair;
  dpopPublicKeyX963?: string | null;
  siteId: string;
  localDeviceId: string;
  localDeviceName: string;
  createdAt: string;
  lastConnectedAt?: string | null;
  lastGoodEndpoint?: string | null;
  activeProjectId?: string | null;
  hostIdentity?: SyncPairingHostIdentity;
};

/**
 * A machine's project catalog as last seen by this browser.
 *
 * Persisted so the welcome surface can paint recents on load, before any relay
 * connection exists. `savedAt` is what marks a row stale until live catalog
 * data replaces it; `ownerUserId` keeps one account's project names from
 * surfacing to the next account signed in on the same browser.
 */
export type WebClientMachineCatalogRecord = {
  machineKey: string;
  machineName: string;
  hostDeviceId: string | null;
  envId: string | null;
  ownerUserId: string | null;
  projects: SyncMobileProjectSummary[];
  savedAt: number;
};

const DB_NAME = "ade-web-client";
const DB_VERSION = 3;
const DB_UPGRADE_BLOCKED_TIMEOUT_MS = 5_000;
const SELECTED_ENV_ID_KEY = "selectedEnvId";
const LAST_ACTIVE_MACHINE_KEY = "lastActiveMachineKey";
/** Bounds on the catalog cache: it is a paint accelerator, not a database. */
export const MAX_PERSISTED_MACHINE_CATALOGS = 8;
export const MAX_PERSISTED_CATALOG_PROJECTS = 24;
/** Icons are data URLs; an oversized one is dropped rather than stored. */
const MAX_PERSISTED_ICON_CHARS = 24_000;
export const WEB_TRUST_RESET_VERSION = 1;
const TRUST_RESET_VERSION_KEY = "machineTrustResetVersion";
export const INDEXED_DB_OPEN_TIMEOUT_MS = 4_000;

export type IndexedDbOpenErrorCode = "blocked" | "timeout" | "failed";

export class IndexedDbOpenError extends Error {
  readonly name = "IndexedDbOpenError";

  constructor(
    message: string,
    readonly code: IndexedDbOpenErrorCode,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
  }
}

export type WebClientEnvironmentPruneResult = {
  readonly removedIds: string[];
  /** Records that survived this same pruning transaction. */
  readonly environments: WebClientEnvironmentRecord[];
};

function sortEnvironments(records: WebClientEnvironmentRecord[]): WebClientEnvironmentRecord[] {
  return records.sort((left, right) => {
    const leftTime = Date.parse(left.lastConnectedAt ?? left.createdAt);
    const rightTime = Date.parse(right.lastConnectedAt ?? right.createdAt);
    return rightTime - leftTime;
  });
}

function pruneResult(
  removedIds: string[],
  environments: WebClientEnvironmentRecord[],
): WebClientEnvironmentPruneResult {
  return {
    removedIds: [...removedIds],
    environments: sortEnvironments(environments),
  };
}

function boundCatalogRecord(
  record: WebClientMachineCatalogRecord,
): WebClientMachineCatalogRecord {
  return {
    ...record,
    savedAt: record.savedAt || Date.now(),
    projects: record.projects.slice(0, MAX_PERSISTED_CATALOG_PROJECTS).map((project) => (
      project.iconDataUrl && project.iconDataUrl.length > MAX_PERSISTED_ICON_CHARS
        ? { ...project, iconDataUrl: null }
        : project
    )),
  };
}

function openRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  });
}

export class IndexedDbStorage implements WebClientStorage {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private versionChangeHandler: (() => void) | null = null;

  constructor(private readonly options: {
    indexedDb?: Pick<IDBFactory, "open">;
    upgradeBlockedTimeoutMs?: number;
    openTimeoutMs?: number;
  } = {}) {}

  setVersionChangeHandler(handler: () => void): void {
    this.versionChangeHandler = handler;
  }

  async get<T>(area: WebClientStorageArea, key: string): Promise<T | null> {
    return await this.transaction([area], "readonly", async (transaction) => (
      await transaction.get<T>(area, key)
    ));
  }

  async put<T>(area: WebClientStorageArea, key: string, value: T): Promise<void> {
    await this.transaction([area], "readwrite", async (transaction) => {
      transaction.put(area, key, value);
    });
  }

  async delete(area: WebClientStorageArea, key: string): Promise<void> {
    await this.transaction([area], "readwrite", async (transaction) => {
      transaction.delete(area, key);
    });
  }

  async list<T>(area: WebClientStorageArea): Promise<T[]> {
    return await this.transaction([area], "readonly", async (transaction) => (
      await transaction.list<T>(area)
    ));
  }

  async transaction<T>(
    areas: WebClientStorageArea[],
    mode: IDBTransactionMode,
    operation: (transaction: WebClientStorageTransaction) => Promise<T>,
  ): Promise<T> {
    const db = await this.open();
    const idbTransaction = db.transaction(areas, mode);
    const done = transactionDone(idbTransaction);
    const transaction: WebClientStorageTransaction = {
      get: async <Value,>(area: WebClientStorageArea, key: string) => {
        const result = await openRequest(idbTransaction.objectStore(area).get(key));
        return (result ?? null) as Value | null;
      },
      put: <Value,>(area: WebClientStorageArea, key: string, value: Value) => {
        idbTransaction.objectStore(area).put(value, key);
      },
      delete: (area, key) => {
        idbTransaction.objectStore(area).delete(key);
      },
      list: async <Value,>(area: WebClientStorageArea) => (
        await openRequest(idbTransaction.objectStore(area).getAll()) as Value[]
      ),
    };
    try {
      const result = await operation(transaction);
      await done;
      return result;
    } catch (error) {
      try {
        idbTransaction.abort();
      } catch {
        // The transaction may already have failed or completed.
      }
      await done.catch(() => undefined);
      throw error;
    }
  }

  private async open(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      const attempt = new Promise<IDBDatabase>((resolve, reject) => {
        let request: IDBOpenDBRequest;
        try {
          request = (this.options.indexedDb ?? indexedDB).open(DB_NAME, DB_VERSION);
        } catch (error) {
          reject(new IndexedDbOpenError(
            "Browser storage is unavailable.",
            "failed",
            { cause: error },
          ));
          return;
        }
        let settled = false;
        let blockedTimer: ReturnType<typeof setTimeout> | null = null;
        const clearBlockedTimer = () => {
          if (blockedTimer) globalThis.clearTimeout(blockedTimer);
          blockedTimer = null;
        };
        const openTimer = globalThis.setTimeout(() => {
          if (settled) return;
          settled = true;
          clearBlockedTimer();
          reject(new IndexedDbOpenError(
            "Opening browser storage timed out.",
            "timeout",
          ));
        }, this.options.openTimeoutMs ?? INDEXED_DB_OPEN_TIMEOUT_MS);
        const rejectOpen = (error: IndexedDbOpenError) => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(openTimer);
          clearBlockedTimer();
          reject(error);
        };
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("environments")) db.createObjectStore("environments");
          if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
          if (!db.objectStoreNames.contains("account")) db.createObjectStore("account");
          if (!db.objectStoreNames.contains("catalogs")) db.createObjectStore("catalogs");
        };
        request.onblocked = () => {
          if (blockedTimer || settled) return;
          globalThis.clearTimeout(openTimer);
          const requestedTimeout = this.options.upgradeBlockedTimeoutMs;
          const timeoutMs = typeof requestedTimeout === "number"
            && Number.isFinite(requestedTimeout)
            && requestedTimeout >= 0
            ? requestedTimeout
            : DB_UPGRADE_BLOCKED_TIMEOUT_MS;
          blockedTimer = globalThis.setTimeout(() => {
            rejectOpen(new IndexedDbOpenError(
              "ADE browser storage couldn't be upgraded. Close other ADE tabs and try again.",
              "blocked",
            ));
          }, timeoutMs);
        };
        request.onsuccess = () => {
          const db = request.result;
          if (settled) {
            db.close();
            return;
          }
          settled = true;
          globalThis.clearTimeout(openTimer);
          clearBlockedTimer();
          db.onversionchange = () => {
            db.close();
            if (this.dbPromise === attempt) {
              this.dbPromise = null;
              this.versionChangeHandler?.();
            }
          };
          resolve(db);
        };
        request.onerror = () => rejectOpen(new IndexedDbOpenError(
          "Failed to open ADE web client browser storage.",
          "failed",
          { cause: request.error },
        ));
      });
      this.dbPromise = attempt;
      void attempt.catch(() => {
        if (this.dbPromise === attempt) this.dbPromise = null;
      });
    }
    return await this.dbPromise;
  }
}

export class MemoryStorage implements WebClientStorage {
  private readonly areas: Record<WebClientStorageArea, Map<string, unknown>> = {
    environments: new Map(),
    meta: new Map(),
    account: new Map(),
    catalogs: new Map(),
  };

  async get<T>(area: WebClientStorageArea, key: string): Promise<T | null> {
    return (this.areas[area].get(key) ?? null) as T | null;
  }

  async put<T>(area: WebClientStorageArea, key: string, value: T): Promise<void> {
    this.areas[area].set(key, value);
  }

  async delete(area: WebClientStorageArea, key: string): Promise<void> {
    this.areas[area].delete(key);
  }

  async list<T>(area: WebClientStorageArea): Promise<T[]> {
    return Array.from(this.areas[area].values()) as T[];
  }

  async transaction<T>(
    areas: WebClientStorageArea[],
    _mode: IDBTransactionMode,
    operation: (transaction: WebClientStorageTransaction) => Promise<T>,
  ): Promise<T> {
    const snapshots = new Map(areas.map((area) => [area, new Map(this.areas[area])]));
    const transaction: WebClientStorageTransaction = {
      get: async <Value,>(area: WebClientStorageArea, key: string) => (
        (this.areas[area].get(key) ?? null) as Value | null
      ),
      put: <Value,>(area: WebClientStorageArea, key: string, value: Value) => {
        this.areas[area].set(key, value);
      },
      delete: (area, key) => {
        this.areas[area].delete(key);
      },
      list: async <Value,>(area: WebClientStorageArea) => (
        Array.from(this.areas[area].values()) as Value[]
      ),
    };
    try {
      return await operation(transaction);
    } catch (error) {
      for (const [area, snapshot] of snapshots) this.areas[area] = snapshot;
      throw error;
    }
  }
}

export class WebClientEnvStore {
  private trustResetPromise: Promise<void> | null = null;

  constructor(private readonly storage: WebClientStorage = new IndexedDbStorage()) {
    this.storage.setVersionChangeHandler?.(() => {
      this.trustResetPromise = null;
    });
  }

  private async ensureTrustReset(): Promise<void> {
    if (!this.trustResetPromise) {
      this.trustResetPromise = this.storage.transaction(
        ["environments", "meta"],
        "readwrite",
        async (transaction) => {
          const completedVersion = await transaction.get<number>("meta", TRUST_RESET_VERSION_KEY);
          if (completedVersion === WEB_TRUST_RESET_VERSION) return;
          const environments = await transaction.list<WebClientEnvironmentRecord>("environments");
          for (const environment of environments) {
            transaction.delete("environments", environment.envId);
          }
          transaction.delete("meta", SELECTED_ENV_ID_KEY);
          transaction.put("meta", TRUST_RESET_VERSION_KEY, WEB_TRUST_RESET_VERSION);
        },
      ).catch((error) => {
        this.trustResetPromise = null;
        throw error;
      });
    }
    await this.trustResetPromise;
  }

  async listEnvironments(): Promise<WebClientEnvironmentRecord[]> {
    await this.ensureTrustReset();
    const records = await this.storage.list<WebClientEnvironmentRecord>("environments");
    return sortEnvironments(records);
  }

  async getEnvironment(envId: string): Promise<WebClientEnvironmentRecord | null> {
    await this.ensureTrustReset();
    return await this.storage.get<WebClientEnvironmentRecord>("environments", envId);
  }

  async findByHostDeviceId(hostDeviceId: string): Promise<WebClientEnvironmentRecord | null> {
    await this.ensureTrustReset();
    const environments = await this.listEnvironments();
    return environments.find((environment) => environment.hostDeviceId === hostDeviceId) ?? null;
  }

  async saveEnvironment(environment: WebClientEnvironmentRecord): Promise<void> {
    await this.ensureTrustReset();
    await this.storage.put("environments", environment.envId, environment);
  }

  async removeEnvironment(envId: string): Promise<void> {
    await this.ensureTrustReset();
    await this.storage.delete("environments", envId);
    const selected = await this.getSelectedEnvId();
    if (selected === envId) await this.setSelectedEnvId(null);
  }

  async removeAccountOwnedEnvironments(ownerUserIdValue: string): Promise<string[]> {
    const ownerUserId = ownerUserIdValue.trim();
    if (!ownerUserId) return [];
    return (await this.pruneAccountOwnedEnvironments(ownerUserId, { removeCurrent: true })).removedIds;
  }

  async pruneAccountOwnedEnvironments(
    currentOwnerUserIdValue: string | null,
    options: { removeCurrent?: boolean } = {},
  ): Promise<WebClientEnvironmentPruneResult> {
    await this.ensureTrustReset();
    const currentOwnerUserId = currentOwnerUserIdValue?.trim() || null;
    return await this.storage.transaction(
      ["environments", "meta"],
      "readwrite",
      async (transaction) => {
        const environments = await transaction.list<WebClientEnvironmentRecord>("environments");
        const removedIds = environments
          .filter((environment) => environment.accountOwnerUserId != null)
          .filter((environment) => options.removeCurrent
            ? environment.accountOwnerUserId === currentOwnerUserId
            : currentOwnerUserId != null
              && environment.accountOwnerUserId !== currentOwnerUserId)
          .map((environment) => environment.envId);
        const removedIdSet = new Set(removedIds);
        for (const envId of removedIds) transaction.delete("environments", envId);
        const selected = await transaction.get<string>("meta", SELECTED_ENV_ID_KEY);
        if (selected && removedIdSet.has(selected)) {
          transaction.delete("meta", SELECTED_ENV_ID_KEY);
        }
        return pruneResult(
          removedIds,
          environments.filter((environment) => !removedIdSet.has(environment.envId)),
        );
      },
    );
  }

  // -------------------------------------------------------------------------
  // Machine project catalogs.
  //
  // Read at boot so the welcome surface paints recents before the first relay
  // dial, written through whenever a live catalog arrives. Every entry is a
  // cache: a failure to read or write one is never fatal to the caller.
  // -------------------------------------------------------------------------

  async listMachineCatalogs(): Promise<WebClientMachineCatalogRecord[]> {
    const records = await this.storage.list<WebClientMachineCatalogRecord>("catalogs");
    return records
      .filter((record) => record && typeof record.machineKey === "string")
      .sort((left, right) => (right.savedAt ?? 0) - (left.savedAt ?? 0));
  }

  async saveMachineCatalog(record: WebClientMachineCatalogRecord): Promise<void> {
    const bounded = boundCatalogRecord(record);
    await this.storage.transaction(["catalogs"], "readwrite", async (transaction) => {
      const existing = (await transaction.list<WebClientMachineCatalogRecord>("catalogs"))
        .filter((entry) => entry && entry.machineKey !== bounded.machineKey);
      transaction.put("catalogs", bounded.machineKey, bounded);
      const overflow = existing
        .sort((left, right) => (right.savedAt ?? 0) - (left.savedAt ?? 0))
        .slice(MAX_PERSISTED_MACHINE_CATALOGS - 1);
      for (const entry of overflow) transaction.delete("catalogs", entry.machineKey);
    });
  }

  async removeMachineCatalog(machineKey: string): Promise<void> {
    await this.storage.delete("catalogs", machineKey);
  }

  /**
   * Drop catalogs that belong to a different account than the one signed in.
   *
   * Deliberately stricter than `pruneAccountOwnedEnvironments` in the one case
   * where they differ: a null `currentOwnerUserId` here means "signed out" (the
   * only caller, `applyAccountPrivacy`, runs after the account has bootstrapped,
   * so the owner is never merely unresolved), and cached project names from the
   * account that just signed out must not survive on the welcome surface.
   * Environments stay because a pairing is this browser's own credential, and
   * they get a second owner filter before they are ever rendered.
   *
   * A null `ownerUserId` on a RECORD is exempt for the same reason it is exempt
   * on an environment: it was saved outside any account, so it belongs to this
   * browser rather than to someone else's account.
   */
  async pruneMachineCatalogs(currentOwnerUserIdValue: string | null): Promise<string[]> {
    const currentOwnerUserId = currentOwnerUserIdValue?.trim() || null;
    return await this.storage.transaction(["catalogs"], "readwrite", async (transaction) => {
      const records = await transaction.list<WebClientMachineCatalogRecord>("catalogs");
      const removed = records
        .filter((record) => record?.ownerUserId != null && record.ownerUserId !== currentOwnerUserId)
        .map((record) => record.machineKey);
      for (const machineKey of removed) transaction.delete("catalogs", machineKey);
      return removed;
    });
  }

  async getLastActiveMachineKey(): Promise<string | null> {
    return await this.storage.get<string>("meta", LAST_ACTIVE_MACHINE_KEY);
  }

  async setLastActiveMachineKey(machineKey: string | null): Promise<void> {
    if (machineKey) {
      await this.storage.put("meta", LAST_ACTIVE_MACHINE_KEY, machineKey);
      return;
    }
    await this.storage.delete("meta", LAST_ACTIVE_MACHINE_KEY);
  }

  async getSelectedEnvId(): Promise<string | null> {
    await this.ensureTrustReset();
    return await this.storage.get<string>("meta", SELECTED_ENV_ID_KEY);
  }

  async setSelectedEnvId(envId: string | null): Promise<void> {
    await this.ensureTrustReset();
    if (envId) {
      await this.storage.put("meta", SELECTED_ENV_ID_KEY, envId);
      return;
    }
    await this.storage.delete("meta", SELECTED_ENV_ID_KEY);
  }
}
