import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EncryptedFileCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import { accountRepoScopeKey } from "../../../shared/accountSettingsScope";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import {
  deviceCredentialProvenance,
  normalizeCredentialProvenance,
  type CredentialProvenance,
} from "../../../shared/types/credentialProvenance";
import type {
  ProjectSecretDeleteArgs,
  ProjectSecretEnvFile,
  ProjectSecretGetArgs,
  ProjectSecretsExportResult,
  ProjectSecretsImportArgs,
  ProjectSecretsImportPreview,
  ProjectSecretsImportResult,
  ProjectSecretsListResult,
  ProjectSecretStorage,
  ProjectSecretSetArgs,
  ProjectSecretSummary,
  ProjectSecretValueResult,
} from "../../../shared/types/projectSecrets";
import { readGitOriginUrl } from "../projects/recentProjectSummary";
import type { AccountVaultBridge } from "../account/accountVaultBridge";
import {
  describeVaultFailure,
  fireAndForgetVaultWrite,
} from "../account/vaultWrite";
import { nowIso } from "../shared/utils";
import {
  formatProjectSecretEnv,
  parseProjectSecretEnv,
  PROJECT_SECRET_ENV_MAX_BYTES,
  PROJECT_SECRET_ENV_MAX_ENTRIES,
} from "./projectSecretEnv";

type ProjectSecretIndexEntry = {
  createdAt: string;
  updatedAt: string;
  valueLength: number;
  storage: ProjectSecretStorage;
} & CredentialProvenance;

type ProjectSecretIndex = {
  version: 1;
  entries: Record<string, ProjectSecretIndexEntry>;
};

const STORE_FILE = "project-secrets.v1.enc";
const KEY_FILE = ".project-secrets-key";
const INDEX_KEY = "__ade_project_secrets_index_v1";
const VALUE_PREFIX = "secret:";
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

export type ProjectSecretServiceOptions = {
  downloadsDir?: string;
  getAccountVault?: () => AccountVaultBridge | null | undefined;
  getAccountUserId?: () => string | null;
  logger?: {
    warn?(message: string, meta?: Record<string, unknown>): void;
  } | null;
};

function normalizeSecretName(name: string | undefined | null): string {
  const normalized = typeof name === "string" ? name.trim() : "";
  if (!normalized) throw new Error("Secret name is required.");
  if (!NAME_PATTERN.test(normalized)) {
    throw new Error("Secret names must start with a letter and contain only letters, numbers, '.', '_', or '-' (max 128 characters).");
  }
  return normalized;
}

function normalizeStorage(value: unknown): ProjectSecretStorage {
  return value === "device" ? "device" : "account";
}

function parseIndex(raw: string | null): ProjectSecretIndex {
  if (!raw) return { version: 1, entries: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { version: 1, entries: {} };
    const record = parsed as Record<string, unknown>;
    const entries = record.entries;
    if (record.version !== 1 || !entries || typeof entries !== "object" || Array.isArray(entries)) {
      return { version: 1, entries: {} };
    }
    const normalizedEntries: Record<string, ProjectSecretIndexEntry> = {};
    for (const [name, entry] of Object.entries(entries as Record<string, unknown>)) {
      if (!NAME_PATTERN.test(name) || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const candidate = entry as Record<string, unknown>;
      const createdAt = typeof candidate.createdAt === "string" ? candidate.createdAt : nowIso();
      const updatedAt = typeof candidate.updatedAt === "string" ? candidate.updatedAt : createdAt;
      const valueLength = Number.isSafeInteger(candidate.valueLength) && Number(candidate.valueLength) >= 0
        ? Number(candidate.valueLength)
        : 0;
      const provenance = normalizeCredentialProvenance(candidate) ?? deviceCredentialProvenance();
      normalizedEntries[name] = {
        createdAt,
        updatedAt,
        valueLength,
        storage: normalizeStorage(candidate.storage),
        ...provenance,
      };
    }
    return { version: 1, entries: normalizedEntries };
  } catch {
    return { version: 1, entries: {} };
  }
}

function serializeIndex(index: ProjectSecretIndex): string {
  return JSON.stringify(index);
}

function valueKey(name: string): string {
  return `${VALUE_PREFIX}${name}`;
}

function toSummary(
  name: string,
  entry: ProjectSecretIndexEntry,
  storage: ProjectSecretStorage = entry.storage,
): ProjectSecretSummary {
  return {
    name,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    valueLength: entry.valueLength,
    storage,
  };
}

function sortSummaries(
  entries: Record<string, ProjectSecretIndexEntry>,
  resolveStorage: (entry: ProjectSecretIndexEntry) => ProjectSecretStorage = (entry) => entry.storage,
): ProjectSecretSummary[] {
  return Object.entries(entries)
    .map(([name, entry]) => toSummary(name, entry, resolveStorage(entry)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function createProjectSecretService(projectRoot: string, options: ProjectSecretServiceOptions = {}) {
  const layout = resolveAdeLayout(projectRoot);
  const credentialsPath = path.join(layout.secretsDir, STORE_FILE);
  const store = new EncryptedFileCredentialStore({
    credentialsPath,
    machineKeyPath: path.join(layout.secretsDir, KEY_FILE),
    lockPath: `${credentialsPath}.lock`,
  });

  const getAccountScope = (): string | null => accountRepoScopeKey(readGitOriginUrl(projectRoot));
  const getAccountUserId = (): string | null => options.getAccountUserId?.()?.trim() || null;
  const resolveStorage = (
    entry: ProjectSecretIndexEntry,
    accountScope = getAccountScope(),
  ): ProjectSecretStorage => entry.storage === "account" && !accountScope ? "device" : entry.storage;

  const logVaultFailure = (operation: string, name: string, detail: unknown): void => {
    options.logger?.warn?.("project_secret.account_vault_sync_failed", {
      operation,
      name,
      error: describeVaultFailure(detail),
    });
  };

  const resolveAccountVault = (operation: string, name: string): AccountVaultBridge | null => {
    try {
      return options.getAccountVault?.() ?? null;
    } catch (error) {
      logVaultFailure(operation, name, error);
      return null;
    }
  };

  const syncSecretToVault = (
    name: string,
    value: string,
    storage: ProjectSecretStorage,
    accountScope = getAccountScope(),
  ): void => {
    if (storage !== "account" || !accountScope) return;
    fireAndForgetVaultWrite(
      {
        getAccountVault: options.getAccountVault,
        logger: options.logger,
        logEvent: "project_secret.account_vault_sync_failed",
        context: { name },
      },
      "set",
      (vault) => vault.set(accountScope, "project_secret", name, value),
    );
  };

  const removeSecretFromVault = (name: string, storage: ProjectSecretStorage, accountScope = getAccountScope()): void => {
    if (storage !== "account" || !accountScope) return;
    fireAndForgetVaultWrite(
      {
        getAccountVault: options.getAccountVault,
        logger: options.logger,
        logEvent: "project_secret.account_vault_sync_failed",
        context: { name },
      },
      "remove",
      (vault) => vault.remove(accountScope, "project_secret", name),
    );
  };

  const readIndex = (): ProjectSecretIndex => {
    if (!fs.existsSync(credentialsPath)) return { version: 1, entries: {} };
    return parseIndex(store.getSync(INDEX_KEY));
  };

  const writeSecrets = (secrets: Array<{ name: string; value: string }>): ProjectSecretsImportResult => {
    if (secrets.length === 0) throw new Error("Select at least one secret to import.");
    if (secrets.length > PROJECT_SECRET_ENV_MAX_ENTRIES) {
      throw new Error(`Select no more than ${PROJECT_SECRET_ENV_MAX_ENTRIES} secrets to import.`);
    }
    const normalized = secrets.map((secret) => {
      const name = normalizeSecretName(secret?.name);
      const value = typeof secret?.value === "string" ? secret.value : "";
      if (!value.length) throw new Error(`Secret value is required for '${name}'.`);
      return { name, value };
    });
    const payloadBytes = normalized.reduce(
      (total, secret) => total + Buffer.byteLength(secret.name, "utf8") + Buffer.byteLength(secret.value, "utf8"),
      0,
    );
    if (payloadBytes > PROJECT_SECRET_ENV_MAX_BYTES) {
      throw new Error("The selected secrets are larger than 1 MB.");
    }
    if (new Set(normalized.map((secret) => secret.name)).size !== normalized.length) {
      throw new Error("Each imported secret name must be unique.");
    }
    const imported: string[] = [];
    const replaced: string[] = [];
    const accountScope = getAccountScope();
    const defaultStorage: ProjectSecretStorage = accountScope ? "account" : "device";
    const saved: Array<{ name: string; value: string; storage: ProjectSecretStorage }> = [];
    const now = nowIso();
    store.updateSync((values) => {
      const index = parseIndex(values[INDEX_KEY] ?? null);
      for (const secret of normalized) {
        const previous = index.entries[secret.name];
        (previous ? replaced : imported).push(secret.name);
        const storage = previous?.storage ?? defaultStorage;
        values[valueKey(secret.name)] = secret.value;
        index.entries[secret.name] = {
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
          valueLength: secret.value.length,
          storage,
          source: "device",
          accountUserId: null,
        };
        saved.push({ ...secret, storage });
      }
      values[INDEX_KEY] = serializeIndex(index);
    });
    for (const secret of saved) {
      syncSecretToVault(secret.name, secret.value, secret.storage, accountScope);
    }
    return { imported, replaced };
  };

  return {
    list(): ProjectSecretsListResult {
      const accountScope = getAccountScope();
      return {
        secrets: sortSummaries(readIndex().entries, (entry) => resolveStorage(entry, accountScope)),
        storage: {
          path: credentialsPath,
          encrypted: true,
          scope: "project",
        },
      };
    },

    get(args: ProjectSecretGetArgs): ProjectSecretValueResult {
      const name = normalizeSecretName(args?.name);
      const index = readIndex();
      const entry = index.entries[name];
      if (!entry) {
        throw new Error(`ADE secret '${name}' was not found.`);
      }
      const value = store.getSync(valueKey(name));
      if (value == null) {
        throw new Error(`ADE secret '${name}' was not found.`);
      }
      return {
        ...toSummary(name, entry, resolveStorage(entry)),
        value,
      };
    },

    set(args: ProjectSecretSetArgs): ProjectSecretSummary {
      const name = normalizeSecretName(args?.name);
      const nextValue = typeof args?.value === "string" ? args.value : "";
      if (!nextValue.length) throw new Error("Secret value is required.");
      const requestedStorage = normalizeStorage(args?.storage);
      const accountScope = getAccountScope();
      const storage: ProjectSecretStorage = requestedStorage === "account" && accountScope
        ? "account"
        : "device";
      const now = nowIso();
      let entry: ProjectSecretIndexEntry | null = null;
      let previousStorage: ProjectSecretStorage = "device";
      store.updateSync((values) => {
        const index = parseIndex(values[INDEX_KEY] ?? null);
        const previous = index.entries[name];
        previousStorage = previous?.storage ?? "account";
        entry = {
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
          valueLength: nextValue.length,
          storage,
          source: "device",
          accountUserId: null,
        };
        values[valueKey(name)] = nextValue;
        index.entries[name] = entry;
        values[INDEX_KEY] = serializeIndex(index);
      });
      if (!entry) throw new Error("Failed to save ADE secret.");
      syncSecretToVault(name, nextValue, storage, accountScope);
      if (storage === "device") removeSecretFromVault(name, previousStorage, accountScope);
      return toSummary(name, entry, storage);
    },

    async hydrateFromVault(): Promise<void> {
      const accountScope = getAccountScope();
      const accountUserId = getAccountUserId();
      if (!accountUserId) return;
      if (!accountScope) return;
      const vault = resolveAccountVault("list", "*");
      if (!vault) return;

      let listed: Awaited<ReturnType<AccountVaultBridge["list"]>>;
      try {
        listed = await vault.list(accountScope);
      } catch (error) {
        logVaultFailure("list", "*", error);
        return;
      }
      if (!listed.ok) {
        logVaultFailure("list", "*", listed);
        return;
      }

      if (getAccountUserId() !== accountUserId) return;

      for (const item of listed.value) {
        if (item.scope !== accountScope || item.kind !== "project_secret") continue;
        let name: string;
        try {
          name = normalizeSecretName(item.key);
        } catch {
          continue;
        }
        if (readIndex().entries[name]) continue;

        let value = typeof item.value === "string" ? item.value : null;
        if (value === null) {
          let fetched: Awaited<ReturnType<AccountVaultBridge["get"]>>;
          try {
            fetched = await vault.get(accountScope, "project_secret", name);
          } catch (error) {
            logVaultFailure("get", name, error);
            continue;
          }
          if (!fetched.ok) {
            logVaultFailure("get", name, fetched);
            continue;
          }
          value = fetched.value;
        }
        if (!value?.length || readIndex().entries[name]) continue;
        if (getAccountUserId() !== accountUserId) return;

        try {
          const now = nowIso();
          store.updateSync((values) => {
            const index = parseIndex(values[INDEX_KEY] ?? null);
            if (index.entries[name]) return false;
            values[valueKey(name)] = value!;
            index.entries[name] = {
              createdAt: now,
              updatedAt: now,
              valueLength: value!.length,
              storage: "account",
              source: "account",
              accountUserId,
            };
            values[INDEX_KEY] = serializeIndex(index);
            return;
          });
        } catch (error) {
          logVaultFailure("hydrate", name, error);
        }
      }
    },

    previewEnvImport(args: ProjectSecretEnvFile): ProjectSecretsImportPreview {
      const fileName = path.basename(typeof args?.fileName === "string" ? args.fileName.trim() : "") || ".env";
      const content = typeof args?.content === "string" ? args.content : "";
      const existing = readIndex().entries;
      return {
        fileName,
        secrets: parseProjectSecretEnv(content).map((secret) => ({
          ...secret,
          exists: Boolean(existing[secret.name]),
        })),
      };
    },

    importEnv(args: ProjectSecretsImportArgs): ProjectSecretsImportResult {
      return writeSecrets(Array.isArray(args?.secrets) ? args.secrets : []);
    },

    exportEnv(): ProjectSecretsExportResult {
      let secrets: Array<{ name: string; value: string }> = [];
      if (fs.existsSync(credentialsPath)) {
        store.updateSync((values) => {
          const index = parseIndex(values[INDEX_KEY] ?? null);
          secrets = sortSummaries(index.entries).map(({ name }) => {
            const value = values[valueKey(name)];
            if (value == null) throw new Error(`ADE secret '${name}' was not found.`);
            return { name, value };
          });
          return false;
        });
      }
      const downloadsDir = options.downloadsDir ?? path.join(os.homedir(), "Downloads");
      fs.mkdirSync(downloadsDir, { recursive: true, mode: 0o700 });
      let filePath = path.join(downloadsDir, "ade-secrets.env");
      for (let suffix = 1; fs.existsSync(filePath) && suffix < 1_000; suffix += 1) {
        filePath = path.join(downloadsDir, `ade-secrets (${suffix}).env`);
      }
      if (fs.existsSync(filePath)) throw new Error("Could not find an unused filename in Downloads.");
      fs.writeFileSync(filePath, formatProjectSecretEnv(secrets), { encoding: "utf8", mode: 0o600, flag: "wx" });
      return { filePath, secretCount: secrets.length };
    },

    delete(args: ProjectSecretDeleteArgs): { deleted: boolean; name: string } {
      const name = normalizeSecretName(args?.name);
      const confirmName = typeof args?.confirmName === "string" ? args.confirmName.trim() : "";
      if (!confirmName) {
        throw new Error(`Deleting ADE secret '${name}' requires confirmName to match the secret name.`);
      }
      const normalizedConfirmName = normalizeSecretName(confirmName);
      if (normalizedConfirmName !== name) {
        throw new Error(`Deleting ADE secret '${name}' requires confirmName to match the secret name.`);
      }
      if (!fs.existsSync(credentialsPath)) {
        return { deleted: false, name };
      }
      let deleted = false;
      let deletedStorage: ProjectSecretStorage = "device";
      store.updateSync((values) => {
        const nextIndex = parseIndex(values[INDEX_KEY] ?? null);
        const key = valueKey(name);
        const previous = nextIndex.entries[name];
        const hadEntry = Boolean(previous);
        const hadValue = values[key] != null;
        deleted = hadEntry || hadValue;
        if (!deleted) return false;
        deletedStorage = previous?.storage ?? "account";
        delete values[key];
        if (hadEntry) {
          delete nextIndex.entries[name];
          values[INDEX_KEY] = serializeIndex(nextIndex);
        }
      });
      if (deleted) removeSecretFromVault(name, deletedStorage);
      return { deleted, name };
    },

    /** Provenance used by account migration; values are never returned here. */
    getSecretProvenance(name: string): CredentialProvenance | null {
      const normalized = normalizeSecretName(name);
      const entry = readIndex().entries[normalized];
      return entry
        ? { source: entry.source, accountUserId: entry.accountUserId }
        : null;
    },

    /** Delete account-hydrated values while retaining device-origin secrets. */
    purgeAccountCredentials(): void {
      if (!fs.existsSync(credentialsPath)) return;
      store.updateSync((values) => {
        const index = parseIndex(values[INDEX_KEY] ?? null);
        let changed = false;
        for (const [name, entry] of Object.entries(index.entries)) {
          if (entry.source !== "account") continue;
          delete values[valueKey(name)];
          delete index.entries[name];
          changed = true;
        }
        if (!changed) return false;
        values[INDEX_KEY] = serializeIndex(index);
        return;
      });
    },
  };
}

export type ProjectSecretService = ReturnType<typeof createProjectSecretService>;
