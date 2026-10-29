import {
  laneStartRefLabel,
  laneStartSourceBranch,
  plainLaneStartBranch,
  type LaneStart,
} from "../../../shared/laneStart";
import type { LaneSummary, NewLaneDefaultsSnapshot } from "../../../shared/types";
import type { LaneBranchListItem } from "./LaneBranchList";
import type { LaneBranchOption } from "./laneUtils";

/** Picker ids for the two moving targets; any other id is a branch name. */
export const START_DEFAULT_REF = "__ade_start_default__";
export const START_PRIMARY_REF = "__ade_start_primary__";

/** The picker id a start is shown under. */
export function startPickerRef(start: LaneStart): string {
  if (start.from === "default") return START_DEFAULT_REF;
  if (start.from === "primary") return START_PRIMARY_REF;
  return plainLaneStartBranch(start.branch);
}

/** The start a picker id stands for, keeping the chosen `bring`. */
export function startFromPickerRef(ref: string, bring: LaneStart["bring"]): LaneStart {
  if (ref === START_DEFAULT_REF) return { from: "default", bring };
  if (ref === START_PRIMARY_REF) return { from: "primary", bring };
  return { from: "branch", branch: plainLaneStartBranch(ref), bring };
}

/** The branch a start points at right now, on the machine the snapshot came from. */
export function startSourceBranch(start: LaneStart, snapshot: NewLaneDefaultsSnapshot | null): string {
  return laneStartSourceBranch(start, {
    defaultBranch: snapshot?.defaultBranch ?? null,
    primaryBranch: snapshot?.primaryBranch ?? null,
  });
}

/** `origin/main` or `main`: where the new branch will begin. */
export function startRefLabel(start: LaneStart, snapshot: NewLaneDefaultsSnapshot | null): string {
  return laneStartRefLabel(start, startSourceBranch(start, snapshot));
}

/** The lane that has the start's branch checked out: the folder uncommitted changes are copied from. */
export function laneHoldingBranch(branch: string, lanes: LaneSummary[]): LaneSummary | null {
  if (!branch) return null;
  return lanes.find((lane) => !lane.archivedAt && plainLaneStartBranch(lane.branchRef) === branch) ?? null;
}

/** A pinned row names a choice, not a checkout: it never reads "current". */
function pinnedBranch(branch: LaneBranchOption | undefined): LaneBranchOption | null {
  return branch ? { ...branch, isCurrent: false } : null;
}

/**
 * Every branch a lane can start from, once each: local branches, plus remote
 * branches with no local copy. Keyed by the plain name the start stores.
 */
export function startBranchItems(args: {
  branches: LaneBranchOption[];
  lanes: LaneSummary[];
  snapshot: NewLaneDefaultsSnapshot | null;
}): LaneBranchListItem[] {
  const byName = new Map<string, LaneBranchOption>();
  for (const branch of args.branches) {
    if (branch.isRemote) continue;
    byName.set(plainLaneStartBranch(branch.name), branch);
  }
  for (const branch of args.branches) {
    if (!branch.isRemote) continue;
    const name = plainLaneStartBranch(branch.name);
    if (name && name !== "HEAD" && !byName.has(name)) byName.set(name, branch);
  }
  const defaultBranch = args.snapshot?.defaultBranch ?? "";
  const primaryBranch = args.snapshot?.primaryBranch ?? "";
  const items: LaneBranchListItem[] = [
    {
      ref: START_DEFAULT_REF,
      label: "Default branch",
      tag: defaultBranch || undefined,
      branch: pinnedBranch(byName.get(defaultBranch)),
      pinned: true,
    },
    {
      ref: START_PRIMARY_REF,
      label: "Primary lane's branch",
      tag: primaryBranch || "detached",
      branch: pinnedBranch(byName.get(primaryBranch)),
      pinned: true,
    },
  ];
  for (const [name, branch] of byName) {
    const holder = laneHoldingBranch(name, args.lanes);
    items.push({
      ref: name,
      label: name,
      branch,
      // The primary checkout's branch already reads "current" in the list.
      tag: holder && holder.laneType !== "primary" ? `in ${holder.name}` : undefined,
    });
  }
  return items;
}

/** The auto-create row's note: "from origin/main", "from main + changes". */
export function describeAutoCreateStart(snapshot: NewLaneDefaultsSnapshot): string | null {
  const start = snapshot.defaults.start;
  const ref = startRefLabel(start, snapshot);
  if (!ref) return null;
  return start.bring === "uncommitted" ? `from ${ref} + changes` : `from ${ref}`;
}
