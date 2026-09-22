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

import type {
  DesktopSeatProvider,
  MacDesktopClaimArgs,
  MacDesktopEventPayload,
  MacDesktopOpenArgs,
  MacDesktopOpenResult,
  MacDesktopPresentArgs,
  MacDesktopReleaseArgs,
  MacDesktopWindow,
} from "../../../shared/types/macDesktop";
import type { Logger } from "../logging/logger";
import type { MacDesktopOwnershipRegistry } from "./macDesktopOwnership";
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

  const claimWindow = async (args: MacDesktopClaimArgs): Promise<MacDesktopWindow> => {
    const laneId = args.laneId.trim();
    deps.requireDisplay(laneId);
    const seat = await deps.ensureProvider();
    deps.assertPermission("accessibility");
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
    for (const windowId of targets) {
      try {
        await seat.unpark({ windowId });
        ownership.releaseWindow(windowId);
        released += 1;
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
