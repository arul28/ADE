import fs from "node:fs";
import path from "node:path";

import {
  normalizeUpdateTrack,
  updateTrackOfVersion,
  type UpdateTrack,
} from "../../../../desktop/src/shared/updateTrack";
import { resolveMachineAdeDir } from "../projects/machineLayout";
import { writeJsonAtomic } from "./atomicJson";
import type { BrainUpdateStatus } from "../../commands/brainUpdate";

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
  /**
   * Set by a brain that saved a switch before installing the other track's
   * build (`machine.switchUpdateTrack` on a machine with no app): the track it
   * switched from, until its next start settles the switch
   * (`settlePendingTrackSwitch`). Absent everywhere else.
   */
  pendingSwitchFrom?: UpdateTrack;
  pendingSwitchVersion?: string;
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
    const pendingSwitchFrom = normalizeUpdateTrack(parsed.pendingSwitchFrom);
    const pendingSwitchVersion = typeof parsed.pendingSwitchVersion === "string" ? parsed.pendingSwitchVersion.trim() : "";
    return {
      track,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      ...(pendingSwitchFrom ? { pendingSwitchFrom } : {}),
      ...(pendingSwitchVersion ? { pendingSwitchVersion } : {}),
    };
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

export type PendingTrackSwitch = { pendingSwitchFrom: UpdateTrack; pendingSwitchVersion: string };

export function writeSavedUpdateTrack(
  track: UpdateTrack,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
  pending?: PendingTrackSwitch,
): UpdateTrackRecord {
  const record: UpdateTrackRecord = {
    track,
    updatedAt: now().toISOString(),
    ...pending,
  };
  writeJsonAtomic(updateTrackFilePath(env), record, `${process.pid}`);
  return record;
}

/**
 * Settle only with evidence from this switch's installer. A second brain
 * starting on an old build may share the home while the installer is active.
 */
export function settlePendingTrackSwitch(
  runningVersion: string,
  update: BrainUpdateStatus,
  env: NodeJS.ProcessEnv = process.env,
): "landed" | "reverted" | null {
  const saved = readSavedUpdateTrack(env);
  if (!saved?.pendingSwitchFrom || !saved.updatedAt || !update.version || update.updatedAt < saved.updatedAt) return null;
  if (saved.pendingSwitchVersion && update.version !== saved.pendingSwitchVersion) return null;
  if (updateTrackOfVersion(update.version) !== saved.track) return null;
  const runningTrack = updateTrackOfVersion(runningVersion);
  if (runningVersion === update.version && (update.state === "restarting" || update.state === "succeeded")) {
    writeSavedUpdateTrack(saved.track, env);
    return "landed";
  }
  if (update.state === "failed" && runningTrack === saved.pendingSwitchFrom) {
    writeSavedUpdateTrack(runningTrack, env);
    return "reverted";
  }
  return null;
}
