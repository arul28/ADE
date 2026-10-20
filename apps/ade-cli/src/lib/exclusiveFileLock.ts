import fs from "node:fs";
import path from "node:path";

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

function unlinkExclusiveFileLockIfStale(lockPath: string): boolean {
  try {
    const stat = fs.statSync(lockPath);
    const owner = readExclusiveFileLockOwner(lockPath);
    if (owner.pid != null && processExists(owner.pid)) return false;
    if (owner.pid == null && Date.now() - stat.mtimeMs <= 30_000) return false;
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

/**
 * Runs `task` while holding the lock at `lockPath`. A current holder is waited
 * for for up to `waitMs`; past that this throws ExclusiveFileLockTimeoutError
 * and `task` never runs. `label` names the lock in that error's message.
 */
export async function withExclusiveFileLock<T>(
  lockPath: string,
  task: () => Promise<T>,
  options: { waitMs: number; label: string },
): Promise<T> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + options.waitMs;
  const owner = createExclusiveFileLockOwner();
  let fd: number | null = null;
  while (fd == null) {
    let created: number;
    try {
      created = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isExclusiveFileLockContention(error)) throw error;
      if (unlinkExclusiveFileLockIfStale(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new ExclusiveFileLockTimeoutError(
          `Timed out waiting for ${options.label} at ${lockPath}.`,
          { cause: error },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
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
    fd = created;
  }

  try {
    return await task();
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    unlinkExclusiveFileLockIfOwner(lockPath, owner.id);
  }
}
