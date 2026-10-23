import type { BuiltInBrowserDownload } from "../../../shared/types/builtInBrowser";

/**
 * The collection's download receipts and the calls waiting on one.
 *
 * Kept out of `builtInBrowserService` because it is a bookkeeping buffer with
 * its own lifecycle: `will-download` records, `done` settles, a read lists, and
 * a wait sleeps until either happens. None of it needs tabs, a window or the
 * debugger.
 */
export type DownloadTracker = {
  record(download: BuiltInBrowserDownload): void;
  settle(download: BuiltInBrowserDownload, state: BuiltInBrowserDownload["state"], endedAt: string): void;
  list(matches: (download: BuiltInBrowserDownload) => boolean, limit: number): BuiltInBrowserDownload[];
  /** The newest completed download that started after the caller's last action, or null. */
  recent(
    matches: (download: BuiltInBrowserDownload) => boolean,
    actionFloorMs: number,
    graceMs: number,
    nowMs: number,
  ): BuiltInBrowserDownload | null;
  wait(args: {
    matches: (download: BuiltInBrowserDownload) => boolean;
    timeoutMs: number;
  }): Promise<BuiltInBrowserDownload | null>;
  dispose(): void;
};

/** The action and the download it starts are milliseconds apart; allow the gap. */
const ACTION_FLOOR_SLACK_MS = 1_000;

type Waiter = {
  matches: (download: BuiltInBrowserDownload) => boolean;
  resolve: (download: BuiltInBrowserDownload | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function createDownloadTracker(args: { maxTracked: number }): DownloadTracker {
  const downloads: BuiltInBrowserDownload[] = [];
  const waiters = new Set<Waiter>();

  const wake = (download: BuiltInBrowserDownload): void => {
    for (const waiter of [...waiters]) {
      if (!waiter.matches(download)) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(download);
    }
  };

  return {
    record(download: BuiltInBrowserDownload): void {
      downloads.unshift(download);
      if (downloads.length > args.maxTracked) downloads.length = args.maxTracked;
    },
    settle(download, state, endedAt): void {
      download.state = state;
      download.endedAt = endedAt;
      // Any terminal state wakes a wait: a cancelled download should return its
      // receipt now, not leave the caller waiting out the timeout.
      wake(download);
    },
    list(matches, limit): BuiltInBrowserDownload[] {
      return downloads.filter(matches).slice(0, limit);
    },
    recent(matches, actionFloorMs, graceMs, nowMs): BuiltInBrowserDownload | null {
      return downloads.find((download) => {
        if (download.state !== "completed" || !download.endedAt) return false;
        if (!matches(download)) return false;
        // Only a file that started after the agent's last action on this tab is
        // the one it just triggered; an older receipt is not.
        const startedAtMs = Date.parse(download.startedAt);
        if (Number.isFinite(startedAtMs) && startedAtMs < actionFloorMs - ACTION_FLOOR_SLACK_MS) return false;
        return nowMs - Date.parse(download.endedAt) <= graceMs;
      }) ?? null;
    },
    wait({ matches, timeoutMs }): Promise<BuiltInBrowserDownload | null> {
      return new Promise((resolve) => {
        const waiter: Waiter = {
          matches,
          resolve,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            resolve(null);
          }, timeoutMs),
        };
        waiter.timer.unref?.();
        waiters.add(waiter);
      });
    },
    dispose(): void {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
      waiters.clear();
    },
  };
}
