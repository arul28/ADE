import { branchNameFromLaneRef, laneIsOnBaseBranch } from "../../../shared/laneBaseResolution";
import type {
  GitHubPrListItem,
  GitHubPrStackMembership,
  LaneSummary,
  PrChecksStatus,
  PrLabel,
  PrReviewStatus,
  PrSummary,
} from "../../../shared/types";
import { isTerminalPrState } from "../../lib/prState";
import { buildPrsRouteSearch, prRouteCoordinatesMatch } from "../prs/prsRouteState";

// Re-exported because these names were this module's API first, and the lane
// surfaces and their tests import them from here. The rule itself lives in
// `shared/` so the host bridge and the CLI answer it the same way.
export { laneIsOnBaseBranch };

export type LaneDeleteBatchResult<T> =
  | { status: "fulfilled"; lane: T }
  | { status: "rejected"; lane: T; reason: unknown };

export const LANE_DELETE_BATCH_CONCURRENCY = 2;

export type LaneTabPrTag = {
  source: "ade" | "github";
  id: string;
  linkedPrId: string | null;
  githubPrNumber: number;
  githubUrl: string;
  /** Repository coordinates keep badge deep links usable before local hydration. */
  repoOwner: string;
  repoName: string;
  title: string;
  state: PrSummary["state"];
  /** Visible lane tags always follow the lane's current branch. Older rows stay in PR history. */
  laneRole?: "active" | "previous";
  // Optional richer fields used to render the hover popover card. Populated when
  // available from the mapped PrSummary and/or the GitHub list item; merged in
  // `selectLaneTabPrTag` so the card gets the richest data across both sources.
  baseBranch?: string | null;
  headBranch?: string | null;
  checksStatus?: PrChecksStatus;
  /** Why the rollup landed where it did; only set for non-obvious states. */
  checksReason?: string | null;
  reviewStatus?: PrReviewStatus;
  additions?: number;
  deletions?: number;
  mergeConflicts?: boolean | null;
  behindBaseBy?: number | null;
  updatedAt?: string;
  labels?: PrLabel[];
  author?: string | null;
  stack?: GitHubPrStackMembership | null;
};

export function lanePrTagRoutePath(
  target: Pick<LaneTabPrTag, "linkedPrId" | "githubPrNumber" | "repoOwner" | "repoName">,
): string | null {
  if (
    !Number.isInteger(target.githubPrNumber)
    || target.githubPrNumber <= 0
    || !target.repoOwner.trim()
    || !target.repoName.trim()
  ) return null;
  return `/prs${buildPrsRouteSearch({
    activeTab: target.linkedPrId ? "normal" : "github",
    selectedPrId: target.linkedPrId,
    selectedPrNumber: target.githubPrNumber,
    repoOwner: target.repoOwner,
    repoName: target.repoName,
  })}`;
}

export const VISIBLE_LANE_PR_REFRESH_LIMIT = 4;
export const VISIBLE_LANE_PR_REFRESH_STALE_MS = 15_000;

export function parseLaneIdsParam(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function shouldApplyLaneIdsDeepLink(args: { action: string | null; laneIdsRaw: string | null }): boolean {
  return !args.action && parseLaneIdsParam(args.laneIdsRaw).length > 0;
}

export function buildLaneActionClearedSearch(search: string): string {
  const next = new URLSearchParams(search);
  next.delete("action");
  next.delete("laneId");
  next.delete("laneIds");
  next.delete("manageTab");
  const query = next.toString();
  return query ? `?${query}` : "";
}

export async function runLaneDeleteBatchWithConcurrency<T>(
  lanes: T[],
  deleteLane: (lane: T) => Promise<void>,
  concurrency = LANE_DELETE_BATCH_CONCURRENCY,
): Promise<LaneDeleteBatchResult<T>[]> {
  if (lanes.length === 0) return [];

  const results = new Array<LaneDeleteBatchResult<T>>(lanes.length);
  const normalizedConcurrency = Number.isFinite(concurrency)
    ? Math.floor(concurrency)
    : LANE_DELETE_BATCH_CONCURRENCY;
  const workerCount = Math.min(lanes.length, Math.max(1, normalizedConcurrency));
  let nextIndex = 0;

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < lanes.length) {
      const index = nextIndex;
      nextIndex += 1;
      const lane = lanes[index]!;
      try {
        await deleteLane(lane);
        results[index] = { status: "fulfilled", lane };
      } catch (reason) {
        results[index] = { status: "rejected", lane, reason };
      }
    }
  }));

  return results;
}

export function resolveLaneIdsDeepLinkSelection(args: {
  laneIdsRaw: string | null;
  inspectorTabParam?: string | null;
  availableLaneIds: Iterable<string>;
  consumedSignature: string | null;
}): { laneIds: string[]; signature: string } | null {
  const parsed = parseLaneIdsParam(args.laneIdsRaw);
  if (parsed.length === 0) return null;
  const signature = `${parsed.join(",")}::${args.inspectorTabParam ?? ""}`;
  if (signature === args.consumedSignature) return null;
  const available = new Set(args.availableLaneIds);
  const laneIds = parsed.filter((laneId) => available.has(laneId));
  if (laneIds.length !== parsed.length) return null;
  return { laneIds, signature };
}

export function normalizeLanePrBranch(ref: string | null | undefined): string {
  return branchNameFromLaneRef(ref).trim();
}

function prStateRank(state: PrSummary["state"]): number {
  if (state === "open" || state === "draft") return 0;
  if (state === "merged") return 1;
  return 2;
}

type PrTagComparable = {
  state: PrSummary["state"];
  updatedAt: string;
  githubPrNumber: number;
};

export function comparePrTags(a: PrTagComparable, b: PrTagComparable): number {
  const byState = prStateRank(a.state) - prStateRank(b.state);
  if (byState !== 0) return byState;
  const aUpdated = Date.parse(a.updatedAt);
  const bUpdated = Date.parse(b.updatedAt);
  if (!Number.isNaN(aUpdated) && !Number.isNaN(bUpdated) && aUpdated !== bUpdated) {
    return bUpdated - aUpdated;
  }
  return b.githubPrNumber - a.githubPrNumber;
}

type LanePrMatchLane = Pick<LaneSummary, "id" | "laneType" | "branchRef" | "baseRef"> & {
  branchDrift?: LaneSummary["branchDrift"];
};

/** Branch a PR is compared to. Drift means the checkout moved and the record did not. */
export function effectiveLanePrBranchRef(
  lane: Pick<LaneSummary, "branchRef"> & { branchDrift?: LaneSummary["branchDrift"] },
): string {
  const live = lane.branchDrift?.headBranchRef?.trim();
  if (live) return live;
  return lane.branchRef;
}

export function lanePrMatchesCurrentBranch(
  lane: LanePrMatchLane,
  pr: Pick<PrSummary, "laneId" | "headBranch">,
): boolean {
  if (pr.laneId !== lane.id) return false;
  const laneBranch = normalizeLanePrBranch(effectiveLanePrBranchRef(lane));
  const prHeadBranch = normalizeLanePrBranch(pr.headBranch);
  if (!laneBranch || !prHeadBranch || laneBranch !== prHeadBranch) return false;
  return !laneIsOnBaseBranch({ ...lane, branchRef: laneBranch });
}

function lanePrMatchesRecordedBranch(
  lane: LanePrMatchLane,
  pr: Pick<PrSummary, "laneId" | "headBranch">,
): boolean {
  if (pr.laneId !== lane.id) return false;
  const laneBranch = normalizeLanePrBranch(lane.branchRef);
  const prHeadBranch = normalizeLanePrBranch(pr.headBranch);
  if (!laneBranch || !prHeadBranch || laneBranch !== prHeadBranch) return false;
  return !laneIsOnBaseBranch(lane);
}

export function lanePrRole(
  lane: LanePrMatchLane,
  pr: Pick<PrSummary, "laneId" | "headBranch">,
): "active" | "previous" | null {
  if (pr.laneId !== lane.id) return null;
  if (!normalizeLanePrBranch(effectiveLanePrBranchRef(lane)) || !normalizeLanePrBranch(pr.headBranch)) return null;
  return lanePrMatchesCurrentBranch(lane, pr) ? "active" : "previous";
}

export function selectLanePrs(
  lane: LanePrMatchLane,
  prs: PrSummary[],
): PrSummary[] {
  // This is the renderer-facing selector used by lane tags, counters, hover
  // lists, Work cards, and chat badges. Historical rows remain in the source
  // list and PR workspace, but never leak into those visible lane surfaces.
  //
  // A primary lane parked on its base branch has no lane PR work at all — chat
  // link or not. The primary lane is the project's own checkout: it cannot be
  // deleted or archived, so anything still attached when it returns to `main`
  // (a merged PR a chat once linked, above all) would otherwise stay pinned to
  // it forever. The main-process single-PR selector
  // (`selectLanePrDisplayCandidate`) and the lane-link bridge answer null for
  // this state too, and the Work/tab badges should not disagree with them. This
  // gate reads the live checkout (`effectiveLanePrBranchRef`) because these
  // surfaces show that branch's PRs; a lane parked on a drifted HEAD is still
  // parked, and the lane record re-syncs to the live HEAD on the next list.
  if (laneIsOnBaseBranch({ ...lane, branchRef: effectiveLanePrBranchRef(lane) })) return [];
  return prs
    .filter((pr) => {
      if (pr.detached) return false;
      // Lane ownership is NOT negotiable here. Callers pass the project-wide PR
      // list, and `lanePrMatchesCurrentBranch` is the only place lane identity
      // is checked, so skipping straight past it on a chat link would put every
      // linked PR on every lane in the project.
      if (pr.laneId !== lane.id) return false;
      // Only the BRANCH half is relaxed. Every PR opened from a lane carries the
      // lane's branch, so branch matching alone capped a lane at one PR and hid
      // a deliberately linked second one. A PR this lane owns and a chat linked
      // stays visible even once the lane moves to another branch. Historical
      // rows with no link still fall back to the branch rule and stay hidden.
      if ((pr.chatSessionIds?.filter(Boolean).length ?? 0) > 0) return true;
      if (lanePrMatchesCurrentBranch(lane, pr)) return true;
      // A drifted checkout did not move the lane: it still records its branch,
      // so that branch's PR is still the lane's work. Without this, an agent
      // cutting a follow-up branch hid the lane's own PR.
      return Boolean(lane.branchDrift?.headBranchRef) && lanePrMatchesRecordedBranch(lane, pr);
    })
    .sort(comparePrTags);
}

/**
 * What a CHAT should show: everything `selectLanePrs` gives the lane, plus any
 * pull request this chat explicitly linked — whether another lane owns it, or
 * the lane surface dropped it (a primary lane back on its base branch sheds its
 * PR tags, but the chat that opened the PR still shows the thread that did the
 * work).
 *
 * The two rules have to live apart. Lane surfaces (tags, badges, Work cards)
 * must stay strictly lane-owned — relaxing that put one lane's PR on every lane
 * in the project. Chat surfaces must not, because `linkToLane` deliberately
 * leaves `lane_id` on the ORIGINAL owning lane, so a cross-lane link would
 * otherwise be written to the database and then filtered out of every view.
 */
export function selectChatPrs(
  lane: LanePrMatchLane,
  prs: PrSummary[],
  sessionId?: string | null,
): PrSummary[] {
  const owned = selectLanePrs(lane, prs);
  const seen = new Set(owned.map((pr) => pr.id));
  const linkedToSession = sessionId
    ? prs.filter((pr) => (
      !pr.detached
      && !seen.has(pr.id)
      && Boolean(pr.chatSessionIds?.includes(sessionId))
    ))
    : [];
  return [...owned, ...linkedToSession].sort(comparePrTags);
}

export function selectLanePrTag(
  lane: LanePrMatchLane,
  prs: PrSummary[],
): PrSummary | null {
  return selectLanePrs(lane, prs)[0] ?? null;
}

export function githubPrMatchesCurrentBranch(
  lane: Pick<LaneSummary, "laneType" | "branchRef" | "baseRef"> & { branchDrift?: LaneSummary["branchDrift"] },
  pr: Pick<GitHubPrListItem, "headBranch" | "repoOwner" | "repoName" | "headRepoOwner" | "headRepoName">,
): boolean {
  const laneBranch = normalizeLanePrBranch(effectiveLanePrBranchRef(lane));
  const prHeadBranch = normalizeLanePrBranch(pr.headBranch);
  if (!laneBranch || !prHeadBranch || laneBranch !== prHeadBranch) return false;
  const headRepoOwner = pr.headRepoOwner?.trim();
  const headRepoName = pr.headRepoName?.trim();
  if (!prRouteCoordinatesMatch(
    { prNumber: null, repoOwner: headRepoOwner ?? null, repoName: headRepoName ?? null },
    { prNumber: null, repoOwner: pr.repoOwner, repoName: pr.repoName },
  )) return false;
  return !laneIsOnBaseBranch({ ...lane, branchRef: laneBranch });
}

export function selectGithubLanePrTag(
  lane: Pick<LaneSummary, "laneType" | "branchRef" | "baseRef"> & { branchDrift?: LaneSummary["branchDrift"] },
  prs: GitHubPrListItem[],
): GitHubPrListItem | null {
  return selectGithubLanePrTags(lane, prs)[0] ?? null;
}

export function selectGithubLanePrTags(
  lane: Pick<LaneSummary, "laneType" | "branchRef" | "baseRef"> & { branchDrift?: LaneSummary["branchDrift"] },
  prs: GitHubPrListItem[],
): GitHubPrListItem[] {
  return prs
    .filter((pr) => pr.scope === "repo" && githubPrMatchesCurrentBranch(lane, pr))
    .sort(comparePrTags);
}

function toLaneTabPrTagFromPrSummary(pr: PrSummary, laneRole?: "active" | "previous"): LaneTabPrTag {
  return {
    source: "ade",
    id: pr.id,
    linkedPrId: pr.id,
    githubPrNumber: pr.githubPrNumber,
    githubUrl: pr.githubUrl,
    repoOwner: pr.repoOwner,
    repoName: pr.repoName,
    title: pr.title,
    state: pr.state,
    laneRole,
    baseBranch: pr.baseBranch,
    headBranch: pr.headBranch,
    checksStatus: pr.checksStatus,
    checksReason: pr.checksReason ?? null,
    reviewStatus: pr.reviewStatus,
    additions: pr.additions,
    deletions: pr.deletions,
    mergeConflicts: pr.mergeConflicts,
    behindBaseBy: pr.behindBaseBy,
    updatedAt: pr.updatedAt,
    stack: pr.stack ?? null,
  };
}

function toLaneTabPrTagFromGithubItem(
  pr: GitHubPrListItem,
  laneId: string,
  laneRole: "active" | "previous" = "active",
): LaneTabPrTag {
  const linkedPrId = pr.linkedLaneId === laneId ? pr.linkedPrId : null;
  return {
    source: "github",
    id: pr.id,
    linkedPrId,
    githubPrNumber: pr.githubPrNumber,
    githubUrl: pr.githubUrl,
    repoOwner: pr.repoOwner,
    repoName: pr.repoName,
    title: pr.title,
    state: pr.isDraft ? "draft" : pr.state,
    laneRole,
    baseBranch: pr.baseBranch,
    headBranch: pr.headBranch,
    updatedAt: pr.updatedAt,
    labels: pr.labels,
    author: pr.author,
    stack: pr.stack ?? null,
  };
}

/**
 * Cross-merge the two PR data sources into one tag: labels/author typically come
 * only from the GitHub list item, while diff/checks/reviews come only from the
 * mapped PrSummary. The base tag's own state/url/title win; the secondary source
 * only fills in fields the base is missing.
 */
function mergeLaneTabPrTags(base: LaneTabPrTag, secondary: LaneTabPrTag | null): LaneTabPrTag {
  if (!secondary) return base;
  return {
    ...base,
    baseBranch: base.baseBranch ?? secondary.baseBranch,
    headBranch: base.headBranch ?? secondary.headBranch,
    checksStatus: base.checksStatus ?? secondary.checksStatus,
    checksReason: base.checksReason ?? secondary.checksReason ?? null,
    reviewStatus: base.reviewStatus ?? secondary.reviewStatus,
    additions: base.additions ?? secondary.additions,
    deletions: base.deletions ?? secondary.deletions,
    mergeConflicts: base.mergeConflicts ?? secondary.mergeConflicts,
    behindBaseBy: base.behindBaseBy ?? secondary.behindBaseBy,
    updatedAt: base.updatedAt ?? secondary.updatedAt,
    labels: base.labels ?? secondary.labels,
    author: base.author ?? secondary.author,
    stack: base.stack ?? secondary.stack ?? null,
  };
}

function compareLaneTabPrTags(a: LaneTabPrTag, b: LaneTabPrTag): number {
  const aRole = a.laneRole === "active" ? 0 : 1;
  const bRole = b.laneRole === "active" ? 0 : 1;
  if (aRole !== bRole) return aRole - bRole;
  const byState = prStateRank(a.state) - prStateRank(b.state);
  if (byState !== 0) return byState;
  const aUpdated = Date.parse(a.updatedAt ?? "");
  const bUpdated = Date.parse(b.updatedAt ?? "");
  if (!Number.isNaN(aUpdated) && !Number.isNaN(bUpdated) && aUpdated !== bUpdated) {
    return bUpdated - aUpdated;
  }
  // Preserve ADE's richer mapped tag when an unlinked GitHub projection ties
  // it on state and recency.
  if (a.source !== b.source) return a.source === "ade" ? -1 : 1;
  return b.githubPrNumber - a.githubPrNumber;
}

function githubPrMatchesAdePr(pr: PrSummary, githubPr: GitHubPrListItem): boolean {
  return (
    githubPr.linkedPrId === pr.id ||
    githubPr.githubPrNumber === pr.githubPrNumber ||
    githubPr.githubUrl === pr.githubUrl
  );
}

function selectTerminalGithubUpdateForPr(
  pr: PrSummary,
  githubPrs: GitHubPrListItem[],
): GitHubPrListItem | null {
  if (isTerminalPrState(pr.state)) return null;
  return githubPrs
    .filter((githubPr) =>
      githubPr.scope === "repo" &&
      isTerminalPrState(githubPr.state) &&
      githubPrMatchesAdePr(pr, githubPr)
    )
    .sort(comparePrTags)[0] ?? null;
}

function shouldPreferGithubPrTag(
  pr: PrSummary,
  githubPr: GitHubPrListItem,
): boolean {
  const githubState = githubPr.isDraft ? "draft" : githubPr.state;
  if (!githubPrMatchesAdePr(pr, githubPr)) {
    return isTerminalPrState(pr.state) && !isTerminalPrState(githubState);
  }
  if (isTerminalPrState(pr.state) && !isTerminalPrState(githubState)) {
    return false;
  }
  return githubState !== pr.state;
}

export function selectLaneTabPrTag(
  lane: Pick<LaneSummary, "id" | "laneType" | "branchRef" | "baseRef">,
  prs: PrSummary[],
  githubPrs: GitHubPrListItem[],
): LaneTabPrTag | null {
  return selectLaneTabPrTags(lane, prs, githubPrs)[0] ?? null;
}

export function selectLaneTabPrTags(
  lane: Pick<LaneSummary, "id" | "laneType" | "branchRef" | "baseRef">,
  prs: PrSummary[],
  githubPrs: GitHubPrListItem[],
): LaneTabPrTag[] {
  const mappedPrs = selectLanePrs(lane, prs);
  const laneGithubPrs = selectGithubLanePrTags(lane, githubPrs);
  const mappedTags = mappedPrs.map((mappedPr) => {
    const githubPr = laneGithubPrs.find((candidate) => githubPrMatchesAdePr(mappedPr, candidate)) ?? null;
    // The PrSummary carries diff/checks/reviews; the matching GitHub item carries
    // labels/author. Merge so the popover card has the richest data available.
    const role = lanePrRole(lane, mappedPr) ?? "previous";
    const githubTag = githubPr ? toLaneTabPrTagFromGithubItem(githubPr, lane.id, role) : null;
    const terminalGithubPr = selectTerminalGithubUpdateForPr(mappedPr, githubPrs);
    if (terminalGithubPr) {
      return mergeLaneTabPrTags(
        toLaneTabPrTagFromGithubItem(terminalGithubPr, lane.id, role),
        toLaneTabPrTagFromPrSummary(mappedPr, role),
      );
    }
    if (githubTag && shouldPreferGithubPrTag(mappedPr, githubPr!)) {
      return mergeLaneTabPrTags(githubTag, toLaneTabPrTagFromPrSummary(mappedPr, role));
    }
    return mergeLaneTabPrTags(toLaneTabPrTagFromPrSummary(mappedPr, role), githubTag);
  });
  const mappedGithubKeys = new Set(mappedPrs.map((mappedPr) => (
    laneGithubPrs.find((candidate) => githubPrMatchesAdePr(mappedPr, candidate))?.id
  )).filter((id): id is string => Boolean(id)));
  const unmappedTags = laneGithubPrs
    .filter((githubPr) => !mappedGithubKeys.has(githubPr.id))
    .map((githubPr) => toLaneTabPrTagFromGithubItem(githubPr, lane.id, "active"));
  return [...mappedTags, ...unmappedTags].sort(compareLaneTabPrTags);
}

function isPrRefreshStale(pr: Pick<PrSummary, "lastSyncedAt">, nowMs: number, staleMs: number): boolean {
  const lastSyncedMs = Date.parse(pr.lastSyncedAt ?? "");
  return Number.isNaN(lastSyncedMs) || nowMs - lastSyncedMs >= staleMs;
}

export function selectVisibleLanePrRefreshIds(args: {
  visibleLaneIds: string[];
  lanePrByLaneId: ReadonlyMap<string, LaneTabPrTag | readonly LaneTabPrTag[]>;
  prs: PrSummary[];
  recentlyRequestedAtByPrId?: ReadonlyMap<string, number>;
  nowMs?: number;
  staleMs?: number;
  limit?: number;
}): string[] {
  const nowMs = args.nowMs ?? Date.now();
  const staleMs = args.staleMs ?? VISIBLE_LANE_PR_REFRESH_STALE_MS;
  const limit = args.limit ?? VISIBLE_LANE_PR_REFRESH_LIMIT;
  if (limit <= 0) return [];

  const prById = new Map(args.prs.map((pr) => [pr.id, pr] as const));
  const selected: string[] = [];
  const seen = new Set<string>();

  for (const laneId of args.visibleLaneIds) {
    const entry = args.lanePrByLaneId.get(laneId);
    const tags = Array.isArray(entry) ? entry : entry ? [entry] : [];
    for (const tag of tags) {
      const prId = tag.linkedPrId;
      if (!prId || seen.has(prId)) continue;
      seen.add(prId);

      const pr = prById.get(prId);
      if (!pr || !isPrRefreshStale(pr, nowMs, staleMs)) continue;

      const requestedAt = args.recentlyRequestedAtByPrId?.get(prId);
      if (requestedAt != null && nowMs - requestedAt < staleMs) continue;

      selected.push(prId);
      if (selected.length >= limit) break;
    }
    if (selected.length >= limit) break;
  }

  return selected;
}

/**
 * Lane to show after `deletingLaneIds` start deleting: the current selection
 * when it survives, else the first surviving candidate in list order.
 */
export function resolveLaneSelectionAfterDelete(args: {
  deletingLaneIds: ReadonlySet<string>;
  selectedLaneId: string | null;
  candidateLaneIds: readonly string[];
}): string | null {
  if (args.selectedLaneId && !args.deletingLaneIds.has(args.selectedLaneId)) return args.selectedLaneId;
  return args.candidateLaneIds.find((laneId) => !args.deletingLaneIds.has(laneId)) ?? null;
}
