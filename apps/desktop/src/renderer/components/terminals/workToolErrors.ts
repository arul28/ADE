import type { BuiltInBrowserStatus } from "../../../shared/types";

/**
 * "Is this tool showing you something broken?" — the red half of the tools
 * pane's activity dots.
 *
 * The counts are pushed, never polled: the browser service emits a
 * `diagnostics` event when a tab's tally moves, and resets it to zero on a
 * main-frame navigation, so a reload clears the badge without the renderer
 * having to guess when to forget. Everything in this file is therefore a pure
 * fold over those events — no timers, no `observe` calls.
 */

export type WorkToolErrorCounts = {
  consoleErrorCount: number;
  failedRequestCount: number;
};

export type WorkToolErrorsByTab = Readonly<Record<string, WorkToolErrorCounts>>;

export const EMPTY_WORK_TOOL_ERRORS: WorkToolErrorsByTab = Object.freeze({});

export type WorkToolDiagnosticsEvent = {
  tabId: string;
  consoleErrorCount: number;
  failedRequestCount: number;
};

function sameCounts(a: WorkToolErrorCounts | undefined, b: WorkToolErrorCounts): boolean {
  return a?.consoleErrorCount === b.consoleErrorCount && a?.failedRequestCount === b.failedRequestCount;
}

/**
 * Folds one `diagnostics` event in.
 *
 * Returns the SAME object when nothing moved. The map feeds a `useState`, and a
 * page that re-reports an unchanged tally — which happens whenever a navigation
 * resets an already-zero tab — must not re-render the whole tools pane.
 */
export function reduceWorkToolBrowserErrors(
  prev: WorkToolErrorsByTab,
  event: WorkToolDiagnosticsEvent,
): WorkToolErrorsByTab {
  const tabId = event.tabId.trim();
  if (!tabId) return prev;
  const next: WorkToolErrorCounts = {
    consoleErrorCount: Math.max(0, Math.trunc(event.consoleErrorCount)),
    failedRequestCount: Math.max(0, Math.trunc(event.failedRequestCount)),
  };
  if (sameCounts(prev[tabId], next)) return prev;
  // A zeroed tab is dropped rather than stored as {0,0}: the map is only ever
  // asked "does this tab have errors", so an entry that answers "no" is dead
  // weight that also has to be pruned later.
  if (next.consoleErrorCount === 0 && next.failedRequestCount === 0) {
    if (!(tabId in prev)) return prev;
    const { [tabId]: _dropped, ...rest } = prev;
    return rest;
  }
  return { ...prev, [tabId]: next };
}

/** Forgets tabs that no longer exist, so a closed tab cannot keep a dot red. */
export function pruneWorkToolBrowserErrors(
  prev: WorkToolErrorsByTab,
  status: BuiltInBrowserStatus | null,
): WorkToolErrorsByTab {
  const keys = Object.keys(prev);
  if (keys.length === 0) return prev;
  const liveTabIds = new Set((status?.tabs ?? []).map((tab) => tab.id));
  if (keys.every((key) => liveTabIds.has(key))) return prev;
  const next: Record<string, WorkToolErrorCounts> = {};
  for (const key of keys) {
    if (liveTabIds.has(key)) next[key] = prev[key]!;
  }
  return next;
}

/**
 * The count the browser card and dot report — the ACTIVE tab's, not the sum
 * across tabs. A dot that turned red for a background tab you cannot see would
 * send you looking for an error that is not on screen.
 */
export function workToolBrowserErrorCount(
  errors: WorkToolErrorsByTab,
  status: BuiltInBrowserStatus | null,
): number {
  const tabId = status?.activeTabId ?? status?.tabs[0]?.id ?? null;
  if (!tabId) return 0;
  const counts = errors[tabId];
  if (!counts) return 0;
  return counts.consoleErrorCount + counts.failedRequestCount;
}

/** `" · 3 errors"`, appended to a card's status line. Empty when there are none. */
export function workToolErrorSuffix(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  return ` · ${count} ${count === 1 ? "error" : "errors"}`;
}
