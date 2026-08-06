import React from "react";
import type { GitHubPrListItem, GitHubPrSnapshot } from "../../../../shared/types";
import type { PrRouteSelectionTarget } from "../prsRouteState";
import {
  GITHUB_TAB_HISTORY_INITIAL_PAGE_LIMIT,
  GITHUB_TAB_HISTORY_MAX_PAGE_LIMIT,
  GITHUB_TAB_HISTORY_PAGE_INCREMENT,
  itemMatchesSelectionTarget,
  selectionTargetKey,
} from "./githubTabModel";

type LoadSnapshot = (options?: {
  force?: boolean;
  silent?: boolean;
  includeExternalClosed?: boolean;
  historyPageLimit?: number;
}) => Promise<GitHubPrSnapshot | null>;

/** Resolve explicit closed/merged routes without delaying the coordinate shell. */
export function useGitHubTargetHistory({
  displayedItems,
  loadSnapshot,
  selectedPrId,
  selectedPrTarget,
  snapshot,
}: {
  displayedItems: GitHubPrListItem[];
  loadSnapshot: LoadSnapshot;
  selectedPrId: string | null;
  selectedPrTarget: PrRouteSelectionTarget | null | undefined;
  snapshot: GitHubPrSnapshot | null;
}): void {
  const requestRef = React.useRef<{
    key: string;
    retryAt: number;
    inFlight: boolean;
  } | null>(null);
  const retryTimerRef = React.useRef<number | null>(null);

  React.useEffect(() => () => {
    if (retryTimerRef.current != null) window.clearTimeout(retryTimerRef.current);
  }, []);

  React.useEffect(() => {
    const clearRetry = () => {
      requestRef.current = null;
      if (retryTimerRef.current != null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
    if (!snapshot || selectedPrTarget?.prNumber == null) {
      clearRetry();
      return;
    }
    if (displayedItems.some((item) => itemMatchesSelectionTarget(item, selectedPrTarget))) {
      clearRetry();
      return;
    }

    const history = snapshot.history;
    const currentLimit = history?.includeExternalClosed ? history.pageLimit : 0;
    const canWidenHistory = Boolean(
      history?.includeExternalClosed
      && history.repoPullRequestsMayHaveMore
      && currentLimit < GITHUB_TAB_HISTORY_MAX_PAGE_LIMIT,
    );
    // `includeExternalClosed` only says which query ran. A projected or
    // paginated snapshot can still be incomplete, so keep widening it for an
    // explicit target until GitHub says there are no more pages (or the
    // bounded maximum is reached).
    if (history?.includeExternalClosed && !canWidenHistory) {
      clearRetry();
      return;
    }

    const targetKey = selectionTargetKey(selectedPrId, selectedPrTarget);
    if (!targetKey) return;
    const previousRequest = requestRef.current;
    if (previousRequest?.key === targetKey
      && (previousRequest.inFlight || Date.now() < previousRequest.retryAt)) return;
    if (previousRequest?.key !== targetKey && retryTimerRef.current != null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    const scheduleRetry = () => {
      if (requestRef.current?.key !== targetKey) return;
      requestRef.current = { key: targetKey, retryAt: Date.now() + 30_000, inFlight: false };
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        if (requestRef.current?.key !== targetKey) return;
        requestRef.current = null;
        requestHistory(GITHUB_TAB_HISTORY_INITIAL_PAGE_LIMIT);
      }, 30_000);
    };
    const requestHistory = (historyPageLimit: number): void => {
      requestRef.current = { key: targetKey, retryAt: Date.now() + 5_000, inFlight: true };
      // Open-only snapshots are intentionally cheap, but an explicit deep link
      // may target a merged/closed PR outside that window. Keep the provisional
      // coordinate pane visible and widen history asynchronously rather than
      // blocking first paint. Continue paging when the response is partial.
      void loadSnapshot({
        force: history?.includeExternalClosed === true
          || historyPageLimit > GITHUB_TAB_HISTORY_INITIAL_PAGE_LIMIT,
        includeExternalClosed: true,
        historyPageLimit,
        silent: true,
      }).then((loaded) => {
        if (requestRef.current?.key !== targetKey) return;
        if (!loaded?.history?.includeExternalClosed) {
          scheduleRetry();
          return;
        }
        if (loaded.history.repoPullRequestsMayHaveMore
          && loaded.history.pageLimit < GITHUB_TAB_HISTORY_MAX_PAGE_LIMIT) {
          requestHistory(Math.min(
            GITHUB_TAB_HISTORY_MAX_PAGE_LIMIT,
            loaded.history.pageLimit + GITHUB_TAB_HISTORY_PAGE_INCREMENT,
          ));
          return;
        }
        clearRetry();
      }).catch(scheduleRetry);
    };

    requestHistory(canWidenHistory
      ? Math.min(GITHUB_TAB_HISTORY_MAX_PAGE_LIMIT, currentLimit + GITHUB_TAB_HISTORY_PAGE_INCREMENT)
      : GITHUB_TAB_HISTORY_INITIAL_PAGE_LIMIT);
  }, [displayedItems, loadSnapshot, selectedPrId, selectedPrTarget, snapshot]);
}
