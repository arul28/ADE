import { BRAND } from "../../../../shared/brand";
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type {
  CtoGetLinearIssuePickerDataResult,
  CtoLinearCustomView,
  CtoLinearQuickView,
  CtoSearchLinearIssuesResult,
  NormalizedLinearIssue,
  OpenProjectBinding,
} from "../../../../shared/types";
import {
  buildIssueSearchArgs,
  cacheIsFresh,
  emptyCatalog,
  emptyPageInfo,
  getBrowserCacheEntry,
  mergeIssuePages,
  readCachedSearch,
  rememberSearchResult,
  searchCacheKey,
  type LinearIssueBrowserFilters,
  type ServerOrder,
} from "./linearIssueBrowserData";

type PageInfo = CtoSearchLinearIssuesResult["pageInfo"];

export type LinearBrowserData = {
  quickView: CtoLinearQuickView | null;
  catalog: CtoGetLinearIssuePickerDataResult;
  catalogLoaded: boolean;
  customViews: CtoLinearCustomView[];
  issues: NormalizedLinearIssue[];
  /** Replaces one listed issue with `apply(issue)`; returns the copy it replaced (null when not listed). */
  patchIssue: (issueId: string, apply: (current: NormalizedLinearIssue) => NormalizedLinearIssue) => NormalizedLinearIssue | null;
  pageInfo: PageInfo;
  /** The cursor of a next-page read that failed; auto-paging leaves it for "Load more". */
  failedAppendCursor: string | null;
  searchTotalCount: number | null;
  loadingQuickView: boolean;
  loadingCatalog: boolean;
  loadingIssues: boolean;
  /** Only while an infinite-scroll page is in flight (not a filter reload). */
  appendingMore: boolean;
  error: string | null;
  setError: Dispatch<SetStateAction<string | null>>;
  /** Reads the first page (or the next one with `append`); `force` skips a fresh cache entry. */
  searchIssues: (append: boolean, force?: boolean) => void;
  /** Shows what the cache holds for these filters, and drops any read still in flight. */
  resetToCache: (filters: LinearIssueBrowserFilters) => void;
  clearIssues: () => void;
};

/**
 * The Linear window's reads from the reader machine: the quick view (teams,
 * connection), the picker catalog, custom views and issue pages. Each goes
 * through the per-project module cache, so reopening the window paints at
 * once and only stale entries are read again. All reads go to `pin`.
 */
export function useLinearBrowserData({
  cacheKey,
  pin,
  filters,
  serverOrder,
  showCompletedIssues,
  refreshKey,
  initialFilters,
  onConnectionVisibilityChange,
}: {
  cacheKey: string;
  pin: OpenProjectBinding | null;
  filters: LinearIssueBrowserFilters;
  serverOrder: ServerOrder;
  showCompletedIssues: boolean;
  refreshKey: number;
  /** The filters the first render shows, for the first paint from cache. */
  initialFilters: () => LinearIssueBrowserFilters;
  onConnectionVisibilityChange?: (visible: boolean) => void;
}): LinearBrowserData {
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const [quickView, setQuickView] = useState<CtoLinearQuickView | null>(() => getBrowserCacheEntry(cacheKey).quickView);
  const [catalog, setCatalog] = useState<CtoGetLinearIssuePickerDataResult>(() => getBrowserCacheEntry(cacheKey).catalog ?? emptyCatalog());
  const [catalogLoaded, setCatalogLoaded] = useState(() => getBrowserCacheEntry(cacheKey).catalog != null);
  const [customViews, setCustomViews] = useState<CtoLinearCustomView[]>(() => getBrowserCacheEntry(cacheKey).views.result ?? []);
  // Searches carry the display order, so the cache is read with it too.
  const searchOptionsRef = useRef({ order: serverOrder, showCompletedIssues });
  searchOptionsRef.current = { order: serverOrder, showCompletedIssues };
  const [initialSearch] = useState(() => readCachedSearch(cacheKey, initialFilters(), searchOptionsRef.current));
  const [issues, setIssues] = useState<NormalizedLinearIssue[]>(() => initialSearch?.issues ?? []);
  const [pageInfo, setPageInfo] = useState<PageInfo>(() => initialSearch?.pageInfo ?? emptyPageInfo());
  const [searchTotalCount, setSearchTotalCount] = useState<number | null>(() => initialSearch?.totalCount ?? null);
  const [loadingQuickView, setLoadingQuickView] = useState(false);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [appendingMore, setAppendingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedAppendCursor, setFailedAppendCursor] = useState<string | null>(null);
  const issuesRef = useRef(issues);
  issuesRef.current = issues;
  const pageInfoRef = useRef(pageInfo);
  const quickViewRequestIdRef = useRef(0);
  const catalogRequestIdRef = useRef(0);
  const searchRequestIdRef = useRef(0);

  useEffect(() => {
    pageInfoRef.current = pageInfo;
  }, [pageInfo]);

  const loadQuickView = useCallback((force = false) => {
    const entry = getBrowserCacheEntry(cacheKey);
    const readPin = pinRef.current;
    if (!window.ade.cto?.getLinearQuickView || !readPin) return;
    if (!force && entry.quickView && cacheIsFresh(entry.quickViewFetchedAt)) {
      setQuickView(entry.quickView);
      onConnectionVisibilityChange?.(entry.quickView.connection.connected === true);
      return;
    }
    if (entry.quickView) {
      setQuickView(entry.quickView);
      onConnectionVisibilityChange?.(entry.quickView.connection.connected === true);
    }
    const requestId = quickViewRequestIdRef.current + 1;
    quickViewRequestIdRef.current = requestId;
    setLoadingQuickView(force || !entry.quickView);
    setError(null);
    const promise = entry.quickViewPromise ?? window.ade.cto.getLinearQuickView(readPin);
    entry.quickViewPromise = promise;
    void promise
      .then((data) => {
        entry.quickView = data;
        entry.quickViewFetchedAt = Date.now();
        entry.quickViewPromise = null;
        if (quickViewRequestIdRef.current !== requestId) return;
        setQuickView(data);
        onConnectionVisibilityChange?.(data.connection.connected === true);
      })
      .catch((err) => {
        entry.quickViewPromise = null;
        if (quickViewRequestIdRef.current !== requestId) return;
        if (!entry.quickView || force) {
          setError(err instanceof Error ? err.message : "Unable to load Linear.");
        }
      })
      .finally(() => {
        if (quickViewRequestIdRef.current === requestId) setLoadingQuickView(false);
      });
  }, [cacheKey, onConnectionVisibilityChange]);

  const loadCatalog = useCallback((force = false) => {
    const entry = getBrowserCacheEntry(cacheKey);
    const cto = window.ade.cto;
    const readPin = pinRef.current;
    if (!cto?.getLinearIssuePickerData) {
      setError(`Linear controls are not available in this ${BRAND.NAME} surface.`);
      return;
    }
    if (!readPin) return;
    if (!force && entry.catalog && cacheIsFresh(entry.catalogFetchedAt)) {
      setCatalog(entry.catalog);
      setCatalogLoaded(true);
      return;
    }
    if (entry.catalog) setCatalog(entry.catalog);
    const requestId = catalogRequestIdRef.current + 1;
    catalogRequestIdRef.current = requestId;
    setLoadingCatalog(force || !entry.catalog);
    setError(null);
    const promise = entry.catalogPromise ?? cto.getLinearIssuePickerData(readPin);
    entry.catalogPromise = promise;
    void promise
      .then((data) => {
        entry.catalog = data;
        entry.catalogFetchedAt = Date.now();
        entry.catalogPromise = null;
        if (catalogRequestIdRef.current !== requestId) return;
        setCatalog(data);
        setCatalogLoaded(true);
      })
      .catch((err) => {
        entry.catalogPromise = null;
        if (catalogRequestIdRef.current !== requestId) return;
        if (!entry.catalog || force) {
          setError(err instanceof Error ? err.message : "Unable to load Linear filters.");
        }
      })
      .finally(() => {
        if (catalogRequestIdRef.current === requestId) setLoadingCatalog(false);
      });
  }, [cacheKey]);

  // Custom views are optional: a brain without them, or a failed read, just
  // leaves the rail with the built-in scopes.
  const loadCustomViews = useCallback((force = false) => {
    const entry = getBrowserCacheEntry(cacheKey);
    const cto = window.ade.cto;
    const readPin = pinRef.current;
    if (!cto?.getLinearCustomViews || !readPin) return;
    if (!force && entry.views.result && cacheIsFresh(entry.views.fetchedAt)) {
      setCustomViews(entry.views.result);
      return;
    }
    const promise = entry.views.promise ?? cto.getLinearCustomViews(readPin);
    entry.views = { ...entry.views, promise };
    void promise
      .then((views) => {
        entry.views = { result: views, fetchedAt: Date.now(), promise: null };
        setCustomViews(views);
      })
      .catch((err: unknown) => {
        console.warn("[linear] custom views read failed", err);
        entry.views = { ...entry.views, promise: null };
      });
  }, [cacheKey]);

  const searchIssues = useCallback((append: boolean, force = false) => {
    const cto = window.ade.cto;
    const readPin = pinRef.current;
    if (!cto?.searchLinearIssues) {
      setError(`Linear issue search is not available in this ${BRAND.NAME} surface.`);
      return;
    }
    if (!readPin) return;
    const requestId = searchRequestIdRef.current + 1;
    searchRequestIdRef.current = requestId;
    const entry = getBrowserCacheEntry(cacheKey);
    const cursor = append ? pageInfoRef.current.endCursor : null;
    const args = buildIssueSearchArgs(filters, cursor, { order: serverOrder, showCompletedIssues });
    const key = searchCacheKey(args);
    const cached = entry.searches.get(key);
    const cachedResult = cached?.result ?? null;
    const applyResult = (result: CtoSearchLinearIssuesResult) => {
      setIssues((current) => append ? mergeIssuePages(current, result.issues) : result.issues);
      setPageInfo(result.pageInfo);
      setFailedAppendCursor(null);
      if (!append) setSearchTotalCount(result.totalCount ?? null);
    };
    if (cachedResult && !force && cacheIsFresh(cached?.fetchedAt ?? 0)) {
      applyResult(cachedResult);
      return;
    }
    if (cachedResult && !append) applyResult(cachedResult);
    setLoadingIssues(force || append || !cachedResult);
    setAppendingMore(append);
    setError(null);
    const promise = cached?.promise ?? cto.searchLinearIssues(args, readPin);
    entry.searches.set(key, {
      result: cachedResult,
      fetchedAt: cached?.fetchedAt ?? 0,
      promise,
    });
    void promise
      .then((result) => {
        rememberSearchResult(entry, key, result);
        // A newer request (another filter, another machine) owns the list now.
        if (searchRequestIdRef.current !== requestId) return;
        applyResult(result);
      })
      .catch((err) => {
        entry.searches.set(key, { result: cachedResult, fetchedAt: cached?.fetchedAt ?? 0, promise: null });
        if (searchRequestIdRef.current !== requestId) return;
        if (append) setFailedAppendCursor(cursor);
        if (!cachedResult || force) {
          setError(err instanceof Error ? err.message : "Unable to search Linear issues.");
        }
      })
      .finally(() => {
        if (searchRequestIdRef.current === requestId) {
          setLoadingIssues(false);
          if (append) setAppendingMore(false);
        }
      });
  }, [cacheKey, filters, serverOrder, showCompletedIssues]);

  // Only a new refresh press forces a reload; a project or machine switch
  // after one reads through the cache like any other load.
  const lastForcedRefreshRef = useRef(0);
  useEffect(() => {
    const force = refreshKey > 0 && refreshKey !== lastForcedRefreshRef.current;
    if (force) lastForcedRefreshRef.current = refreshKey;
    loadQuickView(force);
    loadCatalog(force);
    loadCustomViews(force);
  }, [loadCatalog, loadCustomViews, loadQuickView, refreshKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => searchIssues(false, false), 220);
    return () => window.clearTimeout(timer);
  }, [filters, searchIssues]);

  const resetToCache = useCallback((nextFilters: LinearIssueBrowserFilters) => {
    const entry = getBrowserCacheEntry(cacheKey);
    const cachedSearch = readCachedSearch(cacheKey, nextFilters, searchOptionsRef.current);
    // A read still in flight for the old project or machine must not land here.
    searchRequestIdRef.current += 1;
    setLoadingIssues(false);
    setAppendingMore(false);
    setQuickView(entry.quickView);
    setCatalog(entry.catalog ?? emptyCatalog());
    setCatalogLoaded(entry.catalog != null);
    setCustomViews(entry.views.result ?? []);
    setIssues(cachedSearch?.issues ?? []);
    setPageInfo(cachedSearch?.pageInfo ?? emptyPageInfo());
    setSearchTotalCount(cachedSearch?.totalCount ?? null);
    setFailedAppendCursor(null);
  }, [cacheKey]);

  const clearIssues = useCallback(() => {
    setIssues([]);
    setPageInfo(emptyPageInfo());
    setSearchTotalCount(null);
    setFailedAppendCursor(null);
  }, []);

  const patchIssue = useCallback((issueId: string, apply: (current: NormalizedLinearIssue) => NormalizedLinearIssue) => {
    const previous = issuesRef.current.find((entry) => entry.id === issueId) ?? null;
    if (previous) setIssues((current) => current.map((entry) => (entry.id === issueId ? apply(entry) : entry)));
    return previous;
  }, []);

  return {
    quickView,
    catalog,
    catalogLoaded,
    customViews,
    issues,
    patchIssue,
    pageInfo,
    failedAppendCursor,
    searchTotalCount,
    loadingQuickView,
    loadingCatalog,
    loadingIssues,
    appendingMore,
    error,
    setError,
    searchIssues,
    resetToCache,
    clearIssues,
  };
}
