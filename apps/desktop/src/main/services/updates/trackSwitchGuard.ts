import path from "node:path";

import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import { ProjectRegistry } from "../../../../../ade-cli/src/services/projects/projectRegistry";
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
import { dbCompatLevelOf } from "../state/dbCompatRecord";

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
export type TrackSwitchCheck = TrackSwitchCheckResult;

export type TrackSwitchGuardDeps = {
  /** Resolves the parsed JSON, `null` for a 404, and throws on other failures. */
  fetchJson?: (url: string) => Promise<unknown | null>;
  /** Every database file on this machine. Injected in tests. */
  listDatabasePaths?: () => Array<{ label: string; dbPath: string }>;
};

const MANIFEST_FETCH_TIMEOUT_MS = 15_000;

async function defaultFetchJson(url: string): Promise<unknown | null> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(MANIFEST_FETCH_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}

function defaultListDatabasePaths(): Array<{ label: string; dbPath: string }> {
  const layout = resolveMachineAdeLayout();
  const databases = [{ label: "this computer's ADE data", dbPath: path.join(layout.adeDir, "ade.db") }];
  for (const project of new ProjectRegistry(layout).list()) {
    databases.push({
      label: project.displayName || path.basename(project.rootPath),
      dbPath: resolveAdeLayout(project.rootPath).dbPath,
    });
  }
  return databases;
}

/**
 * Stable releases from before release manifests existed have no
 * `release-manifest.json`. Their schema is the one `DB_COMPAT_LEVEL` 1 was
 * defined as, so such a release reads level 1. Every release since publishes
 * its manifest, or its build fails.
 */
const LEGACY_RELEASE_DB_COMPAT = 1;

export async function checkTrackSwitch(args: {
  target: UpdateTrack;
  runningVersion: string;
  deps?: TrackSwitchGuardDeps;
}): Promise<TrackSwitchCheck> {
  const { target, runningVersion } = args;
  const fetchJson = args.deps?.fetchJson ?? defaultFetchJson;
  const listDatabasePaths = args.deps?.listDatabasePaths ?? defaultListDatabasePaths;
  const runningTrack = updateTrackOfVersion(runningVersion);
  const targetLabel = updateTrackLabel(target);

  // Back to the track this build is on: nothing installs, so nothing to check.
  if (target === runningTrack) return { allowed: true, target, targetVersion: null };

  let raw: unknown | null;
  try {
    raw = await fetchJson(target === "beta" ? BETA_FEED_MANIFEST_URL : LATEST_STABLE_MANIFEST_URL);
  } catch {
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

  const targetDbCompat = manifest ? manifest.dbCompat : LEGACY_RELEASE_DB_COMPAT;
  if (targetDbCompat == null) {
    return {
      allowed: false,
      target,
      reason: `The newest ${targetLabel} build doesn't say which data it can open, so ADE won't switch to it.`,
    };
  }

  let databases: Array<{ label: string; dbPath: string }>;
  try {
    databases = listDatabasePaths();
  } catch {
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
        reason: `ADE couldn't read the data version of ${database.label}, so it won't switch. Open the project once on this build, then try again.`,
      };
    }
    if (level > targetDbCompat) {
      const version = manifest?.version ?? "the newest Stable build";
      return {
        allowed: false,
        target,
        reason: `This Beta already updated ${database.label} in a way ${targetLabel} ${version} can't read yet. Stay on Beta for now, and switch again after the next ${targetLabel} release.`,
      };
    }
  }
  return { allowed: true, target, targetVersion: manifest?.version ?? null };
}
