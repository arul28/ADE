import { createHash } from "node:crypto";
import path from "node:path";
import { withExclusiveFileLock } from "../../lib/exclusiveFileLock";
import { resolveMachineAdeLayout } from "../projects/machineLayout";

/**
 * Cross-process mutual exclusion for "spawn a brain for this socket".
 *
 * Every failing `ade` command can spawn a detached
 * brain, so without a lock a burst of commands races: each one checks, each one
 * finds nothing, and each one spawns. That is how a machine ends up with a pile
 * of immortal brains fighting over the same relay slot. An advisory record
 * alone cannot fix it — the check and the spawn must be one atomic claim.
 *
 * The lock lives next to the socket, is released on completion, and is reaped
 * when its owning pid is gone (or, for an unreadable lock, after 30s) so a
 * crashed spawner cannot wedge the machine. The claim mechanics are shared with
 * the service install lock in lib/exclusiveFileLock.ts.
 */

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
  return await withExclusiveFileLock(socketSpawnLockPath(socketPath), task, {
    waitMs: 10_000,
    label: "ADE socket spawn lock",
  });
}
