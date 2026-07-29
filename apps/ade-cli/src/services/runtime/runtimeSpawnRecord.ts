import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveMachineAdeLayout } from "../projects/machineLayout";

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

/**
 * How long a recorded spawn suppresses another one. Sized to a cold brain
 * start on a large repo, which is the window during which a second spawn is
 * pure harm; past it, a brain that still has not bound its socket is wedged
 * and a replacement is the right answer.
 */
export const RUNTIME_SPAWN_RECORD_GRACE_MS = 30_000;

// Under ~/.ade rather than the system temp dir. On Linux/WSL os.tmpdir() is the
// world-writable /tmp, where another local user could pre-create the record as
// a symlink (writeFileSync follows it) or plant a live pid to suppress this
// user's brain spawns indefinitely. The machine layout dir is ADE-owned and
// created 0700.
function recordDir(): string {
  return path.join(resolveMachineAdeLayout().runtimeDir, "spawns");
}

export function runtimeSpawnRecordPath(socketPath: string): string {
  // Hash rather than sanitize-and-truncate: two socket paths sharing a suffix
  // must not share a record and suppress each other's spawns.
  const key = createHash("sha256").update(socketPath).digest("hex").slice(0, 32);
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
 * Drop the record after deliberately shutting a spawned brain down. Its pid can
 * outlive the shutdown by a moment, and without this the stale record would
 * suppress the replacement spawn the shutdown exists to make room for.
 */
export function clearRuntimeSpawnRecord(socketPath: string): void {
  try {
    fs.rmSync(runtimeSpawnRecordPath(socketPath), { force: true });
  } catch {
    // Advisory only.
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
