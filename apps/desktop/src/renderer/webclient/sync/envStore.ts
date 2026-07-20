import type {
  SyncAddressCandidate,
  SyncPairingHostIdentity,
} from "../../../shared/types/sync";

export type WebClientStorageArea = "environments" | "meta";

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

const DB_NAME = "ade-web-client";
const DB_VERSION = 1;
const SELECTED_ENV_ID_KEY = "selectedEnvId";
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

export type WebClientEnvironmentPruneResult = string[] & {
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
  const result = [...removedIds] as WebClientEnvironmentPruneResult;
  Object.defineProperty(result, "environments", {
    configurable: false,
    enumerable: false,
    value: sortEnvironments(environments),
    writable: false,
  });
  return result;
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

  constructor(private readonly options: { openTimeoutMs?: number } = {}) {}

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
          request = indexedDB.open(DB_NAME, DB_VERSION);
        } catch (error) {
          reject(new IndexedDbOpenError(
            "Browser storage is unavailable.",
            "failed",
            { cause: error },
          ));
          return;
        }
        let settled = false;
        const timeout = globalThis.setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new IndexedDbOpenError(
            "Opening browser storage timed out.",
            "timeout",
          ));
        }, this.options.openTimeoutMs ?? INDEXED_DB_OPEN_TIMEOUT_MS);
        const rejectOpen = (error: IndexedDbOpenError) => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(timeout);
          reject(error);
        };
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("environments")) db.createObjectStore("environments");
          if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
        };
        request.onblocked = () => rejectOpen(new IndexedDbOpenError(
          "Browser storage is blocked by another ADE tab.",
          "blocked",
        ));
        request.onsuccess = () => {
          if (settled) {
            request.result.close();
            return;
          }
          settled = true;
          globalThis.clearTimeout(timeout);
          request.result.onversionchange = () => request.result.close();
          resolve(request.result);
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

  constructor(private readonly storage: WebClientStorage = new IndexedDbStorage()) {}

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
    return await this.pruneAccountOwnedEnvironments(ownerUserId, { removeCurrent: true });
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
            : environment.accountOwnerUserId !== currentOwnerUserId)
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
