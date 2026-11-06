import type { LaneCleanupConfig } from "./types/config";
import { DEFAULT_CLEAN_BUILD_OUTPUT_AFTER_DAYS, type StorageLifecyclePolicy } from "./types/storage";

/**
 * The lane cleanup rules in force, read the same way by the brain that runs
 * them, the Settings page that shows them, the archive reminder and the
 * project health report.
 */

/** `freeUpSpaceAfterDays` when no file sets it: ask after two weeks, as the archive reminder always did. */
export const DEFAULT_FREE_UP_SPACE_AFTER_DAYS = 14;

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
 * An archived lane whose folder is due to be freed up: archived at least
 * `freeUpSpaceAfterDays` ago. Computed, never stored, so changing the setting
 * moves every lane at once.
 */
export function isFreeUpSpaceDue(
  archivedAt: string | null | undefined,
  policy: StorageLifecyclePolicy,
  nowMs: number = Date.now(),
): boolean {
  if (!archivedAt || policy.freeUpSpaceAfterDays <= 0) return false;
  const archivedMs = Date.parse(archivedAt);
  return Number.isFinite(archivedMs) && nowMs - archivedMs >= policy.freeUpSpaceAfterDays * DAY_MS;
}

/** An archived lane due for the automatic delete. */
export function isAutoDeleteDue(
  archivedAt: string | null | undefined,
  policy: StorageLifecyclePolicy,
  nowMs: number = Date.now(),
): boolean {
  if (!archivedAt || policy.deleteArchivedAfterDays <= 0) return false;
  const archivedMs = Date.parse(archivedAt);
  return Number.isFinite(archivedMs) && nowMs - archivedMs >= policy.deleteArchivedAfterDays * DAY_MS;
}
