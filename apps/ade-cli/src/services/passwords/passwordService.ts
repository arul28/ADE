/**
 * Passwords on this machine: the brain's service.
 *
 * What it keeps:
 * - the account's sealed items, mirrored from the relay, in this machine's
 *   encrypted store (they are ciphertext already; the store adds nothing but
 *   is where ADE keeps account caches);
 * - the vault key, cached in the same encrypted store on a person's machine,
 *   and only in memory on an ADE Cloud computer;
 * - writes made while offline, until the relay takes them.
 *
 * What it gives out, and to whom:
 * - `listSummaries()`: sites, usernames and which kinds of value an item has.
 *   Safe for agents; never a value.
 * - `resolveForFill()` and `resolveSecretValue()`: the values, for desktop
 *   main to fill a page or for ADE to inject a secret into a process it
 *   starts. These are never wired to an agent-reachable action; the action
 *   layer exposes them only to the person's own client (see `passwords`
 *   in actionPolicy).
 *
 * Nothing here logs a value, a site or a username: log lines carry item ids
 * and counts only.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  PasswordImportResult,
  PasswordItemSecret,
  PasswordItemSummary,
  PasswordLoginSecret,
  PasswordSecretSecret,
  PasswordsStatus,
} from "../../../../desktop/src/shared/types/passwords";
import { createStoreRegistry } from "../account/accountCacheStore";
import { EncryptedFileCredentialStore, type CredentialStore } from "../credentials/credentialStore";
import type {
  PasswordMachineKind,
  PasswordRelayItem,
  PasswordRelayWrite,
  PasswordRelayWriteResult,
} from "../push/pushRelayClient";
import {
  openPasswordItem,
  parsePasswordEnvelope,
  sealPasswordItem,
} from "./passwordCrypto";
import { dedupeImportedLogins, parsePasswordCsv } from "./passwordCsvImport";
import { matchLoginsForOrigin, normalizeLoginOrigin } from "./passwordMatching";

export type PasswordsRelay = {
  getPasswordItems(options?: { since?: string | null }): Promise<{ items: PasswordRelayItem[]; cursor: string | null; truncated: boolean } | null>;
  putPasswordItems(items: PasswordRelayWrite[], deviceId: string | null): Promise<PasswordRelayWriteResult[] | null>;
  requestPasswordKey(args: { deviceId: string; machineKind: PasswordMachineKind; reset?: boolean }): Promise<{ dek: string; epoch: number } | null>;
};

export type PasswordsLogger = {
  info: (event: string, data?: Record<string, unknown>) => void;
  warn: (event: string, data?: Record<string, unknown>) => void;
};

type StoredItem = { id: string; revision: string | null; deleted: boolean; envelope: string | null };
type PendingWrite = { id: string; envelope: string | null; deleted: boolean; ifRevision: string | null };
type CacheShape = { v: 1; accountId: string; cursor: string | null; items: StoredItem[]; pending: PendingWrite[] };

const CACHE_KEY = "passwords.items.v1";
const KEY_CACHE_KEY = "passwords.key.v1";
const ITEM_ID_BYTES = 12;
const SYNC_INTERVAL_MS = 60_000;

export class PasswordsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordsUnavailableError";
  }
}

function newItemId(): string {
  return `pw_${crypto.randomBytes(ITEM_ID_BYTES).toString("base64url")}`;
}

function summarize(id: string, secret: PasswordItemSecret): PasswordItemSummary {
  if (secret.kind === "login") {
    const sites = [...new Set(secret.origins.map((origin) => normalizeLoginOrigin(origin)?.site).filter((site): site is string => Boolean(site)))];
    return {
      id,
      kind: "login",
      title: secret.title || sites[0] || "Login",
      sites,
      username: secret.username || null,
      hasPassword: Boolean(secret.password),
      hasTotp: Boolean(secret.totpUri),
      projectScope: null,
      updatedAt: secret.updatedAt,
    };
  }
  return {
    id,
    kind: "secret",
    title: secret.name,
    sites: [],
    username: null,
    hasPassword: Boolean(secret.value),
    hasTotp: false,
    projectScope: secret.projectScope,
    updatedAt: secret.updatedAt,
  };
}

export function createPasswordService(args: {
  adeDir: string;
  relay: PasswordsRelay | null;
  getAccountUserId: () => string | null;
  getDeviceId: () => string | null;
  machineKind: PasswordMachineKind;
  /**
   * The account-wide "ADE Cloud computers can use Passwords" switch (an
   * account setting): true, false, or null when nobody has set it yet.
   */
  getCloudEnabled?: () => boolean | null;
  setCloudEnabled?: (enabled: boolean) => void;
  logger?: PasswordsLogger;
  /** Tests inject a store; production uses the machine's encrypted file store. */
  store?: CredentialStore;
  now?: () => Date;
}) {
  const logger = args.logger ?? { info: () => {}, warn: () => {} };
  const now = args.now ?? (() => new Date());
  const store: CredentialStore = args.store ?? new EncryptedFileCredentialStore({
    credentialsPath: path.join(args.adeDir, "passwords", "passwords.v1.enc"),
    machineKeyPath: path.join(args.adeDir, "secrets", ".machine-key"),
    lockPath: path.join(args.adeDir, "passwords", "passwords.v1.enc.lock"),
  });
  // A cloud computer never writes the key to disk: it asks again after a restart.
  const keepKeyOnDisk = args.machineKind !== "cloud";
  const isCloud = args.machineKind === "cloud";
  // Whether the person turned Passwords on for this computer. Plain JSON: it
  // says only "on" or "off", and has to be readable before any key exists.
  const statePath = path.join(args.adeDir, "passwords", "state.json");
  let enabledHere: boolean | null = null;
  const readEnabledHere = (): boolean => {
    if (enabledHere !== null) return enabledHere;
    try {
      enabledHere = (JSON.parse(fs.readFileSync(statePath, "utf8")) as { enabled?: unknown }).enabled === true;
    } catch {
      enabledHere = false;
    }
    return enabledHere;
  };
  const cloudEnabled = (): boolean => args.getCloudEnabled?.() === true;
  /** Passwords is off until the person turns it on: per computer, or by the one ADE Cloud switch. */
  const isEnabled = (): boolean => (isCloud ? cloudEnabled() : readEnabledHere());

  let memoryKey: { accountId: string; key: Buffer; epoch: number } | null = null;
  /** Opened items, by id; rebuilt from the cache whenever it changes. Values live only here. */
  let opened = new Map<string, PasswordItemSecret>();
  let openedFor: string | null = null;
  let syncing: Promise<void> | null = null;
  let periodicSync: ReturnType<typeof setInterval> | null = null;

  const accountOrThrow = (): string => {
    const accountId = args.getAccountUserId();
    if (!accountId) throw new PasswordsUnavailableError("Sign in to ADE to use Passwords.");
    if (!isEnabled()) {
      throw new PasswordsUnavailableError(isCloud
        ? "Passwords is off for ADE Cloud computers. The person can turn it on in Settings › Passwords."
        : "Passwords is off on this computer. The person can turn it on in Settings › Passwords.");
    }
    return accountId;
  };

  async function readCache(accountId: string): Promise<CacheShape> {
    const raw = await store.get(CACHE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as CacheShape;
        // Another account's cache on this machine (a sign-in switch) is never reused.
        if (parsed?.v === 1 && parsed.accountId === accountId && Array.isArray(parsed.items)) return parsed;
      } catch {
        logger.warn("passwords.cache_unreadable", {});
      }
    }
    return { v: 1, accountId, cursor: null, items: [], pending: [] };
  }

  async function writeCache(cache: CacheShape): Promise<void> {
    await store.set(CACHE_KEY, JSON.stringify(cache));
  }

  async function vaultKey(accountId: string): Promise<{ key: Buffer; epoch: number }> {
    if (memoryKey?.accountId === accountId) return memoryKey;
    if (keepKeyOnDisk) {
      const cached = await store.get(KEY_CACHE_KEY);
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as { accountId: string; dek: string; epoch: number };
          if (parsed.accountId === accountId) {
            memoryKey = { accountId, key: Buffer.from(parsed.dek, "base64"), epoch: parsed.epoch };
            return memoryKey;
          }
        } catch {
          // fall through to the relay
        }
      }
    }
    const deviceId = args.getDeviceId();
    if (!args.relay || !deviceId) throw new PasswordsUnavailableError("Passwords needs ADE's account service; try again when online.");
    const released = await args.relay.requestPasswordKey({ deviceId, machineKind: args.machineKind });
    if (!released) throw new PasswordsUnavailableError("Passwords is unavailable right now; try again shortly.");
    memoryKey = { accountId, key: Buffer.from(released.dek, "base64"), epoch: released.epoch };
    if (keepKeyOnDisk) await store.set(KEY_CACHE_KEY, JSON.stringify({ accountId, dek: released.dek, epoch: released.epoch }));
    logger.info("passwords.key_ready", { epoch: released.epoch, source: "relay" });
    return memoryKey;
  }

  /** Forget the cached key, so the next use asks the relay for the current one. */
  async function dropKey(): Promise<void> {
    memoryKey = null;
    if (keepKeyOnDisk) await store.delete(KEY_CACHE_KEY);
  }

  /**
   * Open every live item into memory. An item sealed under a NEWER key epoch
   * means Passwords was reset on another machine: this machine's cached key is
   * stale, so it is dropped and fetched again, once. An item from an older
   * epoch is skipped (a reset wiped it), not an error.
   */
  async function openAll(accountId: string, cache: CacheShape, retried = false): Promise<void> {
    const { key, epoch } = await vaultKey(accountId);
    const next = new Map<string, PasswordItemSecret>();
    let unopenable = 0;
    const live = new Map<string, string | null>();
    for (const item of cache.items) live.set(item.id, item.deleted ? null : item.envelope);
    // Local writes not yet on the relay win over the mirrored copy.
    for (const write of cache.pending) live.set(write.id, write.deleted ? null : write.envelope);
    for (const [id, raw] of live) {
      if (!raw) continue;
      const envelope = parsePasswordEnvelope(raw);
      if (!envelope) {
        unopenable += 1;
        continue;
      }
      if (envelope.epoch > epoch && !retried) {
        logger.info("passwords.key_epoch_advanced", { from: epoch, to: envelope.epoch });
        await dropKey();
        return await openAll(accountId, cache, true);
      }
      try {
        next.set(id, openPasswordItem<PasswordItemSecret>(key, { accountId, itemId: id, epoch }, envelope));
      } catch {
        unopenable += 1;
      }
    }
    if (unopenable) logger.warn("passwords.items_unopenable", { count: unopenable });
    opened = next;
    openedFor = accountId;
  }

  async function ensureOpened(): Promise<string> {
    const accountId = accountOrThrow();
    if (openedFor !== accountId) await openAll(accountId, await readCache(accountId));
    return accountId;
  }

  /** Pull new revisions, push pending writes, and reopen. Safe to call often; one at a time. */
  async function sync(): Promise<void> {
    if (syncing) return syncing;
    syncing = (async () => {
      const accountId = args.getAccountUserId();
      if (!accountId || !args.relay) return;
      if (!isEnabled()) {
        // Turned off (here, or the cloud switch from another machine): keep nothing.
        if (memoryKey || openedFor) await purgeLocal();
        return;
      }
      const cache = await readCache(accountId);
      // Pull.
      let cursor = cache.cursor;
      for (let page = 0; page < 50; page += 1) {
        const result = await args.relay.getPasswordItems({ since: cursor });
        if (!result) break;
        const byId = new Map(cache.items.map((item) => [item.id, item]));
        for (const row of result.items) {
          byId.set(row.id, { id: row.id, revision: row.revision, deleted: row.deleted, envelope: row.ciphertext });
        }
        cache.items = [...byId.values()];
        cursor = result.cursor ?? cursor;
        if (!result.truncated) break;
      }
      cache.cursor = cursor;
      // Push.
      if (cache.pending.length) {
        const results = await args.relay.putPasswordItems(
          cache.pending.map((write) => ({
            id: write.id,
            ...(write.deleted ? { deleted: true } : { ciphertext: write.envelope ?? "" }),
            ...(write.ifRevision ? { ifRevision: write.ifRevision } : { ifRevision: "absent" }),
          })),
          args.getDeviceId(),
        );
        if (results) {
          const answered = new Map(results.map((result) => [result.id, result]));
          const stillPending: PendingWrite[] = [];
          for (const write of cache.pending) {
            const answer = answered.get(write.id);
            if (answer?.status === "ok") {
              const existing = cache.items.find((item) => item.id === write.id);
              const updated: StoredItem = { id: write.id, revision: answer.revision, deleted: write.deleted, envelope: write.envelope };
              if (existing) Object.assign(existing, updated);
              else cache.items.push(updated);
            } else if (answer?.status === "stale") {
              // Another machine changed it first: theirs stands, this edit is dropped and said so.
              logger.warn("passwords.write_superseded", { itemId: write.id });
            } else if (!answer) {
              stillPending.push(write);
            } else {
              logger.warn("passwords.write_refused", { itemId: write.id });
            }
          }
          cache.pending = stillPending;
        }
      }
      await writeCache(cache);
      openedFor = null;
    })().finally(() => {
      syncing = null;
    });
    return syncing;
  }

  async function writeItem(id: string, secret: PasswordItemSecret | null): Promise<void> {
    const accountId = await ensureOpened();
    const cache = await readCache(accountId);
    const { key, epoch } = await vaultKey(accountId);
    const known = cache.items.find((item) => item.id === id);
    const envelope = secret ? JSON.stringify(sealPasswordItem(key, { accountId, itemId: id, epoch }, secret)) : null;
    cache.pending = cache.pending.filter((write) => write.id !== id);
    cache.pending.push({ id, envelope, deleted: secret === null, ifRevision: known?.revision ?? null });
    await writeCache(cache);
    if (secret) opened.set(id, secret);
    else opened.delete(id);
    void sync().catch((error: unknown) => {
      logger.warn("passwords.sync_failed", { error: error instanceof Error ? error.name : "unknown" });
    });
  }

  async function purgeLocal(): Promise<void> {
    await dropKey();
    opened = new Map();
    openedFor = null;
    await store.delete(CACHE_KEY);
    logger.info("passwords.purged", {});
  }

  return {
    /** Whether Passwords is on here, and what this computer holds. Never a value. */
    async status(): Promise<PasswordsStatus> {
      const accountId = args.getAccountUserId();
      const enabled = isEnabled();
      let itemCount: number | null = null;
      if (accountId && enabled) {
        try {
          await ensureOpened();
          itemCount = opened.size;
        } catch {
          itemCount = null;
        }
      }
      return {
        signedIn: Boolean(accountId),
        enabled,
        machineKind: args.machineKind,
        cloudEnabled: args.getCloudEnabled?.() ?? null,
        itemCount,
      };
    },

    /**
     * Turn Passwords on or off for this computer. Off forgets the key and every
     * cached item here (the account's copy stays). The first time any computer
     * turns it on, the ADE Cloud switch starts on.
     */
    async setEnabled(enabled: boolean): Promise<PasswordsStatus> {
      if (isCloud) throw new PasswordsUnavailableError("On an ADE Cloud computer, Passwords follows the ADE Cloud switch in Settings › Passwords.");
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({ enabled }), { mode: 0o600 });
      enabledHere = enabled;
      if (enabled) {
        if (args.getCloudEnabled?.() === null) args.setCloudEnabled?.(true);
        void sync().catch((error: unknown) => {
          logger.warn("passwords.sync_failed", { error: error instanceof Error ? error.name : "unknown" });
        });
      } else {
        await purgeLocal();
      }
      logger.info("passwords.enabled_changed", { enabled });
      return await this.status();
    },

    /** The account-wide switch for ADE Cloud computers. */
    async setCloudEnabled(enabled: boolean): Promise<PasswordsStatus> {
      if (!args.setCloudEnabled) throw new PasswordsUnavailableError("Passwords needs ADE's account service; try again when online.");
      args.setCloudEnabled(enabled);
      if (isCloud && !enabled) await purgeLocal();
      logger.info("passwords.cloud_enabled_changed", { enabled });
      return await this.status();
    },

    /**
     * Reset Passwords: the account starts a new, empty vault under a new key.
     * Every saved item on every computer is gone. The caller asks the person
     * first (and Touch ID / Windows Hello); this only does it.
     */
    async reset(): Promise<PasswordsStatus> {
      const accountId = accountOrThrow();
      const deviceId = args.getDeviceId();
      if (!args.relay || !deviceId) throw new PasswordsUnavailableError("Passwords needs ADE's account service; try again when online.");
      const released = await args.relay.requestPasswordKey({ deviceId, machineKind: args.machineKind, reset: true });
      if (!released) throw new PasswordsUnavailableError("Passwords is unavailable right now; try again shortly.");
      await purgeLocal();
      memoryKey = { accountId, key: Buffer.from(released.dek, "base64"), epoch: released.epoch };
      if (keepKeyOnDisk) await store.set(KEY_CACHE_KEY, JSON.stringify({ accountId, dek: released.dek, epoch: released.epoch }));
      logger.info("passwords.reset", { epoch: released.epoch });
      await sync();
      return await this.status();
    },

    /** Everything an agent or a list may see. Never a value. */
    async listSummaries(): Promise<PasswordItemSummary[]> {
      await ensureOpened();
      return [...opened.entries()]
        .map(([id, secret]) => summarize(id, secret))
        .sort((a, b) => a.title.localeCompare(b.title));
    },

    /** The site and exact origin Passwords would fill a page on, or null (not https, not a site). */
    siteForPage(pageUrl: string): { site: string; origin: string } | null {
      const normalized = normalizeLoginOrigin(pageUrl);
      return normalized ? { site: normalized.site, origin: normalized.origin } : null;
    },

    /** Saved logins for the site a page is on, best match first. Summaries only. */
    async loginsForPage(pageUrl: string): Promise<PasswordItemSummary[]> {
      await ensureOpened();
      const logins = [...opened.entries()]
        .filter((entry): entry is [string, PasswordLoginSecret] => entry[1].kind === "login")
        .map(([id, secret]) => ({ id, origins: secret.origins, secret }));
      return matchLoginsForOrigin(logins, pageUrl).map((entry) => summarize(entry.id, entry.secret));
    },

    /**
     * The values to fill one login into a page. Person-only and desktop-main
     * only: the page URL is the tab's own, and the item must belong to its
     * site. Returns null when it does not.
     */
    async resolveForFill(input: { itemId: string; pageUrl: string }): Promise<{ username: string; password: string; totpUri: string | null } | null> {
      await ensureOpened();
      const secret = opened.get(input.itemId);
      if (!secret || secret.kind !== "login") return null;
      const matches = matchLoginsForOrigin([{ origins: secret.origins }], input.pageUrl);
      if (matches.length === 0) return null;
      return { username: secret.username, password: secret.password, totpUri: secret.totpUri };
    },

    /** A secret's value by name, for injecting into a process ADE starts. Never returned to an agent. */
    async resolveSecretValue(input: { name: string; projectScope: string | null }): Promise<string | null> {
      await ensureOpened();
      let fallback: string | null = null;
      for (const secret of opened.values()) {
        if (secret.kind !== "secret" || secret.name !== input.name) continue;
        if (secret.projectScope === input.projectScope) return secret.value;
        if (secret.projectScope === null) fallback = secret.value;
      }
      return fallback;
    },

    /**
     * Add a login, or change one by id. A change keeps whatever it does not
     * name: its exact sites, username, title, notes and code.
     */
    async saveLogin(input: { id?: string; title?: string; origins?: string[]; username?: string; password: string; notes?: string; totpUri?: string | null }): Promise<PasswordItemSummary> {
      await ensureOpened();
      const existingItem = input.id ? opened.get(input.id) : undefined;
      if (input.id && existingItem?.kind !== "login") throw new Error("That saved login no longer exists.");
      const existing = existingItem?.kind === "login" ? existingItem : undefined;
      const named = input.origins?.length ? input.origins : existing?.origins ?? [];
      const origins = [...new Set(named.map((origin) => normalizeLoginOrigin(origin)?.origin).filter((origin): origin is string => Boolean(origin)))];
      if (origins.length === 0) throw new Error("A saved login needs an https site.");
      if (!input.password) throw new Error("A saved login needs a password.");
      const id = input.id ?? newItemId();
      const stamp = now().toISOString();
      const secret: PasswordLoginSecret = {
        kind: "login",
        title: input.title?.trim() || existing?.title || normalizeLoginOrigin(origins[0]!)?.site || "Login",
        origins,
        username: input.username ?? existing?.username ?? "",
        password: input.password,
        notes: input.notes ?? existing?.notes ?? "",
        totpUri: input.totpUri !== undefined ? input.totpUri : existing?.totpUri ?? null,
        createdAt: existing?.createdAt ?? stamp,
        updatedAt: stamp,
      };
      await writeItem(id, secret);
      logger.info("passwords.item_saved", { itemId: id, kind: "login" });
      return summarize(id, secret);
    },

    async saveSecret(input: { id?: string; name: string; value: string; projectScope: string | null; notes?: string }): Promise<PasswordItemSummary> {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(input.name)) throw new Error("A secret's name must look like an environment variable.");
      const id = input.id ?? newItemId();
      const existing = input.id ? opened.get(input.id) : undefined;
      const stamp = now().toISOString();
      const secret: PasswordSecretSecret = {
        kind: "secret",
        name: input.name,
        value: input.value,
        projectScope: input.projectScope,
        notes: input.notes ?? (existing?.kind === "secret" ? existing.notes : ""),
        createdAt: existing?.createdAt ?? stamp,
        updatedAt: stamp,
      };
      await writeItem(id, secret);
      logger.info("passwords.item_saved", { itemId: id, kind: "secret" });
      return summarize(id, secret);
    },

    async remove(id: string): Promise<boolean> {
      await ensureOpened();
      if (!opened.has(id)) return false;
      await writeItem(id, null);
      logger.info("passwords.item_removed", { itemId: id });
      return true;
    },

    /** Import a CSV export. The file's text never leaves this call except as sealed items. */
    async importCsv(text: string): Promise<PasswordImportResult> {
      await ensureOpened();
      const parsed = parsePasswordCsv(text);
      const existing = [...opened.values()]
        .filter((secret): secret is PasswordLoginSecret => secret.kind === "login")
        .map((secret) => ({ origins: secret.origins, username: secret.username, password: secret.password }));
      const { fresh, skippedDuplicate } = dedupeImportedLogins(parsed.rows, existing);
      for (const row of fresh) {
        await this.saveLogin({
          title: row.title,
          origins: row.origins,
          username: row.username,
          password: row.password,
          notes: row.notes,
          totpUri: row.totpUri,
        });
      }
      logger.info("passwords.imported", { format: parsed.format, imported: fresh.length, skippedDuplicate, skippedInvalid: parsed.skippedInvalid });
      return { imported: fresh.length, skippedDuplicate, skippedInvalid: parsed.skippedInvalid };
    },

    sync,

    /** Keep this computer's copy in step with the account, once per service (unref'd). */
    startPeriodicSync(): void {
      if (periodicSync) return;
      periodicSync = setInterval(() => {
        void sync().catch((error: unknown) => {
          logger.warn("passwords.sync_failed", { error: error instanceof Error ? error.name : "unknown" });
        });
      }, SYNC_INTERVAL_MS);
      periodicSync.unref?.();
    },

    /** Sign-out or a reset: forget the key and every cached item on this machine. */
    purge: purgeLocal,
  };
}

export type PasswordService = ReturnType<typeof createPasswordService>;

/**
 * One service per ADE home, whoever asks first (a project runtime, or the
 * machine route Settings uses with no project open). Two copies would each
 * cache opened items and rewrite the same file, losing each other's writes.
 */
const registry = createStoreRegistry<PasswordService>();

const PASSWORDS_CLOUD_SETTING_KEY = "passwords.cloudEnabled";

/** The ADE Cloud switch, read and written as an ordinary account setting (it holds no secret). */
export function passwordsCloudSwitch(settings: { get(scope: string, key: string): unknown; set(scope: string, key: string, value: unknown): boolean } | null): {
  getCloudEnabled: () => boolean | null;
  setCloudEnabled: (enabled: boolean) => void;
} {
  return {
    getCloudEnabled: () => {
      const value = settings?.get("all", PASSWORDS_CLOUD_SETTING_KEY);
      return typeof value === "boolean" ? value : null;
    },
    setCloudEnabled: (enabled) => {
      settings?.set("all", PASSWORDS_CLOUD_SETTING_KEY, enabled);
    },
  };
}

export function getSharedPasswordService(adeDir: string, create: () => PasswordService): PasswordService {
  return registry.get(adeDir, create);
}
