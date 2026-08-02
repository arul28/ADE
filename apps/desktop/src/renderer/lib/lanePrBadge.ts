import type { LaneSummary, PrState, PrSummary } from "../../shared/types";
import { lanePrMatchesCurrentBranch } from "../components/lanes/lanePageModel";
import { COLORS } from "../components/lanes/laneDesignTokens";

/**
 * Rank used to choose the one PR that represents a lane in a dense list:
 * an open PR is the most actionable, then a draft, then a merged/closed one.
 * Lower rank wins.
 */
export function primaryPrStateRank(state: PrState): number {
  switch (state) {
    case "open":
      return 0;
    case "draft":
      return 1;
    case "merged":
      return 2;
    default:
      return 3; // closed
  }
}

type PrimaryPrComparable = Pick<PrSummary, "state" | "updatedAt" | "githubPrNumber">;

function comparePrimaryPr(a: PrimaryPrComparable, b: PrimaryPrComparable): number {
  const byRank = primaryPrStateRank(a.state) - primaryPrStateRank(b.state);
  if (byRank !== 0) return byRank;
  const aUpdated = Date.parse(a.updatedAt);
  const bUpdated = Date.parse(b.updatedAt);
  if (Number.isFinite(aUpdated) && Number.isFinite(bUpdated) && aUpdated !== bUpdated) {
    return bUpdated - aUpdated;
  }
  return b.githubPrNumber - a.githubPrNumber;
}

/**
 * Pick the single PR that best represents a set of PRs: prefer open over draft
 * over merged/closed; among equals the most recently updated (then highest
 * number) wins. Returns null for an empty list. Pure — the caller pre-filters
 * to a lane's PRs.
 */
export function pickPrimaryPr<T extends PrimaryPrComparable>(prs: T[]): T | null {
  let best: T | null = null;
  for (const pr of prs) {
    if (best === null || comparePrimaryPr(pr, best) < 0) best = pr;
  }
  return best;
}

/** The lane's primary PR from the ADE-mapped set, matched on the lane's current branch. */
export function selectPrimaryLanePr(
  lane: Pick<LaneSummary, "id" | "laneType" | "branchRef" | "baseRef">,
  prs: PrSummary[],
): PrSummary | null {
  return pickPrimaryPr(prs.filter((pr) => lanePrMatchesCurrentBranch(lane, pr)));
}

/** One-word capsule copy for a PR state. */
export function lanePrStateLabel(state: PrState): string {
  switch (state) {
    case "open":
      return "Open";
    case "draft":
      return "Draft";
    case "merged":
      return "Merged";
    default:
      return "Closed";
  }
}

/** State-colored dot color, mirroring the PR-tab badge palette. */
export function lanePrStateColor(state: PrState): string {
  switch (state) {
    case "open":
      return COLORS.info;
    case "draft":
      return COLORS.accent;
    case "merged":
      return COLORS.success;
    default:
      return COLORS.textSecondary; // closed
  }
}

/** Deep link the PR chip opens, identical from every host so the target cannot drift. */
export function lanePrDeepLinkPath(pr: PrSummary): string {
  return `/prs?tab=normal&prId=${encodeURIComponent(pr.id)}`;
}

/**
 * Opens a lane's PR from any Work surface.
 *
 * The PRs tab reads the machine the project tab is bound to, and a PR id is only
 * resolvable on the machine that owns it — so deep-linking a PR that lives on
 * another machine lands on an empty tab. GitHub resolves identically from every
 * machine, so a foreign PR opens there instead of pretending to navigate.
 *
 * Canonical on purpose: the sidebar badge, the session card, and the chat PR
 * pane all answer "where does this PR open" the same way, and a fourth caller
 * getting it wrong is exactly how the foreign-PR dead end appeared twice.
 */
export function openLanePr(
  pr: PrSummary,
  options: {
    foreign?: boolean;
    navigate: (path: string) => void;
    /**
     * Overrides the in-app destination for the local case. The chat toolbar
     * uses a richer route that also selects the lane; everything else wants the
     * plain deep link.
     */
    localPath?: string;
  },
): void {
  if (!options.foreign) {
    options.navigate(options.localPath ?? lanePrDeepLinkPath(pr));
    return;
  }
  if (!pr.githubUrl) return;
  // `githubUrl` on a foreign row is data the paired machine sent us, so
  // `openExternal` can reject (the main process enforces an http/https/mailto
  // allowlist). Swallow it into the same in-app fallback the PR pane uses
  // rather than raising an unhandled rejection on a click handler.
  void window.ade.app.openExternal(pr.githubUrl).catch(() => {
    try {
      window.open(pr.githubUrl, "_blank", "noopener,noreferrer");
    } catch {
      /* nothing left to try */
    }
  });
}
