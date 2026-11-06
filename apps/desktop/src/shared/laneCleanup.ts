import type { LaneCleanupConfig } from "./types/config";
import { DEFAULT_CLEAN_BUILD_OUTPUT_AFTER_DAYS, type StorageLifecyclePolicy } from "./types/storage";

/**
 * The lane cleanup rules in force, read the same way by the brain that runs
 * them, the Settings page that shows them, the archive reminder and the
 * project health report.
 */

/** `freeUpSpaceAfterDays` when no file sets it: ask after two weeks, as the archive reminder always did. */
const DEFAULT_FREE_UP_SPACE_AFTER_DAYS = 14;

/** The archive reminder's and the stale-lane label's line when their rule is off. */
const FALLBACK_STALE_DAYS = 14;

const DAY_MS = 86_400_000;

function days(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

export function resolveLaneCleanupPolicy(config: LaneCleanupConfig | null | undefined): StorageLifecyclePolicy {
  const cleanup = config ?? {};
  return {
    archiveIdleAfterDays: days(cleanup.archiveIdleAfterDays, 0),
    freeUpSpaceAfterDays: days(cleanup.freeUpSpaceAfterDays, DEFAULT_FREE_UP_SPACE_AFTER_DAYS),
    freeUpSpaceMode: cleanup.freeUpSpaceMode === "auto" ? "auto" : "ask",
    deleteArchivedAfterDays: days(cleanup.deleteArchivedAfterDays, 0),
    deleteLocalBranchOnAutoDelete: cleanup.deleteLocalBranchOnAutoDelete === true,
    // On by default: a local.yaml without the key gets a week.
    cleanBuildOutputAfterDays: days(cleanup.cleanBuildOutputAfterDays, DEFAULT_CLEAN_BUILD_OUTPUT_AFTER_DAYS),
  };
}

/** A rule the hourly check has to run for. "Ask me" removes nothing, so it needs no check. */
export function laneCleanupChecksOn(policy: StorageLifecyclePolicy): boolean {
  return policy.archiveIdleAfterDays > 0
    || policy.deleteArchivedAfterDays > 0
    || (policy.freeUpSpaceMode === "auto" && policy.freeUpSpaceAfterDays > 0);
}

/**
 * Days after which archived things count as old: the archive reminder asks
 * about them and Settings → Archive groups them. The free-up-space setting
 * when it is on, else two weeks.
 */
export function archiveStaleDays(config: LaneCleanupConfig | null | undefined): number {
  const policy = resolveLaneCleanupPolicy(config);
  return policy.freeUpSpaceAfterDays > 0 ? policy.freeUpSpaceAfterDays : FALLBACK_STALE_DAYS;
}

/** Days idle before the project health report calls an active lane stale: the archive rule's line when it is on. */
export function staleLaneDays(config: LaneCleanupConfig | null | undefined): number {
  const policy = resolveLaneCleanupPolicy(config);
  return policy.archiveIdleAfterDays > 0 ? policy.archiveIdleAfterDays : FALLBACK_STALE_DAYS;
}

/**
 * Archived at least `days` days ago; never when `days` is 0 (the rule is off).
 * Computed, never stored, so changing a setting moves every lane at once.
 */
export function archivedForDays(
  archivedAt: string | null | undefined,
  days: number,
  nowMs: number = Date.now(),
): boolean {
  if (!archivedAt || days <= 0) return false;
  const archivedMs = Date.parse(archivedAt);
  return Number.isFinite(archivedMs) && nowMs - archivedMs >= days * DAY_MS;
}

/**
 * Where an archived lane stands on "Free up space", read the same way by the
 * cleanup check, the storage page and Settings → Archive.
 *
 * - `due`: archived `freeUpSpaceAfterDays` ago and its folder is still there.
 * - `waiting`: due, and a removal that found files in use is being retried.
 * - `failed`: the last removal failed; it waits for a person.
 * - `not_due`: anything else (not archived, the primary lane, the folder
 *   already gone or freed up, not old enough, the rule off).
 *
 * Without `reclaimState` and `pendingRemoval`, only `due` or `not_due`.
 */
export type LaneFreeUpStatus = "not_due" | "due" | "waiting" | "failed";

export function laneFreeUpStatus(
  lane: {
    archivedAt: string | null | undefined;
    laneType: string;
    folderPresent: boolean;
    reclaimState?: string | null;
    pendingRemoval?: boolean;
  },
  policy: StorageLifecyclePolicy,
  nowMs: number = Date.now(),
): LaneFreeUpStatus {
  if (!lane.archivedAt || lane.laneType === "primary") return "not_due";
  if (lane.reclaimState === "failed") return "failed";
  if (lane.reclaimState === "reclaimed" || !lane.folderPresent) return "not_due";
  if (!archivedForDays(lane.archivedAt, policy.freeUpSpaceAfterDays, nowMs)) return "not_due";
  return lane.pendingRemoval ? "waiting" : "due";
}
