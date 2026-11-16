import fs from "node:fs";
import path from "node:path";
import { AdeExpectedError } from "../../../shared/expectedError";
import { EncryptedFileCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import { getMachineAccountStores } from "../../../../../ade-cli/src/services/account/machineAccountStores";
import type { PasswordService } from "../../../../../ade-cli/src/services/passwords/passwordService";
import type { LegacySecretAdoption, ProjectSecretEntry } from "../../../../../ade-cli/src/services/passwords/passwordProjectSecrets";
import { accountRepoScopeKey } from "../../../shared/accountSettingsScope";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import type { AccountStoreResult } from "../../../shared/types/accountStore";
import type { AccountVaultItem } from "../../../shared/types/accountVault";
import { SECRET_NAME_PATTERN, SECRET_NAME_RULE, SIGN_IN_CONFIG_SECRET_NAMES } from "../../../shared/types/passwords";
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
 * vault rows) into Passwords & Secrets, without saying anything.
 */

type Logger = {
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
};

/** The account vault calls the move needs, to read and clear the old rows. */
export type LegacySecretVault = {
  list(scope?: string | null): Promise<AccountStoreResult<AccountVaultItem[]>>;
  get(scope: string, kind: string, key: string): Promise<AccountStoreResult<string | null>>;
  /** With `expectedRevision`, removes the row only while it is still the one read; `ok: false` when not removed. */
  remove(scope: string, kind: string, key: string, options?: { expectedRevision?: string }): Promise<{ ok: boolean }>;
  /** Pull the account's rows; the value is the sync status. Until a pull succeeds, the old rows count as unread. */
  sync?(options?: { maxAgeMs?: number }): Promise<AccountStoreResult<string | null>>;
};

export type ProjectSecretServiceOptions = {
  /**
   * The Passwords service of the runtime that owns this project. Only that
   * runtime moves old secrets in; without it, reads use the machine's shared
   * service and the move is left to the runtime.
   */
  getPasswordService?: () => PasswordService | null;
  /** The account vault, only to move old account rows across. */
  getAccountVault?: () => LegacySecretVault | null | undefined;
  logger?: Logger | null;
};

/** What one move did: secrets saved in the new place, and old ones still waiting. */
export type LegacySecretMoveResult = { moved: number; waiting: number; done: boolean };

/**
 * A project's key in Passwords & Secrets: its repository (so every clone on
 * every computer shares it), or, with no remote, this folder.
 */
export function projectSecretScopeForRoot(projectRoot: string): string {
  return repoScopeForRoot(projectRoot) ?? `path:${path.resolve(projectRoot)}`;
}

/** The project's repository key, or null for a folder with no remote. */
function repoScopeForRoot(projectRoot: string): string | null {
  return accountRepoScopeKey(readGitOriginUrl(projectRoot));
}

/** The old store's files, under the project's `.ade/secrets`. */
const LEGACY_STORE_FILE = "project-secrets.v1.enc";
const LEGACY_KEY_FILE = ".project-secrets-key";
const LEGACY_INDEX_KEY = "__ade_project_secrets_index_v1";
const LEGACY_VALUE_PREFIX = "secret:";
const LEGACY_VAULT_KIND = "project_secret";
/** A pull of the account's rows this recent is fresh enough to read the old rows from. */
const LEGACY_VAULT_PULL_MAX_AGE_MS = 60_000;

/** How long a read by name or a list waits for the account before answering from this computer's copy. */
const FRESH_READ_WAIT_MS = 3_000;
/** Reads within this long of the last account check answer from this computer's copy (a burst of reads asks once). */
const FRESH_READ_MAX_AGE_MS = 10_000;

/** One secret the old store held, from its file or the account's old rows. */
type LegacyEntry = { name: string; value: string; deviceOnly: boolean; updatedAt: string };
/**
 * A file entry, with where the old store said it came from: `source:
 * "account"` was pulled from `accountUserId`'s rows, so it is that account's
 * copy, not a secret this computer made.
 */
type LegacyFileEntry = LegacyEntry & { storage: "account" | "device"; source: string | null; accountUserId: string | null };
type LegacyVaultRead = {
  live: Array<LegacyEntry & { scope: string; revision?: string }>;
  /** When each deleted name was deleted, newest across both keys. */
  deletedAt: Map<string, string>;
};

const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function normalizeSecretName(name: string | undefined | null): string {
  const normalized = typeof name === "string" ? name.trim() : "";
  if (!normalized) throw new AdeExpectedError("A secret needs a name.", "user");
  if (!SECRET_NAME_PATTERN.test(normalized)) throw new AdeExpectedError(SECRET_NAME_RULE, "user");
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
  return { secrets: [...entries.values()].map(toSummary).sort((a, b) => a.name.localeCompare(b.name)) };
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

  const accountScope = (): string => projectSecretScopeForRoot(projectRoot);

  let lastAccountCheckAt = 0;
  /**
   * The project's secrets after asking the account what changed, so a secret
   * added on another computer a moment ago is there. A slow relay never holds
   * a read past `FRESH_READ_WAIT_MS`; the sync keeps going for the next read.
   */
  const fresh = async (): Promise<Map<string, ProjectSecretEntry>> => {
    const service = passwords();
    // Only the runtime that owns the project syncs: the machine's shared
    // service in another process would write the same Passwords cache.
    const shouldSync = Boolean(options.getPasswordService) && Date.now() - lastAccountCheckAt >= FRESH_READ_MAX_AGE_MS;
    if (shouldSync) lastAccountCheckAt = Date.now();
    // One deadline for the sync and the read (which can wait on the relay for
    // the vault key): past it, the answer is what this computer holds.
    const read = (async () => {
      if (shouldSync) {
        await service.sync().catch((error: unknown) => {
          logger?.warn?.("project_secret.fresh_sync_failed", { error: errorText(error) });
        });
      }
      return await service.secretsForProject(accountScope());
    })();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), FRESH_READ_WAIT_MS);
      timer.unref?.();
    });
    const settled = await Promise.race([read, timedOut]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (settled) return settled;
    // The read keeps going for the next call; a late failure is only logged.
    read.catch((error: unknown) => logger?.warn?.("project_secret.fresh_read_failed", { error: errorText(error) }));
    return snapshot();
  };
  const snapshot = () => passwords().secretsSnapshot(accountScope());

  const valueResult = (entries: Map<string, ProjectSecretEntry>, name: string): ProjectSecretValueResult => {
    const entry = entries.get(name);
    if (!entry) throw notFound(name);
    return { ...toSummary(entry), value: entry.value };
  };

  // ---- The move from the old per-project store ----------------------------

  const legacyPaths = () => {
    const secretsDir = resolveAdeLayout(projectRoot).secretsDir;
    const credentialsPath = path.join(secretsDir, LEGACY_STORE_FILE);
    return { credentialsPath, machineKeyPath: path.join(secretsDir, LEGACY_KEY_FILE), lockPath: `${credentialsPath}.lock` };
  };

  // One store object while the file exists: its reads are cached by the file's stat.
  let legacyStore: EncryptedFileCredentialStore | null = null;
  const openLegacyStore = (): EncryptedFileCredentialStore | null => {
    const paths = legacyPaths();
    if (!fs.existsSync(paths.credentialsPath)) {
      legacyStore = null;
      return null;
    }
    legacyStore ??= new EncryptedFileCredentialStore(paths);
    return legacyStore;
  };

  /** Everything the old store holds on this computer, or null when there is no old store. */
  const readLegacyFile = (): LegacyFileEntry[] | null => {
    const store = openLegacyStore();
    if (!store) return null;
    const indexRaw = store.getSync(LEGACY_INDEX_KEY);
    // The store answers an unreadable file as empty; that is a failed read, not "no secrets".
    if (store.getLastReadState() === "unreadable") throw new Error("ADE couldn't read this project's old secrets file.");
    const index = JSON.parse(indexRaw ?? "null") as {
      entries?: Record<string, { storage?: string; updatedAt?: string; source?: string; accountUserId?: string | null }>;
    } | null;
    const out: LegacyFileEntry[] = [];
    for (const [name, entry] of Object.entries(index?.entries ?? {})) {
      const value = store.getSync(`${LEGACY_VALUE_PREFIX}${name}`);
      if (!value || !SECRET_NAME_PATTERN.test(name)) continue;
      const storage = entry?.storage === "device" ? "device" : "account";
      out.push({
        name,
        value,
        storage,
        deviceOnly: storage === "device" || SIGN_IN_CONFIG_SECRET_NAMES.has(name),
        updatedAt: typeof entry?.updatedAt === "string" ? entry.updatedAt : new Date(0).toISOString(),
        source: typeof entry?.source === "string" ? entry.source : null,
        accountUserId: typeof entry?.accountUserId === "string" ? entry.accountUserId : null,
      });
    }
    return out;
  };

  /** One name out of the old store: moved in, deleted before it moved, or another account's copy. */
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
    const { credentialsPath, machineKeyPath, lockPath } = legacyPaths();
    for (const file of [credentialsPath, machineKeyPath, lockPath]) fs.rmSync(file, { force: true });
    legacyStore = null;
  };

  /** The keys the old account rows for this repository sit under: its repository key and the SSH-alias key older ADE wrote. */
  const legacyVaultScopes = (canonical: string | null): Set<string> => {
    const scopes = new Set<string>();
    const alias = accountRepoScopeKey(readGitConfigOriginUrl(projectRoot));
    if (canonical) scopes.add(canonical);
    if (alias) scopes.add(alias);
    return scopes;
  };

  /**
   * The account's old rows for this repository (and the SSH-alias key older
   * ADE wrote), deleted ones included. Null while they cannot be read, or
   * when the account's rows could not be pulled just now: a stale copy could
   * miss a deletion another computer made.
   */
  const readLegacyVault = async (vault: LegacySecretVault, canonical: string | null): Promise<LegacyVaultRead | null> => {
    if (vault.sync) {
      const synced = await vault.sync({ maxAgeMs: LEGACY_VAULT_PULL_MAX_AGE_MS });
      if (!synced.ok || synced.value !== "ready") return null;
    }
    const scopes = legacyVaultScopes(canonical);
    const read: LegacyVaultRead = { live: [], deletedAt: new Map() };
    for (const scope of scopes) {
      const listed = await vault.list(scope);
      if (!listed.ok) return null;
      for (const item of listed.value) {
        if (item.scope !== scope || item.kind !== LEGACY_VAULT_KIND || !SECRET_NAME_PATTERN.test(item.key)) continue;
        if (item.deleted) {
          const known = read.deletedAt.get(item.key);
          if (!known || item.updatedAt > known) read.deletedAt.set(item.key, item.updatedAt);
          continue;
        }
        let value = item.value;
        if (typeof value !== "string") {
          const fetched = await vault.get(scope, LEGACY_VAULT_KIND, item.key);
          if (!fetched.ok) return null;
          value = fetched.value;
        }
        if (value) read.live.push({ scope, name: item.key, value, deviceOnly: false, updatedAt: item.updatedAt, revision: item.revision });
      }
    }
    return read;
  };

  let migrating: Promise<LegacySecretMoveResult> | null = null;
  /**
   * The move and a delete run one at a time: a delete during a move could
   * otherwise remove an old copy the move already read, and the move would
   * bring the name back.
   */
  let exclusive: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(run: () => Promise<T>): Promise<T> => {
    const next = exclusive.then(run, run);
    exclusive = next.catch(() => undefined);
    return next;
  };

  /**
   * Move the old store's secrets into Passwords & Secrets, without a word to
   * anyone. Safe to run every start and on several computers at once
   * (`adoptLegacySecret`): a name already there with a newer value is left
   * alone, one the account deleted stays deleted, and each old copy is removed
   * only once the new place holds its value (an account secret: once the
   * relay has it). Until then, processes read it from the old store. Account
   * secrets wait for sign-in; this-computer-only ones move at once.
   */
  const migrateLegacy = (): Promise<LegacySecretMoveResult> => {
    migrating ??= oneAtATime(async (): Promise<LegacySecretMoveResult> => {
      // Only the runtime that owns this project moves it: two processes
      // writing the same Passwords cache would lose each other's writes.
      const service = options.getPasswordService?.() ?? null;
      // Not done: the owning runtime still has to move them (reads use the old store until then).
      if (!service) return { moved: 0, waiting: 0, done: false };
      let file: LegacyFileEntry[] | null = null;
      try {
        file = readLegacyFile();
      } catch (error) {
        logger?.warn?.("project_secret.legacy_unreadable", { error: errorText(error) });
        return { moved: 0, waiting: 0, done: false };
      }
      const vault = options.getAccountVault?.() ?? null;
      const accountId = service.accountUserId();
      const status = await service.status();
      // Off means nothing moves: what moved would stop reaching processes. The
      // account's old rows are unread, so with a vault the move is not done.
      if (!status.enabled) return { moved: 0, waiting: file?.length ?? 0, done: !file?.length && !vault };
      const accountReady = Boolean(accountId) && status.signedIn;
      let vaultRead: LegacyVaultRead | null = null;
      const canonical = repoScopeForRoot(projectRoot);
      if (accountReady && vault) {
        vaultRead = await readLegacyVault(vault, canonical).catch((error: unknown) => {
          logger?.warn?.("project_secret.legacy_vault_unreadable", { error: errorText(error) });
          return null;
        });
      }
      // Done needs the account's old rows read too (signed out, or unreadable now: not yet).
      const vaultChecked = !vault || vaultRead !== null;
      if (!file?.length && !vaultRead?.live.length) {
        if (file) removeLegacyFile();
        return { moved: 0, waiting: 0, done: vaultChecked };
      }

      const scope = canonical ?? `path:${path.resolve(projectRoot)}`;
      // A project with no repository has no key shared across computers: its secrets stay here.
      const shared = Boolean(canonical);
      type Candidate = LegacyEntry & { vaultScope: string | null; revision?: string };
      const candidates: Candidate[] = [];
      /** File names to remove without moving: deleted in the account, or another account's copy. */
      const dropped: string[] = [];
      let waiting = 0;
      for (const entry of file ?? []) {
        if (entry.storage === "account") {
          if (!accountReady || (vault && !vaultRead)) {
            waiting += 1;
            continue;
          }
          const deletedAt = vaultRead?.deletedAt.get(entry.name);
          if ((entry.source === "account" && entry.accountUserId !== accountId) || (deletedAt && deletedAt > entry.updatedAt)) {
            dropped.push(entry.name);
            continue;
          }
        }
        candidates.push({ ...entry, deviceOnly: entry.deviceOnly || !shared, vaultScope: null });
      }
      /** Old account rows a newer deletion (under either key) replaced: removed, never moved. */
      const supersededRows: Array<{ scope: string; name: string; revision?: string }> = [];
      for (const entry of vaultRead?.live ?? []) {
        const deletedAt = vaultRead?.deletedAt.get(entry.name);
        if (deletedAt && deletedAt > entry.updatedAt) supersededRows.push({ scope: entry.scope, name: entry.name, revision: entry.revision });
        else candidates.push({ ...entry, deviceOnly: !shared, vaultScope: entry.scope });
      }
      if (accountReady) await service.sync().catch((error: unknown) => {
        // What other computers moved or deleted first, so this one neither duplicates nor brings back a secret.
        logger?.warn?.("project_secret.legacy_pull_failed", { error: errorText(error) });
      });

      let moved = 0;
      const adopted: Array<{ entry: Candidate; result: LegacySecretAdoption }> = [];
      // Newest first, so a name in both the file and the account lands with its latest value.
      for (const entry of candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
        if (!entry.deviceOnly && !accountReady) {
          waiting += 1;
          continue;
        }
        if (service.accountUserId() !== accountId) return { moved, waiting: waiting + 1, done: false };
        const result = await service.adoptLegacySecret({ name: entry.name, value: entry.value, projectScope: scope, deviceOnly: entry.deviceOnly, updatedAt: entry.updatedAt });
        if (result.outcome === "saved") moved += 1;
        adopted.push({ entry, result });
      }
      const accountItems = adopted.flatMap(({ entry, result }) => (result.id ? [{ id: result.id, updatedAt: entry.updatedAt }] : []));
      if (accountItems.length) await service.sync().catch((error: unknown) => {
        logger?.warn?.("project_secret.legacy_sync_failed", { error: errorText(error) });
      });
      const uploaded = await service.uploadedIds(accountItems);
      // Signed out or switched account while this ran: leave every old copy for the next run.
      if (service.accountUserId() !== accountId) return { moved, waiting: waiting + adopted.length, done: false };

      /** Remove one old account row only while it is the one read; a row changed since stays for the next run. */
      const removeVaultRow = async (scope: string, name: string, revision: string | undefined): Promise<boolean> => {
        const removed = await vault?.remove(scope, LEGACY_VAULT_KIND, name, revision ? { expectedRevision: revision } : undefined);
        return removed?.ok === true;
      };
      for (const row of supersededRows) {
        if (!(await removeVaultRow(row.scope, row.name, row.revision))) waiting += 1;
      }
      const doneFileNames = new Set(dropped);
      for (const { entry, result } of adopted) {
        if (result.id !== null && !uploaded.has(result.id)) {
          waiting += 1;
          continue;
        }
        if (!entry.vaultScope) doneFileNames.add(entry.name);
        else if (!(await removeVaultRow(entry.vaultScope, entry.name, entry.revision))) waiting += 1;
      }
      if (file?.length && file.every((entry) => doneFileNames.has(entry.name))) removeLegacyFile();
      else for (const name of doneFileNames) removeLegacyName(name);
      if (moved || waiting) logger?.info?.("project_secret.legacy_moved", { moved, waiting });
      return { moved, waiting, done: waiting === 0 && vaultChecked };
    }).catch((error: unknown): LegacySecretMoveResult => {
      logger?.warn?.("project_secret.legacy_move_failed", { error: errorText(error) });
      return { moved: 0, waiting: 0, done: false };
    }).finally(() => {
      migrating = null;
    });
    return migrating;
  };

  /**
   * What the old store still holds that this computer may use now: an entry
   * pulled from an account is that account's, and only while it is signed in.
   * `accountFree` leaves those out without asking who is signed in (sign-in's
   * own config, which that question would read again).
   */
  const usableLegacy = (accountFree = false): LegacyFileEntry[] | null => {
    const entries = readLegacyFile();
    if (!entries?.some((entry) => entry.source === "account")) return entries;
    const accountId = accountFree ? null : passwords().accountUserId();
    return entries.filter((entry) => entry.source !== "account" || entry.accountUserId === accountId);
  };

  let warnedUnreadable = false;
  /**
   * `current`, plus what only the old store still holds: until it has moved
   * in (account secrets wait for sign-in), a process still gets it. An old
   * entry is this project's own, so it wins over a secret for every project,
   * never over this project's. A file that cannot be read adds nothing, and
   * is said once.
   */
  const withLegacy = (current: Map<string, ProjectSecretEntry>): Map<string, ProjectSecretEntry> => {
    let legacy: LegacyEntry[] | null = null;
    try {
      legacy = usableLegacy();
    } catch (error) {
      if (!warnedUnreadable) logger?.warn?.("project_secret.legacy_unreadable", { error: errorText(error) });
      warnedUnreadable = true;
    }
    if (!legacy?.length) return current;
    const out = new Map(current);
    for (const entry of legacy) {
      if (out.has(entry.name) && out.get(entry.name)!.projectScope !== null) continue;
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
  const valueOrLegacy = (current: Map<string, ProjectSecretEntry>, name: string, accountFree = false): ProjectSecretValueResult => {
    // A read that fails is thrown as itself, never as "not found": a caller
    // that remembers answers must not remember "none" for a disk hiccup.
    const known = current.get(name);
    if (known && known.projectScope !== null) return valueResult(current, name);
    const legacy = usableLegacy(accountFree)?.find((entry) => entry.name === name);
    if (!legacy) {
      if (known) return valueResult(current, name);
      throw notFound(name);
    }
    return {
      name,
      value: legacy.value,
      createdAt: legacy.updatedAt,
      updatedAt: legacy.updatedAt,
      valueLength: legacy.value.length,
      storage: legacy.deviceOnly ? "device" : "account",
    };
  };

  const processValues = (entries: Map<string, ProjectSecretEntry>): Record<string, string> =>
    Object.fromEntries([...withLegacy(entries).values()].map((entry) => [entry.name, entry.value]));

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
      return valueOrLegacy(passwords().deviceSecretsSnapshot(accountScope()), normalizeSecretName(args?.name), true);
    },

    /** The same after asking the account what changed. */
    async listFresh(): Promise<ProjectSecretsListResult> {
      return listResult(withLegacy(await fresh()));
    },

    async getFresh(args: ProjectSecretGetArgs): Promise<ProjectSecretValueResult> {
      const name = normalizeSecretName(args?.name);
      return valueOrLegacy(await fresh(), name);
    },

    /**
     * Save for this project. `storage` picks the place; without it, a name
     * this computer already keeps for itself stays there, and anything else
     * goes to the account (or this computer while nobody is signed in).
     */
    async set(args: ProjectSecretSetArgs): Promise<ProjectSecretSummary> {
      const name = normalizeSecretName(args?.name);
      const value = typeof args?.value === "string" ? args.value : "";
      if (!value.length) throw new AdeExpectedError(`${name} needs a value.`, "user");
      const service = passwords();
      const status = await service.status();
      if (!status.enabled) {
        throw new AdeExpectedError("Passwords & Secrets is off here. The person can turn it on in Settings › Passwords & Secrets.", "user");
      }
      const deviceOnly = args?.storage === "device" ? true : args?.storage === "account" ? false : status.signedIn ? undefined : true;
      await service.saveSecret({ name, value, projectScope: accountScope(), deviceOnly });
      // From what this computer holds: the save just put it there, and a read
      // that asks the account could fail after the save worked.
      const saved = snapshot().get(name);
      if (!saved) throw notFound(name);
      return toSummary(saved);
    },

    /**
     * Delete this project's own secret by name: its account copy and this
     * computer's copy (a secret for every project is left alone).
     * `confirmName` repeats the name, so a stray call can't delete one.
     */
    async delete(args: ProjectSecretDeleteArgs): Promise<{ deleted: boolean; name: string }> {
      const name = normalizeSecretName(args?.name);
      const confirmName = typeof args?.confirmName === "string" ? args.confirmName.trim() : "";
      if (confirmName !== name) throw new AdeExpectedError(`Deleting ${name} needs confirmName set to the same name.`, "user");
      const service = passwords();
      const scope = accountScope();
      return await oneAtATime(async () => {
        // The old store's copies first (its file and its account rows), or the
        // name would come back from them. A failure here stops the delete before
        // anything else changes, so it is never reported done while one remains.
        let deleted = removeLegacyName(name);
        const vault = options.getAccountVault?.() ?? null;
        if (vault && service.accountUserId()) {
          for (const legacyScope of legacyVaultScopes(repoScopeForRoot(projectRoot))) {
            const listed = await vault.list(legacyScope);
            if (!listed.ok) throw new AdeExpectedError(`ADE couldn't check the account's old copies of ${name}. Try again in a moment.`, "environment");
            const live = listed.value.find((item) => item.scope === legacyScope && item.kind === LEGACY_VAULT_KIND && item.key === name && !item.deleted);
            if (live) {
              const removed = await vault.remove(legacyScope, LEGACY_VAULT_KIND, name, live.revision ? { expectedRevision: live.revision } : undefined);
              if (!removed.ok) throw new AdeExpectedError(`ADE couldn't remove the account's old copy of ${name}: it changed. Try again.`, "environment");
            }
          }
        }
        for (const entry of await service.allSecretEntries()) {
          if (entry.name === name && entry.projectScope === scope) deleted = (await service.remove(entry.id)) || deleted;
        }
        return { deleted, name };
      });
    },

    /** The values a process this project starts gets, from what this computer already holds. */
    valuesForProcess(): Record<string, string> {
      return processValues(snapshot());
    },

    /** The same after asking the account what changed (`ade secrets exec`). */
    async valuesForProcessFresh(): Promise<Record<string, string>> {
      return processValues(await fresh());
    },

    migrateLegacy,
  };
}

export type ProjectSecretService = ReturnType<typeof createProjectSecretService>;
