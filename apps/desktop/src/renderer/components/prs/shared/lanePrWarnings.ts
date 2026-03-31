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
    issues.push("has a rebase in progress");
  }

  if (lane.status.dirty) {
    issues.push("has uncommitted changes");
  }

  if (lane.status.behind > 0) {
    issues.push(`is ${lane.status.behind} ${formatCommitSuffix(lane.status.behind)} behind its base branch — rebase recommended before creating or merging a PR`);
  }

  if (!syncStatus) {
    return issues;
  }

  if (!syncStatus.hasUpstream) {
    issues.push("has not been published to remote");
    return issues;
  }

  if (syncStatus.diverged) {
    if (syncStatus.recommendedAction === "force_push_lease") {
      issues.push(
        `has diverged from remote (${syncStatus.ahead} ahead, ${syncStatus.behind} behind) — this is expected after a rebase. Force push to update the remote branch before creating a PR.`
      );
    } else {
      issues.push(
        `has diverged from remote (${syncStatus.ahead} ahead, ${syncStatus.behind} behind) — force push if this is from a rebase, or pull to merge remote changes.`
      );
    }
    return issues;
  }

  if (syncStatus.ahead > 0) {
    issues.push(`has ${syncStatus.ahead} unpushed ${formatCommitSuffix(syncStatus.ahead)}`);
  }

  if (syncStatus.behind > 0) {
    issues.push(`is ${syncStatus.behind} ${formatCommitSuffix(syncStatus.behind)} behind remote`);
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
