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

export type StoredRemoteAttentionAcknowledgment = {
  itemId: string;
  accountOwnerId: string | null;
  sourceRevision: number;
  seenAt: string | null;
  dismissedAt: string | null;
  updatedAt: string;
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
  /** Relay-owned acknowledgments flowing back down with protocol-2 publishes. */
  remoteAttentionAcknowledgments: Record<string, StoredRemoteAttentionAcknowledgment>;
  /** Last detected relay protocol. `1` means the response omitted protocol. */
  activityProtocol: number | null;
  /** Durable monotonic reconcile epoch; incremented before every new sweep. */
  activityRosterEpoch: number;
  /** Account owner whose published source-revision clamps are stored below. */
  lastPublishedRevisionAccountOwnerId: string | null;
  /** Durable per-item revision floor so live-to-roster fallback survives restart. */
  lastPublishedRevisionById: Record<string, number>;
  /**
   * Machine keys this machine published under before the current one. The
   * relay's epoch sweep is machine-scoped, so a rotated key's rows become
   * unreachable garbage that permanently duplicates every session in the
   * account feed. Recording the superseded key is what lets a sweep reach them.
   * Bounded; the oldest entries are dropped first.
   */
  previousMachineKeys: string[];
  /**
   * Set when the registration file existed but could not be used as it stood.
   * Durable so identity loss stays loud on every later status read, not just in
   * the log line of whichever process happened to notice.
   */
  identityRecoveryError: string | null;
  /**
   * When the account owner removed this machine. The relay answers `403
   * machine_revoked` from that moment on, so this is a TERMINAL state, not a
   * transient error: publishing must stop until the user deliberately re-pairs.
   * Durable so a brain restart doesn't resume hammering a revoked endpoint.
   */
  machineRevokedAt: string | null;
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
  /** Non-null when this machine's push identity was lost or repaired. */
  identityRecoveryError: string | null;
  /** Superseded machine keys whose relay rows still need sweeping. */
  previousMachineKeys: string[];
  /** Set once the account owner removed this machine; terminal until re-paired. */
  machineRevokedAt: string | null;
};

type PushRegistrationStoreArgs = {
  filePath: string;
  /**
   * Optional so existing callers keep working. Without it, a lost machine
   * identity is still durable in the file and the status snapshot — it just
   * isn't logged.
   */
  logger?: {
    warn: (message: string, meta?: Record<string, unknown>) => void;
    error: (message: string, meta?: Record<string, unknown>) => void;
  } | null;
};

const MACHINE_KEY_BYTES = 16; // 32 hex chars — matches the relay's 32-64 hex key pattern.
const MACHINE_SECRET_BYTES = 24; // 48 hex chars — inside the relay's 32-128 char secret bounds.
const ATTENTION_ACK_MAX = 512;
const MACHINE_KEY_PATTERN = /^[0-9a-f]{32,64}$/i;
/** Enough history for repeated corruption without unbounded growth. */
const PREVIOUS_MACHINE_KEY_MAX = 8;

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
    remoteAttentionAcknowledgments: {},
    activityProtocol: null,
    activityRosterEpoch: 0,
    lastPublishedRevisionAccountOwnerId: null,
    lastPublishedRevisionById: {},
    previousMachineKeys: [],
    identityRecoveryError: null,
    machineRevokedAt: null,
    lastPublishAt: null,
    lastPublishError: null,
    lastRelayContactAt: null,
  };
}

/** Hex machine keys found anywhere in a damaged file, most-likely first. */
function salvageMachineKeys(parsed: unknown): string[] {
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  if (!record) return [];
  const candidates: unknown[] = [
    record.machineKey,
    ...(Array.isArray(record.previousMachineKeys) ? record.previousMachineKeys : []),
  ];
  const keys: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (!MACHINE_KEY_PATTERN.test(trimmed)) continue;
    if (!keys.includes(trimmed)) keys.push(trimmed);
  }
  return keys;
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
      && MACHINE_KEY_PATTERN.test(value.machineKey)
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

  /**
   * Raw read result. `present` distinguishes "no identity yet" (mint freely)
   * from "identity exists but is damaged" (never silently replace it).
   */
  type RawRead = {
    present: boolean;
    parsed: unknown;
    readError: string | null;
  };

  const readRaw = (): RawRead => {
    if (!fs.existsSync(args.filePath)) {
      return { present: false, parsed: null, readError: null };
    }
    try {
      const text = fs.readFileSync(args.filePath, "utf8");
      return {
        present: true,
        parsed: safeJsonParse<unknown>(text, null),
        readError: null,
      };
    } catch (error) {
      // Unreadable is NOT absent: a permissions or I/O fault must not be
      // answered by minting a replacement identity over the top of it.
      return {
        present: true,
        parsed: null,
        readError: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const readValidFile = (): PushRegistrationFile | null => {
    const raw = readRaw();
    if (!raw.present) return null;
    const parsed = raw.parsed as PushRegistrationFile | null;
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
      remoteAttentionAcknowledgments: Object.fromEntries(
        Object.entries(parsed.remoteAttentionAcknowledgments ?? {})
          .filter((entry): entry is [string, StoredRemoteAttentionAcknowledgment] => {
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
              && (acknowledgment.seenAt === null || typeof acknowledgment.seenAt === "string")
              && (acknowledgment.dismissedAt === null || typeof acknowledgment.dismissedAt === "string")
              && typeof acknowledgment.updatedAt === "string",
            );
          })
          .map(([, acknowledgment]) => {
            const accountOwnerId = acknowledgment.accountOwnerId?.trim() || null;
            return [
              attentionAcknowledgmentKey(accountOwnerId, acknowledgment.itemId),
              { ...acknowledgment, accountOwnerId },
            ];
          }),
      ),
      activityProtocol: Number.isSafeInteger(parsed.activityProtocol)
        && Number(parsed.activityProtocol) > 0
        ? Number(parsed.activityProtocol)
        : null,
      activityRosterEpoch: Number.isSafeInteger(parsed.activityRosterEpoch)
        && Number(parsed.activityRosterEpoch) >= 0
        ? Number(parsed.activityRosterEpoch)
        : 0,
      lastPublishedRevisionAccountOwnerId:
        typeof parsed.lastPublishedRevisionAccountOwnerId === "string"
          ? parsed.lastPublishedRevisionAccountOwnerId.trim() || null
          : null,
      lastPublishedRevisionById: Object.fromEntries(
        Object.entries(parsed.lastPublishedRevisionById ?? {})
          .filter(([itemId, revision]) =>
            itemId.trim().length > 0
            && Number.isSafeInteger(revision)
            && Number(revision) >= 0)
          .map(([itemId, revision]) => [itemId, Number(revision)]),
      ),
      previousMachineKeys: (Array.isArray(parsed.previousMachineKeys) ? parsed.previousMachineKeys : [])
        .filter((key): key is string => typeof key === "string" && MACHINE_KEY_PATTERN.test(key.trim()))
        .map((key) => key.trim())
        .filter((key, index, all) => key !== parsed.machineKey && all.indexOf(key) === index)
        .slice(-PREVIOUS_MACHINE_KEY_MAX),
      identityRecoveryError: typeof parsed.identityRecoveryError === "string"
        ? parsed.identityRecoveryError.trim() || null
        : null,
      machineRevokedAt: typeof parsed.machineRevokedAt === "string"
        && !Number.isNaN(Date.parse(parsed.machineRevokedAt))
        ? parsed.machineRevokedAt
        : null,
      lastPublishAt: parsed.lastPublishAt ?? null,
      lastPublishError: parsed.lastPublishError ?? null,
      lastRelayContactAt: parsed.lastRelayContactAt ?? null,
    };
  };

  /**
   * Recover an identity from a file that exists but failed validation, rather
   * than minting a fresh machineKey behind the user's back. A new key is
   * PERMANENT duplication: the relay's epoch sweep is machine-scoped, so every
   * row the old key published becomes unreachable and the account feed carries
   * two of everything forever.
   *
   * Two outcomes, in order of preference:
   *  1. Repair — the file still holds a well-formed machineKey/machineSecret
   *     pair (typically a schema/device-map problem). Keep the identity and
   *     rebuild the rest of the file around it. Nothing is orphaned.
   *  2. Re-mint with provenance — nothing usable survives. Quarantine the
   *     damaged file so it is never silently clobbered, carry every salvageable
   *     old key forward in `previousMachineKeys` so a relay sweep can still
   *     reach those rows, and record the error durably.
   */
  const recoverDamagedFile = (raw: RawRead): PushRegistrationFile => {
    const detail = raw.readError ?? "registration file failed validation";
    const parsedRecord = raw.parsed && typeof raw.parsed === "object"
      ? raw.parsed as Record<string, unknown>
      : null;
    const machineKey = typeof parsedRecord?.machineKey === "string"
      && MACHINE_KEY_PATTERN.test(parsedRecord.machineKey.trim())
      ? parsedRecord.machineKey.trim()
      : null;
    const machineSecret = typeof parsedRecord?.machineSecret === "string"
      && parsedRecord.machineSecret.trim().length >= 32
      ? parsedRecord.machineSecret.trim()
      : null;
    const salvagedKeys = salvageMachineKeys(raw.parsed);

    if (machineKey && machineSecret) {
      args.logger?.warn?.("push.registration_file_repaired", {
        filePath: args.filePath,
        detail,
      });
      const repaired: PushRegistrationFile = {
        ...createEmptyFile(),
        machineKey,
        machineSecret,
        previousMachineKeys: salvagedKeys
          .filter((key) => key !== machineKey)
          .slice(-PREVIOUS_MACHINE_KEY_MAX),
        identityRecoveryError: `Push registration file was repaired: ${detail}`,
      };
      write(repaired);
      return repaired;
    }

    // Quarantine before overwriting: the damaged bytes are the only remaining
    // evidence of what this machine used to be, and a support path (or a later
    // salvage) needs them.
    let quarantinePath: string | null = null;
    try {
      quarantinePath = `${args.filePath}.corrupt-${Date.now()}`;
      fs.renameSync(args.filePath, quarantinePath);
    } catch {
      quarantinePath = null;
    }
    args.logger?.error?.("push.registration_identity_lost", {
      filePath: args.filePath,
      quarantinePath,
      salvagedMachineKeyCount: salvagedKeys.length,
      detail,
    });
    const replacement: PushRegistrationFile = {
      ...createEmptyFile(),
      previousMachineKeys: salvagedKeys.slice(-PREVIOUS_MACHINE_KEY_MAX),
      identityRecoveryError:
        `Push machine identity was lost and re-minted (${detail}).`
        + ` Re-pair this machine's phones; ${salvagedKeys.length} superseded key(s) still need a relay sweep.`,
    };
    write(replacement);
    return replacement;
  };

  const load = (): PushRegistrationFile => {
    if (cache) return cache;
    const raw = readRaw();
    const parsed = raw.parsed as PushRegistrationFile | null;
    if (raw.present) {
      const existing = isValid(parsed) ? readValidFile() : null;
      if (existing) {
        cache = existing;
        return existing;
      }
      return recoverDamagedFile(raw);
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
        // The race winner wrote something unusable — recover from THAT file
        // rather than stamping a divergent identity over it.
        return recoverDamagedFile(readRaw());
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

    recordRemoteAttentionAcknowledgments(args: {
      accountOwnerId: string | null;
      acknowledgments: Array<{
        itemId: string;
        sourceRevision: number;
        seenAt: string | null;
        dismissedAt: string | null;
      }>;
      updatedAt: string;
    }): void {
      const file = load();
      const next = { ...file.remoteAttentionAcknowledgments };
      for (const acknowledgment of args.acknowledgments) {
        const itemId = acknowledgment.itemId.trim();
        if (!itemId || !Number.isFinite(acknowledgment.sourceRevision)) continue;
        const key = attentionAcknowledgmentKey(args.accountOwnerId, itemId);
        const existing = next[key];
        if (existing && existing.sourceRevision > acknowledgment.sourceRevision) continue;
        next[key] = {
          itemId,
          accountOwnerId: args.accountOwnerId,
          sourceRevision: acknowledgment.sourceRevision,
          seenAt: acknowledgment.seenAt,
          dismissedAt: acknowledgment.dismissedAt,
          updatedAt: args.updatedAt,
        };
      }
      const bounded = Object.fromEntries(
        Object.entries(next)
          .sort((left, right) =>
            Date.parse(right[1].updatedAt) - Date.parse(left[1].updatedAt))
          .slice(0, ATTENTION_ACK_MAX),
      );
      write({ ...file, remoteAttentionAcknowledgments: bounded });
    },

    listRemoteAttentionAcknowledgments(
      accountOwnerId?: string | null,
    ): StoredRemoteAttentionAcknowledgment[] {
      return Object.values(load().remoteAttentionAcknowledgments)
        .filter((acknowledgment) =>
          accountOwnerId === undefined || acknowledgment.accountOwnerId === accountOwnerId)
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    },

    getActivityProtocol(): number | null {
      return load().activityProtocol;
    },

    setActivityProtocol(protocol: number | null): void {
      const file = load();
      const normalized = Number.isSafeInteger(protocol) && Number(protocol) > 0
        ? Number(protocol)
        : null;
      if (file.activityProtocol === normalized) return;
      write({ ...file, activityProtocol: normalized });
    },

    nextActivityRosterEpoch(): number {
      const file = load();
      const next = Math.max(0, file.activityRosterEpoch) + 1;
      write({ ...file, activityRosterEpoch: next });
      return next;
    },

    getLastPublishedActivityRevisions(): {
      accountOwnerId: string | null;
      revisions: Record<string, number>;
    } {
      const file = load();
      return {
        accountOwnerId: file.lastPublishedRevisionAccountOwnerId,
        revisions: { ...file.lastPublishedRevisionById },
      };
    },

    setLastPublishedActivityRevisions(args: {
      accountOwnerId: string | null;
      revisions: Record<string, number>;
    }): void {
      const file = load();
      const revisions = Object.fromEntries(
        Object.entries(args.revisions)
          .filter(([itemId, revision]) =>
            itemId.trim().length > 0
            && Number.isSafeInteger(revision)
            && Number(revision) >= 0)
          .map(([itemId, revision]) => [itemId, Number(revision)]),
      );
      const accountOwnerId = args.accountOwnerId?.trim() || null;
      const currentEntries = Object.entries(file.lastPublishedRevisionById);
      if (
        file.lastPublishedRevisionAccountOwnerId === accountOwnerId
        && currentEntries.length === Object.keys(revisions).length
        && currentEntries.every(([itemId, revision]) => revisions[itemId] === revision)
      ) {
        return;
      }
      write({
        ...file,
        lastPublishedRevisionAccountOwnerId: accountOwnerId,
        lastPublishedRevisionById: revisions,
      });
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
        identityRecoveryError: file.identityRecoveryError,
        previousMachineKeys: [...file.previousMachineKeys],
        machineRevokedAt: file.machineRevokedAt,
      };
    },

    /** Has the account owner removed this machine? Terminal until re-paired. */
    isMachineRevoked(): boolean {
      return load().machineRevokedAt != null;
    },

    /**
     * Record the relay's `403 machine_revoked`. First writer wins: the earliest
     * observed revocation instant is the honest one, and a later 403 must not
     * keep moving the timestamp forward on every retry.
     */
    recordMachineRevoked(revokedAt?: string | null): void {
      const file = load();
      if (file.machineRevokedAt) return;
      const parsed = typeof revokedAt === "string" && !Number.isNaN(Date.parse(revokedAt))
        ? revokedAt
        : new Date().toISOString();
      write({ ...file, machineRevokedAt: parsed });
    },

    /**
     * Clear the revocation after a deliberate re-pair. Only a user-initiated
     * link may call this — clearing it on a heartbeat is what let a removed
     * machine resurrect itself.
     */
    clearMachineRevoked(): void {
      const file = load();
      if (!file.machineRevokedAt) return;
      write({ ...file, machineRevokedAt: null });
    },

    /**
     * Machine keys this machine has published under and abandoned. The relay
     * sweep is machine-scoped, so their rows are only reachable by key —
     * whoever performs the sweep reads them from here.
     */
    listPreviousMachineKeys(): string[] {
      return [...load().previousMachineKeys];
    },

    /**
     * Drop superseded keys once their relay rows have been swept, so the list
     * does not keep asking for work that is already done.
     */
    clearPreviousMachineKeys(keys?: string[]): void {
      const file = load();
      if (file.previousMachineKeys.length === 0) return;
      const swept = keys ? new Set(keys) : null;
      const remaining = swept
        ? file.previousMachineKeys.filter((key) => !swept.has(key))
        : [];
      if (remaining.length === file.previousMachineKeys.length) return;
      write({
        ...file,
        previousMachineKeys: remaining,
        // The recovery notice is only actionable while something is unswept.
        identityRecoveryError: remaining.length > 0 ? file.identityRecoveryError : null,
      });
    },
  };
}

export type PushRegistrationStore = ReturnType<typeof createPushRegistrationStore>;
