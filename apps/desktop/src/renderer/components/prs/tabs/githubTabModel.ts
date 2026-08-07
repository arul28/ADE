import type {
  GitHubPrListItem,
  GitHubPrSnapshot,
  PrSummary,
  PrWithConflicts,
} from "../../../../shared/types";
import { syntheticGithubPrId } from "../../../../shared/types/prs";
import { isTerminalPrState } from "../../../lib/prState";
import {
  prRouteCoordinatesKey,
  prRouteCoordinatesMatch,
  type PrRouteSelectionTarget,
} from "../prsRouteState";

export const GITHUB_TAB_VIRTUALIZE_AT = 50;
export const GITHUB_TAB_REVISIT_CACHE_TTL_MS = 60_000;
export const GITHUB_TAB_SNAPSHOT_FRESH_MS = 30_000;
export const GITHUB_TAB_HOT_REFRESH_DELAY_MS = 30_000;
export const GITHUB_TAB_HISTORY_INITIAL_PAGE_LIMIT = 2;
export const GITHUB_TAB_HISTORY_PAGE_INCREMENT = 2;
export const GITHUB_TAB_HISTORY_MAX_PAGE_LIMIT = 10;

const GITHUB_TAB_CACHE_DISABLED = import.meta.env.MODE === "test";

export type GitHubFilter = "open" | "closed" | "merged";
export type GitHubFilterSelectionMap = Partial<Record<GitHubFilter, string | null>>;

export type GitHubTabWarmCache = {
  projectRoot: string;
  snapshot: GitHubPrSnapshot | null;
  filter: GitHubFilter;
  selectedItemId: string | null;
  selectedItemIdsByFilter?: GitHubFilterSelectionMap;
  searchQuery: string;
  externalHistoryLoaded: boolean;
  cachedAt: number;
};

export type GitHubSnapshotRequestKey = {
  includeExternalClosed: boolean;
  historyPageLimit: number;
};

export type GitHubFilterCounts = Record<GitHubFilter, number>;

let githubTabWarmCache: GitHubTabWarmCache | null = null;

export function normalizeGitHubFilter(value: unknown): GitHubFilter {
  return value === "open" || value === "closed" || value === "merged" ? value : "open";
}

export function initialGitHubFilterSelections(cache: GitHubTabWarmCache | null): GitHubFilterSelectionMap {
  const selections: GitHubFilterSelectionMap = { ...(cache?.selectedItemIdsByFilter ?? {}) };
  if (cache?.selectedItemId) {
    selections[normalizeGitHubFilter(cache.filter)] = cache.selectedItemId;
  }
  return selections;
}

export function normalizeHistoryPageLimit(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return GITHUB_TAB_HISTORY_INITIAL_PAGE_LIMIT;
  }
  return Math.min(
    GITHUB_TAB_HISTORY_MAX_PAGE_LIMIT,
    Math.max(GITHUB_TAB_HISTORY_INITIAL_PAGE_LIMIT, Math.floor(numeric)),
  );
}

export function snapshotRequestKey(options?: {
  includeExternalClosed?: boolean;
  historyPageLimit?: number;
}): GitHubSnapshotRequestKey {
  const includeExternalClosed = options?.includeExternalClosed === true;
  return {
    includeExternalClosed,
    historyPageLimit: includeExternalClosed ? normalizeHistoryPageLimit(options?.historyPageLimit) : 0,
  };
}

export function snapshotRequestSatisfies(
  current: GitHubSnapshotRequestKey | null,
  requested: GitHubSnapshotRequestKey,
): boolean {
  if (!current) return false;
  if (!requested.includeExternalClosed) return true;
  return current.includeExternalClosed && current.historyPageLimit >= requested.historyPageLimit;
}

export function readGitHubTabWarmCache(projectRoot: string | null): GitHubTabWarmCache | null {
  if (GITHUB_TAB_CACHE_DISABLED) return null;
  if (!projectRoot) return null;
  if (githubTabWarmCache?.projectRoot !== projectRoot) return null;
  const filter = normalizeGitHubFilter((githubTabWarmCache as { filter?: unknown }).filter);
  return filter === githubTabWarmCache.filter ? githubTabWarmCache : { ...githubTabWarmCache, filter };
}

export function writeGitHubTabWarmCache(cache: GitHubTabWarmCache): void {
  if (GITHUB_TAB_CACHE_DISABLED) return;
  if (!cache.projectRoot) return;
  githubTabWarmCache = cache;
}

export function formatGitHubSnapshotError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const message = raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
  if (/github (token|auth) missing/i.test(message)) {
    return "Connect GitHub in Settings with gh auth or a PAT to sync pull requests.";
  }
  return message || "Unable to sync pull requests.";
}

function isKnownPrState(value: unknown): value is PrSummary["state"] {
  return value === "draft" || value === "open" || value === "merged" || value === "closed";
}

export function reconcileLinkedPrState(
  item: GitHubPrListItem,
  linkedPr: PrSummary | null | undefined,
): GitHubPrListItem {
  if (!isKnownPrState(linkedPr?.state)) return item;
  if (!isTerminalPrState(linkedPr.state) || isTerminalPrState(item.state)) return item;
  return {
    ...item,
    state: linkedPr.state,
    isDraft: false,
    title: linkedPr.title || item.title,
    updatedAt: linkedPr.updatedAt || item.updatedAt,
  };
}

export function matchesFilter(item: GitHubPrListItem, filter: GitHubFilter): boolean {
  if (filter === "open") return item.state === "open" || item.state === "draft";
  return item.state === filter;
}

export function bucketForState(state: GitHubPrListItem["state"]): GitHubFilter {
  if (state === "merged") return "merged";
  if (state === "closed") return "closed";
  return "open";
}

export function githubCoordKey(item: {
  repoOwner: string;
  repoName: string;
  githubPrNumber: number;
}): string {
  return prRouteCoordinatesKey({
    repoOwner: item.repoOwner,
    repoName: item.repoName,
    prNumber: Number(item.githubPrNumber),
  });
}

function buildOverlayRowFromLastSeen(lastSeen: GitHubPrListItem, linkedPr: PrSummary): GitHubPrListItem {
  return {
    ...lastSeen,
    state: linkedPr.state,
    isDraft: false,
    title: linkedPr.title || lastSeen.title,
    updatedAt: linkedPr.updatedAt || lastSeen.updatedAt,
    linkedPrId: linkedPr.id,
  };
}

export function computeTerminalOverlayItems(
  reconciledItems: GitHubPrListItem[],
  prsById: Map<string, PrSummary>,
  lastSeenByCoord: Map<string, GitHubPrListItem>,
): GitHubPrListItem[] {
  if (prsById.size === 0) return [];
  const presentCoords = new Set(reconciledItems.map((item) => githubCoordKey(item)));
  const overlays: GitHubPrListItem[] = [];
  const usedLinkedIds = new Set<string>();
  for (const pr of prsById.values()) {
    if (!isTerminalPrState(pr.state)) continue;
    if (usedLinkedIds.has(pr.id)) continue;
    const key = githubCoordKey(pr);
    if (presentCoords.has(key)) continue;
    const lastSeen = lastSeenByCoord.get(key);
    if (!lastSeen) continue;
    usedLinkedIds.add(pr.id);
    overlays.push(buildOverlayRowFromLastSeen(lastSeen, pr));
  }
  return overlays;
}

export function mergeGitHubListItems(snapshot: GitHubPrSnapshot): GitHubPrListItem[] {
  const combined = [...snapshot.repoPullRequests, ...snapshot.externalPullRequests];
  const seen = new Set<string>();
  return combined.filter((item) => {
    const key = `${item.scope}:${githubCoordKey(item)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function countGitHubItemsByState(items: GitHubPrListItem[]): GitHubFilterCounts {
  return {
    open: items.filter((item) => item.state === "open" || item.state === "draft").length,
    closed: items.filter((item) => item.state === "closed").length,
    merged: items.filter((item) => item.state === "merged").length,
  };
}

export function syntheticUnmappedPrId(item: GitHubPrListItem): string {
  return syntheticGithubPrId(item);
}

export function selectionTargetForItem(item: GitHubPrListItem): PrRouteSelectionTarget {
  return {
    prId: item.linkedPrId ?? null,
    prNumber: item.githubPrNumber,
    repoOwner: item.repoOwner,
    repoName: item.repoName,
  };
}

export function itemMatchesSelectionTarget(
  item: GitHubPrListItem,
  target: PrRouteSelectionTarget,
): boolean {
  const itemId = item.linkedPrId ?? syntheticUnmappedPrId(item);
  const coordinatesMatch = prRouteCoordinatesMatch(
    {
      prNumber: item.githubPrNumber,
      repoOwner: item.repoOwner,
      repoName: item.repoName,
    },
    target,
  );
  const idMatches = Boolean(target.prId && itemId === target.prId && coordinatesMatch);
  if (idMatches) return true;
  if (target.prId && itemId !== target.prId) return false;
  if (target.prNumber == null) return false;

  const hasRepoOwner = Boolean(target.repoOwner?.trim());
  const hasRepoName = Boolean(target.repoName?.trim());
  if (hasRepoOwner !== hasRepoName) return false;
  if (hasRepoOwner && hasRepoName) return coordinatesMatch;
  // A legacy number-only route is safe to resolve only against ADE's current
  // repository list. External PR rows may share the same number.
  return item.scope === "repo" && coordinatesMatch;
}

export function findSelectionTargetItem(
  items: GitHubPrListItem[],
  target: PrRouteSelectionTarget,
): GitHubPrListItem | null {
  const matches = items.filter((item) => itemMatchesSelectionTarget(item, target));
  if (matches.length === 0) return null;
  const hasCoordinates = Boolean(target.repoOwner?.trim() && target.repoName?.trim());
  if (target.prId || hasCoordinates) return matches[0] ?? null;
  return matches.length === 1 ? matches[0] : null;
}

export function selectionTargetKey(
  selectedPrId: string | null,
  selectedPrTarget: PrRouteSelectionTarget | null | undefined,
): string | null {
  if (selectedPrTarget) {
    return [
      selectedPrTarget.prId ?? "",
      prRouteCoordinatesKey(selectedPrTarget),
    ].join("/");
  }
  return selectedPrId;
}

export function buildProvisionalGithubPrItem(target: {
  prNumber: number | null;
  repoOwner: string | null;
  repoName: string | null;
}): GitHubPrListItem | null {
  if (
    typeof target.prNumber !== "number"
    || !Number.isFinite(target.prNumber)
    || !Number.isInteger(target.prNumber)
    || target.prNumber <= 0
    || !target.repoOwner?.trim()
    || !target.repoName?.trim()
  ) return null;
  const repoOwner = target.repoOwner.trim();
  const repoName = target.repoName.trim();
  const githubPrNumber = target.prNumber;
  const item = {
    id: "",
    scope: "repo" as const,
    repoOwner,
    repoName,
    githubPrNumber,
    githubUrl: `https://github.com/${repoOwner}/${repoName}/pull/${githubPrNumber}`,
    title: `Pull request #${githubPrNumber}`,
    state: "open" as const,
    isDraft: false,
    baseBranch: null,
    headBranch: null,
    author: null,
    createdAt: "",
    updatedAt: "",
    linkedPrId: null,
    linkedGroupId: null,
    linkedLaneId: null,
    linkedLaneName: null,
    adeKind: null,
    workflowDisplayState: null,
    cleanupState: null,
    labels: [],
    isBot: false,
    commentCount: 0,
  } satisfies GitHubPrListItem;
  return { ...item, id: syntheticUnmappedPrId(item) };
}

export function buildSyntheticUnmappedPr(item: GitHubPrListItem, projectId: string): PrWithConflicts {
  return {
    id: syntheticUnmappedPrId(item),
    laneId: "",
    projectId,
    repoOwner: item.repoOwner,
    repoName: item.repoName,
    githubPrNumber: item.githubPrNumber,
    githubUrl: item.githubUrl,
    githubNodeId: null,
    title: item.title,
    state: item.state,
    baseBranch: item.baseBranch ?? "",
    headBranch: item.headBranch ?? "",
    checksStatus: "none",
    reviewStatus: "none",
    additions: 0,
    deletions: 0,
    lastSyncedAt: null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    stack: item.stack ?? null,
    conflictAnalysis: null,
  };
}
