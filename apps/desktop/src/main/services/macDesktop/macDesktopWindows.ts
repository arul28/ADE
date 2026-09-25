/**
 * The window and app lifecycle half of the Mac Desktop service.
 *
 * Owns the one path a window enters or leaves a lane's display on — launching
 * an app onto it, parking an existing window, unparking one, moving the whole
 * set to another destination — and the single read every `windows-changed`
 * event is built from.
 *
 * Split out of `macDesktopService.ts` as pure code motion, with the same deps
 * shape `macDesktopStreaming.ts` uses: the service passes its registries and
 * its gates in, and keeps the API surface.
 */

import {
  MAC_DESKTOP_APP_OWNED_BY_OTHER_LANE_CODE,
  type DesktopSeatProvider,
  type MacDesktopClaimArgs,
  type MacDesktopEventPayload,
  type MacDesktopOpenArgs,
  type MacDesktopOpenResult,
  type MacDesktopPresentArgs,
  type MacDesktopReleaseArgs,
  type MacDesktopWindow,
} from "../../../shared/types/macDesktop";
import type { Logger } from "../logging/logger";
import { MacDesktopOwnershipError, type MacDesktopOwnershipRegistry } from "./macDesktopOwnership";
import { asNullableString, asNumber, asWindows } from "./macDesktopSeatProvider";

export type MacDesktopWindowsDeps = {
  logger: Logger;
  isDarwin: boolean;
  emit: (payload: MacDesktopEventPayload) => void;
  /** Starts the backend if needed. Throws the same errors the service does. */
  ensureProvider: () => Promise<DesktopSeatProvider>;
  /** The backend only if it is already up: a read must not start one. */
  activeProvider: () => DesktopSeatProvider | null;
  requireDisplay: (laneId: string) => void;
  assertPermission: (which: "screenRecording" | "accessibility") => void;
  ownership: MacDesktopOwnershipRegistry;
  /** The lane whose App Control session runs this process, or null. */
  appControlLaneForProcess?: ((pid: number) => Promise<string | null> | string | null) | null;
};

export function createMacDesktopWindows(deps: MacDesktopWindowsDeps) {
  const { ownership } = deps;

  /**
   * The lane's windows as the driver sees them, reconciled into ownership.
   *
   * Answers with an empty list rather than starting the backend: a status read
   * on a lane with no display must not spawn a helper to say "none".
   */
  const listInternal = async (laneId?: string | null): Promise<MacDesktopWindow[]> => {
    const seat = deps.isDarwin ? deps.activeProvider() : null;
    if (!seat) return [];
    const windows = await seat.listWindows({ laneId: laneId ?? null });
    if (laneId) ownership.reconcileWindows(laneId, windows);
    return windows;
  };

  const open = async (args: MacDesktopOpenArgs): Promise<MacDesktopOpenResult> => {
    const laneId = args.laneId.trim();
    deps.requireDisplay(laneId);
    const seat = await deps.ensureProvider();
    deps.assertPermission("accessibility");
    const reply = await seat.launch({
      laneId,
      target: args.target,
      args: args.args ?? [],
    });
    const windows = asWindows(reply.windows);
    const bundleId = asNullableString(reply.bundleId);
    const pid = typeof reply.pid === "number" ? reply.pid : null;
    // Opening an app that is already running re-uses that instance. When the
    // instance is another lane's App Control app, hand back whatever the
    // driver parked and refuse, as `claim` does.
    const holder = pid != null ? await appControlHolder(pid, laneId) : null;
    if (holder) {
      const parked = (await seat.listWindows({ laneId }).catch(() => [] as MacDesktopWindow[]))
        .filter((window) => window.pid === pid)
        .map((window) => window.id);
      for (const windowId of new Set([...windows.filter((window) => window.pid === pid).map((w) => w.id), ...parked])) {
        await seat.unpark({ windowId, laneId }).catch(() => undefined);
      }
      throw otherLanesAppControlAppError(holder, asNullableString(reply.appName));
    }
    for (const window of windows) {
      ownership.claimWindow({
        laneId,
        windowId: window.id,
        pid: window.pid,
        bundleId: window.bundleId,
        appName: window.appName,
        origin: "ade_launched",
        singleInstance: window.singleInstance,
      });
    }
    if (pid != null) {
      ownership.watchLaunch({
        laneId,
        pid,
        target: args.target,
        bundleId,
        chatSessionId: args.chatSessionId ?? null,
      });
    }
    ownership.touchDisplay(laneId);
    // Re-read rather than announcing `reply.windows`.
    //
    // `launch` answers with the windows the app had published by the time it
    // returned, which for a cold app is none. The driver's watcher parks the
    // real window a moment later and emits its own `windows-changed` — and
    // this emit, landing after it with an empty list, overwrote it. The panel
    // then sat on "Windows 0" with the app plainly visible in the stream until
    // something else touched the list. The listing is cheap and this is the
    // only site that had a stale one to hand.
    deps.emit({ type: "windows-changed", laneId, windows: await listInternal(laneId) });
    return {
      laneId,
      pid,
      appName: asNullableString(reply.appName),
      bundleId,
      windows,
      watching: reply.watching === true,
    };
  };

  /** The other lane whose App Control session runs this process, or null. */
  const appControlHolder = async (pid: number, laneId: string): Promise<string | null> => {
    const lookup = deps.appControlLaneForProcess;
    if (!lookup || !pid) return null;
    const holder = await Promise.resolve(lookup(pid)).catch(() => null);
    return holder && holder !== laneId ? holder : null;
  };

  const otherLanesAppControlAppError = (holder: string, appName: string | null | undefined) =>
    new MacDesktopOwnershipError(
      MAC_DESKTOP_APP_OWNED_BY_OTHER_LANE_CODE,
      `${appName || "This app"} is lane ${holder}'s App Control app. A lane cannot claim another lane's app. `
        + "Stop it from that lane first.",
      holder,
    );

  /**
   * An app another lane runs under App Control is that lane's. Claiming one of
   * its windows would move it onto this lane's screen and hand this lane its
   * frames and input, which App Control's own lane rule forbids.
   */
  const assertNotOtherLanesAppControlApp = async (
    seat: DesktopSeatProvider,
    laneId: string,
    windowId: number,
  ): Promise<void> => {
    if (!deps.appControlLaneForProcess) return;
    const window = (await seat.listWindows({ laneId: null })).find((entry) => entry.id === windowId);
    if (!window?.pid) return;
    const holder = await appControlHolder(window.pid, laneId);
    if (holder) throw otherLanesAppControlAppError(holder, window.appName);
  };

  const claimWindow = async (args: MacDesktopClaimArgs): Promise<MacDesktopWindow> => {
    const laneId = args.laneId.trim();
    deps.requireDisplay(laneId);
    const seat = await deps.ensureProvider();
    deps.assertPermission("accessibility");
    await assertNotOtherLanesAppControlApp(seat, laneId, args.windowId);
    const existing = ownership.getWindow(args.windowId);
    if (existing && existing.laneId !== laneId && existing.singleInstance && existing.bundleId) {
      ownership.assertSingleInstanceAvailable({
        laneId,
        bundleId: existing.bundleId,
        singleInstance: true,
        appName: existing.appName,
      });
    }
    const window = await seat.park({ laneId, windowId: args.windowId });
    ownership.claimWindow({
      laneId,
      windowId: window.id ?? args.windowId,
      pid: window.pid,
      bundleId: window.bundleId,
      appName: window.appName,
      origin: "claimed",
      singleInstance: window.singleInstance,
    });
    ownership.touchDisplay(laneId);
    deps.emit({ type: "windows-changed", laneId, windows: await listInternal(laneId) });
    return window;
  };

  const releaseWindow = async (args: MacDesktopReleaseArgs): Promise<{ released: number }> => {
    const laneId = args.laneId.trim();
    const seat = await deps.ensureProvider();
    const targets = args.windowId != null
      ? [args.windowId]
      : ownership.listWindowRecords(laneId).map((record) => record.windowId);
    let released = 0;
    let lastError: string | null = null;
    const alreadyReleased = new Set<number>();
    for (const windowId of targets) {
      // Releasing one window of an app the lane launched releases every
      // window of that app, so a later target may already be the user's.
      if (alreadyReleased.has(windowId)) continue;
      try {
        // The lane is named so the driver refuses a window another lane
        // holds: one lane's Release must never hand over another's app.
        const reply = await seat.unpark({ windowId, laneId });
        const releasedIds = reply.releasedWindowIds.includes(windowId)
          ? reply.releasedWindowIds
          : [windowId, ...reply.releasedWindowIds];
        for (const id of releasedIds) {
          if (alreadyReleased.has(id)) continue;
          alreadyReleased.add(id);
          if (ownership.releaseWindow(id) || id === windowId) released += 1;
        }
        // The user owns that instance now: stop never quits it.
        if (reply.handedOverPid != null) ownership.unwatchLaunch(reply.handedOverPid);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        deps.logger.debug("mac_desktop.release_window_failed", { laneId, windowId, error: lastError });
      }
    }
    if (released) deps.emit({ type: "windows-changed", laneId, windows: await listInternal(laneId) });
    // A Release that released nothing is reported, not swallowed. Every
    // failure used to go to a debug line and the caller got `{released: 0}`,
    // so the button was indistinguishable from a button wired to nothing —
    // which is exactly how it looked to the person pressing it.
    if (!released && targets.length) {
      throw new Error(lastError ?? "Could not move that window back to your screen.");
    }
    return { released };
  };

  const present = async (args: MacDesktopPresentArgs): Promise<{ moved: number }> => {
    const laneId = args.laneId.trim();
    deps.requireDisplay(laneId);
    const seat = await deps.ensureProvider();
    const reply = await seat.present({ laneId, destination: args.destination });
    ownership.touchDisplay(laneId);
    deps.emit({ type: "windows-changed", laneId, windows: await listInternal(laneId) });
    return { moved: asNumber(reply.moved, 0) };
  };

  return { listInternal, open, claimWindow, releaseWindow, present };
}
