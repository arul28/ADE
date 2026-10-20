import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "../../../../../desktop/src/main/services/state/durableFile";
import type { ProjectMoveRecord } from "../../../../../desktop/src/shared/types/projectMove";
import { resolveMachineAdeDir } from "../machineLayout";

/**
 * One file per move under `<ADE_HOME>/project-moves/`. It is written before
 * each step, so after a crash ADE knows which move was running, where its
 * partial copy is, and where the original was parked. The cleanup choice and
 * its reminder live here too, so they survive a restart.
 */
function projectMovesDir(): string {
  return path.join(resolveMachineAdeDir(), "project-moves");
}

/** Written into a project's old folder when it moves, so nothing opens the kept copy by mistake. */
const PROJECT_MOVED_MARKER = path.join(".ade", "moved-to.json");

/** Where the moved marker of `root` lives. */
export function movedMarkerPath(root: string): string {
  return path.join(root, PROJECT_MOVED_MARKER);
}

export type MovedMarker = { movedTo: string | null; moveId: string | null };

/** The moved marker in `root`, or null when `root` is not a kept copy. */
export function readMovedMarker(root: string): MovedMarker | null {
  const marker = movedMarkerPath(root);
  if (!fs.existsSync(marker)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(marker, "utf8")) as { movedTo?: unknown; moveId?: unknown };
    return {
      movedTo: typeof parsed.movedTo === "string" ? parsed.movedTo : null,
      moveId: typeof parsed.moveId === "string" ? parsed.moveId : null,
    };
  } catch {
    // A marker that cannot be read still marks the folder as a kept copy.
    return { movedTo: null, moveId: null };
  }
}

export function writeMovedMarker(root: string, marker: { movedTo: string; moveId: string }): void {
  fs.mkdirSync(path.join(root, ".ade"), { recursive: true });
  writeFileAtomic(
    path.join(root, PROJECT_MOVED_MARKER),
    `${JSON.stringify({ ...marker, movedAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

/** When this Mac booted, in whole minutes since the epoch. */
export function currentBootMinute(): number {
  return Math.round((Date.now() - os.uptime() * 1000) / 60_000);
}

/** Moves this process is running right now. A pid alone cannot say so: after a reboot it may be reused. */
const activeMoveIds = new Set<string>();

export function markMoveActive(moveId: string, active: boolean): void {
  if (active) activeMoveIds.add(moveId);
  else activeMoveIds.delete(moveId);
}

/**
 * Whether the process that ran a move is still running. A pid recorded before
 * a reboot (a power cut mid-copy) may now belong to an unrelated process, so
 * a different boot means it is gone.
 */
export function isMoveProcessAlive(record: Pick<ProjectMoveRecord, "moveId" | "pid" | "bootMinute">): boolean {
  const { pid } = record;
  if (!pid) return false;
  if (pid === process.pid) return activeMoveIds.has(record.moveId);
  if (record.bootMinute != null && Math.abs(record.bootMinute - currentBootMinute()) > 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function recordPath(moveId: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(moveId)) throw new Error("Invalid move id.");
  return path.join(projectMovesDir(), `${moveId}.json`);
}

export function writeMoveRecord(record: ProjectMoveRecord): void {
  fs.mkdirSync(projectMovesDir(), { recursive: true });
  writeFileAtomic(recordPath(record.moveId), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Records the kept original's size on the record as it is on disk now: the
 * measurement can take minutes, and the person may have chosen what happens
 * to the copy meanwhile. Never throws; a size is only shown, not relied on.
 */
export function recordOriginalBytes(moveId: string, bytes: number): void {
  try {
    const latest = readMoveRecord(moveId);
    if (!latest) return;
    latest.originalBytes = bytes;
    writeMoveRecord(latest);
  } catch (error) {
    // The size stays as it was; the cleanup choice is what matters and is untouched.
    console.warn(`[project-move] couldn't record the kept copy's size for ${moveId}:`, error);
  }
}

export function readMoveRecord(moveId: string): ProjectMoveRecord | null {
  try {
    return JSON.parse(fs.readFileSync(recordPath(moveId), "utf8")) as ProjectMoveRecord;
  } catch {
    return null;
  }
}

export function listMoveRecords(): ProjectMoveRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(projectMovesDir());
  } catch {
    return [];
  }
  const records: ProjectMoveRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = readMoveRecord(name.slice(0, -".json".length));
    if (record) records.push(record);
  }
  return records.sort((a, b) => b.startedAt - a.startedAt);
}

/** A move another live process is running right now for this project, as its source or destination. */
export function findMoveInProgress(root: string): ProjectMoveRecord | null {
  return listMoveRecords().find(
    (record) => record.state === "running"
      && (record.sourceRoot === root || record.destinationRoot === root)
      && isMoveProcessAlive(record),
  ) ?? null;
}

/** The latest finished move into `root`, for the Location row and the agent check. */
export function findMoveInto(root: string): ProjectMoveRecord | null {
  return listMoveRecords().find((record) => record.state === "done" && record.destinationRoot === root) ?? null;
}

/** Whether ADE itself left a partial copy at `destinationRoot` (a failed or interrupted move into it). */
export function ownsLeftoverCopy(destinationRoot: string): boolean {
  return listMoveRecords().some(
    (record) => record.destinationRoot === destinationRoot && record.state !== "done" && record.copyCreated === true,
  );
}

/**
 * Where a project now lives, given a folder it used to live in. Something that
 * kept the old folder (a window, a phone, a link) still reaches the project.
 * Only a folder that is gone is followed, so a new project later created at
 * the old path is never redirected. Follows a chain of moves.
 */
export function resolveMovedProjectRoot(root: string): string {
  let current = path.resolve(root);
  for (let hops = 0; hops < 10; hops += 1) {
    if (fs.existsSync(current)) return current;
    const move = listMoveRecords().find(
      (record) => record.state === "done" && (record.resume?.sourceSpellings ?? [record.sourceRoot]).includes(current),
    );
    if (!move) return current;
    current = move.destinationRoot;
  }
  return current;
}
