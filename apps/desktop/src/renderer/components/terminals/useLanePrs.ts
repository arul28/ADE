import { useEffect, useMemo, useState } from "react";
import type { GitHubPrListItem, LaneSummary, PrSummary } from "../../../shared/types";
import { getGitHubSnapshotCoalesced, listPrsCoalesced } from "../../lib/prReadCache";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import {
  lanePrMatchesCurrentBranch,
  selectGithubLanePrTag,
} from "../lanes/lanePageModel";

function githubItemToLanePr(item: GitHubPrListItem, laneId: string): PrSummary {
  return {
    id: item.linkedPrId ?? `gh:${item.repoOwner}/${item.repoName}#${item.githubPrNumber}`,
    laneId,
    projectId: "github-projection",
    repoOwner: item.repoOwner,
    repoName: item.repoName,
    githubPrNumber: item.githubPrNumber,
    githubUrl: item.githubUrl,
    githubNodeId: null,
    title: item.title,
    state: item.isDraft ? "draft" : item.state,
    baseBranch: item.baseBranch ?? "",
    headBranch: item.headBranch ?? "",
    // "none", not "not_run": the GitHub list endpoint carries no check data at
    // all, so we have observed nothing rather than observed an absence. Only a
    // rollup that actually looked at the commit may claim "not_run" (ADE-135).
    checksStatus: "none",
    reviewStatus: "none",
    additions: 0,
    deletions: 0,
    lastSyncedAt: null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    stack: item.stack ?? null,
    unmapped: item.linkedPrId == null ? true : undefined,
  };
}

export function buildLanePrsByLaneId(args: {
  lanes: LaneSummary[];
  prs: PrSummary[];
  githubPrs: GitHubPrListItem[];
}): Map<string, PrSummary[]> {
  const byLane = new Map<string, PrSummary[]>();
  for (const lane of args.lanes) {
    const githubPr = selectGithubLanePrTag(lane, args.githubPrs);
    const mapped = args.prs
      .filter((pr) => lanePrMatchesCurrentBranch(lane, pr))
      .map((pr) => ({
        ...pr,
        stack: githubPr?.githubPrNumber === pr.githubPrNumber
          ? githubPr.stack ?? pr.stack ?? null
          : pr.stack ?? null,
      }));
    if (mapped.length > 0) {
      byLane.set(lane.id, mapped);
    } else if (githubPr) {
      byLane.set(lane.id, [githubItemToLanePr(githubPr, lane.id)]);
    }
  }
  return byLane;
}

/**
 * Canonical current-branch PRs grouped by lane id. A coalesced mapped-PR read
 * and GitHub snapshot read cover both ADE-linked and GitHub-only PRs without
 * per-lane requests. The `prs-updated` push keeps both caches fresh.
 *
 * Extracted from SessionListPane so the Work session hook can answer the
 * "Has PR" chip filter from the same data the lane-header badge renders. The
 * underlying read is coalesced and the event subscription is idempotent, so
 * more than one caller costs a listener and nothing else.
 *
 */
export function useLanePrsByLaneId(): Map<string, PrSummary[]> {
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const lanes = useAppStore((state) => state.lanes);
  const [prs, setPrs] = useState<PrSummary[]>([]);
  const [githubPrs, setGithubPrs] = useState<GitHubPrListItem[]>([]);
  useEffect(() => {
    // `window.ade.prs` is absent in some renders (e.g. tests with a partial
    // `window.ade` mock); no-op gracefully so the badge just doesn't render.
    if (!window.ade?.prs) return;
    let cancelled = false;
    const refresh = () => Promise.all([
      listPrsCoalesced({ projectRoot }),
      getGitHubSnapshotCoalesced({}, { projectRoot }),
    ])
      .then(([list, snapshot]) => {
        if (cancelled) return;
        setPrs(list);
        setGithubPrs(snapshot?.repoPullRequests ?? []);
      })
      .catch(() => {});
    void refresh();
    const unsubscribe = window.ade.prs.onEvent((event) => {
      if (event.type !== "prs-updated") return;
      setPrs(event.prs);
      void getGitHubSnapshotCoalesced({}, { projectRoot })
        .then((snapshot) => {
          if (!cancelled) setGithubPrs(snapshot?.repoPullRequests ?? []);
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectRoot]);
  return useMemo(
    () => buildLanePrsByLaneId({ lanes, prs, githubPrs }),
    [githubPrs, lanes, prs],
  );
}
