import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { safeJsonParse, writeTextAtomic } from "../../../../desktop/src/main/services/shared/utils";
import { DEFAULT_ADE_TUNNEL_RELAY_URL } from "../../../../desktop/src/shared/accountDirectory";

const DEFAULT_RELAY_URL = DEFAULT_ADE_TUNNEL_RELAY_URL;
const IDENTITY_ROTATION_LOCK_STALE_MS = 30_000;
const IDENTITY_ROTATION_LOCK_VERSION = 1;
const IDENTITY_CONFIG_LOCK_WAIT_MS = 2_000;
const IDENTITY_CONFIG_LOCK_RETRY_MS = 10;

export type SyncCloudRelayConfig = {
  /** Per-machine identifier phones dial through the relay (32 hex chars). */
  machineKey: string;
  /** HMAC secret shared with the relay for signed host/pipe upgrades. */
  secret: string;
  /** Optional override for the relay base URL (http/https). */
  relayUrl?: string;
};

type SyncCloudRelayFile = Partial<SyncCloudRelayConfig> & {
  /** Deprecated kill-switch fields are accepted only so old files are cleaned up. */
  enabled?: unknown;
  enabledSetByUser?: unknown;
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

/**
 * Persists the tunnel-relay identity next to the other sync secrets.
 * machineKey/secret are minted lazily on first read (matching the push-relay
 * store's randomBytes sizing) and the file is chmod 600.
 */
export function createSyncCloudRelayStore(args: { filePath: string; lockWaitMs?: number }) {
  fs.mkdirSync(path.dirname(args.filePath), { recursive: true });
  const rotationLockPath = `${args.filePath}.rotate.lock`;
  const lockWaitMs = Math.max(0, args.lockWaitMs ?? IDENTITY_CONFIG_LOCK_WAIT_MS);
  const lockWaiter = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

  const read = (): SyncCloudRelayFile => {
    if (!fs.existsSync(args.filePath)) return {};
    return safeJsonParse<SyncCloudRelayFile>(fs.readFileSync(args.filePath, "utf8"), {});
  };

  const write = (value: SyncCloudRelayConfig): void => {
    const fileValue: SyncCloudRelayFile = {
      machineKey: value.machineKey,
      secret: value.secret,
      ...(value.relayUrl ? { relayUrl: value.relayUrl } : {}),
    };
    // 0o600 at temp-file creation so the identity secret is never world-readable.
    writeTextAtomic(args.filePath, `${JSON.stringify(fileValue, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(args.filePath, 0o600);
    } catch {
      // ignore chmod failures on platforms that don't support it
    }
  };

  const mintIdentity = (relayUrl?: string): SyncCloudRelayConfig => ({
    machineKey: randomBytes(16).toString("hex"),
    secret: randomBytes(24).toString("hex"),
    ...(relayUrl ? { relayUrl } : {}),
  });

  const normalize = (raw: SyncCloudRelayFile): {
    config: SyncCloudRelayConfig;
    needsIdentityWrite: boolean;
    needsWrite: boolean;
  } => {
    const validMachineKey = typeof raw.machineKey === "string"
      && /^[a-f0-9]{32,64}$/i.test(raw.machineKey)
      ? raw.machineKey
      : null;
    const validSecret = typeof raw.secret === "string" && raw.secret.length >= 32
      ? raw.secret
      : null;
    const generated = validMachineKey && validSecret ? null : mintIdentity();
    // A machine key and secret are one relay credential. If either half is
    // invalid, never combine the surviving half with a newly minted value.
    const machineKey = generated?.machineKey ?? validMachineKey;
    const secret = generated?.secret ?? validSecret;
    if (!machineKey || !secret) {
      throw new Error("Could not mint the ADE Relay machine identity.");
    }
    const needsIdentityWrite = raw.machineKey !== machineKey || raw.secret !== secret;
    const hasDeprecatedKillSwitchFields = Object.prototype.hasOwnProperty.call(raw, "enabled")
      || Object.prototype.hasOwnProperty.call(raw, "enabledSetByUser");
    return {
      config: {
        machineKey,
        secret,
        relayUrl: typeof raw.relayUrl === "string" && raw.relayUrl.trim() ? raw.relayUrl.trim() : undefined,
      },
      needsIdentityWrite,
      needsWrite: needsIdentityWrite || hasDeprecatedKillSwitchFields,
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

  const configWhileLocked = (): SyncCloudRelayConfig => {
    const latest = normalize(read());
    if (latest.needsIdentityWrite) throw busyError();
    return latest.config;
  };

  const updateConfig = (
    update: (current: SyncCloudRelayConfig) => { config: SyncCloudRelayConfig; changed: boolean },
    onLocked?: () => SyncCloudRelayConfig,
    waitMs = lockWaitMs,
  ): SyncCloudRelayConfig => {
    const lease = acquireRotationLockWithWait(waitMs);
    if (!lease) {
      if (onLocked) return onLocked();
      throw busyError();
    }
    try {
      // Read only after acquiring the shared lock so every whole-file update
      // is based on the latest identity and relay URL.
      const current = normalize(read());
      const result = update(current.config);
      if (current.needsWrite || result.changed) write(result.config);
      return result.config;
    } finally {
      releaseRotationLock(lease);
    }
  };

  // Reads the file and fills in a freshly generated identity when absent,
  // persisting it so the machineKey stays stable across restarts.
  const load = (): SyncCloudRelayConfig => {
    const current = normalize(read());
    if (!current.needsWrite) return current.config;
    return updateConfig(
      (latest) => ({ config: latest, changed: false }),
      configWhileLocked,
    );
  };

  return {
    getConfig(): SyncCloudRelayConfig {
      return load();
    },

    getMachineIdentity(): { machineKey: string; secret: string } {
      const { machineKey, secret } = load();
      return { machineKey, secret };
    },

    getRelayUrl(): string {
      return load().relayUrl ?? defaultRelayUrl();
    },

    setRelayUrl(relayUrl: string | null): SyncCloudRelayConfig {
      return updateConfig((current) => ({
        config: { ...current, relayUrl: relayUrl?.trim() || undefined },
        changed: true,
      }));
    },

    /**
     * Replaces a relay identity only when the caller is still looking at the
     * expected machine key. The exclusive sibling lock serializes brain
     * processes so exactly one confirmed-conflict recovery wins.
     */
    rotateMachineIdentity(expectedMachineKey: string): SyncCloudRelayConfig {
      return updateConfig((current) => {
        if (current.machineKey !== expectedMachineKey) {
          return { config: current, changed: false };
        }
        const next = mintIdentity(current.relayUrl);
        return { config: next, changed: true };
      }, configWhileLocked, 0);
    },

    /** `wss://<host>/connect/<machineKey>` — the value the QR integration reads. */
    getRelayWssUrl(): string {
      const { relayUrl, machineKey } = load();
      return deriveRelayWssConnectUrl(relayUrl ?? defaultRelayUrl(), machineKey);
    },
  };
}
