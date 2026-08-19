import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { safeJsonParse } from "../../../../desktop/src/main/services/shared/utils";
import { DEFAULT_ADE_TUNNEL_RELAY_URL } from "../../../../desktop/src/shared/accountDirectory";
import type { SyncCloudRelayStatus } from "../../../../desktop/src/shared/types";
import {
  RELAY_SIGN_IN_REQUIRED_MESSAGE,
  type SyncTunnelClientStatus,
} from "./syncTunnelClientService";

const DEFAULT_RELAY_URL = DEFAULT_ADE_TUNNEL_RELAY_URL;

/** The identity file's name inside the machine secrets directory. */
export const SYNC_CLOUD_RELAY_FILE_NAME = "sync-cloud-relay.json";

const IDENTITY_ROTATION_LOCK_STALE_MS = 30_000;
const IDENTITY_ROTATION_LOCK_VERSION = 1;
const IDENTITY_CONFIG_LOCK_WAIT_MS = 2_000;
const IDENTITY_CONFIG_LOCK_RETRY_MS = 10;

/**
 * Sibling copy of the identity file, rewritten after every successful write.
 *
 * A machine key is not a cache: losing it turns a known computer into a
 * stranger the account has never seen, and the row it used to own becomes a
 * phantom the owner is invited to delete — which is precisely how a live
 * MacBook got locked out of its own account. One truncated write is enough to
 * cause that, so the identity always exists in two places.
 */
const IDENTITY_BACKUP_SUFFIX = ".bak";

/**
 * Relay-claim conflicts may rotate this machine's identity at most twice a day.
 *
 * The budget used to be a closure variable, so every brain restart handed the
 * client a fresh allowance — a crash loop could mint an unbounded number of
 * machine rows, each one a phantom on the owner's roster. It is persisted for
 * exactly that reason: restarts must not forgive rotations.
 */
export const IDENTITY_ROTATION_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const MAX_IDENTITY_ROTATIONS_PER_WINDOW = 2;

/** Automatic pairing repairs are bounded the same way, on a 6-hour window. */
export const PAIRING_AUTO_REPAIR_WINDOW_MS = 6 * 60 * 60 * 1_000;
export const MAX_PAIRING_AUTO_REPAIRS_PER_WINDOW = 3;

/**
 * How many retired machine keys are remembered so a server that reports
 * `supersededMachineKeys` can be recognised as confirming OUR rotation rather
 * than describing somebody else's device.
 */
const MAX_RETAINED_PREVIOUS_MACHINE_KEYS = 5;

export type SyncCloudRelayConfig = {
  /** Per-machine identifier phones dial through the relay (32 hex chars). */
  machineKey: string;
  /** HMAC secret shared with the relay for signed host/pipe upgrades. */
  secret: string;
  /** Optional override for the relay base URL (http/https). */
  relayUrl?: string;
};

/** A count of consumptions inside a rolling window, persisted with the identity. */
export type SyncCloudRelayBudget = {
  count: number;
  /** ISO start of the current window; null while the budget is untouched. */
  windowStartedAt: string | null;
  /** ISO timestamp of the most recent consumption. */
  lastAt: string | null;
};

export type SyncCloudRelayBudgetStatus = SyncCloudRelayBudget & {
  limit: number;
  windowMs: number;
  exhausted: boolean;
};

/**
 * Why this machine's identity changed. Every one of these is logged with the
 * same `identity_rotated` shape, so "where did my machine key go" is always
 * answerable from the brain log alone.
 */
export type SyncCloudRelayIdentityReason =
  /** No identity file existed — a genuinely new machine. */
  | "first_mint"
  /** Both halves were unrecoverable from the file AND its backup. */
  | "corrupt_file_remint"
  /** The machine key survived; only the HMAC secret had to be replaced. */
  | "secret_remint"
  /** The primary file was unusable and the backup supplied the identity. */
  | "recovered_from_backup"
  /** A confirmed relay claim conflict (HTTP 409) rotated the whole credential. */
  | "conflict_rotation";

export type SyncCloudRelayIdentityEvent = {
  /** The key in force before this event; null when there was none to lose. */
  previousMachineKey: string | null;
  machineKey: string;
  reason: SyncCloudRelayIdentityReason;
};

export type SyncCloudRelayRotationResult = {
  config: SyncCloudRelayConfig;
  /** False when the expected key had already moved, or the budget is spent. */
  rotated: boolean;
  /** The 24h rotation budget is spent: reconnect by hand, never mint again. */
  budgetExhausted: boolean;
  rotationsInWindow: number;
};

type SyncCloudRelayFile = Partial<SyncCloudRelayConfig> & {
  identityRotations?: unknown;
  pairingAutoRepairs?: unknown;
  previousMachineKeys?: unknown;
  /** Deprecated kill-switch fields are accepted only so old files are cleaned up. */
  enabled?: unknown;
  enabledSetByUser?: unknown;
};

/** Everything the identity file carries, as this module works with it. */
type SyncCloudRelayState = {
  config: SyncCloudRelayConfig;
  identityRotations: SyncCloudRelayBudget;
  pairingAutoRepairs: SyncCloudRelayBudget;
  previousMachineKeys: string[];
};

type ResolvedState = {
  state: SyncCloudRelayState;
  /** The identity differs from what the primary file literally held. */
  needsIdentityWrite: boolean;
  needsWrite: boolean;
  event: SyncCloudRelayIdentityEvent | null;
};

type SyncCloudRelayStoreLogger = {
  info?: (event: string, data?: Record<string, unknown>) => void;
  warn?: (event: string, data?: Record<string, unknown>) => void;
};

type RotationLockOwner = {
  version: typeof IDENTITY_ROTATION_LOCK_VERSION;
  pid: number;
  token: string;
  createdAt: string;
};

type RotationLockLease = {
  fd: number;
  owner: RotationLockOwner;
};

/** Default relay base URL: env override wins, else the deployed worker. */
export function defaultRelayUrl(): string {
  return process.env.ADE_TUNNEL_RELAY_URL?.trim() || DEFAULT_RELAY_URL;
}

/** Swaps an http(s) base URL to its ws(s) equivalent, preserving host/path. */
export function httpToWsUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`;
  if (trimmed.startsWith("wss://") || trimmed.startsWith("ws://")) return trimmed;
  // Bare host → assume TLS (the deployed worker is always https).
  return `wss://${trimmed}`;
}

/**
 * The phone-facing tunnel URL. This is the single value the QR / candidate
 * integration consumes: a phone that dials it reaches this machine's brain
 * through the relay, where the normal ADE sync hello/pairing runs end-to-end.
 */
export function deriveRelayWssConnectUrl(relayUrl: string, machineKey: string): string {
  return `${httpToWsUrl(relayUrl)}/connect/${machineKey}`;
}

/** Canonical signing strings — identical to the worker's (apps/tunnel-relay). */
export function buildHostSignatureBase(machineKey: string, epoch: string, timestamp?: string): string {
  return timestamp == null
    ? `host:${machineKey}:${epoch}`
    : `host:${machineKey}:${epoch}:${timestamp}`;
}

export function buildPipeSignatureBase(machineKey: string, id: string, epoch: string, timestamp?: string): string {
  return timestamp == null
    ? `pipe:${machineKey}:${id}:${epoch}`
    : `pipe:${machineKey}:${id}:${epoch}:${timestamp}`;
}

export function signRelayHmacHex(secret: string, base: string): string {
  return createHmac("sha256", secret).update(base).digest("hex");
}

export type SyncCloudRelayStore = ReturnType<typeof createSyncCloudRelayStore>;

function emptyBudget(): SyncCloudRelayBudget {
  return { count: 0, windowStartedAt: null, lastAt: null };
}

function readIsoTimestamp(value: unknown): string | null {
  return typeof value === "string" && value.trim() && !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

/**
 * Read a persisted budget defensively. A budget that cannot be understood is
 * read as SPENT-window-unknown rather than as empty: forgiving an unreadable
 * counter is the same failure mode as not persisting it at all.
 */
function readBudget(value: unknown, lastKey: string): SyncCloudRelayBudget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyBudget();
  const record = value as Record<string, unknown>;
  const rawCount = record.count;
  const count = typeof rawCount === "number" && Number.isFinite(rawCount) && rawCount > 0
    ? Math.floor(rawCount)
    : 0;
  const windowStartedAt = readIsoTimestamp(record.windowStartedAt);
  const lastAt = readIsoTimestamp(record[lastKey]);
  if (count === 0) return emptyBudget();
  return {
    count,
    // A count with no window would never expire; anchor it to the last
    // consumption, and failing that treat the window as starting now.
    windowStartedAt: windowStartedAt ?? lastAt ?? new Date().toISOString(),
    lastAt,
  };
}

function serializeBudget(
  budget: SyncCloudRelayBudget,
  lastKey: string,
): Record<string, unknown> | null {
  if (budget.count <= 0) return null;
  return {
    count: budget.count,
    ...(budget.windowStartedAt ? { windowStartedAt: budget.windowStartedAt } : {}),
    ...(budget.lastAt ? { [lastKey]: budget.lastAt } : {}),
  };
}

function isValidMachineKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32,64}$/i.test(value);
}

function isValidSecret(value: unknown): value is string {
  return typeof value === "string" && value.length >= 32;
}

function readPreviousMachineKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys: string[] = [];
  for (const entry of value) {
    if (!isValidMachineKey(entry) || keys.includes(entry)) continue;
    keys.push(entry);
    if (keys.length >= MAX_RETAINED_PREVIOUS_MACHINE_KEYS) break;
  }
  return keys;
}

/**
 * Persists the tunnel-relay identity next to the other sync secrets.
 * machineKey/secret are minted lazily on first read (matching the push-relay
 * store's randomBytes sizing) and the file is chmod 600.
 *
 * Two rules govern every path through this store, both bought by a production
 * lockout: an identity is never discarded when any copy on disk still holds it,
 * and every mint, rotation, or recovery leaves a log line naming what changed
 * and why.
 */
export function createSyncCloudRelayStore(args: {
  filePath: string;
  lockWaitMs?: number;
  logger?: SyncCloudRelayStoreLogger;
  /** Test seam for the rotation/auto-repair windows. */
  now?: () => number;
}) {
  fs.mkdirSync(path.dirname(args.filePath), { recursive: true });
  const rotationLockPath = `${args.filePath}.rotate.lock`;
  const backupPath = `${args.filePath}${IDENTITY_BACKUP_SUFFIX}`;
  const lockWaitMs = Math.max(0, args.lockWaitMs ?? IDENTITY_CONFIG_LOCK_WAIT_MS);
  const lockWaiter = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const now = args.now ?? Date.now;
  const log = args.logger;
  /**
   * The machine key whose backup this process has already reconciled. Purely an
   * optimisation: `load()` runs on every identity read, and re-statting the
   * backup each time would put a syscall on the relay hot path.
   */
  let backupVerifiedFor: string | null = null;

  const logIdentityEvent = (event: SyncCloudRelayIdentityEvent): void => {
    // One event name for every identity transition, matching the tunnel
    // client's `identity_rotated` payload, so a single grep answers "when did
    // this machine's key change, and what changed it".
    log?.info?.("sync_cloud_relay.identity_rotated", {
      previousMachineKey: event.previousMachineKey,
      machineKey: event.machineKey,
      reason: event.reason,
    });
  };

  /**
   * Read one identity file. Unlike a `safeJsonParse(..., {})` read, a parse
   * failure is reported as a FAILURE rather than as an empty object — the
   * difference between "this machine has no identity yet" and "this machine's
   * identity is temporarily unreadable", and conflating them is what minted a
   * whole new machine out of one corrupt file.
   */
  const readFileAt = (target: string): {
    raw: SyncCloudRelayFile;
    present: boolean;
    parsed: boolean;
  } => {
    let text: string;
    try {
      text = fs.readFileSync(target, "utf8");
    } catch {
      return { raw: {}, present: false, parsed: false };
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      log?.warn?.("sync_cloud_relay.identity_file_unparsable", { file: path.basename(target) });
      return { raw: {}, present: true, parsed: false };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      log?.warn?.("sync_cloud_relay.identity_file_unparsable", { file: path.basename(target) });
      return { raw: {}, present: true, parsed: false };
    }
    return { raw: value as SyncCloudRelayFile, present: true, parsed: true };
  };

  const serialize = (state: SyncCloudRelayState): string => {
    const identityRotations = serializeBudget(state.identityRotations, "lastRotationAt");
    const pairingAutoRepairs = serializeBudget(state.pairingAutoRepairs, "lastRepairAt");
    // Optional members stay ABSENT while unused so a machine that has never
    // rotated serializes byte-for-byte like it always did.
    const fileValue = {
      machineKey: state.config.machineKey,
      secret: state.config.secret,
      ...(state.config.relayUrl ? { relayUrl: state.config.relayUrl } : {}),
      ...(identityRotations ? { identityRotations } : {}),
      ...(pairingAutoRepairs ? { pairingAutoRepairs } : {}),
      ...(state.previousMachineKeys.length > 0
        ? { previousMachineKeys: state.previousMachineKeys }
        : {}),
    };
    return `${JSON.stringify(fileValue, null, 2)}\n`;
  };

  /**
   * Atomic AND durable: 0o600 temp file, fsync, rename, then fsync the
   * directory so the rename itself survives a power loss. `writeTextAtomic`
   * does the rename but not the fsyncs, and an identity that reappears empty
   * after a crash is exactly the loss this store exists to prevent.
   */
  const writeDurable = (target: string, text: string): void => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tempPath = `${target}.tmp-${randomBytes(8).toString("hex")}`;
    try {
      const fd = fs.openSync(tempPath, "w", 0o600);
      try {
        fs.writeFileSync(fd, text, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      // Windows `rename` fails onto an existing target; POSIX replaces silently.
      if (process.platform === "win32") {
        try {
          fs.unlinkSync(target);
        } catch {
          // first write, or already gone
        }
      }
      fs.renameSync(tempPath, target);
    } catch (error) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // best effort
      }
      throw error;
    }
    if (process.platform !== "win32") {
      try {
        const dirFd = fs.openSync(path.dirname(target), "r");
        try {
          fs.fsyncSync(dirFd);
        } finally {
          fs.closeSync(dirFd);
        }
      } catch {
        // Directory fsync is unsupported on some filesystems; the rename still
        // happened and the temp file was already flushed.
      }
    }
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      // ignore chmod failures on platforms that don't support it
    }
  };

  const write = (state: SyncCloudRelayState): void => {
    const text = serialize(state);
    writeDurable(args.filePath, text);
    // The backup follows the primary, never leads it: a reader that falls back
    // to the backup must find the last identity that was actually in force.
    try {
      writeDurable(backupPath, text);
      backupVerifiedFor = state.config.machineKey;
    } catch (error) {
      backupVerifiedFor = null;
      log?.warn?.("sync_cloud_relay.identity_backup_write_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const mintIdentity = (relayUrl?: string): SyncCloudRelayConfig => ({
    machineKey: randomBytes(16).toString("hex"),
    secret: randomBytes(24).toString("hex"),
    ...(relayUrl ? { relayUrl } : {}),
  });

  const relayUrlFrom = (raw: SyncCloudRelayFile): string | undefined =>
    typeof raw.relayUrl === "string" && raw.relayUrl.trim() ? raw.relayUrl.trim() : undefined;

  /**
   * Build the live state from the primary file, falling back to the backup for
   * anything the primary cannot supply.
   *
   * The machine key is the one field that is preserved at any cost: it is kept
   * from whichever file still holds one, and only a file pair that yields none
   * at all may mint a new one. A broken secret costs a secret, never a machine.
   */
  const resolve = (): ResolvedState => {
    const primary = readFileAt(args.filePath);
    const primaryMachineKey = isValidMachineKey(primary.raw.machineKey)
      ? primary.raw.machineKey
      : null;
    const primarySecret = isValidSecret(primary.raw.secret) ? primary.raw.secret : null;

    const needsBackup = !primaryMachineKey || !primarySecret;
    const backup = needsBackup ? readFileAt(backupPath) : null;
    const backupMachineKey = backup && isValidMachineKey(backup.raw.machineKey)
      ? backup.raw.machineKey
      : null;
    const backupSecret = backup && isValidSecret(backup.raw.secret) ? backup.raw.secret : null;

    const machineKey = primaryMachineKey ?? backupMachineKey;
    // Pair the secret with its own machine key wherever possible: a secret is
    // only meaningful for the key it was minted alongside.
    const secret = primaryMachineKey && primarySecret
      ? primarySecret
      : machineKey && machineKey === backupMachineKey && backupSecret
        ? backupSecret
        : null;

    const source: SyncCloudRelayFile = machineKey && machineKey === primaryMachineKey
      ? primary.raw
      : backup?.raw ?? primary.raw;
    const fallbackSource = source === primary.raw ? backup?.raw ?? {} : primary.raw;

    const relayUrl = relayUrlFrom(source) ?? relayUrlFrom(fallbackSource);
    const identityRotations = readBudget(
      source.identityRotations ?? fallbackSource.identityRotations,
      "lastRotationAt",
    );
    const pairingAutoRepairs = readBudget(
      source.pairingAutoRepairs ?? fallbackSource.pairingAutoRepairs,
      "lastRepairAt",
    );
    let previousMachineKeys = readPreviousMachineKeys(
      source.previousMachineKeys ?? fallbackSource.previousMachineKeys,
    );

    let event: SyncCloudRelayIdentityEvent | null = null;
    let config: SyncCloudRelayConfig;
    if (machineKey && secret) {
      config = { machineKey, secret, ...(relayUrl ? { relayUrl } : {}) };
      if (!primaryMachineKey) {
        event = { previousMachineKey: null, machineKey, reason: "recovered_from_backup" };
      }
    } else if (machineKey) {
      // The machine survives; only its relay secret is replaced.
      config = {
        machineKey,
        secret: mintIdentity().secret,
        ...(relayUrl ? { relayUrl } : {}),
      };
      event = {
        previousMachineKey: machineKey,
        machineKey,
        reason: primaryMachineKey ? "secret_remint" : "recovered_from_backup",
      };
    } else {
      const minted = mintIdentity(relayUrl);
      config = minted;
      // A file that exists but yields nothing is a LOSS, not a new machine, and
      // it is logged as such so the roster phantom it may create is explainable.
      const lost = primary.present || backup?.present === true;
      event = {
        previousMachineKey: null,
        machineKey: minted.machineKey,
        reason: lost ? "corrupt_file_remint" : "first_mint",
      };
      previousMachineKeys = [];
    }

    const needsIdentityWrite = primary.raw.machineKey !== config.machineKey
      || primary.raw.secret !== config.secret;
    const hasDeprecatedKillSwitchFields = Object.prototype.hasOwnProperty.call(primary.raw, "enabled")
      || Object.prototype.hasOwnProperty.call(primary.raw, "enabledSetByUser");
    return {
      state: { config, identityRotations, pairingAutoRepairs, previousMachineKeys },
      needsIdentityWrite,
      needsWrite: needsIdentityWrite || hasDeprecatedKillSwitchFields || !primary.parsed,
      event,
    };
  };

  const readRotationLock = (): { owner: RotationLockOwner | null; text: string; ageMs: number } | null => {
    try {
      const text = fs.readFileSync(rotationLockPath, "utf8");
      const raw = safeJsonParse<Partial<RotationLockOwner>>(text, {});
      const owner = raw.version === IDENTITY_ROTATION_LOCK_VERSION
        && typeof raw.pid === "number" && Number.isInteger(raw.pid) && raw.pid > 0
        && typeof raw.token === "string" && raw.token.length >= 16
        && typeof raw.createdAt === "string"
        ? raw as RotationLockOwner
        : null;
      return {
        owner,
        text,
        ageMs: Math.max(0, Date.now() - fs.statSync(rotationLockPath).mtimeMs),
      };
    } catch {
      return null;
    }
  };

  const isPidAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };

  const acquireRotationLock = (): RotationLockLease | null => {
    const owner: RotationLockOwner = {
      version: IDENTITY_ROTATION_LOCK_VERSION,
      pid: process.pid,
      token: randomBytes(16).toString("hex"),
      createdAt: new Date().toISOString(),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(rotationLockPath, "wx", 0o600);
        try {
          fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
          fs.fsyncSync(fd);
          return { fd, owner };
        } catch (error) {
          fs.closeSync(fd);
          try {
            fs.unlinkSync(rotationLockPath);
          } catch {
            // Preserve the original lock-write failure.
          }
          throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (attempt > 0) return null;
        const existing = readRotationLock();
        if (!existing) continue;
        if (existing.owner && isPidAlive(existing.owner.pid)) return null;
        if (!existing.owner && existing.ageMs < IDENTITY_ROTATION_LOCK_STALE_MS) return null;
        const latest = readRotationLock();
        if (!latest || latest.text !== existing.text) return null;
        try {
          fs.unlinkSync(rotationLockPath);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") return null;
        }
      }
    }
    return null;
  };

  const acquireRotationLockWithWait = (waitMs: number): RotationLockLease | null => {
    const deadline = Date.now() + Math.max(0, waitMs);
    while (true) {
      const lease = acquireRotationLock();
      if (lease) return lease;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return null;
      Atomics.wait(lockWaiter, 0, 0, Math.min(IDENTITY_CONFIG_LOCK_RETRY_MS, remainingMs));
    }
  };

  const releaseRotationLock = (lease: RotationLockLease): void => {
    try {
      fs.closeSync(lease.fd);
    } finally {
      const current = readRotationLock();
      if (current?.owner?.token === lease.owner.token) {
        try {
          fs.unlinkSync(rotationLockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            // Cleanup is best effort; a later owner can reap this dead PID lock.
          }
        }
      }
    }
  };

  const busyError = (): Error =>
    new Error("The ADE Relay configuration is being updated by another live ADE process.");

  const stateWhileLocked = (): SyncCloudRelayState => {
    const latest = resolve();
    if (latest.needsIdentityWrite) throw busyError();
    return latest.state;
  };

  /**
   * Roll a persisted budget forward and try to spend one unit of it.
   * `windowStartedAt` is only reset once the window has fully elapsed, so a
   * steady drip of attempts cannot keep the window open indefinitely.
   */
  const consumeBudget = (
    budget: SyncCloudRelayBudget,
    windowMs: number,
    limit: number,
  ): { budget: SyncCloudRelayBudget; allowed: boolean; countInWindow: number } => {
    const nowMs = now();
    const startedAtMs = budget.windowStartedAt ? Date.parse(budget.windowStartedAt) : Number.NaN;
    const windowExpired = !Number.isFinite(startedAtMs) || nowMs - startedAtMs >= windowMs;
    const countInWindow = windowExpired ? 0 : budget.count;
    if (countInWindow >= limit) {
      return { budget, allowed: false, countInWindow };
    }
    const nowIso = new Date(nowMs).toISOString();
    return {
      budget: {
        count: countInWindow + 1,
        windowStartedAt: windowExpired ? nowIso : budget.windowStartedAt ?? nowIso,
        lastAt: nowIso,
      },
      allowed: true,
      countInWindow: countInWindow + 1,
    };
  };

  const budgetStatus = (
    budget: SyncCloudRelayBudget,
    windowMs: number,
    limit: number,
  ): SyncCloudRelayBudgetStatus => {
    const nowMs = now();
    const startedAtMs = budget.windowStartedAt ? Date.parse(budget.windowStartedAt) : Number.NaN;
    const windowExpired = !Number.isFinite(startedAtMs) || nowMs - startedAtMs >= windowMs;
    const countInWindow = windowExpired ? 0 : budget.count;
    return {
      count: countInWindow,
      windowStartedAt: windowExpired ? null : budget.windowStartedAt,
      lastAt: budget.lastAt,
      limit,
      windowMs,
      exhausted: countInWindow >= limit,
    };
  };

  const updateState = <T>(
    update: (current: SyncCloudRelayState) => {
      state: SyncCloudRelayState;
      changed: boolean;
      event?: SyncCloudRelayIdentityEvent | null;
      result?: T;
    },
    onLocked?: () => { state: SyncCloudRelayState; result?: T },
    waitMs = lockWaitMs,
  ): { state: SyncCloudRelayState; result?: T } => {
    const lease = acquireRotationLockWithWait(waitMs);
    if (!lease) {
      if (onLocked) return onLocked();
      throw busyError();
    }
    try {
      // Read only after acquiring the shared lock so every whole-file update
      // is based on the latest identity, relay URL, and budgets.
      const current = resolve();
      const outcome = update(current.state);
      if (current.needsWrite || outcome.changed) {
        write(outcome.state);
        // Logged only after the write lands: an event announcing an identity
        // that failed to persist would be worse than silence.
        if (current.event) logIdentityEvent(current.event);
        if (outcome.event) logIdentityEvent(outcome.event);
      }
      return { state: outcome.state, result: outcome.result };
    } finally {
      releaseRotationLock(lease);
    }
  };

  /**
   * Make sure the backup exists and names the identity currently in force.
   * Cheap and idempotent; the in-process guard keeps it off the hot path after
   * the first read.
   */
  const ensureBackup = (state: SyncCloudRelayState): void => {
    if (backupVerifiedFor === state.config.machineKey) return;
    const existing = readFileAt(backupPath);
    if (existing.parsed && existing.raw.machineKey === state.config.machineKey
      && existing.raw.secret === state.config.secret) {
      backupVerifiedFor = state.config.machineKey;
      return;
    }
    try {
      writeDurable(backupPath, serialize(state));
      backupVerifiedFor = state.config.machineKey;
    } catch (error) {
      log?.warn?.("sync_cloud_relay.identity_backup_write_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Reads the file and fills in a freshly generated identity when absent,
  // persisting it so the machineKey stays stable across restarts.
  const load = (): SyncCloudRelayState => {
    const current = resolve();
    if (!current.needsWrite) {
      ensureBackup(current.state);
      return current.state;
    }
    return updateState<never>(
      (latest) => ({ state: latest, changed: false }),
      () => ({ state: stateWhileLocked() }),
    ).state;
  };

  return {
    getConfig(): SyncCloudRelayConfig {
      return load().config;
    },

    getMachineIdentity(): { machineKey: string; secret: string } {
      const { machineKey, secret } = load().config;
      return { machineKey, secret };
    },

    getRelayUrl(): string {
      return load().config.relayUrl ?? defaultRelayUrl();
    },

    setRelayUrl(relayUrl: string | null): SyncCloudRelayConfig {
      return updateState((current) => ({
        state: {
          ...current,
          config: { ...current.config, relayUrl: relayUrl?.trim() || undefined },
        },
        changed: true,
      })).state.config;
    },

    /**
     * Replaces a relay identity only when the caller is still looking at the
     * expected machine key, and only while the persisted 24-hour rotation
     * budget allows it. The exclusive sibling lock serializes brain processes
     * so exactly one confirmed-conflict recovery wins.
     *
     * The budget lives in the FILE, not in a closure: the previous in-memory
     * counter reset on every brain restart, so a restart loop could mint one
     * new machine row per boot and bury the owner's roster in phantoms.
     */
    rotateMachineIdentity(expectedMachineKey: string): SyncCloudRelayRotationResult {
      const outcome = updateState<SyncCloudRelayRotationResult>(
        (current) => {
          if (current.config.machineKey !== expectedMachineKey) {
            return {
              state: current,
              changed: false,
              result: {
                config: current.config,
                rotated: false,
                budgetExhausted: false,
                rotationsInWindow: budgetStatus(
                  current.identityRotations,
                  IDENTITY_ROTATION_WINDOW_MS,
                  MAX_IDENTITY_ROTATIONS_PER_WINDOW,
                ).count,
              },
            };
          }
          const spend = consumeBudget(
            current.identityRotations,
            IDENTITY_ROTATION_WINDOW_MS,
            MAX_IDENTITY_ROTATIONS_PER_WINDOW,
          );
          if (!spend.allowed) {
            return {
              state: current,
              changed: false,
              result: {
                config: current.config,
                rotated: false,
                budgetExhausted: true,
                rotationsInWindow: spend.countInWindow,
              },
            };
          }
          const next = mintIdentity(current.config.relayUrl);
          const previousMachineKeys = [
            current.config.machineKey,
            ...current.previousMachineKeys.filter((key) => key !== current.config.machineKey),
          ].slice(0, MAX_RETAINED_PREVIOUS_MACHINE_KEYS);
          return {
            state: {
              config: next,
              identityRotations: spend.budget,
              pairingAutoRepairs: current.pairingAutoRepairs,
              previousMachineKeys,
            },
            changed: true,
            event: {
              previousMachineKey: current.config.machineKey,
              machineKey: next.machineKey,
              reason: "conflict_rotation",
            },
            result: {
              config: next,
              rotated: true,
              budgetExhausted: spend.countInWindow >= MAX_IDENTITY_ROTATIONS_PER_WINDOW,
              rotationsInWindow: spend.countInWindow,
            },
          };
        },
        () => {
          const state = stateWhileLocked();
          return {
            state,
            result: {
              config: state.config,
              rotated: false,
              budgetExhausted: false,
              rotationsInWindow: budgetStatus(
                state.identityRotations,
                IDENTITY_ROTATION_WINDOW_MS,
                MAX_IDENTITY_ROTATIONS_PER_WINDOW,
              ).count,
            },
          };
        },
        0,
      );
      return outcome.result ?? {
        config: outcome.state.config,
        rotated: false,
        budgetExhausted: false,
        rotationsInWindow: 0,
      };
    },

    getIdentityRotationBudget(): SyncCloudRelayBudgetStatus {
      return budgetStatus(
        load().identityRotations,
        IDENTITY_ROTATION_WINDOW_MS,
        MAX_IDENTITY_ROTATIONS_PER_WINDOW,
      );
    },

    getPairingAutoRepairBudget(): SyncCloudRelayBudgetStatus {
      return budgetStatus(
        load().pairingAutoRepairs,
        PAIRING_AUTO_REPAIR_WINDOW_MS,
        MAX_PAIRING_AUTO_REPAIRS_PER_WINDOW,
      );
    },

    /**
     * Spend one automatic pairing repair from the persisted 6-hour budget.
     *
     * Persisted for the same reason the rotation budget is: an auto-repair loop
     * whose allowance resets on restart is a machine that hammers the account
     * directory forever, and the brain restarts far more often than six hours.
     */
    tryConsumePairingAutoRepair(): { allowed: boolean; countInWindow: number; limit: number } {
      let allowed = false;
      let countInWindow = 0;
      try {
        const outcome = updateState<{ allowed: boolean; countInWindow: number }>(
          (current) => {
            const spend = consumeBudget(
              current.pairingAutoRepairs,
              PAIRING_AUTO_REPAIR_WINDOW_MS,
              MAX_PAIRING_AUTO_REPAIRS_PER_WINDOW,
            );
            return {
              state: spend.allowed
                ? { ...current, pairingAutoRepairs: spend.budget }
                : current,
              changed: spend.allowed,
              result: { allowed: spend.allowed, countInWindow: spend.countInWindow },
            };
          },
          () => ({ state: stateWhileLocked(), result: { allowed: false, countInWindow: 0 } }),
        );
        allowed = outcome.result?.allowed ?? false;
        countInWindow = outcome.result?.countInWindow ?? 0;
      } catch {
        // A contended or unwritable store must not authorize an unbounded
        // repair loop: fail closed and let the next cycle try again.
        allowed = false;
      }
      return { allowed, countInWindow, limit: MAX_PAIRING_AUTO_REPAIRS_PER_WINDOW };
    },

    /**
     * Reconcile the directory's `supersededMachineKeys` against the keys this
     * machine actually retired, and forget the ones it confirmed.
     *
     * Returns only OUR keys. A server naming a key we never held describes some
     * other device, and acting on it would be the phantom problem in reverse.
     * Older directories send nothing, which is simply an empty answer.
     */
    confirmSupersededMachineKeys(serverKeys: readonly unknown[]): string[] {
      const claimed = readPreviousMachineKeys(serverKeys);
      if (claimed.length === 0) return [];
      const current = load();
      const confirmed = current.previousMachineKeys.filter((key) =>
        claimed.some((candidate) => candidate.toLowerCase() === key.toLowerCase()));
      if (confirmed.length === 0) return [];
      try {
        updateState((state) => ({
          state: {
            ...state,
            previousMachineKeys: state.previousMachineKeys.filter(
              (key) => !confirmed.includes(key),
            ),
          },
          changed: true,
        }));
      } catch {
        // Bookkeeping only — the confirmation is still true if the prune fails.
      }
      return confirmed;
    },

    /** `wss://<host>/connect/<machineKey>` — the value the QR integration reads. */
    getRelayWssUrl(): string {
      const { relayUrl, machineKey } = load().config;
      return deriveRelayWssConnectUrl(relayUrl ?? defaultRelayUrl(), machineKey);
    },
  };
}

/**
 * The relay status the desktop and the CLI read, built the same way whether a
 * project scope owns sync or the brain answers for the bare machine.
 *
 * Both surfaces had their own copy of this projection and they had already
 * drifted apart in whitespace only — one edit away from drifting in meaning,
 * which would show two different relay stories for one machine.
 *
 * `accountSignedIn` is the gate: without it the live fields collapse to their
 * off values and the error becomes the sign-in prompt, so a signed-out machine
 * never reports a connection it cannot have.
 */
export function buildSyncCloudRelayStatus(args: {
  cloudRelayStore: Pick<SyncCloudRelayStore, "getConfig" | "getRelayUrl" | "getRelayWssUrl">;
  tunnelStatus: SyncTunnelClientStatus | null;
  accountSignedIn: boolean;
}): SyncCloudRelayStatus {
  const { cloudRelayStore, tunnelStatus, accountSignedIn } = args;
  // Built as a variable, not returned inline: the relay self-probe fields below
  // are not in `SyncCloudRelayStatus` yet and both original copies passed them
  // through. Dropping them here would quietly blank the desktop's probe row.
  const status = {
    relayWssUrl: cloudRelayStore.getRelayWssUrl(),
    machineKey: cloudRelayStore.getConfig().machineKey,
    relayUrl: cloudRelayStore.getRelayUrl(),
    connected: accountSignedIn && (tunnelStatus?.connected ?? false),
    activeTunnels: accountSignedIn ? tunnelStatus?.activeTunnels ?? 0 : 0,
    relayBridgeValidated: accountSignedIn && (tunnelStatus?.relayBridgeValidated ?? false),
    lastFailureAt: tunnelStatus?.lastFailureAt ?? null,
    lastControlOpenAt: tunnelStatus?.lastControlOpenAt ?? null,
    lastBridgeValidationAt: tunnelStatus?.lastBridgeValidationAt ?? null,
    relayEndToEndVerifiedAt: tunnelStatus?.relayEndToEndVerifiedAt ?? null,
    relayEndToEndFailure: tunnelStatus?.relayEndToEndFailure ?? null,
    relayEndToEndRoundTripMs: tunnelStatus?.relayEndToEndRoundTripMs ?? null,
    lastControlError: tunnelStatus?.lastControlError ?? null,
    lastError: accountSignedIn
      ? tunnelStatus?.lastError ?? null
      : RELAY_SIGN_IN_REQUIRED_MESSAGE,
  };
  return status;
}
