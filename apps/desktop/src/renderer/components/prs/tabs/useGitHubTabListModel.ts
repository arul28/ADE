import React from "react";
import type {
  GitHubPrListItem,
  GitHubPrSnapshot,
  PrSummary,
} from "../../../../shared/types";
import { buildPrListRows } from "../shared/prListGrouping";
import {
  GITHUB_TAB_HISTORY_MAX_PAGE_LIMIT,
  GITHUB_TAB_VIRTUALIZE_AT,
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
  filter,
  renderedHydrationItems,
  lastSeenRowByCoordRef,
  currentHistoryPageLimit,
}: {
  snapshot: GitHubPrSnapshot | null;
  searchQuery: string;
  prsByIdMap: Map<string, PrSummary>;
  filter: GitHubFilter;
  renderedHydrationItems: GitHubPrListItem[];
  lastSeenRowByCoordRef: React.MutableRefObject<Map<string, GitHubPrListItem>>;
  currentHistoryPageLimit: () => number;
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
    () => allItems.map((item) =>
      reconcileLinkedPrState(item, item.linkedPrId ? prsByIdMap.get(item.linkedPrId) : null)
    ),
    [allItems, prsByIdMap],
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
  const filteredItems = React.useMemo(
    () => displayedItems
      .filter((item) => matchesFilter(item, filter) && matchesSearch(item))
      .sort((a, b) =>
        new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime()
      ),
    [displayedItems, filter, matchesSearch],
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
