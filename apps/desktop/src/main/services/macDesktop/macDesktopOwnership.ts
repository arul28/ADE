/**
 * Which lane owns which display, which window sits on it, and who is allowed to
 * ask for a single-instance app.
 *
 * Pure bookkeeping. The driver moves the actual windows; this file is the
 * record of what was asked for, so the two failure modes that matter — a second
 * lane claiming a window this lane holds, and two lanes fighting over Xcode —
 * are decided in one place that a test can drive without a window server.
 */

import {
  MAC_DESKTOP_APP_OWNED_BY_OTHER_LANE_CODE,
  type MacDesktopDisplay,
  type MacDesktopLaneSummary,
  type MacDesktopWindow,
  type MacDesktopWindowOrigin,
} from "../../../shared/types/macDesktop";

export class MacDesktopOwnershipError extends Error {
  readonly code: string;
  readonly laneId: string | null;

  constructor(code: string, message: string, laneId: string | null = null) {
    // See `MacDesktopError`: the `CODE: ` prefix is what reaches the CLI hints.
    super(message.startsWith(`${code}:`) ? message : `${code}: ${message}`);
    this.name = "MacDesktopOwnershipError";
    this.code = code;
    this.laneId = laneId;
  }
}

export type MacDesktopWindowRecord = {
  windowId: number;
  laneId: string;
  pid: number;
  bundleId: string | null;
  appName: string | null;
  origin: MacDesktopWindowOrigin;
  singleInstance: boolean;
  claimedAt: string;
};

export type MacDesktopWatchedLaunch = {
  laneId: string;
  pid: number;
  target: string;
  bundleId: string | null;
  startedAt: string;
  chatSessionId: string | null;
};

export function createMacDesktopOwnershipRegistry(options: { now?: () => number } = {}) {
  const now = options.now ?? (() => Date.now());
  const displays = new Map<string, MacDesktopDisplay>();
  const laneNames = new Map<string, string | null>();
  const windows = new Map<number, MacDesktopWindowRecord>();
  /** bundleId → laneId, for apps that refuse to run twice. */
  const singleInstanceHolders = new Map<string, string>();
  /** pid → the launch the driver is still watching for late windows. */
  const watchedLaunches = new Map<number, MacDesktopWatchedLaunch>();

  const iso = () => new Date(now()).toISOString();

  const countWindows = (laneId: string): number => {
    let count = 0;
    for (const record of windows.values()) if (record.laneId === laneId) count += 1;
    return count;
  };

  /**
   * Refuses the second lane by name.
   *
   * The message names the holding lane rather than saying "in use", for the
   * same reason `IOS_SIMULATOR_OWNED_BY_OTHER_SESSION` does: the only useful
   * next action is to go and stop that lane, and the caller cannot do that
   * without its id.
   */
  const assertSingleInstanceAvailable = (args: {
    laneId: string;
    bundleId: string | null | undefined;
    singleInstance: boolean;
    appName?: string | null;
  }): void => {
    const bundleId = args.bundleId?.trim();
    if (!args.singleInstance || !bundleId) return;
    const holder = singleInstanceHolders.get(bundleId);
    if (!holder || holder === args.laneId) return;
    const label = args.appName?.trim() || bundleId;
    throw new MacDesktopOwnershipError(
      MAC_DESKTOP_APP_OWNED_BY_OTHER_LANE_CODE,
      `${label} runs one copy at a time and lane ${holder} already holds it. Stop that lane's desktop first.`,
      holder,
    );
  };

  return {
    // -- displays ---------------------------------------------------------
    setDisplay(display: MacDesktopDisplay, laneName?: string | null): MacDesktopDisplay {
      const stored: MacDesktopDisplay = { ...display, windowCount: countWindows(display.laneId) };
      displays.set(display.laneId, stored);
      if (laneName !== undefined) laneNames.set(display.laneId, laneName ?? null);
      return stored;
    },

    getDisplay(laneId: string): MacDesktopDisplay | null {
      const display = displays.get(laneId);
      if (!display) return null;
      return { ...display, windowCount: countWindows(laneId) };
    },

    hasDisplay(laneId: string): boolean {
      return displays.has(laneId);
    },

    listDisplays(): MacDesktopDisplay[] {
      return [...displays.keys()].map((laneId) => ({
        ...displays.get(laneId)!,
        windowCount: countWindows(laneId),
      }));
    },

    laneIds(): string[] {
      return [...displays.keys()];
    },

    touchDisplay(laneId: string): void {
      const display = displays.get(laneId);
      if (!display) return;
      displays.set(laneId, { ...display, lastActivityAt: iso() });
    },

    /** Forgets a lane entirely: its display, its windows, its app claims. */
    removeDisplay(laneId: string): { removed: boolean; releasedWindows: number } {
      const removed = displays.delete(laneId);
      laneNames.delete(laneId);
      let releasedWindows = 0;
      for (const [windowId, record] of [...windows]) {
        if (record.laneId !== laneId) continue;
        windows.delete(windowId);
        releasedWindows += 1;
      }
      for (const [bundleId, holder] of [...singleInstanceHolders]) {
        if (holder === laneId) singleInstanceHolders.delete(bundleId);
      }
      for (const [pid, launch] of [...watchedLaunches]) {
        if (launch.laneId === laneId) watchedLaunches.delete(pid);
      }
      return { removed, releasedWindows };
    },

    // -- windows ----------------------------------------------------------
    assertSingleInstanceAvailable,

    /**
     * Records that a window now belongs to a lane.
     *
     * Re-claiming a window this lane already holds is a no-op rather than an
     * error: a window that moved itself off the display and was re-parked lands
     * here a second time, and that is normal operation, not a conflict.
     */
    claimWindow(args: {
      laneId: string;
      windowId: number;
      pid: number;
      bundleId?: string | null;
      appName?: string | null;
      origin: MacDesktopWindowOrigin;
      singleInstance?: boolean;
    }): MacDesktopWindowRecord {
      const singleInstance = args.singleInstance === true;
      assertSingleInstanceAvailable({
        laneId: args.laneId,
        bundleId: args.bundleId,
        singleInstance,
        appName: args.appName,
      });
      const record: MacDesktopWindowRecord = {
        windowId: args.windowId,
        laneId: args.laneId,
        pid: args.pid,
        bundleId: args.bundleId?.trim() || null,
        appName: args.appName?.trim() || null,
        origin: args.origin,
        singleInstance,
        claimedAt: iso(),
      };
      windows.set(args.windowId, record);
      if (singleInstance && record.bundleId) singleInstanceHolders.set(record.bundleId, args.laneId);
      return record;
    },

    releaseWindow(windowId: number): MacDesktopWindowRecord | null {
      const record = windows.get(windowId) ?? null;
      if (!record) return null;
      windows.delete(windowId);
      if (record.bundleId && record.singleInstance) {
        // The bundle stays claimed while any other window of it is still
        // parked; only the last window out releases the app.
        const stillHeld = [...windows.values()].some(
          (other) => other.bundleId === record.bundleId && other.laneId === record.laneId,
        );
        if (!stillHeld) singleInstanceHolders.delete(record.bundleId);
      }
      return record;
    },

    releaseLaneWindows(laneId: string): number {
      let released = 0;
      for (const [windowId, record] of [...windows]) {
        if (record.laneId !== laneId) continue;
        windows.delete(windowId);
        released += 1;
        if (record.bundleId && record.singleInstance) singleInstanceHolders.delete(record.bundleId);
      }
      return released;
    },

    getWindow(windowId: number): MacDesktopWindowRecord | null {
      return windows.get(windowId) ?? null;
    },

    laneForWindow(windowId: number): string | null {
      return windows.get(windowId)?.laneId ?? null;
    },

    listWindowRecords(laneId?: string | null): MacDesktopWindowRecord[] {
      const all = [...windows.values()];
      return laneId ? all.filter((record) => record.laneId === laneId) : all;
    },

    windowCount(laneId: string): number {
      return countWindows(laneId);
    },

    singleInstanceHolder(bundleId: string): string | null {
      return singleInstanceHolders.get(bundleId) ?? null;
    },

    /**
     * Reconciles the registry against what the driver actually sees.
     *
     * Window ids die with their process, so a list that no longer contains a
     * claimed id means the window is gone — not that the driver forgot it.
     */
    reconcileWindows(laneId: string, live: MacDesktopWindow[]): { dropped: number } {
      const liveIds = new Set(live.map((window) => window.id));
      let dropped = 0;
      for (const [windowId, record] of [...windows]) {
        if (record.laneId !== laneId || liveIds.has(windowId)) continue;
        windows.delete(windowId);
        dropped += 1;
        if (record.bundleId && record.singleInstance) singleInstanceHolders.delete(record.bundleId);
      }
      return { dropped };
    },

    // -- ade_launched pid watching ---------------------------------------
    watchLaunch(args: {
      laneId: string;
      pid: number;
      target: string;
      bundleId?: string | null;
      chatSessionId?: string | null;
    }): MacDesktopWatchedLaunch {
      const launch: MacDesktopWatchedLaunch = {
        laneId: args.laneId,
        pid: args.pid,
        target: args.target,
        bundleId: args.bundleId?.trim() || null,
        startedAt: iso(),
        chatSessionId: args.chatSessionId?.trim() || null,
      };
      watchedLaunches.set(args.pid, launch);
      return launch;
    },

    unwatchLaunch(pid: number): boolean {
      return watchedLaunches.delete(pid);
    },

    watchedLaunch(pid: number): MacDesktopWatchedLaunch | null {
      return watchedLaunches.get(pid) ?? null;
    },

    listWatchedLaunches(laneId?: string | null): MacDesktopWatchedLaunch[] {
      const all = [...watchedLaunches.values()];
      return laneId ? all.filter((launch) => launch.laneId === laneId) : all;
    },

    // -- summaries --------------------------------------------------------
    laneSummaries(isStreaming: (laneId: string) => boolean): MacDesktopLaneSummary[] {
      return [...displays.values()].map((display) => ({
        laneId: display.laneId,
        laneName: laneNames.get(display.laneId) ?? null,
        displayId: display.displayId,
        windowCount: countWindows(display.laneId),
        streaming: isStreaming(display.laneId),
      }));
    },

    laneName(laneId: string): string | null {
      return laneNames.get(laneId) ?? null;
    },

    clear(): void {
      displays.clear();
      laneNames.clear();
      windows.clear();
      singleInstanceHolders.clear();
      watchedLaunches.clear();
    },
  };
}

export type MacDesktopOwnershipRegistry = ReturnType<typeof createMacDesktopOwnershipRegistry>;
