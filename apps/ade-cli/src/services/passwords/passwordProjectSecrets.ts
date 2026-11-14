/**
 * Secrets as a project's processes see them: the account's (synced) and this
 * computer's own, by name, for every project or for one.
 *
 * The Passwords service owns the vault (its key, cache and sync); this module
 * owns what a secret is to a project: which copy wins, where a save goes, and
 * how an old per-project secret moves in.
 */
import crypto from "node:crypto";
import {
  SECRET_NAME_PATTERN,
  SECRET_NAME_RULE,
  SIGN_IN_CONFIG_SECRET_NAMES,
  type PasswordItemSecret,
  type PasswordItemSummary,
  type PasswordSecretSecret,
} from "../../../../desktop/src/shared/types/passwords";
import { isDeviceId, newDeviceSecretId, type DeviceSecret, type DeviceSecretStore } from "./passwordDeviceSecrets";
import { newPasswordItemId, summarizePasswordItem } from "./passwordItems";
import type { PasswordsLogger } from "./passwordService";

/** A secret a project's processes get, from the account vault or this computer's own store. */
export type ProjectSecretEntry = {
  id: string;
  name: string;
  value: string;
  projectScope: string | null;
  deviceOnly: boolean;
  createdAt: string;
  updatedAt: string;
};

export type LegacySecretAdoption = {
  outcome: "saved" | "kept" | "deleted";
  /** The account item that holds the value now; null when it lives on this computer, or was deleted. */
  id: string | null;
};

/**
 * The largest old account secret moved into the account. The relay takes
 * sealed items up to 64 KiB of text, and sealing adds about a third; a bigger
 * old value stays on this computer only instead of failing to upload forever.
 */
const LEGACY_ACCOUNT_VALUE_MAX_CHARS = 40_000;

/**
 * The secrets one project's processes get, by name: those for every project,
 * then the project's own over them; within each, this computer's own over the
 * account's (a this-computer-only value is the deliberate one here).
 */
export function secretsForScope(entries: readonly ProjectSecretEntry[], projectScope: string | null): Map<string, ProjectSecretEntry> {
  const rank = (entry: ProjectSecretEntry) => (entry.projectScope === null ? 0 : 2) + (entry.deviceOnly ? 1 : 0);
  const out = new Map<string, ProjectSecretEntry>();
  for (const entry of [...entries].sort((a, b) => rank(a) - rank(b))) {
    if (entry.projectScope !== null && entry.projectScope !== projectScope) continue;
    out.set(entry.name, entry);
  }
  return out;
}

type Opened = ReadonlyMap<string, PasswordItemSecret>;

export type ProjectSecretsContext = {
  logger: PasswordsLogger;
  now: () => Date;
  device: DeviceSecretStore;
  isEnabled: () => boolean;
  accountUserId: () => string | null;
  /** The account's opened items without waiting (from disk when it can), or null while locked. */
  openedNow: () => Opened | null;
  /** Open the account's items; throws when signed out or off. */
  ensureOpened: () => Promise<{ accountId: string; opened: Opened }>;
  writeItem: (id: string, secret: PasswordItemSecret | null) => Promise<void>;
  vaultKey: (accountId: string) => Promise<{ key: Buffer }>;
  /** Which items this computer knows the relay holds, and which writes it has not sent yet. */
  cacheView: (accountId: string) => Promise<{ items: ReadonlyArray<{ id: string; deleted: boolean }>; pending: ReadonlyArray<{ id: string; deleted: boolean }> }>;
};

export type ProjectSecretSaveInput = {
  id?: string;
  name: string;
  value: string;
  projectScope: string | null;
  notes?: string;
  /**
   * Where it goes: true for this computer only, false for the account.
   * Unset updates a this-computer-only copy of the name already here, and
   * otherwise saves to the account.
   */
  deviceOnly?: boolean;
};

export function createProjectSecrets(ctx: ProjectSecretsContext) {
  const { logger, device } = ctx;

  const accountEntries = (opened: Opened | null): ProjectSecretEntry[] => {
    const out: ProjectSecretEntry[] = [];
    for (const [id, secret] of opened ?? []) {
      if (secret.kind !== "secret") continue;
      out.push({ id, name: secret.name, value: secret.value, projectScope: secret.projectScope, deviceOnly: false, createdAt: secret.createdAt, updatedAt: secret.updatedAt });
    }
    return out;
  };
  const deviceEntries = (items: readonly DeviceSecret[]): ProjectSecretEntry[] => items.map((secret) => ({
    id: secret.id,
    name: secret.name,
    value: secret.value,
    projectScope: secret.projectScope,
    deviceOnly: true,
    createdAt: secret.createdAt,
    updatedAt: secret.updatedAt,
  }));

  /** The account's items when the vault is usable here (signed in, on), opened; else null. */
  async function openAccount(): Promise<Opened | null> {
    if (!ctx.accountUserId() || !ctx.isEnabled()) return null;
    return (await ctx.ensureOpened()).opened;
  }

  /**
   * Every secret this computer can use, unmerged. Off means off: nothing at
   * all. An account vault that can't be opened now (no key here, the relay
   * unreachable) leaves this computer's own secrets usable.
   */
  async function allEntries(): Promise<ProjectSecretEntry[]> {
    if (!ctx.isEnabled()) return [];
    const items = await device.read();
    const opened = await openAccount().catch((error: unknown) => {
      logger.warn("passwords.account_open_failed", { error: error instanceof Error ? error.name : "unknown" });
      return null;
    });
    return [...accountEntries(opened), ...deviceEntries(items)];
  }

  // Saves run one at a time: two saves of one new name must update one item, not make two.
  let saveQueue: Promise<unknown> = Promise.resolve();
  function oneAtATime<T>(run: () => Promise<T>): Promise<T> {
    const next = saveQueue.then(run, run);
    saveQueue = next.catch(() => undefined);
    return next;
  }

  const findSecret = (opened: Opened, name: string, projectScope: string | null): [string, PasswordSecretSecret] | undefined =>
    [...opened.entries()].find((entry): entry is [string, PasswordSecretSecret] =>
      entry[1].kind === "secret" && entry[1].name === name && entry[1].projectScope === projectScope);

  /** Write one this-computer-only secret (by id, else by name in its project), stamped `updatedAt`. */
  async function saveOnDevice(input: ProjectSecretSaveInput & { name: string; updatedAt: string; skipIfNotOlder?: boolean }): Promise<DeviceSecret | null> {
    const result: { saved: DeviceSecret | null; missing: boolean } = { saved: null, missing: false };
    await device.update((items) => {
      const existing = input.id
        ? items.find((item) => item.id === input.id)
        : items.find((item) => item.name === input.name && item.projectScope === input.projectScope);
      if (input.id && !existing) {
        result.missing = true;
        return undefined;
      }
      if (input.skipIfNotOlder && existing && existing.updatedAt >= input.updatedAt) return undefined;
      const saved: DeviceSecret = {
        id: existing?.id ?? newDeviceSecretId(),
        kind: "secret",
        name: input.name,
        value: input.value,
        projectScope: input.projectScope,
        notes: input.notes ?? existing?.notes ?? "",
        createdAt: existing?.createdAt ?? input.updatedAt,
        updatedAt: input.updatedAt,
      };
      result.saved = saved;
      return [...items.filter((item) => item.id !== saved.id), saved];
    });
    if (result.missing) throw new Error("That secret no longer exists.");
    if (result.saved) logger.info("passwords.item_saved", { itemId: result.saved.id, kind: "secret", deviceOnly: true });
    return result.saved;
  }

  /** Write one account secret under `id`, keeping what `existing` had that the input does not name. */
  async function saveInAccount(id: string, input: ProjectSecretSaveInput & { name: string; updatedAt: string }, existing: PasswordSecretSecret | undefined): Promise<PasswordSecretSecret> {
    const secret: PasswordSecretSecret = {
      kind: "secret",
      name: input.name,
      value: input.value,
      projectScope: input.projectScope,
      notes: input.notes ?? existing?.notes ?? "",
      createdAt: existing?.createdAt ?? input.updatedAt,
      updatedAt: input.updatedAt,
    };
    await ctx.writeItem(id, secret);
    return secret;
  }

  return {
    /** The secrets one project sees, by name (see `secretsForScope` for which wins). */
    async secretsForProject(projectScope: string | null): Promise<Map<string, ProjectSecretEntry>> {
      return secretsForScope(await allEntries(), projectScope);
    },

    allSecretEntries: allEntries,

    /**
     * The same, from what this computer already holds: for a caller that
     * cannot wait (a webhook signature check, a process env). The periodic
     * sync keeps it current; before the first open it holds only this
     * computer's secrets.
     */
    secretsSnapshot(projectScope: string | null): Map<string, ProjectSecretEntry> {
      if (!ctx.isEnabled()) return new Map();
      const opened = ctx.accountUserId() ? ctx.openedNow() : null;
      return secretsForScope([...accountEntries(opened), ...deviceEntries(device.readSync())], projectScope);
    },

    /**
     * Only this computer's own secrets, without waiting, without asking who is
     * signed in, and whatever the Passwords switch says: for sign-in's account
     * server (`SIGN_IN_CONFIG_SECRET_NAMES`), which is read before anyone is
     * signed in and must not lock a person out of signing in.
     */
    deviceSecretsSnapshot(projectScope: string | null): Map<string, ProjectSecretEntry> {
      return secretsForScope(deviceEntries(device.readSync()), projectScope);
    },

    /**
     * Save a secret. Without an id, a secret with the same name for the same
     * project in the same place is updated rather than doubled. See
     * `ProjectSecretSaveInput.deviceOnly` for where it goes. Sign-in's account
     * server names always stay on this computer.
     */
    saveSecret: (input: ProjectSecretSaveInput): Promise<PasswordItemSummary> => oneAtATime(async () => {
      const name = input.name.trim();
      if (!SECRET_NAME_PATTERN.test(name)) throw new Error(SECRET_NAME_RULE);
      if (!input.value) throw new Error(`${name} needs a value.`);
      const updatedAt = ctx.now().toISOString();
      let deviceOnly: boolean;
      if (input.id) deviceOnly = isDeviceId(input.id);
      else if (SIGN_IN_CONFIG_SECRET_NAMES.has(name)) deviceOnly = true;
      else if (input.deviceOnly !== undefined) deviceOnly = input.deviceOnly;
      else deviceOnly = (await device.read()).some((item) => item.name === name && item.projectScope === input.projectScope);
      if (deviceOnly) {
        const saved = await saveOnDevice({ ...input, name, updatedAt });
        return summarizePasswordItem(saved!.id, saved!, true);
      }
      const { opened } = await ctx.ensureOpened();
      const existingEntry = input.id
        ? [input.id, opened.get(input.id)] as const
        : findSecret(opened, name, input.projectScope);
      const existing = existingEntry?.[1];
      if (input.id && existing?.kind !== "secret") throw new Error("That secret no longer exists.");
      const id = existingEntry?.[0] ?? newPasswordItemId();
      const secret = await saveInAccount(id, { ...input, name, updatedAt }, existing?.kind === "secret" ? existing : undefined);
      logger.info("passwords.item_saved", { itemId: id, kind: "secret" });
      return summarizePasswordItem(id, secret);
    }),

    /**
     * One secret from the old per-project store, moved in. A copy already here
     * that is as new or newer stays. An account secret with no copy here gets
     * an id derived from its project and name under the vault key (the relay
     * cannot read names from it): two computers that move the same old secret
     * write the same item, and the relay keeps the first. A secret the account
     * has since deleted stays deleted. A value too big for the relay stays on
     * this computer only.
     */
    adoptLegacySecret: (input: { name: string; value: string; projectScope: string; deviceOnly: boolean; updatedAt: string }): Promise<LegacySecretAdoption> => oneAtATime(async () => {
      const deviceOnly = input.deviceOnly || input.value.length > LEGACY_ACCOUNT_VALUE_MAX_CHARS || SIGN_IN_CONFIG_SECRET_NAMES.has(input.name);
      if (deviceOnly) {
        const saved = await saveOnDevice({ ...input, deviceOnly: true, skipIfNotOlder: true });
        return { outcome: saved ? "saved" : "kept", id: null };
      }
      const { accountId, opened } = await ctx.ensureOpened();
      const existing = findSecret(opened, input.name, input.projectScope);
      if (existing) {
        if (existing[1].updatedAt >= input.updatedAt) return { outcome: "kept", id: existing[0] };
        await saveInAccount(existing[0], input, existing[1]);
        logger.info("passwords.item_saved", { itemId: existing[0], kind: "secret", legacy: true });
        return { outcome: "saved", id: existing[0] };
      }
      const { key } = await ctx.vaultKey(accountId);
      const id = `pw_${crypto.createHmac("sha256", key).update(`legacy-secret\0${input.projectScope}\0${input.name}`).digest("base64url").slice(0, 32)}`;
      const cache = await ctx.cacheView(accountId);
      if (cache.items.some((item) => item.id === id && item.deleted) || cache.pending.some((write) => write.id === id && write.deleted)) {
        return { outcome: "deleted", id: null };
      }
      await saveInAccount(id, input, undefined);
      logger.info("passwords.item_saved", { itemId: id, kind: "secret", legacy: true });
      return { outcome: "saved", id };
    }),

    /**
     * Which of these account items the relay holds now, at least as new as
     * `updatedAt`: no write of theirs is still waiting here, and the copy
     * here is not an older one another computer wrote first. One the account
     * deleted counts: the deletion wins.
     */
    async uploadedIds(items: ReadonlyArray<{ id: string; updatedAt: string }>): Promise<Set<string>> {
      const accountId = ctx.accountUserId();
      if (!accountId || items.length === 0) return new Set();
      const cache = await ctx.cacheView(accountId);
      const opened = ctx.openedNow();
      if (!opened) return new Set();
      const waiting = new Set(cache.pending.map((write) => write.id));
      const known = new Set(cache.items.map((item) => item.id));
      return new Set(items.filter(({ id, updatedAt }) => {
        if (!known.has(id) || waiting.has(id)) return false;
        const current = opened.get(id);
        return !current || current.updatedAt >= updatedAt;
      }).map(({ id }) => id));
    },
  };
}
