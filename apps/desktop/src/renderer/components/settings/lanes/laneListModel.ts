import type { ProjectLaneHealth } from "../../../../shared/types/projectHealth";

/**
 * The rules behind Project → Lanes: which bucket a lane counts in, what its
 * pill says, which lanes the bulk archive may take, and the order rows show.
 */

export type LaneFilter = "all" | "stale" | "changes" | "running";

export const LANE_FILTERS: ReadonlyArray<{ id: LaneFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "stale", label: "Stale" },
  { id: "changes", label: "Has changes" },
  { id: "running", label: "Running" },
];

function hasUnsavedWork(lane: ProjectLaneHealth): boolean {
  return Boolean(lane.dirty) || (lane.unpushedCommits ?? 0) > 0;
}

/** One bucket per lane for the summary bar: stale wins, then unsaved work. */
export function laneBucket(lane: ProjectLaneHealth): "active" | "changes" | "stale" {
  if (lane.stale) return "stale";
  if (hasUnsavedWork(lane)) return "changes";
  return "active";
}

export function laneFilterMatches(lane: ProjectLaneHealth, filter: LaneFilter): boolean {
  if (filter === "stale") return lane.stale != null;
  if (filter === "changes") return hasUnsavedWork(lane);
  if (filter === "running") return lane.runningSessions > 0;
  return true;
}

function daysSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  return Math.max(0, Math.floor((now - ts) / 86_400_000));
}

/** The one status pill a row wears. */
export function laneStatusPill(lane: ProjectLaneHealth, now = Date.now()): { label: string; tone?: "ok" | "warn" | "crit" } {
  if (lane.laneType === "primary") return { label: "Primary" };
  if (lane.stale === "pr-merged") return { label: "Stale · PR merged", tone: "warn" };
  if (lane.stale === "pr-closed") return { label: "Stale · PR closed", tone: "warn" };
  if (lane.stale === "idle") {
    const days = daysSince(lane.lastActivityAt, now);
    return { label: days != null ? `Stale · idle ${days}d` : "Stale · idle", tone: "warn" };
  }
  if (lane.dirty) return { label: lane.changedFileCount ? `${lane.changedFileCount} changed` : "Changes" };
  if ((lane.unpushedCommits ?? 0) > 0) return { label: `${lane.unpushedCommits} unpushed` };
  return { label: "Active", tone: "ok" };
}

/** Why a stale lane counts as stale, in one line. */
export function laneStaleReason(lane: ProjectLaneHealth, staleAfterDays: number): string {
  if (lane.stale === "pr-merged") return `Its pull request #${lane.pr?.number ?? "?"} was merged.`;
  if (lane.stale === "pr-closed") return `Its pull request #${lane.pr?.number ?? "?"} was closed.`;
  if (lane.stale === "idle") return `Nothing happened in it for over ${staleAfterDays} days.`;
  return "";
}

/**
 * Why a lane can't join a bulk archive, or null when it can. Only lanes that
 * lose nothing qualify: no uncommitted files, nothing only on this computer,
 * nothing running. The primary lane never does.
 */
export function laneNotSelectableReason(lane: ProjectLaneHealth): string | null {
  if (lane.laneType === "primary") return "The primary lane is never archived";
  if (lane.runningSessions > 0) return "A chat or terminal is running in it";
  if (lane.dirty) return "It has uncommitted changes";
  if ((lane.unpushedCommits ?? 0) > 0) return "It has commits that aren't pushed";
  if (!lane.safeToArchive) return "ADE couldn't confirm nothing would be lost";
  return null;
}

/** Primary first, then stale lanes, then the rest, each in the report's order (newest activity first). */
export function sortLanes(lanes: readonly ProjectLaneHealth[]): ProjectLaneHealth[] {
  const rank = (lane: ProjectLaneHealth) => (lane.laneType === "primary" ? 0 : lane.stale ? 1 : 2);
  return lanes
    .map((lane, index) => ({ lane, index }))
    .sort((left, right) => rank(left.lane) - rank(right.lane) || left.index - right.index)
    .map((entry) => entry.lane);
}
