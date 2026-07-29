import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Remembers the last brain this machine spawned for a given RPC socket.
 *
 * Every `ade` command that fails to reach the brain spawns one, detached and
 * unref'd, and then forgets it — so N failing commands leak N immortal brains.
 * We found 18 stacked on one dev socket, each one signed in and each one
 * dialing the relay, which is how a machine ends up evicting its own relay
 * connection in a loop.
 *
 * The record is deliberately advisory: it suppresses a *duplicate* spawn while
 * a previously spawned brain is still coming up, and expires so a genuinely
 * wedged brain never blocks recovery forever.
 */

export type RuntimeSpawnRecord = {
  pid: number;
  socketPath: string;
  spawnedAtMs: number;
};

/** How long a recorded spawn suppresses another one. */
export const RUNTIME_SPAWN_RECORD_GRACE_MS = 30_000;

function recordDir(): string {
  return path.join(os.tmpdir(), "ade-runtime-spawns");
}

export function runtimeSpawnRecordPath(socketPath: string): string {
  // Socket paths are absolute and may collide on basename alone, so key on the
  // full path with separators flattened.
  const key = socketPath.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(-120);
  return path.join(recordDir(), `${key}.json`);
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readRuntimeSpawnRecord(socketPath: string): RuntimeSpawnRecord | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(runtimeSpawnRecordPath(socketPath), "utf8"),
    ) as Partial<RuntimeSpawnRecord> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const pid = Number(parsed.pid);
    const spawnedAtMs = Number(parsed.spawnedAtMs);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(spawnedAtMs)) return null;
    return { pid, socketPath, spawnedAtMs };
  } catch {
    return null;
  }
}

export function recordRuntimeSpawn(socketPath: string, pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const record: RuntimeSpawnRecord = { pid, socketPath, spawnedAtMs: Date.now() };
  try {
    fs.mkdirSync(recordDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(runtimeSpawnRecordPath(socketPath), JSON.stringify(record), {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // The record is an optimization; never fail a spawn over it.
  }
}

/**
 * True when a brain we spawned for this socket is still alive and recent
 * enough that spawning another would just add a rival, not fix anything.
 */
export function hasRecentRuntimeSpawn(
  socketPath: string,
  now = Date.now(),
  graceMs = RUNTIME_SPAWN_RECORD_GRACE_MS,
): boolean {
  const record = readRuntimeSpawnRecord(socketPath);
  if (!record) return false;
  if (now - record.spawnedAtMs > graceMs) return false;
  return processAlive(record.pid);
}
