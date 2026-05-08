import type { GitUpstreamSyncStatus, LaneSummary } from "../../../../shared/types";

export type LanePrWarning = {
  laneId: string;
  laneName: string;
  issues: string[];
};

function formatCommitSuffix(count: number): string {
  return count === 1 ? "commit" : "commits";
}

export function describeLanePrIssues(
  lane: LaneSummary,
  syncStatus: GitUpstreamSyncStatus | null | undefined
): string[] {
  const issues: string[] = [];

  if (lane.status.rebaseInProgress) {
    issues.push("has a rebase in progress. Finish or abort it before creating a PR.");
  }

  if (lane.status.dirty) {
    issues.push("has uncommitted changes. Commit or stash them if they should be part of the PR.");
  }

  if (lane.status.behind > 0) {
    issues.push(`is ${lane.status.behind} ${formatCommitSuffix(lane.status.behind)} behind its base branch. Update the lane before creating or merging a PR.`);
  }

  if (!syncStatus) {
    return issues;
  }

  if (syncStatus.upstreamState === "missing") {
    issues.push("remote branch is missing. It may have been deleted after merge.");
    return issues;
  }

  if (!syncStatus.hasUpstream) {
    issues.push("has not been pushed to remote yet.");
    return issues;
  }

  if (syncStatus.diverged) {
    issues.push(
      `local and remote both have changes (${syncStatus.ahead} local, ${syncStatus.behind} remote). Pull or rebase, then push once the history looks right.`
    );
    return issues;
  }

  if (syncStatus.ahead > 0) {
    issues.push(`has ${syncStatus.ahead} ${formatCommitSuffix(syncStatus.ahead)} not pushed yet.`);
  }

  if (syncStatus.behind > 0) {
    issues.push(`remote has ${syncStatus.behind} newer ${formatCommitSuffix(syncStatus.behind)}. Pull or rebase before creating a PR.`);
  }

  return issues;
}

export function buildLaneRebaseRecommendedLaneIds(args: {
  lanes: LaneSummary[];
  selectedLaneIds: string[];
}): string[] {
  const laneById = new Map(args.lanes.map((lane) => [lane.id, lane]));
  return args.selectedLaneIds.filter((laneId) => {
    const lane = laneById.get(laneId);
    return Boolean(lane && (lane.status.behind > 0 || lane.status.rebaseInProgress));
  });
}

export function buildLanePrWarnings(args: {
  lanes: LaneSummary[];
  selectedLaneIds: string[];
  syncStatusByLaneId: Record<string, GitUpstreamSyncStatus | null | undefined>;
}): LanePrWarning[] {
  const laneById = new Map(args.lanes.map((lane) => [lane.id, lane]));
  return args.selectedLaneIds
    .map((laneId) => {
      const lane = laneById.get(laneId);
      if (!lane) return null;
      const issues = describeLanePrIssues(lane, args.syncStatusByLaneId[laneId]);
      if (issues.length === 0) return null;
      return {
        laneId,
        laneName: lane.name,
        issues,
      };
    })
    .filter((warning): warning is LanePrWarning => warning != null);
}
