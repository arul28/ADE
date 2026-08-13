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
import {
  entityMatchesPluginFilters,
  pluginPrContext,
  usePluginSurfaceContributions,
  useSurfaceContributions,
} from "../../plugins/sockets";

export function useGitHubTabListModel({
  snapshot,
  searchQuery,
  prsByIdMap,
  prsByCoordinateMap,
  filter,
  renderedHydrationItems,
  lastSeenRowByCoordRef,
  currentHistoryPageLimit,
  pluginFilterKeys,
  active = true,
}: {
  snapshot: GitHubPrSnapshot | null;
  searchQuery: string;
  prsByIdMap: Map<string, PrSummary>;
  prsByCoordinateMap: Map<string, PrSummary>;
  filter: GitHubFilter;
  renderedHydrationItems: GitHubPrListItem[];
  lastSeenRowByCoordRef: React.MutableRefObject<Map<string, GitHubPrListItem>>;
  currentHistoryPageLimit: () => number;
  /** Contributed `filter-chip` selections. Owned by the tab. */
  pluginFilterKeys: readonly string[];
  /** False while the PRs tab is mounted but not visible. */
  active?: boolean;
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
      return reconcileLinkedPrState(item, linkedPr ?? coordinatePr);
    }),
    [allItems, prsByCoordinateMap, prsByIdMap],
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
  const pluginContributionSet = usePluginSurfaceContributions("prs", active);
  const pluginFilterChips = useSurfaceContributions("prs", "filter-chip", { active });
  // A selection outlives the chip that made it — disable the plugin and the
  // chip vanishes while the filter keeps hiding pull requests, with nothing on
  // screen to undo it. Only keys a visible chip still offers may filter.
  const appliedPluginFilterKeys = React.useMemo(() => {
    const offered = new Set(pluginFilterChips.map((chip) => chip.payload.filterKey));
    return pluginFilterKeys.filter((key) => offered.has(key));
  }, [pluginFilterChips, pluginFilterKeys]);

  const filteredItems = React.useMemo(
    () => displayedItems
      .filter((item) => matchesFilter(item, filter)
        && matchesSearch(item)
        && entityMatchesPluginFilters(
          pluginContributionSet,
          // The same projection `GitHubTabPrRow` badges with. A list row
          // carries no checks state, so `ciStatus` takes its `"unknown"`
          // default here exactly as it does there — only the detail pane has
          // the real answer.
          pluginPrContext({
            number: item.githubPrNumber,
            title: item.title,
            branch: item.headBranch,
            state: item.state,
            isDraft: item.isDraft,
          }),
          appliedPluginFilterKeys,
        ))
      .sort((a, b) =>
        new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime()
      ),
    [appliedPluginFilterKeys, displayedItems, filter, matchesSearch, pluginContributionSet],
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
