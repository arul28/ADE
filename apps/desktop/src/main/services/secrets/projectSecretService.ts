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
  ProjectSecretPullResult,
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
    info?(message: string, meta?: Record<string, unknown>): void;
    warn?(message: string, meta?: Record<string, unknown>): void;
  } | null;
};

const UNAVAILABLE_PULL: ProjectSecretPullResult = { state: "unavailable" };

/** ISO-8601 parse, or null when the value is not a usable timestamp. */
function parseTimestamp(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * True when the vault's row is strictly newer than the copy on this machine.
 *
 * An unparsable timestamp on either side answers false, so a malformed vault
 * row can never overwrite a value that already works here.
 */
function isVaultRowNewer(vaultUpdatedAt: string, localUpdatedAt: string): boolean {
  const vaultTime = parseTimestamp(vaultUpdatedAt);
  const localTime = parseTimestamp(localUpdatedAt);
  if (vaultTime === null || localTime === null) return false;
  return vaultTime > localTime;
}

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

  /** Is a vault bridge wired at all? Quiet, because a "no" here is routine. */
  const hasAccountVault = (): boolean => {
    try {
      return Boolean(options.getAccountVault?.());
    } catch (error) {
      logVaultFailure("resolve", "*", error);
      return false;
    }
  };

  /**
   * The storage a write can actually honour.
   *
   * "Account" is a promise that the value leaves this machine, so a NEW secret
   * only claims it when this project has an account scope, the person is signed
   * in, and a vault bridge is wired. Reporting "account" for a value that
   * silently stayed on this disk is the defect this guards against: the row
   * looked shared, the other machines never saw it, and nothing said so.
   *
   * A row that is ALREADY shared stays shared. A vault that is briefly
   * unreachable must not quietly turn a shared secret into a machine-local one,
   * because every later pull then skips it and the other machines keep the old
   * value forever. The push is re-offered on a later vault-ready tick instead.
   */
  const resolveWritableStorage = (
    requested: ProjectSecretStorage,
    previousStorage: ProjectSecretStorage | null,
    accountScope = getAccountScope(),
  ): ProjectSecretStorage => {
    if (requested !== "account") return "device";
    if (!accountScope) return "device";
    if (previousStorage === "account") return "account";
    if (!getAccountUserId()) return "device";
    return hasAccountVault() ? "account" : "device";
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
    const defaultStorage: ProjectSecretStorage = resolveWritableStorage("account", null, accountScope);
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

  /**
   * Take everything the account vault holds for this repository.
   *
   * The vault used to be write-only from this side: `set` pushed a value and
   * nothing ever read it back, because the only caller of this method was the
   * one-shot account migration. A secret added on a second machine therefore
   * reached the vault and never reached this one — the reported symptom.
   *
   * A row lands only when it is genuinely new or genuinely newer. A
   * device-scoped secret is never replaced, however old it looks: device is a
   * deliberate "this machine only", and the account copy is not the owner.
   *
   * Every way of not reading the vault at all — signed out, no repository
   * scope, no vault wired, the list throwing, the list answering unavailable,
   * the account changing mid-pull — answers `unavailable`, never a count of
   * zero. "Nothing new" and "could not ask" are different sentences to show a
   * person, and collapsing them told a signed-out user their secrets were
   * already up to date.
   */
  /**
   * Drop an account-scoped copy on this machine, without touching the vault.
   *
   * Only ever reached for a name the account already holds as deleted, so there
   * is nothing left to remove on the other side.
   */
  const removeAccountCopy = (name: string): boolean => {
    let removed = false;
    try {
      store.updateSync((values) => {
        const index = parseIndex(values[INDEX_KEY] ?? null);
        const entry = index.entries[name];
        if (!entry || entry.storage !== "account") return false;
        delete values[valueKey(name)];
        delete index.entries[name];
        values[INDEX_KEY] = serializeIndex(index);
        removed = true;
        return;
      });
    } catch (error) {
      logVaultFailure("remove", name, error);
      return false;
    }
    return removed;
  };

  /**
   * Move one local row onto the relay's clock without touching its value.
   *
   * Only ever called when the value already matches the vault's, so the write
   * cannot change what the secret is. Without it a row saved here keeps this
   * machine's stamp forever, and a fast clock then hides every later edit made
   * on another machine.
   */
  const restampFromVault = (name: string, vaultUpdatedAt: string): void => {
    const stamp = parseTimestamp(vaultUpdatedAt) === null ? nowIso() : vaultUpdatedAt;
    try {
      store.updateSync((values) => {
        const index = parseIndex(values[INDEX_KEY] ?? null);
        const entry = index.entries[name];
        if (!entry || entry.storage !== "account" || entry.updatedAt === stamp) return false;
        index.entries[name] = { ...entry, updatedAt: stamp };
        values[INDEX_KEY] = serializeIndex(index);
        return;
      });
    } catch (error) {
      logVaultFailure("restamp", name, error);
    }
  };

  const pullFromAccount = async (): Promise<ProjectSecretPullResult> => {
    const accountScope = getAccountScope();
    const accountUserId = getAccountUserId();
    if (!accountUserId) return UNAVAILABLE_PULL;
    if (!accountScope) return UNAVAILABLE_PULL;
    const vault = resolveAccountVault("list", "*");
    if (!vault) return UNAVAILABLE_PULL;

    let listed: Awaited<ReturnType<AccountVaultBridge["list"]>>;
    try {
      listed = await vault.list(accountScope);
    } catch (error) {
      logVaultFailure("list", "*", error);
      return UNAVAILABLE_PULL;
    }
    if (!listed.ok) {
      logVaultFailure("list", "*", listed);
      return UNAVAILABLE_PULL;
    }

    if (getAccountUserId() !== accountUserId) return UNAVAILABLE_PULL;

    /** The vault's own value for a name, fetched when the list omitted it. */
    const readVaultValue = async (
      name: string,
      listedValue: string | null,
    ): Promise<string | null> => {
      if (typeof listedValue === "string") return listedValue;
      try {
        const fetched = await vault.get(accountScope, "project_secret", name);
        if (!fetched.ok) {
          logVaultFailure("get", name, fetched);
          return null;
        }
        return fetched.value;
      } catch (error) {
        logVaultFailure("get", name, error);
        return null;
      }
    };

    let added = 0;
    let updated = 0;
    let removed = 0;
    for (const item of listed.value) {
      if (item.scope !== accountScope || item.kind !== "project_secret") continue;
      let name: string;
      try {
        name = normalizeSecretName(item.key);
      } catch {
        continue;
      }
      // A device-scoped copy is a deliberate "this machine only". The account
      // copy is not its owner in either direction, so neither a delete nor a
      // newer vault row reaches it.
      const known = readIndex().entries[name];
      if (known && known.storage !== "account") continue;

      if (item.deleted) {
        // Deleted on another machine, and the account is the authority for a
        // name this machine holds as account-scoped. The local copy goes too,
        // or the secret keeps working here while the account says it is gone.
        if (!known || !isVaultRowNewer(item.updatedAt, known.updatedAt)) continue;
        if (removeAccountCopy(name)) removed += 1;
        continue;
      }

      if (known) {
        if (known.updatedAt === item.updatedAt) continue;
        if (!isVaultRowNewer(item.updatedAt, known.updatedAt)) {
          // The stamps disagree in the direction a fast local clock can invent:
          // a secret saved here carries this machine's stamp, a vault row the
          // relay's. Compare the values instead — no clock is involved.
          const localValue = store.getSync(valueKey(name));
          const vaultValue = await readVaultValue(name, item.value);
          if (localValue == null || vaultValue === null) continue;
          if (localValue === vaultValue) {
            // This machine's own push landed. Take the vault's stamp so the next
            // comparison runs on one clock.
            restampFromVault(name, item.updatedAt);
            continue;
          }
          if (localValue.length && isVaultRowNewer(known.updatedAt, item.updatedAt)) {
            // The local value really is newer and the vault never took it — a
            // push that failed while the vault was unreachable. Offer it again.
            syncSecretToVault(name, localValue, "account", accountScope);
          }
          continue;
        }
      }

      const value = await readVaultValue(name, item.value);
      if (!value?.length) continue;
      // The account changed under this pull; stop rather than write one
      // owner's secrets into another owner's store.
      if (getAccountUserId() !== accountUserId) return UNAVAILABLE_PULL;

      // Re-read: the awaits above gave another writer a window.
      const current = readIndex().entries[name];
      if (current && current.storage !== "account") continue;
      if (current && !isVaultRowNewer(item.updatedAt, current.updatedAt)) continue;
      const wasAbsent = !current;
      const vaultUpdatedAt = parseTimestamp(item.updatedAt) === null ? nowIso() : item.updatedAt;

      let wrote = false;
      try {
        store.updateSync((values) => {
          const index = parseIndex(values[INDEX_KEY] ?? null);
          const existing = index.entries[name];
          if (existing && existing.storage !== "account") return false;
          if (existing && !isVaultRowNewer(item.updatedAt, existing.updatedAt)) return false;
          values[valueKey(name)] = value!;
          index.entries[name] = {
            createdAt: existing?.createdAt ?? vaultUpdatedAt,
            updatedAt: vaultUpdatedAt,
            valueLength: value!.length,
            storage: "account",
            source: "account",
            accountUserId,
          };
          values[INDEX_KEY] = serializeIndex(index);
          wrote = true;
          return;
        });
      } catch (error) {
        logVaultFailure("hydrate", name, error);
        continue;
      }
      if (!wrote) continue;
      if (wasAbsent) added += 1;
      else updated += 1;
    }

    if (added > 0 || updated > 0 || removed > 0) {
      options.logger?.info?.("project_secret.account_vault_pull", { added, updated, removed });
    }
    return { state: "pulled", added, updated, removed };
  };

  /**
   * The migration lifecycle's name for the same pull.
   *
   * It only needs completion — every caller awaits and ignores the value — so
   * an unavailable vault is simply a pull that moved nothing. `pullFromAccount`
   * keeps the distinction for the callers that report it to a person.
   */
  const hydrateFromVault = async (): Promise<void> => {
    await pullFromAccount();
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
      // Read before the write: an existing shared row must stay shared, so the
      // destination is the row's, not just the request's.
      const existingStorage = readIndex().entries[name]?.storage ?? null;
      const storage = resolveWritableStorage(requestedStorage, existingStorage, accountScope);
      const now = nowIso();
      let entry: ProjectSecretIndexEntry | null = null;
      let previousStorage: ProjectSecretStorage = "device";
      store.updateSync((values) => {
        const index = parseIndex(values[INDEX_KEY] ?? null);
        const previous = index.entries[name];
        // No local entry means no local account copy to forget. Defaulting to
        // "account" here made a first device-only save delete a vault row this
        // machine had never seen — another machine's only copy of the name.
        previousStorage = previous?.storage ?? "device";
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
      // Only an explicit "this device only" forgets the account copy. A request
      // for account storage that degraded because the vault was unreachable
      // leaves the vault row alone: deleting it would destroy the copy the
      // other machines already hold.
      if (requestedStorage === "device") removeSecretFromVault(name, previousStorage, accountScope);
      return toSummary(name, entry, storage);
    },

    hydrateFromVault,
    pullFromAccount,
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
