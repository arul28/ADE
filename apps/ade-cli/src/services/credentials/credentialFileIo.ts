import fs from "node:fs";
import path from "node:path";

/**
 * File-level plumbing shared by everything that reads or writes an ADE
 * credential file: private-mode creation, atomic replacement, the cross-process
 * advisory lock, and the stat-poll change watcher.
 *
 * Split out of `credentialStore.ts` because it is infrastructure, not policy —
 * the store decides which key seals a file and what to do when it cannot be
 * read; nothing here knows what a credential is. The quarantine module needs the
 * same primitives, which is what forced the seam.
 */

/**
 * How long a writer waits for the credential-file lock before giving up.
 *
 * Exported because cross-process protocols layered on the credential store have
 * to out-wait it. In particular the account service polls for a peer's rotated
 * refresh token after a definitive `invalid_grant`: if that poll window were
 * shorter than this timeout, a peer that legitimately won the exchange but is
 * still queued behind the lock would have its session declared dead by the
 * loser.
 */
export const CREDENTIAL_FILE_LOCK_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_MS = CREDENTIAL_FILE_LOCK_TIMEOUT_MS;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 25;

type CredentialLockMetadata = {
  pid?: number;
  createdAt?: string;
};

export function ensureMode600(filePath: string): void {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort; some filesystems do not support chmod.
  }
}

export function ensureDirMode700(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch {
    // Best effort; some filesystems do not support chmod.
  }
}

export function writeFileAtomic(filePath: string, contents: string | Buffer): void {
  ensureDirMode700(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, contents, { mode: 0o600 });
  ensureMode600(tmpPath);
  fs.renameSync(tmpPath, filePath);
  ensureMode600(filePath);
}

export function isEnoent(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

export function isEexist(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "EEXIST";
}

/**
 * Windows does not report lock contention as EEXIST the way POSIX does.
 *
 * Deleting a file on Windows only unlinks the name once every open handle to it
 * closes, so between one holder's unlink and the last handle drop the lock name
 * still occupies the directory in a "delete pending" state. A concurrent
 * `open(lockPath, "wx")` against that name fails with a delete-pending or
 * sharing violation, which Node surfaces as EPERM, EACCES or EBUSY instead of
 * EEXIST. Those are the same "someone else holds it, try again" condition, so
 * they have to keep the acquisition loop running; treating them as fatal makes
 * every concurrent credential write a coin flip on Windows.
 */
export function isLockContention(error: unknown): boolean {
  if (isEexist(error)) return true;
  if (process.platform !== "win32") return false;
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function defaultLockPath(credentialsPath: string): string {
  return `${credentialsPath}.lock`;
}

export function isSamePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

export type CredentialFileStatSnapshot = {
  ino: number;
  mtimeMs: number;
  size: number;
} | null;

function readCredentialFileStatSnapshot(filePath: string): CredentialFileStatSnapshot | undefined {
  try {
    const stat = fs.statSync(filePath);
    return { ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (error: unknown) {
    if (isEnoent(error)) return null;
    return undefined;
  }
}

function isSameCredentialFileStat(
  left: CredentialFileStatSnapshot,
  right: CredentialFileStatSnapshot,
): boolean {
  if (left === null || right === null) return left === right;
  return left.ino === right.ino
    && left.mtimeMs === right.mtimeMs
    && left.size === right.size;
}

export class CredentialFileStatWatcher {
  private previous: CredentialFileStatSnapshot | undefined;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly filePath: string,
    private readonly listener: () => void,
    private readonly intervalMs: number | null,
  ) {}

  start(): void {
    this.previous = readCredentialFileStatSnapshot(this.filePath);
    if (this.intervalMs === null) return;
    this.timer = setInterval(() => this.checkNow(), this.intervalMs);
    this.timer.unref();
  }

  checkNow(): void {
    const current = readCredentialFileStatSnapshot(this.filePath);
    if (current === undefined) return;
    if (this.previous === undefined) {
      this.previous = current;
      return;
    }
    if (isSameCredentialFileStat(current, this.previous)) return;
    this.previous = current;
    try {
      this.listener();
    } catch {
      // Credential observers are best-effort; one subscriber must not stop
      // the watcher or prevent sibling subscribers from seeing the change.
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function parseLockMetadata(raw: string): CredentialLockMetadata {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    return {
      pid: Number.isSafeInteger(record.pid) && Number(record.pid) > 0 ? Number(record.pid) : undefined,
      createdAt: typeof record.createdAt === "string" ? record.createdAt : undefined,
    };
  } catch {
    return {};
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !(
      typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { code?: unknown }).code === "ESRCH"
    );
  }
}

function isSameLockStat(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function removeStaleLock(lockPath: string): void {
  let originalStat: fs.Stats;
  let originalRaw: string;
  try {
    originalStat = fs.statSync(lockPath);
    if (Date.now() - originalStat.mtimeMs <= LOCK_STALE_MS) return;
    originalRaw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return;
  }

  const metadata = parseLockMetadata(originalRaw);
  if (metadata.pid && isProcessRunning(metadata.pid)) return;

  try {
    const currentStat = fs.statSync(lockPath);
    if (!isSameLockStat(currentStat, originalStat)) return;
    if (fs.readFileSync(lockPath, "utf8") !== originalRaw) return;
    fs.unlinkSync(lockPath);
  } catch {
    // Another process won the lock race or removed the stale file first.
  }
}

export function withCredentialFileLock<T>(
  lockPath: string,
  fn: () => T,
  options: { timeoutMs?: number } = {},
): T {
  ensureDirMode700(path.dirname(lockPath));
  const deadline = Date.now() + (options.timeoutMs ?? LOCK_TIMEOUT_MS);
  let fd: number | null = null;

  while (fd === null) {
    try {
      const candidateFd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(
          candidateFd,
          JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
        );
        fd = candidateFd;
      } catch (error: unknown) {
        try {
          fs.closeSync(candidateFd);
        } catch {
          // ignore
        }
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // ignore
        }
        throw error;
      }
      ensureMode600(lockPath);
    } catch (error: unknown) {
      if (!isLockContention(error)) throw error;
      removeStaleLock(lockPath);
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for ADE credential store lock.", { cause: error });
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }

  try {
    return fn();
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

export function unlinkIfExists(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error: unknown) {
    if (!isEnoent(error)) throw error;
  }
}

export function withOptionalCredentialFileLock<T>(lockPath: string, skippedLockPath: string, fn: () => T): T {
  if (isSamePath(lockPath, skippedLockPath)) return fn();
  return withCredentialFileLock(lockPath, fn);
}

export function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch (error: unknown) {
    if (isEnoent(error)) return {};
    throw error;
  }
}

export async function readJsonObjectAsync(filePath: string): Promise<{
  value: Record<string, unknown> | null;
  exists: boolean;
}> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { value: null, exists: true };
    }
    return { value: parsed as Record<string, unknown>, exists: true };
  } catch (error: unknown) {
    if (isEnoent(error)) return { value: {}, exists: false };
    throw error;
  }
}
