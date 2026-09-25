import type {
  GitHubPrListItem,
  PrChecksStatus,
  PrReviewDecision,
  PrReviewStatus,
  PrState,
} from "../../../../shared/types";
import { prNextStepBlocker, resolvePrNextStep, type PrNextStepKind } from "../../../../shared/prNextStep";

/**
 * The GitHub tab's row sort.
 *
 * `updated` is the historical default. `blocked` floats the PRs whose next step
 * is blocked on a person above the ones still waiting on CI, without ever
 * reordering rows across the open/merged/closed sections.
 */
export type GitHubTabSort = "updated" | "blocked";

export function normalizeGitHubTabSort(value: unknown): GitHubTabSort {
  return value === "blocked" ? "blocked" : "updated";
}

/** The subset of a linked local PR row the blocker resolver reads. */
export type GitHubRowBlockerSource = {
  mergeConflicts?: boolean | null;
  behindBaseBy?: number | null;
  checksStatus?: PrChecksStatus | null;
  reviewStatus?: PrReviewStatus | null;
};

function checksCounts(status: PrChecksStatus | null | undefined): { failing: number; pending: number; passing: number } {
  if (status === "failing") return { failing: 1, pending: 0, passing: 0 };
  if (status === "pending") return { failing: 0, pending: 1, passing: 0 };
  if (status === "passing") return { failing: 0, pending: 0, passing: 1 };
  return { failing: 0, pending: 0, passing: 0 };
}

function reviewDecisionFrom(status: PrReviewStatus | null | undefined): PrReviewDecision {
  if (status === "changes_requested") return "changes_requested";
  if (status === "approved") return "approved";
  if (status === "requested") return "review_required";
  return null;
}

/**
 * The next step for a GitHub list row, from the row plus its linked local row.
 *
 * Reuses `resolvePrNextStep` so the list and the Merge card agree on what
 * "blocked" means rather than the list re-deriving its own blocker rules. The
 * detail-only signals the list does not carry (merge box, review threads,
 * approval counts) stay neutral.
 */
export function resolveGitHubRowNextStepKind(args: {
  state: PrState;
  isDraft: boolean;
  baseBranch: string | null;
  source: GitHubRowBlockerSource | null;
}): PrNextStepKind {
  if (args.state === "merged") return "merged";
  if (args.state === "closed") return "closed";
  // A GitHub draft can arrive as `open` + `isDraft`; it is not ready for any
  // merge-blocking action until it is marked ready.
  if (args.isDraft || args.state === "draft") return "draft";
  const source = args.source;
  const step = resolvePrNextStep({
    state: args.state,
    mergeStateStatus: null,
    mergeConflicts: Boolean(source?.mergeConflicts),
    behindBaseBy: source?.behindBaseBy ?? null,
    mergeabilityComputing: false,
    checksStatus: source?.checksStatus ?? null,
    checks: checksCounts(source?.checksStatus),
    reviewDecision: reviewDecisionFrom(source?.reviewStatus),
    approvalsCount: null,
    requiredApprovals: null,
    // The review decision above already drives the changes_requested branch; the
    // list has no per-reviewer logins to attribute it to.
    changesRequestedBy: [],
    unresolvedThreads: 0,
    canBypass: false,
    autoMergeAllowed: undefined,
    autoMergeEnabled: false,
    autoMergeMethod: null,
    baseBranch: args.baseBranch ?? "main",
  });
  return step.kind;
}

/**
 * Tier for the "Blocked on me" sort: 0 blocked on a person, 1 waiting on
 * CI/others, 2 nothing outstanding. Lower sorts first.
 */
export function githubRowBlockedTier(kind: PrNextStepKind): number {
  const blocker = prNextStepBlocker(kind);
  return blocker === "me" ? 0 : blocker === "waiting" ? 1 : 2;
}

export function compareGitHubRowsByUpdated(a: GitHubPrListItem, b: GitHubPrListItem): number {
  return new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime();
}

/**
 * Newest-first within a tier, and never across: the comparator only reorders
 * rows inside one open/merged/closed section because it treats equal tiers by
 * the historical updated-desc order.
 */
export function compareGitHubRows(a: GitHubPrListItem, b: GitHubPrListItem, tierOf: (item: GitHubPrListItem) => number): number {
  const tierDelta = tierOf(a) - tierOf(b);
  if (tierDelta !== 0) return tierDelta;
  return compareGitHubRowsByUpdated(a, b);
}
