import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolError, asToolError } from "./errors";

/**
 * A holder refreshes the lock's mtime every `STALE_LOCK_MS / 4`, so a lock that
 * has not been touched in this long belongs to a process that died mid-install.
 * Long downloads never trip it — only crashes do.
 */
export const STALE_LOCK_MS = 60_000;
export const LOCK_POLL_INTERVAL_MS = 250;
/**
 * Generous by design: the waiter is blocked on someone else downloading up to
 * ~300 MB, and the alternative to waiting is two processes racing on the same
 * cache directory.
 */
export const LOCK_TIMEOUT_MS = 15 * 60_000;

type LockRecord = {
  pid: number;
  host: string;
  startedAt: string;
};

export type ToolLockAcquisition =
  | { kind: "acquired"; release: () => Promise<void> }
  /** Someone else finished the work while we waited; there is nothing to do. */
  | { kind: "satisfied" };

export type ToolLockOptions = {
  lockPath: string;
  /** Polled before each attempt and between waits — typically the install sentinel. */
  isSatisfied?: () => boolean;
  onWait?: (waitedMs: number) => void;
  staleMs?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockRecord(lockPath: string): LockRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.pid === "number" && typeof record.host === "string") {
        return { pid: record.pid, host: record.host, startedAt: String(record.startedAt ?? "") };
      }
    }
  } catch {
    // Unreadable or half-written lock; fall back to mtime alone.
  }
  return null;
}

/**
 * Windows does not report lock contention as EEXIST the way POSIX does.
 *
 * Deleting a file on Windows only unlinks the name once every open handle to it
 * closes, so between one holder's unlink and the last handle drop the name
 * still occupies the directory in a "delete pending" state. A concurrent
 * `open(lockPath, "wx")` against that name fails with a delete-pending or
 * sharing violation, which Node surfaces as EPERM, EACCES or EBUSY instead of
 * EEXIST — the same "someone else holds it, try again" condition. Treating any
 * of them as fatal turns a benign race between two ADE processes into a hard
 * install failure. Mirrors `isLockContention` in
 * services/credentials/credentialStore.ts.
 *
 * `socketSpawnLock.ts` deliberately narrows its own version of this to EBUSY,
 * because there a genuine ACL denial retried as contention burned its whole
 * 10s deadline and hid an actionable error. That trade-off comes out the other
 * way here: this lock is held for *minutes* by a legitimate holder downloading
 * hundreds of megabytes, so the delete-pending window is wide and constantly
 * hit, and a genuine denial still terminates on its own — as a `lock-timeout`
 * ToolError naming the holder, not an unbounded hang.
 */
export function isToolLockContention(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "EEXIST") return true;
  if (process.platform !== "win32") return false;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

function isLockStale(lockPath: string, staleMs: number, now: number): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch {
    // Vanished between the failed create and this stat: retry immediately.
    return true;
  }
  if (now - mtimeMs > staleMs) return true;
  const record = readLockRecord(lockPath);
  // A dead PID only proves the holder is gone when the lock was taken on this
  // machine; a shared network home could carry another host's live PID number.
  return record != null && record.host === os.hostname() && !isProcessAlive(record.pid);
}

/**
 * Cross-process single-flight around one package@version install.
 *
 * `O_EXCL` create is the primitive on every platform ADE ships to. The file
 * descriptor is closed immediately after the record is written, so a stale-lock
 * takeover never has to delete a file another process holds open — which is the
 * failure mode that would make this unusable on Windows.
 */
export async function acquireToolLock(options: ToolLockOptions): Promise<ToolLockAcquisition> {
  const {
    lockPath,
    isSatisfied,
    onWait,
    staleMs = STALE_LOCK_MS,
    pollIntervalMs = LOCK_POLL_INTERVAL_MS,
    timeoutMs = LOCK_TIMEOUT_MS,
    now = Date.now,
    sleep = defaultSleep,
  } = options;

  await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  const startedAt = now();

  for (;;) {
    if (isSatisfied?.()) return { kind: "satisfied" };

    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fsp.open(lockPath, "wx");
      const record: LockRecord = { pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() };
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.close();
      handle = null;
      return { kind: "acquired", release: startHeartbeat(lockPath, staleMs, record) };
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if (!isToolLockContention(error)) {
        throw asToolError(error, { kind: "filesystem" });
      }
    }

    if (isSatisfied?.()) return { kind: "satisfied" };

    // The deadline is checked before the takeover so that a lock which reads as
    // permanently stale but cannot be removed (an unremovable file, a denied
    // directory) still terminates instead of spinning this branch's `continue`
    // forever without ever reaching the timeout below.
    if (now() - startedAt < timeoutMs && isLockStale(lockPath, staleMs, now())) {
      // Best-effort takeover. Losing this race is fine: the loop re-attempts
      // the O_EXCL create and only one process can win it.
      const removed = await fsp.rm(lockPath, { force: true }).then(() => true).catch(() => false);
      // Only retry immediately when the name is actually gone. A stale lock
      // that cannot be removed — an unremovable file, a denied directory, a
      // Windows handle still open on it — reads as stale on every pass, so an
      // unconditional `continue` would spin this branch with no sleep for the
      // whole (15 minute) deadline, burning a core in syscalls. Falling through
      // makes that case poll like any other contention and still terminate on
      // the timeout below.
      if (removed) continue;
    }

    const waited = now() - startedAt;
    if (waited >= timeoutMs) {
      const record = readLockRecord(lockPath);
      throw new ToolError(
        `Timed out after ${Math.round(waited / 1000)}s waiting for another ADE process`
        + `${record ? ` (pid ${record.pid} on ${record.host})` : ""} to finish installing agent tools.`,
        { kind: "lock-timeout" },
      );
    }
    onWait?.(waited);
    await sleep(pollIntervalMs);
  }
}

function startHeartbeat(lockPath: string, staleMs: number, owned: LockRecord): () => Promise<void> {
  const timer = setInterval(() => {
    // Only refresh a lock that is still ours. If this process stalled long
    // enough to be declared stale, the path now holds another process's record,
    // and touching it would keep *their* lock looking fresh for as long as this
    // process lives — so if that holder then died, nobody could ever take it
    // over. An unreadable record is left alone rather than treated as foreign:
    // a half-written record is transient, and stopping on one would give up the
    // heartbeat for a lock we still hold.
    const current = readLockRecord(lockPath);
    if (current && (current.pid !== owned.pid || current.host !== owned.host)) {
      clearInterval(timer);
      return;
    }
    try {
      const stamp = new Date();
      fs.utimesSync(lockPath, stamp, stamp);
    } catch {
      // The lock was taken over or removed; release() will still be a no-op.
    }
  }, Math.max(1_000, Math.floor(staleMs / 4)));
  timer.unref?.();

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    // Only unlink a lock that is still *ours*. If our heartbeat stalled long
    // enough for the acquisition loop above to declare this lock stale, another
    // process has already rm'd it and created its own record under the same
    // path — an unconditional rm here would silently release someone else's
    // lock and let two installs race the same cache directory. An unreadable
    // record counts as not-ours: leaving a lock behind costs one stale-takeover
    // cycle, deleting the wrong one costs correctness.
    try {
      const current = readLockRecord(lockPath);
      if (!current || current.pid !== owned.pid || current.host !== owned.host) return;
      await fsp.rm(lockPath, { force: true });
    } catch {
      // Release is always best-effort; a leftover lock ages out via staleMs.
    }
  };
}
