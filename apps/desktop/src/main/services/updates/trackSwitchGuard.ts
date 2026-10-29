import path from "node:path";

import {
  resolveMachineAdeLayout,
  resolvePersonalChatsStateRoot,
} from "../../../../../ade-cli/src/services/projects/machineLayout";
import { ProjectRegistry } from "../../../../../ade-cli/src/services/projects/projectRegistry";
import { fetchReleaseManifestJson } from "../../../../../ade-cli/src/lib/releaseAssets";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import {
  BETA_FEED_MANIFEST_URL,
  LATEST_STABLE_MANIFEST_URL,
  parseReleaseManifest,
  updateTrackLabel,
  updateTrackOfVersion,
  type ReleaseManifest,
  type UpdateTrack,
} from "../../../shared/updateTrack";
import type { TrackSwitchCheckResult } from "../../../shared/types";
import { DB_COMPAT_LEVEL, LEGACY_DB_COMPAT_LEVEL } from "../../../shared/releaseCompat";
import type { Logger } from "../logging/logger";
import { dbCompatLevelOf } from "../state/dbCompatRecord";

export type TrackSwitchGuardDeps = {
  /** Resolves the parsed JSON, `null` for a 404, and throws on other failures. */
  fetchJson?: (url: string) => Promise<unknown | null>;
  /** Every database file on this machine. Injected in tests. */
  listDatabasePaths?: () => Array<{ label: string; dbPath: string }>;
};

function defaultListDatabasePaths(): Array<{ label: string; dbPath: string }> {
  const layout = resolveMachineAdeLayout();
  const databases = [
    { label: "this computer's ADE data", dbPath: path.join(layout.adeDir, "ade.db") },
    // Personal chats run a runtime of their own on this state root.
    {
      label: "your personal chats",
      dbPath: resolveAdeLayout(resolvePersonalChatsStateRoot(layout)).dbPath,
    },
  ];
  for (const project of new ProjectRegistry(layout).list()) {
    databases.push({
      label: project.displayName || path.basename(project.rootPath),
      dbPath: resolveAdeLayout(project.rootPath).dbPath,
    });
  }
  return databases;
}

/**
 * Before a machine moves to the other update track: can the build it would
 * install open every database this machine has? (docs/plans/beta-track.md,
 * T3 #26288.)
 *
 * Moving to a newer build is always safe for the data. Moving to an OLDER one
 * (Beta back to Stable) is safe only when that build's `dbCompat` is at least
 * the highest level any local database was migrated to. Anything this check
 * cannot read blocks the switch instead of guessing.
 */
export async function checkTrackSwitch(args: {
  target: UpdateTrack;
  runningVersion: string;
  deps?: TrackSwitchGuardDeps;
  logger?: Pick<Logger, "warn">;
}): Promise<TrackSwitchCheckResult> {
  const { target, runningVersion } = args;
  const fetchJson = args.deps?.fetchJson ?? fetchReleaseManifestJson;
  const listDatabasePaths = args.deps?.listDatabasePaths ?? defaultListDatabasePaths;
  const runningTrack = updateTrackOfVersion(runningVersion);
  const targetLabel = updateTrackLabel(target);

  // Back to the track this build is on: nothing installs, so nothing to check.
  if (target === runningTrack) return { allowed: true, target, targetVersion: null };

  let raw: unknown | null;
  try {
    raw = await fetchJson(target === "beta" ? BETA_FEED_MANIFEST_URL : LATEST_STABLE_MANIFEST_URL);
  } catch (error) {
    args.logger?.warn("autoUpdate.track_switch_manifest_failed", { target, error: String(error) });
    return {
      allowed: false,
      target,
      reason: `ADE couldn't reach GitHub to check the newest ${targetLabel} build. Check your connection and try again.`,
    };
  }
  let manifest: ReleaseManifest | null;
  if (raw === null) {
    if (target === "beta") {
      return { allowed: false, target, reason: "There is no Beta build to switch to right now. Try again later." };
    }
    manifest = null;
  } else {
    manifest = parseReleaseManifest(raw);
    if (!manifest || manifest.track !== target) {
      return {
        allowed: false,
        target,
        reason: `ADE couldn't read the newest ${targetLabel} build's details, so it can't tell whether that build can open your projects. Try again later.`,
      };
    }
  }

  const targetDbCompat = manifest ? manifest.dbCompat : LEGACY_DB_COMPAT_LEVEL;
  if (targetDbCompat == null) {
    return {
      allowed: false,
      target,
      reason: `The newest ${targetLabel} build doesn't say which data it can open, so ADE won't switch to it.`,
    };
  }

  const targetName = manifest ? `${targetLabel} ${manifest.version}` : `the newest ${targetLabel} build`;
  const tooNew = (subject: string): TrackSwitchCheckResult => ({
    allowed: false,
    target,
    reason: `${subject} in a way ${targetName} can't read yet. Stay on ${updateTrackLabel(runningTrack)} for now, and switch again after the next ${targetLabel} release.`,
  });

  // This build may still open a project before the switch installs, and that
  // open migrates the file to this build's level. So a target below this
  // build's own level is refused even when no database is there yet; the
  // per-file check below then covers files a newer build already migrated.
  if (targetDbCompat < DB_COMPAT_LEVEL) return tooNew("This build updates projects");

  let databases: Array<{ label: string; dbPath: string }>;
  try {
    databases = listDatabasePaths();
  } catch (error) {
    args.logger?.warn("autoUpdate.track_switch_projects_failed", { target, error: String(error) });
    return {
      allowed: false,
      target,
      reason: "ADE couldn't read the list of projects on this computer, so it can't check them. Try again.",
    };
  }
  for (const database of databases) {
    const level = dbCompatLevelOf(database.dbPath);
    if (level === "unreadable") {
      return {
        allowed: false,
        target,
        reason: `ADE couldn't read the data version of ${database.label}, so it won't switch. Open it once on this build, then try again.`,
      };
    }
    if (level > targetDbCompat) return tooNew(`A newer build already updated ${database.label}`);
  }
  return { allowed: true, target, targetVersion: manifest?.version ?? null };
}
