import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveMachineAdeLayout } from "../projects/machineLayout";

/**
 * Cross-process mutual exclusion for "spawn a brain for this socket".
 *
 * Every failing `ade` command and every `ade code` launch can spawn a detached
 * brain, so without a lock a burst of commands races: each one checks, each one
 * finds nothing, and each one spawns. That is how a machine ends up with a pile
 * of immortal brains fighting over the same relay slot. An advisory record
 * alone cannot fix it — the check and the spawn must be one atomic claim.
 *
 * The lock lives next to the socket, is released on completion, and is reaped
 * when its owning pid is gone (or, for an unreadable lock, after 30s) so a
 * crashed spawner cannot wedge the machine.
 */

type SocketSpawnLockOwner = {
  id: string | null;
  pid: number | null;
};

function createSocketSpawnLockOwner(): SocketSpawnLockOwner {
  return {
    id: `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    pid: process.pid,
  };
}

function serializeSocketSpawnLockOwner(owner: SocketSpawnLockOwner): string {
  return JSON.stringify({
    id: owner.id,
    pid: owner.pid,
    createdAt: new Date().toISOString(),
  });
}

function readSocketSpawnLockOwner(lockPath: string): SocketSpawnLockOwner {
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

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// A contended `open(..., "wx")` reports EEXIST on POSIX, but Windows keeps a
// deleted name in the directory until the last handle closes. Between the
// holder's unlink and that final drop, a contending open hits the
// delete-pending name and Node surfaces EPERM, EACCES or EBUSY instead. Those
// are contention, not failure, so the caller must wait rather than abort --
// this is the brain-spawn path, where burst contention is the normal case.
function isSocketSpawnLockContention(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "EEXIST") return true;
  if (process.platform !== "win32") return false;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

function unlinkSocketSpawnLockIfStale(lockPath: string): boolean {
  try {
    const stat = fs.statSync(lockPath);
    const owner = readSocketSpawnLockOwner(lockPath);
    if (owner.pid != null && processExists(owner.pid)) return false;
    if (owner.pid == null && Date.now() - stat.mtimeMs <= 30_000) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function unlinkSocketSpawnLockIfOwner(lockPath: string, ownerId: string | null): void {
  if (!ownerId) return;
  try {
    const owner = readSocketSpawnLockOwner(lockPath);
    if (owner.id !== ownerId) return;
    fs.unlinkSync(lockPath);
  } catch {
    // ignore cleanup races
  }
}

function isWindowsNamedPipePath(socketPath: string): boolean {
  return socketPath
    .trim()
    .replace(/\//g, "\\")
    .toLowerCase()
    .startsWith("\\\\.\\pipe\\");
}

export function socketSpawnLockPath(socketPath: string): string {
  if (isWindowsNamedPipePath(socketPath)) {
    // A named pipe is a kernel namespace, not a filesystem directory. Trying
    // to create `\\.\pipe\<name>.spawn.lock` fails with ENOENT before a cold
    // Windows runtime can be spawned. Keep the advisory lock in ADE's
    // per-user runtime directory and hash the case-insensitive pipe identity.
    const normalizedPipe = socketPath.trim().replace(/\//g, "\\").toLowerCase();
    const key = createHash("sha256")
      .update(normalizedPipe)
      .digest("hex")
      .slice(0, 32);
    return path.join(
      resolveMachineAdeLayout().runtimeDir,
      "spawn-locks",
      `${key}.lock`,
    );
  }
  return path.join(
    path.dirname(socketPath),
    `${path.basename(socketPath)}.spawn.lock`,
  );
}

export async function withSocketSpawnLock<T>(socketPath: string, task: () => Promise<T>): Promise<T> {
  if (socketPath.startsWith("tcp://")) return await task();
  const lockPath = socketSpawnLockPath(socketPath);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 10_000;
  const owner = createSocketSpawnLockOwner();
  let fd: number | null = null;
  while (fd == null) {
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, serializeSocketSpawnLockOwner(owner), "utf8");
      break;
    } catch (error) {
      if (!isSocketSpawnLockContention(error)) throw error;
      if (unlinkSocketSpawnLockIfStale(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ADE socket spawn lock at ${lockPath}.`, { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  try {
    return await task();
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    unlinkSocketSpawnLockIfOwner(lockPath, owner.id);
  }
}
