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

  async get<T>(area: WebClientStorageArea, key: string): Promise<T | null> {
    const store = await this.store(area, "readonly");
    const result = await openRequest(store.get(key));
    return (result ?? null) as T | null;
  }

  async put<T>(area: WebClientStorageArea, key: string, value: T): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(area, "readwrite");
    transaction.objectStore(area).put(value, key);
    await transactionDone(transaction);
  }

  async delete(area: WebClientStorageArea, key: string): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(area, "readwrite");
    transaction.objectStore(area).delete(key);
    await transactionDone(transaction);
  }

  async list<T>(area: WebClientStorageArea): Promise<T[]> {
    const store = await this.store(area, "readonly");
    const result = await openRequest(store.getAll());
    return result as T[];
  }

  private async store(area: WebClientStorageArea, mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.open();
    return db.transaction(area, mode).objectStore(area);
  }

  private async open(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("environments")) db.createObjectStore("environments");
          if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Failed to open ADE web client IndexedDB."));
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
}

export class WebClientEnvStore {
  private trustResetPromise: Promise<void> | null = null;

  constructor(private readonly storage: WebClientStorage = new IndexedDbStorage()) {}

  private async ensureTrustReset(): Promise<void> {
    if (!this.trustResetPromise) {
      this.trustResetPromise = (async () => {
        const completedVersion = await this.storage.get<number>("meta", TRUST_RESET_VERSION_KEY);
        if (completedVersion === WEB_TRUST_RESET_VERSION) return;
        const environments = await this.storage.list<WebClientEnvironmentRecord>("environments");
        for (const environment of environments) {
          await this.storage.delete("environments", environment.envId);
        }
        await this.storage.delete("meta", SELECTED_ENV_ID_KEY);
        await this.storage.put("meta", TRUST_RESET_VERSION_KEY, WEB_TRUST_RESET_VERSION);
      })().catch((error) => {
        this.trustResetPromise = null;
        throw error;
      });
    }
    await this.trustResetPromise;
  }

  async listEnvironments(): Promise<WebClientEnvironmentRecord[]> {
    await this.ensureTrustReset();
    const records = await this.storage.list<WebClientEnvironmentRecord>("environments");
    return records.sort((left, right) => {
      const leftTime = Date.parse(left.lastConnectedAt ?? left.createdAt);
      const rightTime = Date.parse(right.lastConnectedAt ?? right.createdAt);
      return rightTime - leftTime;
    });
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
  ): Promise<string[]> {
    await this.ensureTrustReset();
    const currentOwnerUserId = currentOwnerUserIdValue?.trim() || null;
    const environments = await this.storage.list<WebClientEnvironmentRecord>("environments");
    const removedIds = environments
      .filter((environment) => environment.accountOwnerUserId != null)
      .filter((environment) => options.removeCurrent
        ? environment.accountOwnerUserId === currentOwnerUserId
        : environment.accountOwnerUserId !== currentOwnerUserId)
      .map((environment) => environment.envId);
    for (const envId of removedIds) {
      await this.storage.delete("environments", envId);
    }
    const selected = await this.storage.get<string>("meta", SELECTED_ENV_ID_KEY);
    if (selected && removedIds.includes(selected)) {
      await this.storage.delete("meta", SELECTED_ENV_ID_KEY);
    }
    return removedIds;
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
