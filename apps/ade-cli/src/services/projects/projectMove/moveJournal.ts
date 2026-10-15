import fs from "node:fs";
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
export function projectMovesDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveMachineAdeDir(env), "project-moves");
}

function recordPath(moveId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(moveId)) throw new Error("Invalid move id.");
  return path.join(projectMovesDir(), `${moveId}.json`);
}

export function writeMoveRecord(record: ProjectMoveRecord): void {
  fs.mkdirSync(projectMovesDir(), { recursive: true });
  writeFileAtomic(recordPath(record.moveId), `${JSON.stringify(record, null, 2)}\n`);
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

/** The move currently running, or interrupted, for a project. */
export function findUnfinishedMove(root: string): ProjectMoveRecord | null {
  return listMoveRecords().find(
    (record) => record.state === "running" && (record.sourceRoot === root || record.destinationRoot === root),
  ) ?? null;
}

/** The latest finished move into `root`, for the Location row and the agent check. */
export function findMoveInto(root: string): ProjectMoveRecord | null {
  return listMoveRecords().find((record) => record.state === "done" && record.destinationRoot === root) ?? null;
}

/** Whether ADE itself left a partial copy at `destinationRoot` (a failed or interrupted move into it). */
export function ownsLeftoverCopy(destinationRoot: string): boolean {
  return listMoveRecords().some(
    (record) => record.destinationRoot === destinationRoot && record.state !== "done",
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
