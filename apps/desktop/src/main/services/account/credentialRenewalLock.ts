import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const LOCK_RETRY_MS = 25;

export class CredentialRenewalLockTimeoutError extends Error {
  constructor(message = "Timed out waiting for a credential renewal lock.") {
    super(message);
    this.name = "CredentialRenewalLockTimeoutError";
  }
}

export type CredentialRenewalLockOptions = {
  /** How long to wait for another process before giving up. */
  timeoutMs?: number;
  /** A lock file older than this is a crashed holder's and is removed. */
  staleMs?: number;
  /** Error to throw on timeout, so callers keep their own error types. */
  timeoutError?: () => Error;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function removeStaleLock(lockPath: string, staleMs: number): void {
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > staleMs) fs.unlinkSync(lockPath);
  } catch {
    // Gone already, or (Windows) still held open by its owner.
  }
}

/**
 * A lock file name for an arbitrary credential key. Vault keys hold `/` and
 * `:`, which are not file-name characters on Windows, so the key is hashed.
 */
export function credentialRenewalLockFileName(prefix: string, key: string): string {
  const digest = crypto.createHash("sha256").update(key).digest("hex").slice(0, 24);
  return `${prefix}-${digest}.lock`;
}

/**
 * Serialize one credential's renewal across the processes on this computer.
 *
 * The desktop app and the brain share a sync device id, so the account vault's
 * refresh owner cannot tell them apart. An exclusive-create file (`wx`) is the
 * one primitive that behaves the same on macOS, Linux and Windows.
 */
export async function withCredentialRenewalLock<T>(
  lockDir: string,
  fileName: string,
  fn: () => Promise<T>,
  options: CredentialRenewalLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const staleMs = options.staleMs ?? 10_000;
  fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, fileName);
  const deadline = Date.now() + timeoutMs;
  let fd: number | null = null;

  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows answers EPERM/EBUSY while a stale file is being removed.
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EBUSY") throw error;
      removeStaleLock(lockPath, staleMs);
      if (Date.now() >= deadline) {
        throw options.timeoutError?.() ?? new CredentialRenewalLockTimeoutError();
      }
      await sleep(LOCK_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}
