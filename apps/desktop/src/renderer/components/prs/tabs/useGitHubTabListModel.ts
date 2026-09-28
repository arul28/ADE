import React from "react";
import type {
  GitHubPrListItem,
  GitHubPrSnapshot,
  PrSummary,
} from "../../../../shared/types";
import { buildPrListRows } from "../shared/prListGrouping";
import {
  compareGitHubRows,
  compareGitHubRowsByUpdated,
  githubRowBlockedTier,
  resolveGitHubRowNextStepKind,
  type GitHubTabSort,
} from "./prBlockedSort";
import type { OptimisticTerminalState } from "../state/PrsContext";
import {
  GITHUB_TAB_HISTORY_MAX_PAGE_LIMIT,
  GITHUB_TAB_VIRTUALIZE_AT,
  applyOptimisticTerminalState,
  computeTerminalOverlayItems,
  countGitHubItemsByState,
  githubCoordKey,
  matchesFilter,
  mergeGitHubListItems,
  reconcileLinkedPrState,
  type GitHubFilter,
  type GitHubFilterCounts,
} from "./githubTabModel";

export function useGitHubTabListModel({
  snapshot,
  searchQuery,
  prsByIdMap,
  prsByCoordinateMap,
  filter,
  sort,
  renderedHydrationItems,
  lastSeenRowByCoordRef,
  currentHistoryPageLimit,
  optimisticTerminalByCoord,
}: {
  snapshot: GitHubPrSnapshot | null;
  searchQuery: string;
  prsByIdMap: Map<string, PrSummary>;
  prsByCoordinateMap: Map<string, PrSummary>;
  filter: GitHubFilter;
  sort: GitHubTabSort;
  renderedHydrationItems: GitHubPrListItem[];
  lastSeenRowByCoordRef: React.MutableRefObject<Map<string, GitHubPrListItem>>;
  currentHistoryPageLimit: () => number;
  /** Merges/closes GitHub has confirmed but the snapshot has not caught up to. */
  optimisticTerminalByCoord?: ReadonlyMap<string, OptimisticTerminalState> | null;
}) {
  const matchesSearch = React.useCallback((item: GitHubPrListItem) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.trim().toLowerCase();
    return (
      item.title.toLowerCase().includes(q)
      || (item.author?.toLowerCase().includes(q) ?? false)
      || (item.headBranch?.toLowerCase().includes(q) ?? false)
      || String(item.githubPrNumber).includes(q)
    );
  }, [searchQuery]);

  const allItems = React.useMemo(
    () => (snapshot ? mergeGitHubListItems(snapshot) : []),
    [snapshot],
  );
  const reconciledItems = React.useMemo(
    () => allItems.map((item) => {
      const linkedPr = item.linkedPrId ? prsByIdMap.get(item.linkedPrId) : null;
      const coordinatePr = prsByCoordinateMap.get(githubCoordKey(item));
      // Row reconciliation first, then the local optimistic layer. A PR with no
      // local row has nothing in `prsByIdMap` to reconcile against, so the
      // optimistic layer is the only thing that moves it out of Open before the
      // next snapshot lands.
      return applyOptimisticTerminalState(
        reconcileLinkedPrState(item, linkedPr ?? coordinatePr),
        optimisticTerminalByCoord,
      );
    }),
    [allItems, optimisticTerminalByCoord, prsByCoordinateMap, prsByIdMap],
  );

  React.useEffect(() => {
    const map = lastSeenRowByCoordRef.current;
    for (const item of allItems) {
      map.set(githubCoordKey(item), item);
    }
  }, [allItems, lastSeenRowByCoordRef]);

  const overlayItems = React.useMemo(
    () => computeTerminalOverlayItems(reconciledItems, prsByIdMap, lastSeenRowByCoordRef.current),
    [lastSeenRowByCoordRef, reconciledItems, prsByIdMap],
  );
  const displayedItems = React.useMemo(
    () => (overlayItems.length === 0 ? reconciledItems : [...reconciledItems, ...overlayItems]),
    [reconciledItems, overlayItems],
  );
  // "Blocked on me" tiers, keyed by row id. Built once per list change from the
  // linked local rows; no network/diff work is triggered by sorting. A row with
  // no linked status at all is "nothing outstanding" (tier 2).
  const blockedTierByItemId = React.useMemo(() => {
    if (sort !== "blocked") return null;
    const tiers = new Map<string, number>();
    for (const item of displayedItems) {
      const linked = (item.linkedPrId ? prsByIdMap.get(item.linkedPrId) : null)
        ?? prsByCoordinateMap.get(githubCoordKey(item))
        ?? null;
      const kind = resolveGitHubRowNextStepKind({
        state: item.state,
        isDraft: item.isDraft,
        baseBranch: item.baseBranch ?? linked?.baseBranch ?? null,
        source: linked,
      });
      tiers.set(item.id, githubRowBlockedTier(kind));
    }
    return tiers;
  }, [displayedItems, prsByIdMap, prsByCoordinateMap, sort]);
  const filteredItems = React.useMemo(
    () => displayedItems
      .filter((item) => matchesFilter(item, filter) && matchesSearch(item))
      // A live search keeps relevance order: the blocked sort is a browse aid,
      // not a way to override what the query matched.
      .sort((a, b) => blockedTierByItemId && !searchQuery.trim()
        ? compareGitHubRows(a, b, (item) => blockedTierByItemId.get(item.id) ?? 2)
        : compareGitHubRowsByUpdated(a, b)),
    [blockedTierByItemId, displayedItems, filter, matchesSearch, searchQuery],
  );
  const hydrationItems = filteredItems.length > GITHUB_TAB_VIRTUALIZE_AT
    ? renderedHydrationItems
    : filteredItems;
  const listRows = React.useMemo(
    () => buildPrListRows(filteredItems, { grouped: filter === "merged" || filter === "closed" }),
    [filteredItems, filter],
  );
  const filterCounts = React.useMemo(() => {
    const listedCounts = countGitHubItemsByState(displayedItems);
    const snapshotCounts = snapshot?.history?.repoPullRequestCounts;
    const rawCounts = countGitHubItemsByState(allItems);
    const withReconcileDelta = (
      base: number | null | undefined,
      key: keyof GitHubFilterCounts,
      fallback: number,
    ): number => base == null ? fallback : Math.max(0, base + listedCounts[key] - rawCounts[key]);
    return {
      open: withReconcileDelta(snapshotCounts?.open, "open", listedCounts.open),
      closed: withReconcileDelta(snapshotCounts?.closed, "closed", listedCounts.closed),
      merged: withReconcileDelta(snapshotCounts?.merged, "merged", listedCounts.merged),
    };
  }, [allItems, displayedItems, snapshot?.history?.repoPullRequestCounts]);
  const canLoadOlderHistory = filter !== "open"
    && Boolean(snapshot?.history?.repoPullRequestsMayHaveMore)
    && currentHistoryPageLimit() < GITHUB_TAB_HISTORY_MAX_PAGE_LIMIT;

  return {
    displayedItems,
    filteredItems,
    hydrationItems,
    listRows,
    filterCounts,
    canLoadOlderHistory,
  };
}
