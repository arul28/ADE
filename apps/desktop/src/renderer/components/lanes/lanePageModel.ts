import { branchNameFromLaneRef } from "../../../shared/laneBaseResolution";
import type {
  GitHubPrListItem,
  GitHubPrStackMembership,
  LaneListSnapshot,
  LaneSummary,
  PrChecksStatus,
  PrLabel,
  PrReviewStatus,
  PrSummary,
} from "../../../shared/types";
import type { CreateLaneMode } from "./CreateLaneDialog";
import { mergeUnique } from "./laneUtils";
import { isTerminalPrState } from "../../lib/prState";
import { prRouteCoordinatesMatch } from "../prs/prsRouteState";

type CreateLaneRequest =
  | { kind: "child"; args: { name: string; parentLaneId: string } }
  | { kind: "root"; args: { name: string; baseBranch: string } }
  | { kind: "import"; args: { branchRef: string; name: string; baseBranch?: string } };

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
  /** A live PR follows the lane's current branch; previous PRs remain history on the lane. */
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

export const VISIBLE_LANE_PR_REFRESH_LIMIT = 4;
export const VISIBLE_LANE_PR_REFRESH_STALE_MS = 15_000;
export const DEFERRED_LANE_PANE_STEP_MS = 220;
export const DEFERRED_LANE_PANE_MAX_MS = 3_300;

export function resolveCreateLaneRequest(args: {
  name: string;
  createMode: CreateLaneMode;
  createParentLaneId: string;
  createBaseBranch: string;
  createImportBranch: string;
}): CreateLaneRequest {
  if (args.createMode === "child") {
    return {
      kind: "child",
      args: {
        name: args.name,
        parentLaneId: args.createParentLaneId,
      },
    };
  }

  if (args.createMode === "existing") {
    return {
      kind: "import",
      args: {
        branchRef: args.createImportBranch,
        name: args.name,
      },
    };
  }

  return {
    kind: "root",
    args: {
      name: args.name,
      baseBranch: args.createBaseBranch,
    },
  };
}

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
  const query = next.toString();
  return query ? `?${query}` : "";
}

export function planLaneDeleteBatches<T extends Pick<LaneSummary, "id" | "parentLaneId">>(lanes: T[]): T[][] {
  const lanesById = new Map(lanes.map((lane) => [lane.id, lane] as const));
  const remaining = new Set(lanesById.keys());
  const batches: T[][] = [];

  while (remaining.size > 0) {
    const leafIds = Array.from(remaining).filter((laneId) => {
      for (const candidateId of remaining) {
        if (lanesById.get(candidateId)?.parentLaneId === laneId) return false;
      }
      return true;
    });
    const batchIds = leafIds.length > 0 ? leafIds : [remaining.values().next().value as string];
    batches.push(batchIds.map((laneId) => lanesById.get(laneId)).filter((lane): lane is T => lane != null));
    for (const laneId of batchIds) {
      remaining.delete(laneId);
    }
  }

  return batches;
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

export function laneHasAncestor<T extends Pick<LaneSummary, "id" | "parentLaneId">>(
  laneId: string,
  ancestorLaneId: string,
  lanesById: ReadonlyMap<string, T>,
): boolean {
  const visited = new Set<string>([laneId]);
  let cursor = lanesById.get(laneId) ?? null;
  while (cursor?.parentLaneId) {
    const parentLaneId = cursor.parentLaneId;
    if (parentLaneId === ancestorLaneId) return true;
    if (visited.has(parentLaneId)) return false;
    visited.add(parentLaneId);
    cursor = lanesById.get(parentLaneId) ?? null;
  }
  return false;
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

function normalizeLanePrBranch(ref: string | null | undefined): string {
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

function comparePrTags(a: PrTagComparable, b: PrTagComparable): number {
  const byState = prStateRank(a.state) - prStateRank(b.state);
  if (byState !== 0) return byState;
  const aUpdated = Date.parse(a.updatedAt);
  const bUpdated = Date.parse(b.updatedAt);
  if (!Number.isNaN(aUpdated) && !Number.isNaN(bUpdated) && aUpdated !== bUpdated) {
    return bUpdated - aUpdated;
  }
  return b.githubPrNumber - a.githubPrNumber;
}

export function lanePrMatchesCurrentBranch(
  lane: Pick<LaneSummary, "id" | "laneType" | "branchRef" | "baseRef">,
  pr: Pick<PrSummary, "laneId" | "headBranch">,
): boolean {
  if (pr.laneId !== lane.id) return false;
  const laneBranch = normalizeLanePrBranch(lane.branchRef);
  const prHeadBranch = normalizeLanePrBranch(pr.headBranch);
  if (!laneBranch || !prHeadBranch || laneBranch !== prHeadBranch) return false;
  if (lane.laneType === "primary") {
    const baseBranch = normalizeLanePrBranch(lane.baseRef);
    if (laneBranch && baseBranch && laneBranch === baseBranch) return false;
  }
  return true;
}

export function lanePrRole(
  lane: Pick<LaneSummary, "id" | "laneType" | "branchRef" | "baseRef">,
  pr: Pick<PrSummary, "laneId" | "headBranch">,
): "active" | "previous" | null {
  if (pr.laneId !== lane.id) return null;
  if (!normalizeLanePrBranch(lane.branchRef) || !normalizeLanePrBranch(pr.headBranch)) return null;
  return lanePrMatchesCurrentBranch(lane, pr) ? "active" : "previous";
}

export function selectLanePrs(
  lane: Pick<LaneSummary, "id" | "laneType" | "branchRef" | "baseRef">,
  prs: PrSummary[],
): PrSummary[] {
  return prs
    .filter((pr) => !pr.detached && lanePrRole(lane, pr) != null)
    .sort((a, b) => {
      const aRole = lanePrRole(lane, a) === "active" ? 0 : 1;
      const bRole = lanePrRole(lane, b) === "active" ? 0 : 1;
      return aRole - bRole || comparePrTags(a, b);
    });
}

export function selectLanePrTag(
  lane: Pick<LaneSummary, "id" | "laneType" | "branchRef" | "baseRef">,
  prs: PrSummary[],
): PrSummary | null {
  return selectLanePrs(lane, prs)[0] ?? null;
}

export function githubPrMatchesCurrentBranch(
  lane: Pick<LaneSummary, "laneType" | "branchRef" | "baseRef">,
  pr: Pick<GitHubPrListItem, "headBranch" | "repoOwner" | "repoName" | "headRepoOwner" | "headRepoName">,
): boolean {
  const laneBranch = normalizeLanePrBranch(lane.branchRef);
  const prHeadBranch = normalizeLanePrBranch(pr.headBranch);
  if (!laneBranch || !prHeadBranch || laneBranch !== prHeadBranch) return false;
  const headRepoOwner = pr.headRepoOwner?.trim();
  const headRepoName = pr.headRepoName?.trim();
  if (!prRouteCoordinatesMatch(
    { prNumber: null, repoOwner: headRepoOwner ?? null, repoName: headRepoName ?? null },
    { prNumber: null, repoOwner: pr.repoOwner, repoName: pr.repoName },
  )) return false;
  if (lane.laneType === "primary") {
    const baseBranch = normalizeLanePrBranch(lane.baseRef);
    if (laneBranch && baseBranch && laneBranch === baseBranch) return false;
  }
  return true;
}

export function selectGithubLanePrTag(
  lane: Pick<LaneSummary, "laneType" | "branchRef" | "baseRef">,
  prs: GitHubPrListItem[],
): GitHubPrListItem | null {
  return selectGithubLanePrTags(lane, prs)[0] ?? null;
}

export function selectGithubLanePrTags(
  lane: Pick<LaneSummary, "laneType" | "branchRef" | "baseRef">,
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

export function getDeferredLanePaneDelayMs(args: {
  laneId: string | null;
  visibleLaneIds: readonly string[];
  stepMs?: number;
  maxMs?: number;
}): number {
  if (!args.laneId) return 0;
  const index = args.visibleLaneIds.indexOf(args.laneId);
  if (index <= 0) return 0;
  const stepMs = args.stepMs ?? DEFERRED_LANE_PANE_STEP_MS;
  const maxMs = args.maxMs ?? DEFERRED_LANE_PANE_MAX_MS;
  return Math.min(index * stepMs, maxMs);
}

type LaneRuntimeBucket = LaneListSnapshot["runtime"]["bucket"];

export function sortLaneListRows<T extends Pick<LaneSummary, "id" | "laneType">>(args: {
  lanes: T[];
  laneRuntimeById: ReadonlyMap<string, Pick<LaneListSnapshot["runtime"], "bucket">>;
  laneStatusFilter: LaneRuntimeBucket | "all";
  laneOrderById: ReadonlyMap<string, number>;
  pinnedLaneIds: ReadonlySet<string>;
}): T[] {
  const bucketRank: Record<LaneRuntimeBucket, number> = {
    "awaiting-input": 0,
    running: 1,
    ended: 2,
    none: 3,
  };
  const base =
    args.laneStatusFilter === "all"
      ? [...args.lanes]
      : args.lanes.filter((lane) => (args.laneRuntimeById.get(lane.id)?.bucket ?? "none") === args.laneStatusFilter);
  return base.sort((a, b) => {
    const aPrimary = a.laneType === "primary" ? 0 : 1;
    const bPrimary = b.laneType === "primary" ? 0 : 1;
    if (aPrimary !== bPrimary) return aPrimary - bPrimary;
    const aPinned = args.pinnedLaneIds.has(a.id) ? 0 : 1;
    const bPinned = args.pinnedLaneIds.has(b.id) ? 0 : 1;
    if (aPinned !== bPinned) return aPinned - bPinned;
    const aBucket = args.laneRuntimeById.get(a.id)?.bucket ?? "none";
    const bBucket = args.laneRuntimeById.get(b.id)?.bucket ?? "none";
    const byBucket = bucketRank[aBucket] - bucketRank[bBucket];
    if (byBucket !== 0) return byBucket;
    return (args.laneOrderById.get(a.id) ?? 0) - (args.laneOrderById.get(b.id) ?? 0);
  });
}

export function resolveLaneDeleteStartSelection(args: {
  deletingLaneIds: Iterable<string>;
  selectedLaneId: string | null;
  activeLaneIds: string[];
  pinnedLaneIds: Iterable<string>;
  filteredLaneIds: string[];
  sortedLaneIds: string[];
}): { selectedLaneId: string | null; activeLaneIds: string[]; pinnedLaneIds: Set<string> } {
  const deleting = new Set(args.deletingLaneIds);
  const isAvailable = (laneId: string | null | undefined): laneId is string =>
    Boolean(laneId && !deleting.has(laneId));
  const pinnedLaneIds = new Set(Array.from(args.pinnedLaneIds).filter((laneId) => !deleting.has(laneId)));
  const nextSelectedLaneId = isAvailable(args.selectedLaneId)
    ? args.selectedLaneId
    : args.filteredLaneIds.find((laneId) => !deleting.has(laneId))
      ?? args.sortedLaneIds.find((laneId) => !deleting.has(laneId))
      ?? null;
  const preservedActiveLaneIds = args.activeLaneIds.filter((laneId) => !deleting.has(laneId) && laneId !== nextSelectedLaneId);
  return {
    selectedLaneId: nextSelectedLaneId,
    activeLaneIds: mergeUnique(
      nextSelectedLaneId ? [nextSelectedLaneId] : [],
      preservedActiveLaneIds,
      Array.from(pinnedLaneIds),
    ),
    pinnedLaneIds,
  };
}

export function resolveVisibleLaneIds(args: {
  activeLaneIds: string[];
  existingLaneIds: Iterable<string>;
  filteredLaneIds: Iterable<string>;
  selectableFilteredLaneIds: Iterable<string>;
  deletingLaneIds: Iterable<string>;
}): string[] {
  const existing = new Set(args.existingLaneIds);
  const deleting = new Set(args.deletingLaneIds);
  const selectableFiltered = new Set(args.selectableFilteredLaneIds);
  const filteredLaneIds = Array.from(args.filteredLaneIds);
  const allowDeleteFallbackPane =
    selectableFiltered.size === 0 && filteredLaneIds.some((laneId) => deleting.has(laneId));

  return args.activeLaneIds.filter((laneId) => (
    existing.has(laneId)
    && !deleting.has(laneId)
    && (selectableFiltered.has(laneId) || allowDeleteFallbackPane)
  ));
}
