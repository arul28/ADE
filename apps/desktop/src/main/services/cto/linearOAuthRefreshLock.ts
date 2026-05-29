import fs from "node:fs";
import path from "node:path";

const LOCK_FILE = "linear-oauth-refresh.lock";
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 25;

export class LinearOAuthRefreshLockTimeoutError extends Error {
  constructor() {
    super("Timed out waiting for Linear OAuth refresh lock.");
    this.name = "LinearOAuthRefreshLockTimeoutError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function removeStaleLock(lockPath: string): void {
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // ignore
  }
}

/**
 * Serialize Linear OAuth refresh across ADE runtimes (desktop + ade serve) that
 * share the same encrypted credential store. Linear rotates refresh tokens on
 * each exchange, so concurrent refreshes can cause the loser to get
 * invalid_grant and wipe a still-valid connection.
 */
export async function withLinearOAuthRefreshLock<T>(
  secretsDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  fs.mkdirSync(secretsDir, { recursive: true });
  const lockPath = path.join(secretsDir, LOCK_FILE);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number | null = null;

  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      removeStaleLock(lockPath);
      if (Date.now() >= deadline) {
        throw new LinearOAuthRefreshLockTimeoutError();
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
