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
 * - `resolveForFill()` and `secretsForProject()`: the values, for desktop
 *   main to fill a page or for ADE to inject a secret into a process it
 *   starts. These are never wired to an agent-reachable action; the action
 *   layer exposes them only to the person's own client (see `passwords`
 *   in actionPolicy).
 *
 * Nothing here logs a value, a site or a username: log lines carry item ids
 * and counts only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  PasswordImportResult,
  PasswordItemSecret,
  PasswordItemSummary,
  PasswordLoginSecret,
  PasswordPasskeySecret,
  PasswordsStatus,
  PasswordUseRecord,
} from "../../../../desktop/src/shared/types/passwords";
import { createStoreRegistry } from "../account/accountCacheStore";
import { EncryptedFileCredentialStore, type CredentialStore, type SyncCredentialStore } from "../credentials/credentialStore";
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
import { createDeviceSecretStore, isDeviceId } from "./passwordDeviceSecrets";
import { newPasswordItemId, savedForExactOrigin, summarizePasswordItem as summarize, totpOrThrow } from "./passwordItems";
import { matchLoginsForOrigin, normalizeLoginOrigin } from "./passwordMatching";
import { createProjectSecrets } from "./passwordProjectSecrets";
import { parseTotp, totpCode } from "./passwordTotp";

export type PasswordsRelay = {
  /** `epoch`: the account's current key epoch (a newer one means another computer reset Passwords). */
  getPasswordItems(options?: { since?: string | null }): Promise<{ items: PasswordRelayItem[]; cursor: string | null; truncated: boolean; epoch?: number | null } | null>;
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
const ACTIVITY_KEY = "passwords.activity.v1";
/** Newest uses kept on this computer, for Settings › Passwords & Secrets › Activity. */
const ACTIVITY_LIMIT = 500;
const SYNC_INTERVAL_MS = 60_000;
/** The most items the relay takes in one write (`MAX_ITEMS_PER_WRITE` there). */
const RELAY_WRITE_BATCH = 200;

export class PasswordsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordsUnavailableError";
  }
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
  /**
   * Whether this computer has read the account's settings at least once. On
   * an ADE Cloud computer, an unset switch counts as off until then: a fresh
   * cloud computer must not open the vault before it can see "off".
   */
  cloudSwitchSynced?: () => boolean;
  logger?: PasswordsLogger;
  /** Tests inject a store; production uses the machine's encrypted file store. */
  store?: CredentialStore;
  now?: () => Date;
}) {
  const logger = args.logger ?? { info: () => {}, warn: () => {} };
  const now = args.now ?? (() => new Date());
  const store: CredentialStore & Partial<SyncCredentialStore> = args.store ?? new EncryptedFileCredentialStore({
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
      // On unless the person turned it off on this computer.
      enabledHere = (JSON.parse(fs.readFileSync(statePath, "utf8")) as { enabled?: unknown }).enabled !== false;
    } catch {
      enabledHere = true;
    }
    return enabledHere;
  };
  const cloudEnabled = (): boolean => {
    const value = args.getCloudEnabled?.() ?? null;
    if (value === null && args.cloudSwitchSynced && !args.cloudSwitchSynced()) return false;
    return value !== false;
  };
  /** Passwords is on unless turned off: per computer, or by the one ADE Cloud switch. */
  const isEnabled = (): boolean => (isCloud ? cloudEnabled() : readEnabledHere());

  let memoryKey: { accountId: string; key: Buffer; epoch: number } | null = null;
  /** Opened items, by id; rebuilt from the cache whenever it changes. Values live only here. */
  let opened = new Map<string, PasswordItemSecret>();
  let openedFor: string | null = null;
  /**
   * Counts purges (sign-out, off, reset). An open or a key fetch that started
   * before one never installs what it got after it: a purge means this
   * computer forgot the key and the values.
   */
  let purgeCount = 0;
  const purgedSince = (count: number): boolean => purgeCount !== count;
  const purgedError = (): Error => new PasswordsUnavailableError("Passwords & Secrets was signed out or turned off here while it opened.");
  let syncing: Promise<void> | null = null;
  let periodicSync: ReturnType<typeof setInterval> | null = null;

  const accountOrThrow = (): string => {
    const accountId = args.getAccountUserId();
    if (!accountId) throw new PasswordsUnavailableError("Sign in to ADE to use Passwords & Secrets.");
    if (!isEnabled()) {
      throw new PasswordsUnavailableError(isCloud
        ? "Passwords & Secrets is off for ADE Cloud computers. The person can turn it on in Settings › Passwords & Secrets."
        : "Passwords & Secrets is off on this computer. The person can turn it on in Settings › Passwords & Secrets.");
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
    const startedAt = purgeCount;
    if (keepKeyOnDisk) {
      const cached = await store.get(KEY_CACHE_KEY);
      if (purgedSince(startedAt)) throw purgedError();
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as { accountId: string; dek: string; epoch: number };
          if (parsed.accountId === accountId) {
            memoryKey = { accountId, key: Buffer.from(parsed.dek, "base64"), epoch: parsed.epoch };
            return memoryKey;
          }
        } catch {
          logger.warn("passwords.key_cache_unreadable", {});
        }
      }
    }
    const deviceId = args.getDeviceId();
    if (!args.relay || !deviceId) throw new PasswordsUnavailableError("Passwords needs ADE's account service; try again when online.");
    const released = await args.relay.requestPasswordKey({ deviceId, machineKind: args.machineKind });
    if (!released) throw new PasswordsUnavailableError("Passwords & Secrets is unavailable right now; try again shortly.");
    if (purgedSince(startedAt)) throw purgedError();
    memoryKey = { accountId, key: Buffer.from(released.dek, "base64"), epoch: released.epoch };
    if (keepKeyOnDisk) await store.set(KEY_CACHE_KEY, JSON.stringify({ accountId, dek: released.dek, epoch: released.epoch }));
    logger.info("passwords.key_ready", { epoch: released.epoch, source: "relay" });
    return memoryKey;
  }

  /** The epoch of the key cached on disk, without asking the relay. */
  async function cachedKeyEpoch(accountId: string): Promise<{ epoch: number } | null> {
    if (!keepKeyOnDisk) return null;
    try {
      const parsed = JSON.parse((await store.get(KEY_CACHE_KEY)) ?? "null") as { accountId?: string; epoch?: number } | null;
      return parsed?.accountId === accountId && typeof parsed.epoch === "number" ? { epoch: parsed.epoch } : null;
    } catch {
      return null;
    }
  }

  /** Forget the cached key, so the next use asks the relay for the current one. */
  async function dropKey(): Promise<void> {
    memoryKey = null;
    if (keepKeyOnDisk) await store.delete(KEY_CACHE_KEY);
  }

  /** Each item's current envelope (null: deleted); local writes not yet on the relay win over the mirrored copy. */
  function liveEnvelopes(cache: Pick<CacheShape, "items" | "pending">): Map<string, string | null> {
    const live = new Map<string, string | null>();
    for (const item of cache.items) live.set(item.id, item.deleted ? null : item.envelope);
    for (const write of cache.pending ?? []) live.set(write.id, write.deleted ? null : write.envelope);
    return live;
  }

  /**
   * Open every live item into memory. An item sealed under a NEWER key epoch
   * means Passwords was reset on another machine: this machine's cached key is
   * stale, so it is dropped and fetched again, once. An item from an older
   * epoch is skipped (a reset wiped it), not an error.
   */
  async function openAll(
    accountId: string,
    cache: CacheShape,
    /** Unsent saves opened with the previous key, on the pass after a key change. */
    carried: Map<string, PasswordItemSecret> | null = null,
  ): Promise<void> {
    const retried = carried !== null;
    const startedAt = purgeCount;
    const { key, epoch } = await vaultKey(accountId);
    const next = new Map<string, PasswordItemSecret>();
    let unopenable = 0;
    for (const [id, raw] of liveEnvelopes(cache)) {
      if (!raw) continue;
      const envelope = parsePasswordEnvelope(raw);
      if (!envelope) {
        unopenable += 1;
        continue;
      }
      if (envelope.epoch > epoch && !retried) {
        logger.info("passwords.key_epoch_advanced", { from: epoch, to: envelope.epoch });
        // Unsent saves sealed with the key being dropped exist only here:
        // open them now, so the next sync can seal them again, not lose them.
        const unsent = new Map<string, PasswordItemSecret>();
        for (const write of cache.pending) {
          const sealed = write.deleted || !write.envelope ? null : parsePasswordEnvelope(write.envelope);
          if (!sealed || sealed.epoch !== epoch) continue;
          try {
            unsent.set(write.id, openPasswordItem<PasswordItemSecret>(key, { accountId, itemId: write.id, epoch }, sealed));
          } catch {
            logger.warn("passwords.unsent_unopenable", { itemId: write.id });
          }
        }
        await dropKey();
        return await openAll(accountId, cache, unsent);
      }
      const carriedSecret = envelope.epoch !== epoch ? carried?.get(id) : undefined;
      if (carriedSecret) {
        next.set(id, carriedSecret);
        continue;
      }
      try {
        next.set(id, openPasswordItem<PasswordItemSecret>(key, { accountId, itemId: id, epoch }, envelope));
      } catch {
        unopenable += 1;
      }
    }
    if (unopenable) logger.warn("passwords.items_unopenable", { count: unopenable });
    if (purgedSince(startedAt)) throw purgedError();
    opened = next;
    openedFor = accountId;
  }

  async function ensureOpened(): Promise<string> {
    const accountId = accountOrThrow();
    if (openedFor !== accountId) await openAll(accountId, await readCache(accountId));
    return accountId;
  }

  /**
   * Every read-modify-write of this computer's cache (and of Activity) runs
   * through this one queue, so a save that lands while a sync talks to the
   * relay is never written over by the sync's older copy.
   */
  let cacheQueue: Promise<unknown> = Promise.resolve();
  function withCache<T>(run: () => Promise<T>): Promise<T> {
    const next = cacheQueue.then(run, run);
    cacheQueue = next.catch(() => undefined);
    return next;
  }

  /**
   * Re-seal pending writes made under an older key (another computer reset
   * Passwords while this one held the old key): the relay refuses them, and
   * every other computer would skip them.
   */
  function resealStale(
    accountId: string,
    cache: CacheShape,
    key: { key: Buffer; epoch: number },
    /** The key these writes were sealed with: an unsent save may exist only here (nothing opened yet after a restart). */
    oldKey: { key: Buffer; epoch: number } | null,
  ): void {
    cache.pending = cache.pending.flatMap((write) => {
      if (write.deleted || !write.envelope) return [write];
      const envelope = parsePasswordEnvelope(write.envelope);
      if (envelope && envelope.epoch === key.epoch) return [write];
      let secret = opened.get(write.id) ?? null;
      if (!secret && envelope && oldKey && envelope.epoch === oldKey.epoch) {
        try {
          secret = openPasswordItem<PasswordItemSecret>(oldKey.key, { accountId, itemId: write.id, epoch: oldKey.epoch }, envelope);
        } catch {
          secret = null;
        }
      }
      if (!secret) {
        logger.warn("passwords.stale_write_dropped", { itemId: write.id });
        return [];
      }
      return [{ ...write, envelope: JSON.stringify(sealPasswordItem(key.key, { accountId, itemId: write.id, epoch: key.epoch }, secret)), ifRevision: null }];
    });
  }

  /** Pull new revisions, push pending writes, and reopen. Safe to call often; one at a time. */
  /** One more sync, asked for while a sync was running; shared by every caller that asked. */
  let followUp: Promise<void> | null = null;
  /**
   * Pull, then push this computer's unsent writes. A call while a sync is
   * running gets one more sync after it, so a save made mid-sync is sent now,
   * not at the next minute's tick (and a caller awaiting it sees it sent).
   */
  async function sync(): Promise<void> {
    if (syncing) {
      followUp ??= syncing.catch(() => undefined).then(() => {
        followUp = null;
        return sync();
      });
      return followUp;
    }
    syncing = (async () => {
      const accountId = args.getAccountUserId();
      const relay = args.relay;
      if (!accountId || !relay) return;
      if (!isEnabled()) {
        // Turned off (here, or the cloud switch from another machine): keep nothing.
        if (memoryKey || openedFor) await purgeLocal();
        return;
      }
      // Pull, outside the queue: the network can be slow, saves must not wait on it.
      const startCursor = (await withCache(() => readCache(accountId))).cursor;
      let cursor = startCursor;
      let relayEpoch: number | null = null;
      const pulled = new Map<string, StoredItem>();
      for (let page = 0; page < 50; page += 1) {
        const result = await relay.getPasswordItems({ since: cursor });
        if (!result) break;
        if (typeof result.epoch === "number") relayEpoch = result.epoch;
        for (const row of result.items) pulled.set(row.id, { id: row.id, revision: row.revision, deleted: row.deleted, envelope: row.ciphertext });
        cursor = result.cursor ?? cursor;
        if (!result.truncated) break;
      }
      // A reset on another computer: this one's key is stale. Drop it, so the
      // next use asks the relay for the current one, and re-seal unsent writes.
      // Only a key this computer already holds: asking the relay would create a vault.
      const known = memoryKey ?? await cachedKeyEpoch(accountId);
      const keyIsStale = relayEpoch !== null && known !== null && relayEpoch > known.epoch;
      let pulledOldKey: { key: Buffer; epoch: number } | null = null;
      if (keyIsStale) {
        logger.info("passwords.key_epoch_advanced", { from: known.epoch, to: relayEpoch });
        // Kept to open unsent saves made under it (it is cached here: no network).
        pulledOldKey = await vaultKey(accountId);
        await dropKey();
      }
      const toPush = await withCache(async () => {
        const cache = await readCache(accountId);
        const byId = new Map(cache.items.map((item) => [item.id, item]));
        for (const [id, row] of pulled) byId.set(id, row);
        cache.items = [...byId.values()];
        cache.cursor = cursor;
        if (keyIsStale && cache.pending.length) resealStale(accountId, cache, await vaultKey(accountId), pulledOldKey);
        await writeCache(cache);
        return cache.pending.map((write) => ({ ...write }));
      });
      // Push, also outside the queue.
      if (toPush.length) {
        // In batches the relay accepts (a big import made offline is many);
        // a batch with no answer, or a newer key, stops the rest for now.
        const results: PasswordRelayWriteResult[] = [];
        for (let start = 0; start < toPush.length; start += RELAY_WRITE_BATCH) {
          const batch = await relay.putPasswordItems(
            toPush.slice(start, start + RELAY_WRITE_BATCH).map((write) => ({
              id: write.id,
              ...(write.deleted ? { deleted: true } : { ciphertext: write.envelope ?? "" }),
              ...(write.ifRevision ? { ifRevision: write.ifRevision } : { ifRevision: "absent" }),
            })),
            args.getDeviceId(),
          );
          if (!batch) break;
          results.push(...batch);
          if (batch.some((result) => result.status === "stale_key")) break;
        }
        if (results.length) {
          const answered = new Map(results.map((result) => [result.id, result]));
          const sent = new Map(toPush.map((write) => [write.id, write]));
          // The relay has a newer key than the one these were sealed with.
          const staleKey = results.some((result) => result.status === "stale_key");
          let refusedKey: { key: Buffer; epoch: number } | null = null;
          if (staleKey) {
            refusedKey = await vaultKey(accountId);
            await dropKey();
          }
          await withCache(async () => {
            const cache = await readCache(accountId);
            const recordAccepted = (accepted: { id: string; deleted: boolean; envelope: string | null }, revision: string | null): void => {
              const updated: StoredItem = { id: accepted.id, revision, deleted: accepted.deleted, envelope: accepted.envelope };
              const existing = cache.items.find((item) => item.id === accepted.id);
              if (existing) Object.assign(existing, updated);
              else cache.items.push(updated);
            };
            cache.pending = cache.pending.filter((write) => {
              const pushed = sent.get(write.id);
              if (!pushed) return true;
              const answer = answered.get(write.id);
              // A newer save of the same item, made while this push was out: keep
              // it, based on the revision the push just got, so it is not refused as stale.
              if (pushed.envelope !== write.envelope || pushed.deleted !== write.deleted) {
                if (answer?.status === "ok") {
                  recordAccepted(pushed, answer.revision);
                  write.ifRevision = answer.revision;
                }
                return true;
              }
              if (!answer || answer.status === "stale_key") return true;
              if (answer.status === "ok") {
                recordAccepted(write, answer.revision);
              } else if (answer.status === "stale") {
                // Another machine changed it first: theirs stands, this edit is dropped and said so.
                logger.warn("passwords.write_superseded", { itemId: write.id });
              } else {
                logger.warn("passwords.write_refused", { itemId: write.id });
              }
              return false;
            });
            // Kept writes are sealed again under the current key; the next sync sends them.
            if (staleKey && cache.pending.length) resealStale(accountId, cache, await vaultKey(accountId), refusedKey);
            await writeCache(cache);
          });
        }
      }
      openedFor = null;
      // Open what the sync brought in now, so a caller that cannot wait (a
      // webhook check) reads today's secrets, not the last open's.
      try {
        await openAll(accountId, await withCache(() => readCache(accountId)));
      } catch (error) {
        logger.warn("passwords.reopen_failed", { error: error instanceof Error ? error.name : "unknown" });
      }
    })().finally(() => {
      syncing = null;
    });
    return syncing;
  }

  async function writeItem(id: string, secret: PasswordItemSecret | null): Promise<void> {
    const accountId = await ensureOpened();
    const { key, epoch } = await vaultKey(accountId);
    const envelope = secret ? JSON.stringify(sealPasswordItem(key, { accountId, itemId: id, epoch }, secret)) : null;
    await withCache(async () => {
      const cache = await readCache(accountId);
      const known = cache.items.find((item) => item.id === id);
      cache.pending = cache.pending.filter((write) => write.id !== id);
      cache.pending.push({ id, envelope, deleted: secret === null, ifRevision: known?.revision ?? null });
      await writeCache(cache);
    });
    if (secret) opened.set(id, secret);
    else opened.delete(id);
    void sync().catch((error: unknown) => {
      logger.warn("passwords.sync_failed", { error: error instanceof Error ? error.name : "unknown" });
    });
  }

  async function purgeLocal(): Promise<void> {
    await withCache(async () => {
      purgeCount += 1;
      await dropKey();
      opened = new Map();
      openedFor = null;
      await store.delete(CACHE_KEY);
      await store.delete(ACTIVITY_KEY);
    });
    logger.info("passwords.purged", {});
  }

  const device = createDeviceSecretStore(store, logger);

  /** Is the account vault usable here right now (signed in, on)? Opens it when so. */
  async function accountVaultOpen(): Promise<boolean> {
    if (!args.getAccountUserId() || !isEnabled()) return false;
    await ensureOpened();
    return true;
  }

  /**
   * Open this computer's copy without waiting, for a process that has not
   * opened it yet (a CLI command, a fresh project runtime) and a caller that
   * cannot wait. Only with a key already cached on disk; it never asks the
   * relay, and skips anything sealed under a newer key (the next sync's job).
   */
  function openFromDiskSync(accountId: string): void {
    if (!keepKeyOnDisk || typeof store.getSync !== "function") return;
    try {
      const keyRaw = JSON.parse(store.getSync(KEY_CACHE_KEY) ?? "null") as { accountId?: string; dek?: string; epoch?: number } | null;
      if (keyRaw?.accountId !== accountId || typeof keyRaw.dek !== "string" || typeof keyRaw.epoch !== "number") return;
      const cache = JSON.parse(store.getSync(CACHE_KEY) ?? "null") as CacheShape | null;
      if (cache?.v !== 1 || cache.accountId !== accountId || !Array.isArray(cache.items)) return;
      const key = Buffer.from(keyRaw.dek, "base64");
      const epoch = keyRaw.epoch;
      const next = new Map<string, PasswordItemSecret>();
      for (const [id, raw] of liveEnvelopes(cache)) {
        const envelope = raw ? parsePasswordEnvelope(raw) : null;
        if (!envelope || envelope.epoch !== epoch) continue;
        try {
          next.set(id, openPasswordItem<PasswordItemSecret>(key, { accountId, itemId: id, epoch }, envelope));
        } catch {
          // Unopenable here; the async open logs it.
        }
      }
      memoryKey ??= { accountId, key, epoch };
      opened = next;
      openedFor = accountId;
    } catch (error) {
      logger.warn("passwords.open_sync_failed", { error: error instanceof Error ? error.name : "unknown" });
    }
  }
  /** The account's opened items without waiting (from disk when it can), or null while locked. */
  function openedNow(): ReadonlyMap<string, PasswordItemSecret> | null {
    const accountId = args.getAccountUserId();
    if (!accountId) return null;
    if (openedFor !== accountId) openFromDiskSync(accountId);
    return openedFor === accountId ? opened : null;
  }

  const projectSecrets = createProjectSecrets({
    logger,
    now,
    device,
    isEnabled,
    accountUserId: () => args.getAccountUserId(),
    openedNow,
    ensureOpened: async () => {
      const accountId = await ensureOpened();
      return { accountId, opened };
    },
    writeItem,
    vaultKey,
    cacheView: (accountId) => withCache(() => readCache(accountId)),
  });

  /** Whether Passwords is on here, and what this computer holds. Never a value. */
  async function status(): Promise<PasswordsStatus> {
    const accountId = args.getAccountUserId();
    const enabled = isEnabled();
    let itemCount: number | null = null;
    if (accountId && enabled) {
      try {
        await ensureOpened();
        itemCount = opened.size;
      } catch (error) {
        logger.warn("passwords.status_open_failed", { error: error instanceof Error ? error.message : String(error) });
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
  }

  /**
   * Add a login, or change one by id. A change keeps whatever it does not
   * name: its exact sites, username, title, notes and code.
   */
  async function saveLogin(input: { id?: string; title?: string; origins?: string[]; username?: string; password: string; notes?: string; totpUri?: string | null }): Promise<PasswordItemSummary> {
    await ensureOpened();
    const existingItem = input.id ? opened.get(input.id) : undefined;
    if (input.id && existingItem?.kind !== "login") throw new Error("That saved login no longer exists.");
    const existing = existingItem?.kind === "login" ? existingItem : undefined;
    const named = input.origins?.length ? input.origins : existing?.origins ?? [];
    const origins = [...new Set(named.map((origin) => normalizeLoginOrigin(origin)?.origin).filter((origin): origin is string => Boolean(origin)))];
    if (origins.length === 0) throw new Error("A saved login needs an https site.");
    if (!input.password) throw new Error("A saved login needs a password.");
    const id = input.id ?? newPasswordItemId();
    const stamp = now().toISOString();
    const secret: PasswordLoginSecret = {
      kind: "login",
      title: input.title?.trim() || existing?.title || normalizeLoginOrigin(origins[0]!)?.site || "Login",
      origins,
      username: input.username ?? existing?.username ?? "",
      password: input.password,
      notes: input.notes ?? existing?.notes ?? "",
      // A bare key a site shows ("can't scan?") is kept as a standard URI; a
      // value that is neither is refused rather than saved broken.
      totpUri: input.totpUri !== undefined ? totpOrThrow(input.totpUri, input.title?.trim() || existing?.title || "") : existing?.totpUri ?? null,
      createdAt: existing?.createdAt ?? stamp,
      updatedAt: stamp,
    };
    await writeItem(id, secret);
    logger.info("passwords.item_saved", { itemId: id, kind: "login" });
    return summarize(id, secret);
  }

  return {
    /**
     * Note one use of a saved item (a fill, a secret given to a command). Kept
     * on this computer only, sealed in its encrypted store; never a value.
     */
    async recordUse(input: Omit<PasswordUseRecord, "at" | "machineName"> & { machineName?: string | null }): Promise<void> {
      const accountId = args.getAccountUserId();
      if (!accountId) return;
      const record: PasswordUseRecord = {
        itemId: input.itemId,
        kind: input.kind,
        target: input.target.slice(0, 300),
        by: input.by,
        chatSessionId: input.chatSessionId ?? null,
        machineName: input.machineName ?? os.hostname(),
        at: now().toISOString(),
      };
      await withCache(async () => {
        let list: PasswordUseRecord[] = [];
        try {
          const raw = await store.get(ACTIVITY_KEY);
          const parsed = raw ? JSON.parse(raw) as { accountId?: string; uses?: PasswordUseRecord[] } : null;
          if (parsed?.accountId === accountId && Array.isArray(parsed.uses)) list = parsed.uses;
        } catch {
          logger.warn("passwords.activity_unreadable", {});
        }
        list.unshift(record);
        await store.set(ACTIVITY_KEY, JSON.stringify({ accountId, uses: list.slice(0, ACTIVITY_LIMIT) }));
      });
    },

    /** This computer's recorded uses, newest first. */
    async activity(): Promise<PasswordUseRecord[]> {
      const accountId = args.getAccountUserId();
      if (!accountId) return [];
      try {
        const raw = await store.get(ACTIVITY_KEY);
        const parsed = raw ? JSON.parse(raw) as { accountId?: string; uses?: PasswordUseRecord[] } : null;
        return parsed?.accountId === accountId && Array.isArray(parsed.uses) ? parsed.uses : [];
      } catch {
        logger.warn("passwords.activity_unreadable", {});
        return [];
      }
    },

    status,

    /** Who this computer is signed in as, or null. */
    accountUserId: (): string | null => args.getAccountUserId(),

    /**
     * Turn Passwords on or off for this computer. Off forgets the key and every
     * cached item here (the account's copy stays). The first time any computer
     * turns it on, the ADE Cloud switch starts on.
     */
    async setEnabled(enabled: boolean): Promise<PasswordsStatus> {
      if (isCloud) throw new PasswordsUnavailableError("On an ADE Cloud computer, Passwords follows the ADE Cloud switch in Settings › Passwords & Secrets.");
      // Before turning off, send what is still waiting (a save made offline),
      // while the switch still allows it. Offline, the purge still runs: off means off.
      if (!enabled && isEnabled() && args.getAccountUserId()) {
        await sync().catch((error: unknown) => {
          logger.warn("passwords.sync_failed", { error: error instanceof Error ? error.name : "unknown" });
        });
      }
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({ enabled }), { mode: 0o600 });
      enabledHere = enabled;
      if (enabled) {
        if (args.getCloudEnabled?.() === null) args.setCloudEnabled?.(true);
        // Bring the account's items back before answering, so the page that
        // turned it on lists them.
        await sync().catch((error: unknown) => {
          logger.warn("passwords.sync_failed", { error: error instanceof Error ? error.name : "unknown" });
        });
      } else {
        await purgeLocal();
      }
      logger.info("passwords.enabled_changed", { enabled });
      return await status();
    },

    /** The account-wide switch for ADE Cloud computers. */
    async setCloudEnabled(enabled: boolean): Promise<PasswordsStatus> {
      if (!args.setCloudEnabled) throw new PasswordsUnavailableError("Passwords needs ADE's account service; try again when online.");
      args.setCloudEnabled(enabled);
      if (isCloud && !enabled) await purgeLocal();
      logger.info("passwords.cloud_enabled_changed", { enabled });
      return await status();
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
      if (!released) throw new PasswordsUnavailableError("Passwords & Secrets is unavailable right now; try again shortly.");
      await purgeLocal();
      memoryKey = { accountId, key: Buffer.from(released.dek, "base64"), epoch: released.epoch };
      if (keepKeyOnDisk) await store.set(KEY_CACHE_KEY, JSON.stringify({ accountId, dek: released.dek, epoch: released.epoch }));
      logger.info("passwords.reset", { epoch: released.epoch });
      await sync();
      return await status();
    },

    /** Everything an agent or a list may see. Never a value. */
    async listSummaries(): Promise<PasswordItemSummary[]> {
      const own = isEnabled() ? (await device.read()).map((secret) => summarize(secret.id, secret, true)) : [];
      // A vault that can't be opened now still lists this computer's own secrets.
      const accountOpen = await accountVaultOpen().catch((error: unknown) => {
        logger.warn("passwords.account_open_failed", { error: error instanceof Error ? error.name : "unknown" });
        return false;
      });
      const account = accountOpen ? [...opened.entries()].map(([id, secret]) => summarize(id, secret)) : [];
      return [...account, ...own].sort((a, b) => a.title.localeCompare(b.title));
    },

    /** The site and exact origin Passwords would fill a page on, or null (not https, not a site). */
    siteForPage(pageUrl: string): { site: string; origin: string } | null {
      const normalized = normalizeLoginOrigin(pageUrl);
      return normalized ? { site: normalized.site, origin: normalized.origin } : null;
    },

    /**
     * Saved logins for the site a page is on, best match first. Summaries only.
     * `exactOrigin`: only logins saved for this exact address (scheme, host,
     * port). An agent's fill asks for that, so a login is never typed into
     * another subdomain of its site; the person's key button matches the site.
     */
    async loginsForPage(pageUrl: string, options: { exactOrigin?: boolean } = {}): Promise<PasswordItemSummary[]> {
      await ensureOpened();
      const logins = [...opened.entries()]
        .filter((entry): entry is [string, PasswordLoginSecret] => entry[1].kind === "login")
        .filter(([, secret]) => !options.exactOrigin || savedForExactOrigin(secret, pageUrl))
        .map(([id, secret]) => ({ id, origins: secret.origins, secret }));
      return matchLoginsForOrigin(logins, pageUrl).map((entry) => summarize(entry.id, entry.secret));
    },

    /**
     * The values to fill one login into a page. Person-only and desktop-main
     * only: the page URL is the tab's own, and the item must belong to its
     * site. Returns null when it does not.
     */
    async resolveForFill(input: { itemId: string; pageUrl: string; exactOrigin?: boolean }): Promise<{ username: string; password: string; code: string | null } | null> {
      await ensureOpened();
      const secret = opened.get(input.itemId);
      if (!secret || secret.kind !== "login") return null;
      if (input.exactOrigin && !savedForExactOrigin(secret, input.pageUrl)) return null;
      const matches = matchLoginsForOrigin([{ origins: secret.origins }], input.pageUrl);
      if (matches.length === 0) return null;
      // The current code, never the authenticator key itself.
      const totp = secret.totpUri ? parseTotp(secret.totpUri) : null;
      return { username: secret.username, password: secret.password, code: totp ? totpCode(totp, now().getTime()).code : null };
    },

    /**
     * A saved login's current authenticator code. Agents may read codes (they
     * last seconds), never the key. By item, or by the site's best login.
     */
    async currentCode(input: { itemId?: string | null; site?: string | null; username?: string | null }): Promise<{ itemId: string; site: string; username: string | null; code: string; secondsLeft: number } | null> {
      await ensureOpened();
      let entry: [string, PasswordLoginSecret] | null = null;
      if (input.itemId) {
        const secret = opened.get(input.itemId);
        if (secret?.kind === "login") entry = [input.itemId, secret];
      } else if (input.site) {
        // A site name ("github.com", "localhost") matches every login for that
        // site, whatever its exact address (scheme, port, subdomain).
        const raw = input.site.trim();
        const wanted = normalizeLoginOrigin(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)?.site ?? raw.toLowerCase();
        const match = [...opened.entries()]
          .filter((candidate): candidate is [string, PasswordLoginSecret] => candidate[1].kind === "login" && Boolean(candidate[1].totpUri))
          .find(([id, secret]) => summarize(id, secret).sites.includes(wanted) && (!input.username || secret.username === input.username));
        if (match) entry = match;
      }
      if (!entry?.[1].totpUri) return null;
      const totp = parseTotp(entry[1].totpUri);
      if (!totp) return null;
      const { code, secondsLeft } = totpCode(totp, now().getTime());
      return { itemId: entry[0], site: summarize(entry[0], entry[1]).sites[0] ?? entry[1].title, username: entry[1].username || null, code, secondsLeft };
    },

    ...projectSecrets,

    /**
     * One saved value for the person's own eyes (Settings' Reveal / Copy, after
     * Touch ID in desktop main). Person-only and this-desktop-only in the
     * action layer. Null when the item or field is not there.
     */
    async revealValue(input: { itemId: string; field: "password" | "username" | "value" | "notes" }): Promise<string | null> {
      if (isDeviceId(input.itemId)) {
        if (!isEnabled()) return null;
        const secret = (await device.read()).find((item) => item.id === input.itemId);
        if (!secret) return null;
        return input.field === "value" ? secret.value : input.field === "notes" ? secret.notes : null;
      }
      await ensureOpened();
      const secret = opened.get(input.itemId);
      if (!secret) return null;
      if (secret.kind === "login") {
        if (input.field === "password") return secret.password;
        if (input.field === "username") return secret.username;
        if (input.field === "notes") return secret.notes;
        return null;
      }
      // A passkey's private key is never shown, only used by ADE's browser.
      if (secret.kind === "passkey") return null;
      if (input.field === "value") return secret.value;
      if (input.field === "notes") return secret.notes;
      return null;
    },

    /**
     * The passkeys for one relying party, private keys included, for desktop
     * main to sign a WebAuthn request with. Person-only and this-desktop-only
     * in the action layer, like `resolveForFill`.
     */
    async passkeysForRp(rpId: string): Promise<Array<PasswordPasskeySecret & { id: string }>> {
      await ensureOpened();
      const wanted = rpId.trim().toLowerCase();
      return [...opened.entries()]
        .filter((entry): entry is [string, PasswordPasskeySecret] => entry[1].kind === "passkey" && entry[1].rpId === wanted)
        .map(([id, secret]) => ({ ...secret, id }));
    },

    /** Save a passkey ADE's browser just made (desktop main, after the person approved it). */
    async savePasskey(input: Omit<PasswordPasskeySecret, "kind" | "createdAt" | "updatedAt"> & { createdAt?: string }): Promise<PasswordItemSummary> {
      if (!input.rpId || !input.credentialId || !input.privateKeyPkcs8) throw new Error("A passkey needs its site, id and key.");
      const stamp = now().toISOString();
      const secret: PasswordPasskeySecret = {
        kind: "passkey",
        rpId: input.rpId.toLowerCase(),
        credentialId: input.credentialId,
        userHandle: input.userHandle,
        userName: input.userName,
        userDisplayName: input.userDisplayName,
        privateKeyPkcs8: input.privateKeyPkcs8,
        signCount: input.signCount,
        createdAt: input.createdAt ?? stamp,
        updatedAt: stamp,
      };
      const id = newPasswordItemId();
      await writeItem(id, secret);
      logger.info("passwords.item_saved", { itemId: id, kind: "passkey" });
      return summarize(id, secret);
    },

    saveLogin,

    async remove(id: string): Promise<boolean> {
      if (isDeviceId(id)) {
        let removed = false;
        await device.update((items) => {
          removed = items.some((item) => item.id === id);
          return removed ? items.filter((item) => item.id !== id) : undefined;
        });
        if (removed) logger.info("passwords.item_removed", { itemId: id, deviceOnly: true });
        return removed;
      }
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
        await saveLogin({
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
      void sync().catch((error: unknown) => {
        logger.warn("passwords.sync_failed", { error: error instanceof Error ? error.name : "unknown" });
      });
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
export function passwordsCloudSwitch(settings: {
  get(scope: string, key: string): unknown;
  set(scope: string, key: string, value: unknown): boolean;
  health?(): { lastSyncedAt: string | null };
} | null): {
  getCloudEnabled: () => boolean | null;
  setCloudEnabled: (enabled: boolean) => void;
  cloudSwitchSynced: () => boolean;
} {
  return {
    getCloudEnabled: () => {
      const value = settings?.get("all", PASSWORDS_CLOUD_SETTING_KEY);
      return typeof value === "boolean" ? value : null;
    },
    setCloudEnabled: (enabled) => {
      settings?.set("all", PASSWORDS_CLOUD_SETTING_KEY, enabled);
    },
    cloudSwitchSynced: () => Boolean(settings?.health?.().lastSyncedAt),
  };
}

export function getSharedPasswordService(adeDir: string, create: () => PasswordService): PasswordService {
  return registry.get(adeDir, create);
}
