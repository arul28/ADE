import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type {
  PushDeviceRegistration,
  PushNotificationPrefs,
} from "../../../../desktop/src/shared/types/push";
import { safeJsonParse, writeTextAtomic } from "../../../../desktop/src/main/services/shared/utils";

/** A device registration plus the machine-side metadata we persist for it. */
export type StoredPushDevice = PushDeviceRegistration & {
  prefs: PushNotificationPrefs;
  updatedAt: string;
};

export type StoredAttentionAcknowledgment = {
  itemId: string;
  accountOwnerId: string | null;
  sourceRevision: number;
  seenAt: string;
  dismissedAt: string | null;
  updatedAt: string;
  pendingRelaySync: boolean;
};

type PushRegistrationFile = {
  version: 1;
  /** Unguessable machine key claimed on the relay (32 hex chars). */
  machineKey: string;
  /** HMAC signing secret for every non-claim relay call (48 hex chars). */
  machineSecret: string;
  /** Whether `POST /machines/:key/claim` has succeeded at least once. */
  claimed: boolean;
  /** Master publisher switch for this machine (default on). */
  enabled: boolean;
  devices: Record<string, StoredPushDevice>;
  /** Durable machine-fallback inbox state, revision-fenced per Attention item. */
  attentionAcknowledgments: Record<string, StoredAttentionAcknowledgment>;
  lastPublishAt: string | null;
  lastPublishError: string | null;
  lastRelayContactAt: string | null;
};

export type PushStoreStatusSnapshot = {
  claimed: boolean;
  enabled: boolean;
  registeredDeviceCount: number;
  lastPublishAt: string | null;
  lastPublishError: string | null;
  lastRelayContactAt: string | null;
};

type PushRegistrationStoreArgs = {
  filePath: string;
};

const MACHINE_KEY_BYTES = 16; // 32 hex chars — matches the relay's 32-64 hex key pattern.
const MACHINE_SECRET_BYTES = 24; // 48 hex chars — inside the relay's 32-128 char secret bounds.
const ATTENTION_ACK_MAX = 512;

function attentionAcknowledgmentKey(
  accountOwnerId: string | null,
  itemId: string,
): string {
  return `${accountOwnerId ?? ""}\u0000${itemId}`;
}

export function defaultPushPrefs(): PushNotificationPrefs {
  return {
    enabled: true,
    liveActivitiesEnabled: true,
    mutedSessionIds: [],
    quietHours: null,
  };
}

function normalizePrefs(prefs: PushNotificationPrefs | null | undefined): PushNotificationPrefs {
  const base = defaultPushPrefs();
  if (!prefs) return base;
  return {
    enabled: typeof prefs.enabled === "boolean" ? prefs.enabled : base.enabled,
    liveActivitiesEnabled:
      typeof prefs.liveActivitiesEnabled === "boolean" ? prefs.liveActivitiesEnabled : base.liveActivitiesEnabled,
    mutedSessionIds: Array.isArray(prefs.mutedSessionIds)
      ? prefs.mutedSessionIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      : [],
    quietHours: prefs.quietHours ?? null,
  };
}

function createEmptyFile(): PushRegistrationFile {
  return {
    version: 1,
    machineKey: randomBytes(MACHINE_KEY_BYTES).toString("hex"),
    machineSecret: randomBytes(MACHINE_SECRET_BYTES).toString("hex"),
    claimed: false,
    enabled: true,
    devices: {},
    attentionAcknowledgments: {},
    lastPublishAt: null,
    lastPublishError: null,
    lastRelayContactAt: null,
  };
}

/**
 * Machine-local push identity + device roster, stored next to the sync pairing
 * files under `~/.ade/secrets/`. The machineKey/machineSecret are minted once on
 * first access and never rotate — the relay's first-writer-wins claim binds them.
 */
export function createPushRegistrationStore(args: PushRegistrationStoreArgs) {
  fs.mkdirSync(path.dirname(args.filePath), { recursive: true });

  let cache: PushRegistrationFile | null = null;

  const isValid = (value: PushRegistrationFile | null): value is PushRegistrationFile => {
    return Boolean(
      value
      && typeof value.machineKey === "string"
      && /^[0-9a-f]{32,64}$/i.test(value.machineKey)
      && typeof value.machineSecret === "string"
      && value.machineSecret.length >= 32
      && value.devices
      && typeof value.devices === "object",
    );
  };

  const write = (value: PushRegistrationFile): void => {
    // 0o600 at temp-file creation so the secrets never exist world-readable.
    writeTextAtomic(args.filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(args.filePath, 0o600);
    } catch {
      // ignore chmod failures on platforms that don't support it
    }
    cache = value;
  };

  const readValidFile = (): PushRegistrationFile | null => {
    if (!fs.existsSync(args.filePath)) return null;
    const parsed = safeJsonParse<PushRegistrationFile | null>(fs.readFileSync(args.filePath, "utf8"), null);
    if (!isValid(parsed)) return null;
    // Backfill defaults for fields added after the file was first written.
    return {
      version: 1,
      machineKey: parsed.machineKey,
      machineSecret: parsed.machineSecret,
      claimed: parsed.claimed === true,
      enabled: parsed.enabled !== false,
      devices: Object.fromEntries(
        Object.entries(parsed.devices)
          // A hand-edited or corrupted file can hold null/garbage entries; a
          // bad device row must not crash every store load.
          .filter((entry): entry is [string, StoredPushDevice] =>
            Boolean(entry[1] && typeof entry[1] === "object" && typeof (entry[1] as StoredPushDevice).bundleId === "string"))
          .map(([deviceId, device]) => [
            deviceId,
            { ...device, prefs: normalizePrefs(device.prefs) },
          ]),
      ),
      attentionAcknowledgments: Object.fromEntries(
        Object.entries(parsed.attentionAcknowledgments ?? {})
          .filter((entry): entry is [string, StoredAttentionAcknowledgment] => {
            const acknowledgment = entry[1];
            return Boolean(
              acknowledgment
              && typeof acknowledgment === "object"
              && typeof acknowledgment.itemId === "string"
              && acknowledgment.itemId.trim().length > 0
              && (
                acknowledgment.accountOwnerId === undefined
                || acknowledgment.accountOwnerId === null
                || typeof acknowledgment.accountOwnerId === "string"
              )
              && Number.isFinite(acknowledgment.sourceRevision)
              && typeof acknowledgment.seenAt === "string"
              && (
                acknowledgment.dismissedAt === null
                || typeof acknowledgment.dismissedAt === "string"
              )
              && typeof acknowledgment.updatedAt === "string",
            );
          })
          .map(([, acknowledgment]) => {
            const accountOwnerId = acknowledgment.accountOwnerId?.trim() || null;
            return [
              attentionAcknowledgmentKey(accountOwnerId, acknowledgment.itemId),
              {
              ...acknowledgment,
              accountOwnerId,
              pendingRelaySync: acknowledgment.pendingRelaySync !== false,
              },
            ];
          }),
      ),
      lastPublishAt: parsed.lastPublishAt ?? null,
      lastPublishError: parsed.lastPublishError ?? null,
      lastRelayContactAt: parsed.lastRelayContactAt ?? null,
    };
  };

  const load = (): PushRegistrationFile => {
    if (cache) return cache;
    const existing = readValidFile();
    if (existing) {
      cache = existing;
      return existing;
    }
    // Mint the identity once, exclusively (O_EXCL). If two `ade` processes race
    // on first run the loser gets EEXIST and adopts the winner's identity rather
    // than overwriting the phone-pairing crypto key with a divergent one.
    const created = createEmptyFile();
    try {
      fs.writeFileSync(args.filePath, `${JSON.stringify(created, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      cache = created;
      return created;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const winner = readValidFile();
        if (winner) {
          cache = winner;
          return winner;
        }
      }
      // No exclusive create and nothing valid to adopt — best-effort overwrite.
      write(created);
      return created;
    }
  };

  return {
    getOrCreateIdentity(): { machineKey: string; machineSecret: string } {
      const file = load();
      return { machineKey: file.machineKey, machineSecret: file.machineSecret };
    },

    isClaimed(): boolean {
      return load().claimed;
    },

    markClaimed(): void {
      const file = load();
      if (file.claimed) return;
      write({ ...file, claimed: true });
    },

    upsertDevice(registration: PushDeviceRegistration): StoredPushDevice {
      if (registration.pushToStartToken && registration.clearPushToStartToken) {
        throw new Error("Cannot set and clear pushToStartToken together.");
      }
      const file = load();
      const existing = file.devices[registration.deviceId];
      const stored: StoredPushDevice = {
        deviceId: registration.deviceId,
        // Preserve a previously reported token when the phone only re-registers
        // the other one (matches the relay's coalesce-on-conflict semantics).
        apnsToken: registration.apnsToken ?? existing?.apnsToken ?? null,
        pushToStartToken: registration.clearPushToStartToken
          ? null
          : registration.pushToStartToken ?? existing?.pushToStartToken ?? null,
        bundleId: registration.bundleId,
        apsEnvironment: registration.apsEnvironment,
        platform: registration.platform ?? existing?.platform ?? null,
        deviceName: registration.deviceName ?? existing?.deviceName ?? null,
        prefs: normalizePrefs(registration.prefs ?? existing?.prefs),
        updatedAt: new Date().toISOString(),
      };
      write({ ...file, devices: { ...file.devices, [registration.deviceId]: stored } });
      return stored;
    },

    removeDevice(deviceId: string): void {
      const file = load();
      if (!file.devices[deviceId]) return;
      const devices = { ...file.devices };
      delete devices[deviceId];
      write({ ...file, devices });
    },

    listDevices(): StoredPushDevice[] {
      return Object.values(load().devices);
    },

    getDevice(deviceId: string): StoredPushDevice | null {
      return load().devices[deviceId] ?? null;
    },

    setPrefs(deviceId: string, prefs: PushNotificationPrefs): StoredPushDevice | null {
      const file = load();
      const existing = file.devices[deviceId];
      if (!existing) return null;
      const stored: StoredPushDevice = {
        ...existing,
        prefs: normalizePrefs(prefs),
        updatedAt: new Date().toISOString(),
      };
      write({ ...file, devices: { ...file.devices, [deviceId]: stored } });
      return stored;
    },

    setEnabled(enabled: boolean): void {
      const file = load();
      if (file.enabled === enabled) return;
      write({ ...file, enabled });
    },

    recordAttentionAcknowledgments(args: {
      items: Array<{ id: string; revision: number }>;
      accountOwnerId: string | null;
      seenAt: string;
      dismissedAt?: string | null;
      updatedAt: string;
    }): void {
      const file = load();
      const next = { ...file.attentionAcknowledgments };
      for (const item of args.items) {
        const itemId = item.id.trim();
        if (!itemId || !Number.isFinite(item.revision)) continue;
        const key = attentionAcknowledgmentKey(args.accountOwnerId, itemId);
        const existing = next[key];
        next[key] = {
          itemId,
          accountOwnerId: args.accountOwnerId,
          sourceRevision: Math.max(item.revision, existing?.sourceRevision ?? 0),
          seenAt: args.seenAt,
          dismissedAt:
            typeof args.dismissedAt === "string"
              ? args.dismissedAt
              : existing?.dismissedAt ?? null,
          updatedAt: args.updatedAt,
          pendingRelaySync: true,
        };
      }
      const bounded = Object.fromEntries(
        Object.entries(next)
          .sort((left, right) =>
            Date.parse(right[1].updatedAt) - Date.parse(left[1].updatedAt))
          .slice(0, ATTENTION_ACK_MAX),
      );
      write({ ...file, attentionAcknowledgments: bounded });
    },

    getAttentionAcknowledgment(
      itemId: string,
      accountOwnerId: string | null,
    ): StoredAttentionAcknowledgment | null {
      return load().attentionAcknowledgments[
        attentionAcknowledgmentKey(accountOwnerId, itemId)
      ] ?? null;
    },

    listPendingAttentionAcknowledgments(): StoredAttentionAcknowledgment[] {
      return Object.values(load().attentionAcknowledgments)
        .filter((acknowledgment) => acknowledgment.pendingRelaySync)
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    },

    markAttentionAcknowledgmentsSynced(
      acknowledgments: Array<{
        itemId: string;
        accountOwnerId: string | null;
        updatedAt: string;
      }>,
    ): void {
      const file = load();
      let changed = false;
      const next = { ...file.attentionAcknowledgments };
      for (const acknowledgment of acknowledgments) {
        const key = attentionAcknowledgmentKey(
          acknowledgment.accountOwnerId,
          acknowledgment.itemId,
        );
        const existing = next[key];
        if (
          !existing?.pendingRelaySync
          || existing.updatedAt !== acknowledgment.updatedAt
        ) continue;
        next[key] = { ...existing, pendingRelaySync: false };
        changed = true;
      }
      if (changed) write({ ...file, attentionAcknowledgments: next });
    },

    hasRegisteredDevices(): boolean {
      // A device only counts once it has at least one deliverable token.
      return Object.values(load().devices).some(
        (device) => Boolean(device.apnsToken) || Boolean(device.pushToStartToken),
      );
    },

    recordPublishResult(result: { at: string; error?: string | null }): void {
      const file = load();
      write({
        ...file,
        lastPublishAt: result.at,
        lastPublishError: result.error ?? null,
        lastRelayContactAt: result.at,
      });
    },

    recordRelayContact(at: string): void {
      const file = load();
      write({ ...file, lastRelayContactAt: at });
    },

    getStatusSnapshot(): PushStoreStatusSnapshot {
      const file = load();
      return {
        claimed: file.claimed,
        enabled: file.enabled,
        registeredDeviceCount: Object.keys(file.devices).length,
        lastPublishAt: file.lastPublishAt,
        lastPublishError: file.lastPublishError,
        lastRelayContactAt: file.lastRelayContactAt,
      };
    },
  };
}

export type PushRegistrationStore = ReturnType<typeof createPushRegistrationStore>;
