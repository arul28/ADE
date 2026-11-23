import fs from "node:fs";
import path from "node:path";
import { computerBootedAtMs, processStartTimeReader } from "../../../desktop/src/main/services/processes/processStartTime";

/**
 * Cross-process mutual exclusion over one lock file.
 *
 * The claim is one atomic `open(path, "wx")`, so two processes cannot both hold
 * it, and the check and the claim are the same step. The owner record (id and
 * pid) lets a waiter reap a lock whose owner is gone, so a crashed or killed
 * holder cannot wedge the machine. Callers choose the lock path, how long to
 * wait, and how they name the lock in the error they get on a timeout.
 */

type ExclusiveFileLockOwner = {
  id: string | null;
  pid: number | null;
};

/** The lock was still held by another owner when the wait budget ran out. */
export class ExclusiveFileLockTimeoutError extends Error {}

function createExclusiveFileLockOwner(): ExclusiveFileLockOwner {
  return {
    id: `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    pid: process.pid,
  };
}

function serializeExclusiveFileLockOwner(owner: ExclusiveFileLockOwner): string {
  return JSON.stringify({
    id: owner.id,
    pid: owner.pid,
    createdAt: new Date().toISOString(),
  });
}

function readExclusiveFileLockOwner(lockPath: string): ExclusiveFileLockOwner {
  const raw = fs.readFileSync(lockPath, "utf8");
  try {
    const parsed = JSON.parse(raw) as { id?: unknown; pid?: unknown };
    return {
      id: typeof parsed.id === "string" ? parsed.id : null,
      pid: typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0
        ? parsed.pid
        : null,
    };
  } catch {
    const [pidLine] = raw.split(/\r?\n/u);
    const pid = Number.parseInt(pidLine ?? "", 10);
    return {
      id: null,
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    };
  }
}

// Signal 0 only asks whether the pid exists. A pid recycled by an unrelated
// process reads as alive, so a stale lock then waits out the caller's budget
// instead of being reaped. Same limit the spawn lock has always had.
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** `ps lstart` is whole-second; mirrors the 2 s window the sync-host singleton uses. */
const LOCK_OWNER_START_TOLERANCE_MS = 2_000;
/** A record written before this boot cannot have a live writer when the start time is unavailable. */
const LOCK_WRITER_BOOT_SLACK_MS = 60_000;
/**
 * Captured once: `computerBootedAtMs` follows the wall clock, so reading it
 * again after a forward clock step could make a live holder look pre-boot.
 */
const COMPUTER_BOOTED_AT_MS = computerBootedAtMs();

/**
 * Whether the recorded pid is still the process that wrote the lock. A recycled
 * pid belongs to a process that started after the write, so its start time is
 * later than the lock's; a genuine holder started before writing it.
 */
function lockOwnerStillRuns(
  pid: number,
  writtenAtMs: number,
  startTimeOf: (pid: number) => number | null,
): boolean {
  if (!processExists(pid)) return false;
  const startedAtMs = startTimeOf(pid);
  if (startedAtMs != null) return startedAtMs - writtenAtMs <= LOCK_OWNER_START_TOLERANCE_MS;
  return writtenAtMs > COMPUTER_BOOTED_AT_MS - LOCK_WRITER_BOOT_SLACK_MS;
}

// A contended `open(..., "wx")` reports EEXIST -- on Windows too.
//
// This branch used to also treat EPERM/EACCES as contention, on the theory that
// Windows leaves a delete-pending name behind after the holder's unlink. That
// is FALSE for these locks: libuv opens with FILE_SHARE_DELETE, so unlink-while-
// open succeeds immediately and the next `open(..., "wx")` succeeds too. A
// 10-process contention run on Windows 11 26200 produced ONLY EEXIST, zero
// mutual-exclusion violations, and no leaked lock file.
//
// Keeping EPERM/EACCES in here had a real cost: a GENUINE permission denial on
// the lock directory (ACLs, EDR, a redirected profile) was retried as if it were
// contention, so every caller burned the full wait and then reported a timeout
// instead of the permission error the user could act on. EBUSY stays: it is what
// a sharing-mode conflict from an antivirus scanner holding the file surfaces as,
// and that one genuinely does resolve on its own.
function isExclusiveFileLockContention(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "EEXIST") return true;
  if (process.platform !== "win32") return false;
  return code === "EBUSY";
}

/**
 * Remove a lock whose owner is gone. With `staleAfterMs`, a lock older than
 * that is gone too, whatever its pid says: a pid can be reused by a live
 * process after the holder crashed, and a lock held only for a quick write
 * is never that old.
 */
function unlinkExclusiveFileLockIfStale(
  lockPath: string,
  staleAfterMs?: number,
  startTimeOf: (pid: number) => number | null = () => null,
): boolean {
  try {
    const stat = fs.statSync(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (staleAfterMs === undefined || ageMs <= staleAfterMs) {
      const owner = readExclusiveFileLockOwner(lockPath);
      // The lock file is written once and never heartbeated, so its mtime is
      // the write time.
      if (owner.pid != null && lockOwnerStillRuns(owner.pid, stat.mtimeMs, startTimeOf)) return false;
      if (owner.pid == null && ageMs <= 30_000) return false;
    }
    // The lock may have been replaced between the stat and the owner read; the
    // evidence would then describe a file that is no longer there.
    const current = fs.statSync(lockPath);
    if (
      current.mtimeMs !== stat.mtimeMs
      || current.ino !== stat.ino
      || current.size !== stat.size
    ) {
      return false;
    }
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function unlinkExclusiveFileLockIfOwner(lockPath: string, ownerId: string | null): void {
  if (!ownerId) return;
  try {
    const owner = readExclusiveFileLockOwner(lockPath);
    if (owner.id !== ownerId) return;
    fs.unlinkSync(lockPath);
  } catch {
    // ignore cleanup races
  }
}

type ExclusiveFileLockOptions = {
  waitMs: number;
  label: string;
  /** Treat a lock older than this as abandoned, whatever its pid (see `unlinkExclusiveFileLockIfStale`). */
  staleAfterMs?: number;
};

/**
 * One attempt to take the lock: the open file when it is ours, null when the
 * caller should wait and try again. Throws the timeout error once the
 * deadline has passed, and any error that is not contention.
 */
function tryClaimExclusiveFileLock(
  lockPath: string,
  owner: ExclusiveFileLockOwner,
  deadline: number,
  options: ExclusiveFileLockOptions,
  startTimeOf: (pid: number) => number | null,
): number | null {
  let created: number | null = null;
  while (created == null) {
    try {
      created = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isExclusiveFileLockContention(error)) throw error;
      // The holder is gone: the lock is free now, so claim it right away.
      if (unlinkExclusiveFileLockIfStale(lockPath, options.staleAfterMs, startTimeOf)) continue;
      if (Date.now() >= deadline) {
        throw new ExclusiveFileLockTimeoutError(
          `Timed out waiting for ${options.label} at ${lockPath}.`,
          { cause: error },
        );
      }
      return null;
    }
  }
  // The file is ours now. If its owner record cannot be written, give it back
  // rather than hold (or strand) a lock nobody can identify.
  try {
    fs.writeFileSync(created, serializeExclusiveFileLockOwner(owner), "utf8");
  } catch (error) {
    try { fs.closeSync(created); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
    throw error;
  }
  return created;
}

function releaseExclusiveFileLock(fd: number, lockPath: string, owner: ExclusiveFileLockOwner): void {
  try {
    fs.closeSync(fd);
  } catch {}
  unlinkExclusiveFileLockIfOwner(lockPath, owner.id);
}

/**
 * Runs `task` while holding the lock at `lockPath`. A current holder is waited
 * for for up to `waitMs`; past that this throws ExclusiveFileLockTimeoutError
 * and `task` never runs. `label` names the lock in that error's message.
 */
export async function withExclusiveFileLock<T>(
  lockPath: string,
  task: () => Promise<T>,
  options: ExclusiveFileLockOptions,
): Promise<T> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + options.waitMs;
  const owner = createExclusiveFileLockOwner();
  const startTimeOf = processStartTimeReader();
  let fd = tryClaimExclusiveFileLock(lockPath, owner, deadline, options, startTimeOf);
  while (fd == null) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    fd = tryClaimExclusiveFileLock(lockPath, owner, deadline, options, startTimeOf);
  }
  try {
    return await task();
  } finally {
    releaseExclusiveFileLock(fd, lockPath, owner);
  }
}

const SYNC_RETRY_MS = 15;
const syncSleepCell = new Int32Array(new SharedArrayBuffer(4));

/**
 * `withExclusiveFileLock` for synchronous callers. The wait blocks the
 * thread, so keep `waitMs` short and the task small: a read and a write of
 * one file, never a child process or a network call.
 */
export function withExclusiveFileLockSync<T>(
  lockPath: string,
  task: () => T,
  options: ExclusiveFileLockOptions,
): T {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + options.waitMs;
  const owner = createExclusiveFileLockOwner();
  const startTimeOf = processStartTimeReader();
  let fd = tryClaimExclusiveFileLock(lockPath, owner, deadline, options, startTimeOf);
  while (fd == null) {
    Atomics.wait(syncSleepCell, 0, 0, SYNC_RETRY_MS);
    fd = tryClaimExclusiveFileLock(lockPath, owner, deadline, options, startTimeOf);
  }
  try {
    return task();
  } finally {
    releaseExclusiveFileLock(fd, lockPath, owner);
  }
}
