import fs from "node:fs";
import path from "node:path";
import { AdeExpectedError } from "../../../shared/expectedError";
import { EncryptedFileCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import { getMachineAccountStores } from "../../../../../ade-cli/src/services/account/machineAccountStores";
import {
  SECRET_NAME_PATTERN,
  type PasswordService,
  type ProjectSecretEntry,
} from "../../../../../ade-cli/src/services/passwords/passwordService";
import { accountRepoScopeKey } from "../../../shared/accountSettingsScope";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import type { AccountStoreResult } from "../../../shared/types/accountStore";
import type { AccountVaultItem } from "../../../shared/types/accountVault";
import type {
  ProjectSecretDeleteArgs,
  ProjectSecretGetArgs,
  ProjectSecretsListResult,
  ProjectSecretSetArgs,
  ProjectSecretSummary,
  ProjectSecretValueResult,
} from "../../../shared/types/projectSecrets";
import { readGitConfigOriginUrl, readGitOriginUrl } from "../projects/recentProjectSummary";

/**
 * A project's secrets, as its processes and `ade secrets` see them.
 *
 * They live in Passwords & Secrets (the account's vault, plus this computer's
 * own "this computer only" store): the secrets for every project, then this
 * project's own over them. This is the project-shaped view of that one store;
 * it keeps none of its own.
 *
 * It also moves secrets saved by the old per-project store (and its account
 * vault rows) into Passwords & Secrets, once, without saying anything.
 */

type Logger = {
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
};

/** The account vault calls the move needs, to read and clear the old rows. */
export type LegacySecretVault = {
  list(scope?: string | null): Promise<AccountStoreResult<AccountVaultItem[]>>;
  get(scope: string, kind: string, key: string): Promise<AccountStoreResult<string | null>>;
  remove(scope: string, kind: string, key: string): Promise<unknown>;
};

export type ProjectSecretServiceOptions = {
  /** This computer's Passwords service; defaults to the machine's shared one. */
  getPasswordService?: () => PasswordService | null;
  /** The account vault, only to move old account rows across. */
  getAccountVault?: () => LegacySecretVault | null | undefined;
  logger?: Logger | null;
};

/** The old store's files, under the project's `.ade/secrets`. */
const LEGACY_STORE_FILE = "project-secrets.v1.enc";
const LEGACY_KEY_FILE = ".project-secrets-key";
const LEGACY_INDEX_KEY = "__ade_project_secrets_index_v1";
const LEGACY_VALUE_PREFIX = "secret:";
const LEGACY_VAULT_KIND = "project_secret";

type LegacyEntry = { name: string; value: string; deviceOnly: boolean; updatedAt: string };

/**
 * The secrets that say which account server this computer signs in to (a
 * development Clerk project, a private account directory). They are read
 * before anyone is signed in, so they live on this computer: the move keeps
 * them this-computer-only, and sign-in reads only these names this way.
 */
export const SIGN_IN_CONFIG_SECRET_NAMES: ReadonlySet<string> = new Set([
  "CLERK_ISSUER",
  "CLERK_OAUTH_CLIENT_ID",
  "CLERK_JWKS_URL",
  "ADE_ACCOUNT_DIRECTORY_URL",
]);

const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function normalizeSecretName(name: string | undefined | null): string {
  const normalized = typeof name === "string" ? name.trim() : "";
  if (!normalized) throw new AdeExpectedError("A secret needs a name.", "user");
  if (!SECRET_NAME_PATTERN.test(normalized)) {
    throw new AdeExpectedError("A secret's name is letters, digits, _, . or -, starting with a letter or _ (like STRIPE_API_KEY).", "user");
  }
  return normalized;
}

function toSummary(entry: ProjectSecretEntry): ProjectSecretSummary {
  return {
    name: entry.name,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    valueLength: entry.value.length,
    storage: entry.deviceOnly ? "device" : "account",
  };
}

function listResult(entries: Map<string, ProjectSecretEntry>): ProjectSecretsListResult {
  return {
    secrets: [...entries.values()].map(toSummary).sort((a, b) => a.name.localeCompare(b.name)),
    storage: { path: "Passwords & Secrets", encrypted: true, scope: "project" },
  };
}

function notFound(name: string): Error {
  return new AdeExpectedError(`No secret named ${name} for this project. \`ade secrets list\` shows the names.`, "user");
}

export function createProjectSecretService(projectRoot: string, options: ProjectSecretServiceOptions = {}) {
  const logger = options.logger ?? null;
  const passwords = (): PasswordService => {
    const service = options.getPasswordService?.() ?? getMachineAccountStores({ ...noopLogger, ...logger }).passwords;
    if (!service) throw new AdeExpectedError("Passwords & Secrets isn't available on this computer right now.", "environment");
    return service;
  };

  /**
   * The project's key in Passwords & Secrets: its repository (so every clone
   * on every computer shares it), or, with no remote, this folder.
   */
  const accountScope = (): string => accountRepoScopeKey(readGitOriginUrl(projectRoot))
    ?? `path:${path.resolve(projectRoot)}`;

  const fresh = async () => await passwords().secretsForProject(accountScope());
  const snapshot = () => passwords().secretsSnapshot(accountScope());

  const valueResult = (entries: Map<string, ProjectSecretEntry>, name: string): ProjectSecretValueResult => {
    const entry = entries.get(name);
    if (!entry) throw notFound(name);
    return { ...toSummary(entry), value: entry.value };
  };

  // ---- The move from the old per-project store ----------------------------

  const legacyPaths = () => {
    const secretsDir = resolveAdeLayout(projectRoot).secretsDir;
    return {
      credentialsPath: path.join(secretsDir, LEGACY_STORE_FILE),
      machineKeyPath: path.join(secretsDir, LEGACY_KEY_FILE),
    };
  };

  const openLegacyStore = (): EncryptedFileCredentialStore | null => {
    const { credentialsPath, machineKeyPath } = legacyPaths();
    if (!fs.existsSync(credentialsPath)) return null;
    return new EncryptedFileCredentialStore({ credentialsPath, machineKeyPath, lockPath: `${credentialsPath}.lock` });
  };

  /** Everything the old store holds on this computer, or null when there is no old store. */
  const readLegacyFile = (): LegacyEntry[] | null => {
    const store = openLegacyStore();
    if (!store) return null;
    const indexRaw = store.getSync(LEGACY_INDEX_KEY);
    // The store answers an unreadable file as empty; that is a failed read, not "no secrets".
    if (store.getLastReadState() === "unreadable") throw new Error("ADE couldn't read this project's old secrets file.");
    const index = JSON.parse(indexRaw ?? "null") as { entries?: Record<string, { storage?: string; updatedAt?: string }> } | null;
    const out: LegacyEntry[] = [];
    for (const [name, entry] of Object.entries(index?.entries ?? {})) {
      const value = store.getSync(`${LEGACY_VALUE_PREFIX}${name}`);
      if (!value || !SECRET_NAME_PATTERN.test(name)) continue;
      out.push({
        name,
        value,
        deviceOnly: entry?.storage === "device" || SIGN_IN_CONFIG_SECRET_NAMES.has(name),
        updatedAt: typeof entry?.updatedAt === "string" ? entry.updatedAt : new Date(0).toISOString(),
      });
    }
    return out;
  };

  /** One name out of the old store: a secret still waiting there, deleted before it moved. */
  const removeLegacyName = (name: string): boolean => {
    let removed = false;
    openLegacyStore()?.updateSync((values) => {
      const index = JSON.parse(values[LEGACY_INDEX_KEY] ?? "null") as { entries?: Record<string, unknown> } | null;
      if (!index?.entries?.[name]) return false;
      delete index.entries[name];
      values[LEGACY_INDEX_KEY] = JSON.stringify(index);
      delete values[`${LEGACY_VALUE_PREFIX}${name}`];
      removed = true;
      return true;
    });
    return removed;
  };

  const removeLegacyFile = (): void => {
    const { credentialsPath, machineKeyPath } = legacyPaths();
    for (const file of [credentialsPath, machineKeyPath, `${credentialsPath}.lock`]) fs.rmSync(file, { force: true });
  };

  /** The account's old rows for this repository (and the SSH-alias key older ADE wrote). */
  const readLegacyVault = async (vault: LegacySecretVault): Promise<Array<LegacyEntry & { scope: string }> | null> => {
    const scopes = new Set<string>();
    const canonical = accountRepoScopeKey(readGitOriginUrl(projectRoot));
    const alias = accountRepoScopeKey(readGitConfigOriginUrl(projectRoot));
    if (canonical) scopes.add(canonical);
    if (alias) scopes.add(alias);
    const out: Array<LegacyEntry & { scope: string }> = [];
    for (const scope of scopes) {
      const listed = await vault.list(scope);
      if (!listed.ok) return null;
      for (const item of listed.value) {
        if (item.scope !== scope || item.kind !== LEGACY_VAULT_KIND || item.deleted || !SECRET_NAME_PATTERN.test(item.key)) continue;
        let value = item.value;
        if (typeof value !== "string") {
          const fetched = await vault.get(scope, LEGACY_VAULT_KIND, item.key);
          if (!fetched.ok) return null;
          value = fetched.value;
        }
        if (value) out.push({ scope, name: item.key, value, deviceOnly: false, updatedAt: item.updatedAt });
      }
    }
    return out;
  };

  let migrating: Promise<void> | null = null;
  /** Nothing old was left at the last look (no file, the account's rows read and empty). */
  let legacyGone = false;

  /**
   * Move the old store's secrets into Passwords & Secrets. Safe to run every
   * start and on several computers at once (`adoptLegacySecret`): a name
   * already there with a newer value is left alone, one the account deleted
   * stays deleted, and each old copy is removed only once its value is saved
   * in the new place. Account secrets wait until the account vault is usable
   * (read from the old file until then); this-computer-only ones move at once.
   */
  const migrateLegacy = (): Promise<void> => {
    if (legacyGone) return Promise.resolve();
    migrating ??= (async () => {
      let fileEntries: LegacyEntry[] | null = null;
      try {
        fileEntries = readLegacyFile();
      } catch (error) {
        logger?.warn?.("project_secret.legacy_unreadable", { error: error instanceof Error ? error.message : String(error) });
      }
      const vault = options.getAccountVault?.() ?? null;
      const service = passwords();
      const status = await service.status();
      const accountReady = status.signedIn && status.enabled;
      let vaultEntries: Array<LegacyEntry & { scope: string }> | null = null;
      if (accountReady && vault) {
        vaultEntries = await readLegacyVault(vault).catch((error: unknown) => {
          logger?.warn?.("project_secret.legacy_vault_unreadable", { error: error instanceof Error ? error.message : String(error) });
          return null;
        });
      }
      if (!fileEntries?.length && !vaultEntries?.length) {
        if (fileEntries && !fileEntries.length) removeLegacyFile();
        // Nothing old here, and the account's rows were read (or there is no account vault).
        legacyGone = !vault || vaultEntries !== null;
        return;
      }

      const scope = accountScope();
      // What other computers moved or deleted first, so this one neither
      // duplicates nor brings back a secret.
      if (accountReady) await service.sync().catch((error: unknown) => {
        logger?.warn?.("project_secret.legacy_pull_failed", { error: error instanceof Error ? error.message : String(error) });
      });

      let moved = 0;
      let waiting = 0;
      // Newest first, so a name in both the file and the account lands with its latest value.
      const all = [...(fileEntries ?? []), ...(vaultEntries ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      for (const entry of all) {
        if (!entry.deviceOnly && !accountReady) {
          waiting += 1;
          continue;
        }
        const outcome = await service.adoptLegacySecret({
          name: entry.name,
          value: entry.value,
          projectScope: scope,
          deviceOnly: entry.deviceOnly,
          updatedAt: entry.updatedAt,
        });
        if (outcome === "saved") moved += 1;
      }
      if (moved) await service.sync().catch((error: unknown) => {
        logger?.warn?.("project_secret.legacy_sync_failed", { error: error instanceof Error ? error.message : String(error) });
      });
      // Old copies go only once everything they held is in the new place.
      if (fileEntries && waiting === 0) removeLegacyFile();
      if (vault && vaultEntries) {
        for (const entry of vaultEntries) await vault.remove(entry.scope, LEGACY_VAULT_KIND, entry.name);
      }
      if (moved || waiting) logger?.info?.("project_secret.legacy_moved", { moved, waiting });
    })().catch((error: unknown) => {
      logger?.warn?.("project_secret.legacy_move_failed", { error: error instanceof Error ? error.message : String(error) });
    }).finally(() => {
      migrating = null;
    });
    return migrating;
  };

  let warnedUnreadable = false;
  /**
   * `current`, plus every name only the old store still holds: until it has
   * moved in (account secrets wait for sign-in), a process still gets them. A
   * file that cannot be read adds nothing, and is said once.
   */
  const withLegacy = (current: Map<string, ProjectSecretEntry>): Map<string, ProjectSecretEntry> => {
    let legacy: LegacyEntry[] | null = null;
    try {
      legacy = readLegacyFile();
    } catch (error) {
      if (!warnedUnreadable) logger?.warn?.("project_secret.legacy_unreadable", { error: error instanceof Error ? error.message : String(error) });
      warnedUnreadable = true;
    }
    if (!legacy?.length) return current;
    const out = new Map(current);
    for (const entry of legacy) {
      if (out.has(entry.name)) continue;
      out.set(entry.name, {
        id: `legacy:${entry.name}`,
        name: entry.name,
        value: entry.value,
        projectScope: accountScope(),
        deviceOnly: entry.deviceOnly,
        createdAt: entry.updatedAt,
        updatedAt: entry.updatedAt,
      });
    }
    return out;
  };

  /** A name from what this computer holds, else from the old store while it still exists. */
  const valueOrLegacy = (current: Map<string, ProjectSecretEntry>, name: string): ProjectSecretValueResult => {
    if (current.has(name)) return valueResult(current, name);
    // A read that fails is thrown as itself, never as "not found": a caller
    // that remembers answers must not remember "none" for a disk hiccup.
    const legacy = readLegacyFile()?.find((entry) => entry.name === name);
    if (!legacy) throw notFound(name);
    return {
      name,
      value: legacy.value,
      createdAt: legacy.updatedAt,
      updatedAt: legacy.updatedAt,
      valueLength: legacy.value.length,
      storage: legacy.deviceOnly ? "device" : "account",
    };
  };

  return {
    accountScope,

    /** What this computer already holds, without waiting (process env, webhook checks). */
    list(): ProjectSecretsListResult {
      return listResult(withLegacy(snapshot()));
    },

    /**
     * By name, without waiting. Until the old per-project store has moved in,
     * a name only it holds is read from it, so nothing that starts before the
     * move (a webhook check) loses a value.
     */
    get(args: ProjectSecretGetArgs): ProjectSecretValueResult {
      return valueOrLegacy(snapshot(), normalizeSecretName(args?.name));
    },

    /**
     * Sign-in's account server (`SIGN_IN_CONFIG_SECRET_NAMES`): this
     * computer's own secrets, then the old store, never the account's vault.
     * It is read before anyone is signed in, and asking the account who is
     * signed in would read it again.
     */
    getSignInConfig(args: ProjectSecretGetArgs): ProjectSecretValueResult {
      return valueOrLegacy(passwords().deviceSecretsSnapshot(accountScope()), normalizeSecretName(args?.name));
    },

    /** The same after opening the account's current copy. */
    async listFresh(): Promise<ProjectSecretsListResult> {
      return listResult(withLegacy(await fresh()));
    },

    async getFresh(args: ProjectSecretGetArgs): Promise<ProjectSecretValueResult> {
      const name = normalizeSecretName(args?.name);
      return valueOrLegacy(await fresh(), name);
    },

    /** Save for this project: in the account by default, or on this computer only. */
    async set(args: ProjectSecretSetArgs): Promise<ProjectSecretSummary> {
      const name = normalizeSecretName(args?.name);
      const value = typeof args?.value === "string" ? args.value : "";
      if (!value.length) throw new AdeExpectedError(`${name} needs a value.`, "user");
      const deviceOnly = args?.storage === "device";
      await passwords().saveSecret({ name, value, projectScope: accountScope(), deviceOnly });
      const saved = (await fresh()).get(name);
      if (!saved) throw notFound(name);
      return toSummary(saved);
    },

    /** Delete this project's own secret by name (a secret for every project is left alone). */
    async delete(args: ProjectSecretDeleteArgs): Promise<{ deleted: boolean; name: string }> {
      const name = normalizeSecretName(args?.name);
      const entry = (await fresh()).get(name);
      if (!entry) return { deleted: removeLegacyName(name), name };
      if (entry.projectScope !== accountScope()) return { deleted: false, name };
      // The old store's copy goes too, or the name would come back from it.
      const deleted = await passwords().remove(entry.id);
      try {
        removeLegacyName(name);
      } catch (error) {
        logger?.warn?.("project_secret.legacy_remove_failed", { error: error instanceof Error ? error.message : String(error) });
      }
      return { deleted, name };
    },

    valuesForProcess(): Record<string, string> {
      return Object.fromEntries([...withLegacy(snapshot()).values()].map((entry) => [entry.name, entry.value]));
    },

    migrateLegacy,
  };
}

export type ProjectSecretService = ReturnType<typeof createProjectSecretService>;
