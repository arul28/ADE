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
      return { kind: "acquired", release: startHeartbeat(lockPath, staleMs) };
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw asToolError(error, { kind: "filesystem" });
      }
    }

    if (isSatisfied?.()) return { kind: "satisfied" };

    if (isLockStale(lockPath, staleMs, now())) {
      // Best-effort takeover. Losing this race is fine: the loop re-attempts
      // the O_EXCL create and only one process can win it.
      await fsp.rm(lockPath, { force: true }).catch(() => undefined);
      continue;
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

function startHeartbeat(lockPath: string, staleMs: number): () => Promise<void> {
  const timer = setInterval(() => {
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
    await fsp.rm(lockPath, { force: true }).catch(() => undefined);
  };
}
