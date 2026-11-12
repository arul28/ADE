import { useCallback, useMemo, useSyncExternalStore } from "react";
import type {
  GithubDirectData,
  GithubDirectListState,
  GithubDirectOp,
  GithubDirectRepoRef,
  GithubDirectRequest,
} from "../../shared/types";
import { createAccountGithubReadStore, type AccountGithubReadSnapshot } from "./accountGithubReadStore";

/**
 * React hooks over the direct GitHub reads (accountGithubReadStore.ts): the
 * account's sign-in, no machine. One store per window, so two panes showing
 * the same list share one read and one timer.
 */
const store = createAccountGithubReadStore({
  request: () => {
    const api = typeof window === "undefined" ? null : window.ade?.githubDirect;
    return api ? (request, requestOptions) => api.request(request, requestOptions) : null;
  },
  isVisible: () => typeof document === "undefined" || document.visibilityState === "visible",
  onVisibilityChange: (listener) => {
    if (typeof document === "undefined") return () => undefined;
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
});

const IDLE: AccountGithubReadSnapshot<never> = { data: null, error: null, loading: false, refreshing: false, fetchedAt: null, truncated: false };

/** One direct read, or nothing while `request` is null (no repository yet). */
function useAccountGithubRead<O extends GithubDirectOp>(request: Extract<GithubDirectRequest, { op: O }> | null) {
  const subscribe = useCallback(
    (listener: () => void) => (request ? store.subscribe(request, listener) : () => undefined),
    [request],
  );
  const getSnapshot = useCallback(
    (): AccountGithubReadSnapshot<GithubDirectData[O]> => (request ? store.snapshot(request) : IDLE),
    [request],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const refresh = useCallback(() => (request ? store.refresh(request) : Promise.resolve()), [request]);
  return {
    supported: Boolean(typeof window !== "undefined" && window.ade?.githubDirect),
    ...snapshot,
    refresh,
  };
}

/** Pull requests of one repository (open by default). */
export function useAccountGithubPulls(repo: GithubDirectRepoRef | null, options: { state?: GithubDirectListState } = {}) {
  const state = options.state ?? "open";
  const owner = repo?.owner ?? null;
  const name = repo?.name ?? null;
  const request = useMemo(
    () => (owner && name ? { op: "listPulls" as const, params: { owner, name, state } } : null),
    [owner, name, state],
  );
  const read = useAccountGithubRead<"listPulls">(request);
  return { ...read, pulls: read.data ?? [] };
}

/** Issues of one repository (open by default). GitHub's pull requests are left out. */
export function useAccountGithubIssues(repo: GithubDirectRepoRef | null, options: { state?: GithubDirectListState } = {}) {
  const state = options.state ?? "open";
  const owner = repo?.owner ?? null;
  const name = repo?.name ?? null;
  const request = useMemo(
    () => (owner && name ? { op: "listIssues" as const, params: { owner, name, state } } : null),
    [owner, name, state],
  );
  const read = useAccountGithubRead<"listIssues">(request);
  return { ...read, issues: read.data ?? [] };
}

/** One issue with its text, and its comments: two reads that refresh together. */
export function useAccountGithubIssue(repo: GithubDirectRepoRef | null, number: number | null) {
  const owner = repo?.owner ?? null;
  const name = repo?.name ?? null;
  const detailRequest = useMemo(
    () => (owner && name && number ? { op: "getIssue" as const, params: { owner, name, number } } : null),
    [owner, name, number],
  );
  const commentsRequest = useMemo(
    () => (owner && name && number ? { op: "listIssueComments" as const, params: { owner, name, number } } : null),
    [owner, name, number],
  );
  const detail = useAccountGithubRead<"getIssue">(detailRequest);
  const comments = useAccountGithubRead<"listIssueComments">(commentsRequest);
  const refreshDetail = detail.refresh;
  const refreshComments = comments.refresh;
  const refresh = useCallback(() => Promise.all([refreshDetail(), refreshComments()]).then(() => undefined), [refreshDetail, refreshComments]);
  return {
    supported: detail.supported,
    issue: detail.data,
    comments: comments.data ?? [],
    error: detail.error ?? comments.error,
    loading: detail.loading || comments.loading,
    refreshing: detail.refreshing || comments.refreshing,
    fetchedAt: detail.fetchedAt,
    refresh,
  };
}
