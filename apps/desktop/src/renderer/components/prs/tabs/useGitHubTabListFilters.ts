import React from "react";
import type {
  GitHubPrFilterKind,
  GitHubPrListFilters,
  GitHubPrSnapshot,
} from "../../../../shared/types";
import {
  emptyGitHubPrListFilters,
  githubPrListFiltersKey,
  hasGitHubPrListFilters,
  mergeGitHubPrListFilters,
  normalizeGitHubPrListFilters,
  parseGitHubPrSearchText,
} from "../../../../shared/githubPrSearch";
import type { GitHubPrFilterFacets } from "../shared/GitHubPrFilters";
import type { GitHubFilterOptionsLoader } from "../shared/useGitHubFilterOptions";
import { mergeGitHubListItems, type GitHubFilter } from "./githubTabModel";
import { useGitHubPrFilterSearch } from "./useGitHubPrFilterSearch";
import type { GitHubTabListSource } from "./useGitHubTabListModel";
import type { GitHubTabViewChrome } from "./GitHubTabView";

type FilterChrome = Pick<
  GitHubTabViewChrome,
  | "searchQuery"
  | "onSearchQueryChange"
  | "onSearchSubmit"
  | "listFilters"
  | "onListFiltersChange"
  | "filterFacets"
  | "filterLoadOptions"
  | "filterSearch"
>;

/**
 * The GitHub tab's search text and label / author / assignee filters: their
 * state, the GitHub search they drive, the picker's facets, and what the list
 * model should show (GitHub's answer, or the loaded rows narrowed locally
 * until GitHub answers or when it cannot).
 *
 * Kept with the tab's other list state in its in-memory warm cache (not the
 * URL); `restore` puts back what the cache held for a project.
 */
export function useGitHubTabListFilters({
  projectRoot,
  filter,
  snapshot,
  initial,
}: {
  projectRoot: string | null;
  filter: GitHubFilter;
  snapshot: GitHubPrSnapshot | null;
  initial: { searchQuery?: string; listFilters?: GitHubPrListFilters } | null;
}) {
  const [searchQuery, setSearchQuery] = React.useState(() => initial?.searchQuery ?? "");
  const [listFilters, setListFiltersState] = React.useState<GitHubPrListFilters>(
    () => normalizeGitHubPrListFilters(initial?.listFilters ?? emptyGitHubPrListFilters()),
  );
  const restore = React.useCallback((saved: { searchQuery?: string; listFilters?: GitHubPrListFilters } | null) => {
    setSearchQuery(saved?.searchQuery ?? "");
    setListFiltersState(normalizeGitHubPrListFilters(saved?.listFilters ?? emptyGitHubPrListFilters()));
  }, []);

  const listFiltersActive = hasGitHubPrListFilters(listFilters);
  const setListFilters = React.useCallback((next: GitHubPrListFilters) => {
    const normalized = normalizeGitHubPrListFilters(next);
    setListFiltersState((current) => (
      githubPrListFiltersKey(current) === githubPrListFiltersKey(normalized) ? current : normalized
    ));
  }, []);
  // `label:x author:y assignee:z no:assignee` typed in the search box become
  // filters once the token is finished (a space after it, or Enter).
  const applySearchText = React.useCallback((value: string, keepTrailingToken: boolean) => {
    const parsed = parseGitHubPrSearchText(value, { keepTrailingToken });
    if (parsed.matched) {
      setListFiltersState((current) => mergeGitHubPrListFilters(current, parsed.filters));
      setSearchQuery(parsed.text);
      return;
    }
    setSearchQuery(value);
  }, []);
  const onSearchQueryChange = React.useCallback(
    (value: string) => applySearchText(value, true),
    [applySearchText],
  );
  const onSearchSubmit = React.useCallback(
    () => applySearchText(searchQuery, false),
    [applySearchText, searchQuery],
  );

  const filterSearch = useGitHubPrFilterSearch({
    enabled: listFiltersActive,
    scopeKey: projectRoot,
    state: filter,
    filters: listFilters,
    text: searchQuery,
  });
  // GitHub's answer for exactly this query, else the last answer for the same
  // filters while the text moves on (matched locally until GitHub replies).
  const searchPage = filterSearch.exact ?? filterSearch.sameFilters;
  // Read by Refresh without making the row callbacks change identity per render.
  const refreshFilterSearchRef = React.useRef<(() => void) | null>(null);
  refreshFilterSearchRef.current = listFiltersActive ? filterSearch.refresh : null;
  const searchItems = listFiltersActive && searchPage && !searchPage.error ? searchPage.items : null;
  const searchTotalCount = searchItems ? searchPage?.totalCount ?? null : null;
  const searchMatchesText = Boolean(searchItems && filterSearch.exact);
  const viewerLogin = snapshot?.viewerLogin ?? null;

  const listSource = React.useMemo((): GitHubTabListSource | null => {
    if (searchItems) return { kind: "search", items: searchItems, totalCount: searchTotalCount, matchesText: searchMatchesText };
    if (listFiltersActive) return { kind: "local", filters: listFilters, viewerLogin };
    return null;
  }, [listFilters, listFiltersActive, searchItems, searchMatchesText, searchTotalCount, viewerLogin]);

  const filterLoadOptions = React.useMemo((): GitHubFilterOptionsLoader | null => {
    const list = window.ade.prs.listGitHubFilterOptions;
    if (typeof list !== "function") return null;
    return async (kind: GitHubPrFilterKind, query: string) => (await list({ kind, query })).options;
  }, []);
  const filterFacets = React.useMemo((): GitHubPrFilterFacets => {
    const labels = new Map<string, GitHubPrFilterFacets["labels"][number]>();
    const authors = new Map<string, GitHubPrFilterFacets["authors"][number]>();
    for (const item of snapshot ? mergeGitHubListItems(snapshot) : []) {
      for (const label of item.labels) {
        const key = label.name.toLowerCase();
        const seen = labels.get(key);
        if (seen) seen.count += 1;
        else labels.set(key, { ...label, count: 1 });
      }
      if (item.author) {
        const key = item.author.toLowerCase();
        const seen = authors.get(key);
        if (seen) seen.count += 1;
        else authors.set(key, { login: item.author, count: 1 });
      }
    }
    // Most-used first, the way a reviewer reaches for them.
    const byCount = <T extends { count: number }>(name: (value: T) => string) => (a: T, b: T) =>
      b.count - a.count || name(a).localeCompare(name(b));
    return {
      labels: [...labels.values()].sort(byCount((label) => label.name)),
      authors: [...authors.values()].sort(byCount((author) => author.login)),
    };
  }, [snapshot]);

  const chrome: FilterChrome = {
    searchQuery,
    onSearchQueryChange,
    onSearchSubmit,
    listFilters,
    onListFiltersChange: setListFilters,
    filterFacets,
    filterLoadOptions,
    filterSearch: listFiltersActive ? {
      loading: filterSearch.loading,
      error: searchPage?.error ?? null,
      unavailable: filterSearch.unavailable,
      totalCount: searchTotalCount,
      canLoadMore: Boolean(searchItems && filterSearch.exact?.nextCursor),
      loadingMore: filterSearch.loadingMore,
      onLoadMore: filterSearch.loadMore,
    } : null,
  };

  return { searchQuery, listFilters, restore, listSource, refreshFilterSearchRef, chrome };
}
