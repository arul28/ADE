import React from "react";
import type { BranchPullRequest, LaneSummary, OpenProjectBinding } from "../../../shared/types";
import type { LaneBranchOption } from "./laneUtils";

/** Where `loadLaneStartMenuData` puts what it reads. */
export type LaneStartMenuSink = {
  setBranches: (branches: LaneBranchOption[]) => void;
  setBranchesLoading: (loading: boolean) => void;
  setGitUserName: (name: string) => void;
  setPullRequests: (pullRequests: BranchPullRequest[]) => void;
};

/**
 * The start-from menu's data on one machine, read through its primary lane:
 * its branches, git's user name (for "mine"), and the repo's open PRs. Each
 * result lands only while `isCurrent()` holds, so a newer read for another
 * machine wins. The caller sets `setBranchesLoading(true)` first; this ends it.
 */
export function loadLaneStartMenuData(
  primaryLaneId: string,
  pin: OpenProjectBinding,
  isCurrent: () => boolean,
  sink: LaneStartMenuSink,
): void {
  void window.ade.git.listBranches({ laneId: primaryLaneId }, pin)
    .then((branches) => {
      if (isCurrent()) sink.setBranches(branches);
    })
    .catch((error: unknown) => console.warn("lane_start_menu.branches_load_failed", error))
    .finally(() => {
      if (isCurrent()) sink.setBranchesLoading(false);
    });
  void window.ade.git.getUserIdentity({ laneId: primaryLaneId }, pin)
    .then((identity) => {
      if (isCurrent()) sink.setGitUserName(identity?.name ?? "");
    })
    .catch((error: unknown) => console.warn("lane_start_menu.git_identity_load_failed", error));
  // Repo-wide (GitHub): the same machine answers it, since any copy can.
  // Only decoration for the menu, so a host without it (even one that throws
  // at the call) never blocks the menu.
  void Promise.resolve()
    .then(() => window.ade.prs.listOpenForRepo(pin))
    .then((pullRequests) => {
      if (isCurrent()) sink.setPullRequests(pullRequests);
    })
    .catch((error: unknown) => console.warn("lane_start_menu.pull_requests_load_failed", error));
}

/**
 * The start-from menu's data for a surface that only shows the menu (Settings
 * → Lanes → New lanes): that machine's lanes (who has which branch open), then
 * `loadLaneStartMenuData` through its primary lane. Reloads when the pin's
 * machine changes. The New lane dialog calls `loadLaneStartMenuData` itself,
 * inside its own per-open, per-target load.
 */
export function useLaneStartMenuData(pin: OpenProjectBinding | null): {
  lanes: LaneSummary[];
  branches: LaneBranchOption[];
  branchesLoading: boolean;
  pullRequests: BranchPullRequest[];
  gitUserName: string;
} {
  const [lanes, setLanes] = React.useState<LaneSummary[]>([]);
  const [branches, setBranches] = React.useState<LaneBranchOption[]>([]);
  const [branchesLoading, setBranchesLoading] = React.useState(true);
  const [pullRequests, setPullRequests] = React.useState<BranchPullRequest[]>([]);
  const [gitUserName, setGitUserName] = React.useState("");
  React.useEffect(() => {
    let cancelled = false;
    const isCurrent = () => !cancelled;
    // Another machine: its menu starts empty, never on the last machine's
    // branches (one picked there may not exist here).
    setLanes([]);
    setBranches([]);
    setPullRequests([]);
    setGitUserName("");
    // No machine: an empty menu, and nothing is sent.
    const target = pin;
    if (!target) {
      setBranchesLoading(false);
      return;
    }
    setBranchesLoading(true);
    void window.ade.lanes.list({ includeStatus: false }, target)
      .then((next) => {
        if (cancelled) return;
        const list = Array.isArray(next) ? next : [];
        setLanes(list);
        const primary = list.find((lane) => lane.laneType === "primary");
        if (!primary) {
          setBranchesLoading(false);
          return;
        }
        loadLaneStartMenuData(primary.id, target, isCurrent, { setBranches, setBranchesLoading, setGitUserName, setPullRequests });
      })
      .catch((error: unknown) => {
        console.warn("lane_start_menu.lanes_load_failed", error);
        if (!cancelled) setBranchesLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the pin's identity, not the object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin?.key]);
  return { lanes, branches, branchesLoading, pullRequests, gitUserName };
}
