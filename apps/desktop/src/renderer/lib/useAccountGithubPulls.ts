import { useCallback, useSyncExternalStore } from "react";
import type { GithubDirectListState, GithubDirectRepoRef } from "../../shared/types";
import {
  createAccountGithubPullsStore,
  type AccountGithubPullsSnapshot,
} from "./accountGithubPullsStore";

/**
 * The pull requests of `repo`, read straight from GitHub with the ADE
 * account's GitHub App sign-in, with no machine online. For a page that
 * lists PRs when no machine can (the PRs tab adopts it in its own track).
 *
 * Refreshes every 60 s while the window is visible and something shows the
 * list; nothing runs while hidden (accountGithubPullsStore.ts). `error` is a
 * typed state; `githubDirectStateCopy` has its words.
 */

const store = createAccountGithubPullsStore({
  request: () => {
    const api = typeof window === "undefined" ? null : window.ade?.githubDirect;
    return api ? (request, requestOptions) => api.request<"listPulls">(request, requestOptions) : null;
  },
  isVisible: () => typeof document === "undefined" || document.visibilityState === "visible",
  onVisibilityChange: (listener) => {
    if (typeof document === "undefined") return () => undefined;
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
});

const IDLE: AccountGithubPullsSnapshot = { pulls: [], error: null, loading: false, refreshing: false, fetchedAt: null, truncated: false };

export function useAccountGithubPulls(
  repo: GithubDirectRepoRef | null,
  options: { state?: GithubDirectListState } = {},
) {
  const state = options.state ?? "open";
  const owner = repo?.owner ?? null;
  const name = repo?.name ?? null;
  const subscribe = useCallback(
    (listener: () => void) => (owner && name ? store.subscribe({ owner, name }, state, listener) : () => undefined),
    [owner, name, state],
  );
  const getSnapshot = useCallback(
    () => (owner && name ? store.snapshot({ owner, name }, state) : IDLE),
    [owner, name, state],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const refresh = useCallback(
    () => (owner && name ? store.refresh({ owner, name }, state) : Promise.resolve()),
    [owner, name, state],
  );
  return {
    /** This window can read GitHub directly (false on an older ADE). */
    supported: Boolean(typeof window !== "undefined" && window.ade?.githubDirect),
    ...snapshot,
    refresh,
  };
}
