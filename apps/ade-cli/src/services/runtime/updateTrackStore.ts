import fs from "node:fs";
import path from "node:path";

import {
  normalizeUpdateTrack,
  updateTrackOfVersion,
  type UpdateTrack,
} from "../../../../desktop/src/shared/updateTrack";
import { resolveMachineAdeDir } from "../projects/machineLayout";
import { writeJsonAtomic } from "./atomicJson";

/**
 * The machine's chosen update track, in `~/.ade/update-track.json`.
 *
 * One file, read by the desktop app, the brain and the CLI, so all three agree
 * on which builds this machine takes. It lives in the machine home, not in the
 * app's own state, because a machine with no app (a Linux server) still
 * updates its brain, and an app reinstall must not forget the choice.
 *
 * The file holds the user's intent. A switch that has not finished yet leaves
 * the running build on the other track; callers compare the two and offer to
 * finish the switch rather than guessing.
 */
export const UPDATE_TRACK_FILE = "update-track.json";

export type UpdateTrackRecord = {
  track: UpdateTrack;
  updatedAt: string | null;
};

export function updateTrackFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveMachineAdeDir(env), UPDATE_TRACK_FILE);
}

/** The saved choice, or null when nothing (readable) was saved. */
export function readSavedUpdateTrack(env: NodeJS.ProcessEnv = process.env): UpdateTrackRecord | null {
  let raw: string;
  try {
    raw = fs.readFileSync(updateTrackFilePath(env), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const track = normalizeUpdateTrack(parsed?.track);
    if (!track) return null;
    return { track, updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null };
  } catch {
    return null;
  }
}

/**
 * The track this machine follows: the saved choice, else the track of the
 * build that is running. A machine that never chose stays where its build is.
 */
export function resolveSelectedUpdateTrack(
  runningVersion: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): UpdateTrack {
  return readSavedUpdateTrack(env)?.track ?? updateTrackOfVersion(runningVersion);
}

export function writeSavedUpdateTrack(
  track: UpdateTrack,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): UpdateTrackRecord {
  const record: UpdateTrackRecord = { track, updatedAt: now().toISOString() };
  writeJsonAtomic(updateTrackFilePath(env), record, `${process.pid}`);
  return record;
}
