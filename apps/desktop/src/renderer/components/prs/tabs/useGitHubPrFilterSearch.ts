import React from "react";
import type {
  GitHubPrListFilters,
  GitHubPrListItem,
  GitHubPrSearchState,
  SearchGitHubPrsError,
  SearchGitHubPrsResult,
} from "../../../../shared/types";
import { githubPrListFiltersKey } from "../../../../shared/githubPrSearch";

/** Typing pause before the list asks GitHub. */
export const GITHUB_PR_SEARCH_DEBOUNCE_MS = 300;
/** A revisited query (a tab switch, a filter toggled back) answers from here. */
const RESULT_CACHE_TTL_MS = 60_000;
const RESULT_CACHE_MAX = 20;

export type GitHubPrSearchPage = {
  key: string;
  baseKey: string;
  items: GitHubPrListItem[];
  totalCount: number;
  nextCursor: string | null;
  error: SearchGitHubPrsError | null;
};

const resultCache = new Map<string, { at: number; page: GitHubPrSearchPage }>();

function readCache(key: string): GitHubPrSearchPage | null {
  const hit = resultCache.get(key);
  if (!hit || Date.now() - hit.at > RESULT_CACHE_TTL_MS) return null;
  return hit.page;
}

function writeCache(page: GitHubPrSearchPage): void {
  if (page.error) return;
  resultCache.delete(page.key);
  resultCache.set(page.key, { at: Date.now(), page });
  while (resultCache.size > RESULT_CACHE_MAX) {
    const oldest = resultCache.keys().next().value;
    if (oldest === undefined) break;
    resultCache.delete(oldest);
  }
}

/** An older host answers a new action with "not callable" / "not exposed". */
function isMissingActionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /is not callable|not exposed through ADE actions|cannot search GitHub yet|no handler registered/i.test(message);
}

/**
 * The GitHub tab's list while a filter is on: GitHub search for this state +
 * filters + text, debounced, with stale answers dropped and pages appended by
 * "Load more". Nothing runs while `enabled` is false, so clearing the filters
 * returns to the snapshot list without a request.
 *
 * Reads go to the tab's own machine (no pin), the same machine the snapshot
 * list comes from.
 */
export function useGitHubPrFilterSearch({
  enabled,
  scopeKey,
  state,
  filters,
  text,
}: {
  enabled: boolean;
  /** The project; results never cross projects. */
  scopeKey: string | null;
  state: GitHubPrSearchState;
  filters: GitHubPrListFilters;
  text: string;
}): {
  /** The answer for exactly this state + filters + text. */
  exact: GitHubPrSearchPage | null;
  /** The newest answer for this state + filters (the text may have moved on). */
  sameFilters: GitHubPrSearchPage | null;
  loading: boolean;
  loadingMore: boolean;
  /** The host cannot search GitHub (older ADE): filter loaded rows instead. */
  unavailable: boolean;
  loadMore: () => void;
  refresh: () => void;
} {
  const supported = typeof window.ade?.prs?.searchGitHubPrs === "function";
  const trimmedText = text.trim();
  const baseKey = `${scopeKey ?? ""}|${state}|${githubPrListFiltersKey(filters)}`;
  const key = `${baseKey}|${trimmedText}`;
  const [page, setPage] = React.useState<GitHubPrSearchPage | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [unavailable, setUnavailable] = React.useState(!supported);
  const [refreshNonce, setRefreshNonce] = React.useState(0);
  const seqRef = React.useRef(0);
  const argsRef = React.useRef({ state, filters, text: trimmedText });
  argsRef.current = { state, filters, text: trimmedText };
  const pageRef = React.useRef(page);
  pageRef.current = page;
  const forceNextRef = React.useRef(false);

  React.useEffect(() => {
    if (!enabled || unavailable) {
      seqRef.current += 1;
      setLoading(false);
      return undefined;
    }
    const force = forceNextRef.current;
    forceNextRef.current = false;
    const cached = force ? null : readCache(key);
    if (cached) {
      seqRef.current += 1;
      setPage(cached);
      setLoading(false);
      return undefined;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    const timer = window.setTimeout(() => {
      const search = window.ade.prs.searchGitHubPrs;
      if (!search) {
        setUnavailable(true);
        return;
      }
      const current = argsRef.current;
      search({ state: current.state, filters: current.filters, text: current.text || null, ...(force ? { force: true } : {}) })
        .then((result: SearchGitHubPrsResult) => {
          if (seq !== seqRef.current) return;
          const next: GitHubPrSearchPage = {
            key,
            baseKey,
            items: result.items ?? [],
            totalCount: result.totalCount ?? 0,
            nextCursor: result.nextCursor ?? null,
            error: result.error ?? null,
          };
          writeCache(next);
          setPage(next);
        })
        .catch((error: unknown) => {
          if (seq !== seqRef.current) return;
          if (isMissingActionError(error)) {
            setUnavailable(true);
            return;
          }
          setPage({
            key,
            baseKey,
            items: [],
            totalCount: 0,
            nextCursor: null,
            error: { kind: "failed", message: error instanceof Error ? error.message : String(error) },
          });
        })
        .finally(() => {
          if (seq === seqRef.current) setLoading(false);
        });
    }, GITHUB_PR_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [baseKey, enabled, key, refreshNonce, unavailable]);

  const loadMore = React.useCallback(() => {
    const current = pageRef.current;
    const search = window.ade.prs.searchGitHubPrs;
    if (!current || current.key !== key || !current.nextCursor || loadingMore || !search) return;
    const seq = seqRef.current;
    setLoadingMore(true);
    const args = argsRef.current;
    search({ state: args.state, filters: args.filters, text: args.text || null, cursor: current.nextCursor })
      .then((result) => {
        if (seq !== seqRef.current || pageRef.current?.key !== current.key) return;
        if (result.error) {
          setPage({ ...current, error: result.error });
          return;
        }
        const seen = new Set(current.items.map((item) => item.id));
        const next: GitHubPrSearchPage = {
          ...current,
          items: [...current.items, ...(result.items ?? []).filter((item) => !seen.has(item.id))],
          nextCursor: result.nextCursor ?? null,
          totalCount: result.totalCount ?? current.totalCount,
        };
        writeCache(next);
        setPage(next);
      })
      .catch(() => undefined)
      .finally(() => setLoadingMore(false));
  }, [key, loadingMore]);

  const refresh = React.useCallback(() => {
    forceNextRef.current = true;
    resultCache.delete(key);
    setRefreshNonce((value) => value + 1);
  }, [key]);

  const active = enabled && !unavailable;
  return {
    exact: active && page?.key === key ? page : null,
    sameFilters: active && page?.baseKey === baseKey ? page : null,
    loading: active && loading,
    loadingMore,
    unavailable: enabled && unavailable,
    loadMore,
    refresh,
  };
}
