/**
 * The fixed desktop layout for tabs being recorded.
 *
 * A recording tab lays its page out at `BUILT_IN_BROWSER_RECORDING_VIEWPORT`
 * (1280×800) with the same CDP override a device preset uses, scaled to fit
 * the view's box, so a recording is a desktop page rather than whatever strip
 * the pane happened to be. Every other tab — agent-owned ones included — lays
 * out at its box: pinning a tab when an agent claimed it resized the page the
 * person was looking at on every claim, release and lease expiry.
 */

import type { WebContents } from "electron";
import {
  BUILT_IN_BROWSER_NARROW_PAGE_WIDTH,
  BUILT_IN_BROWSER_RECORDING_VIEWPORT,
} from "../../../shared/types/builtInBrowser";
import type { Logger } from "../logging/logger";
import { clampBuiltInBrowserEmulationViewScale } from "./builtInBrowserCapabilities";
import { errorMessage } from "./builtInBrowserConstants";
import type { BrowserDebuggerHoldOwner, BrowserTabState } from "./builtInBrowserService";

/**
 * Whether the tab is laid out at `BUILT_IN_BROWSER_RECORDING_VIEWPORT` rather than
 * at its box: it is being recorded, or is about to be (`recordingStarting`, set
 * before the first frame so the video never opens at the pane's size).
 *
 * Ownership alone does not pin it. An agent works fine at the pane's size, and
 * its screenshots then match what the person sees. A device preset is an
 * explicit ask and wins; DevTools needs the debugger the override holds; and a
 * handoff hands the tab to a person, who gets the page at their pane's size.
 */
export function tabUsesRecordingViewport(
  tab: Pick<BrowserTabState, "emulation" | "devToolsMode" | "handoff" | "recording" | "recordingStarting">,
): boolean {
  if (tab.emulation || tab.devToolsMode !== null || tab.handoff) return false;
  return Boolean(tab.recording) || tab.recordingStarting === true;
}

/** How much the recording viewport shrinks to fit inside `box` (never grows). */
function recordingViewportScaleIn(box: { width: number; height: number }): number {
  return Math.min(
    1,
    box.width / BUILT_IN_BROWSER_RECORDING_VIEWPORT.width,
    box.height / BUILT_IN_BROWSER_RECORDING_VIEWPORT.height,
  );
}

/**
 * Where a tab on the fixed viewport sits inside the box its pane reported:
 * the viewport's shape, shrunk to fit, centred.
 *
 * The pane letterboxes the box itself once it knows the tab is on the fixed
 * viewport, and then this is the box unchanged. It is recomputed here because
 * main is what applies the override: a pane that had not yet heard (or missed
 * a resize) left the view at the whole pane with the 1280×800 page drawn in
 * its top-left corner.
 */
export function recordingViewportViewRect<T extends { x: number; y: number; width: number; height: number }>(box: T): T {
  const { width: viewportWidth, height: viewportHeight } = BUILT_IN_BROWSER_RECORDING_VIEWPORT;
  if (!(box.width > 0) || !(box.height > 0)) return box;
  const scale = recordingViewportScaleIn(box);
  const width = Math.min(box.width, Math.round(viewportWidth * scale));
  const height = Math.min(box.height, Math.round(viewportHeight * scale));
  // Already the viewport's shape (the pane's own letterbox, give or take its
  // rounding): keep it exactly, so the view stays on the DOM frame under it.
  if (box.width - width <= 1 && box.height - height <= 1) return box;
  return {
    ...box,
    x: box.x + Math.floor((box.width - width) / 2),
    y: box.y + Math.floor((box.height - height) / 2),
    width,
    height,
  };
}

/**
 * What an agent is told when the page it reads is narrow because the
 * person's pane is narrow. The page stays the person's size; the agent
 * learns why a site may be in its mobile layout and how to get a desktop one
 * when its task needs it. Null when the width is somebody's explicit choice
 * (a device preset, a recording) or is not the pane's (a tab never shown).
 */
export function narrowPageHint(
  tab: Pick<BrowserTabState, "id" | "emulation" | "devToolsMode" | "handoff" | "recording" | "lastPanelRect">,
  pageWidth: number | null,
): string | null {
  if (tab.emulation || tabUsesRecordingViewport(tab) || !tab.lastPanelRect) return null;
  const width = pageWidth ?? tab.lastPanelRect.width;
  if (!(width > 0) || width >= BUILT_IN_BROWSER_NARROW_PAGE_WIDTH) return null;
  const { width: desktopWidth, height: desktopHeight } = BUILT_IN_BROWSER_RECORDING_VIEWPORT;
  return `The page is ${Math.round(width)} px wide, the size of the user's browser pane, so a site can show its mobile layout. `
    + "This is what the user sees. If the task needs the desktop layout, run "
    + `\`ade browser emulate --tab ${tab.id} --width ${desktopWidth} --height ${desktopHeight}\`, and `
    + `\`ade browser emulate --tab ${tab.id} --off\` when you finish.`;
}

export type BuiltInBrowserRecordingViewport = ReturnType<typeof createBuiltInBrowserRecordingViewport>;

export function createBuiltInBrowserRecordingViewport(deps: {
  tabs: () => Iterable<BrowserTabState>;
  /** Re-places every view; a tab's box depends on whether it wants the viewport. */
  reattachViews: () => void;
  acquireDebuggerHold: (tab: BrowserTabState, owner: BrowserDebuggerHoldOwner) => Promise<void>;
  releaseDebuggerHold: (tab: BrowserTabState, owner: BrowserDebuggerHoldOwner) => void;
  sendDebuggerCommand: (wc: WebContents, method: string, params?: Record<string, unknown>) => Promise<unknown>;
  logger: () => Logger | null;
}) {
  /**
   * Per tab: the fit factor we want Chromium to draw the recording viewport at,
   * the one it last accepted, the view box it is fitted into, and the queue
   * the CDP calls run on. `target`/`applied` null means "no override of ours".
   */
  type RecordingViewportState = {
    target: number | null;
    applied: number | null;
    wanted: boolean;
    box: { width: number; height: number } | null;
    chain: Promise<void>;
  };
  const recordingViewports = new WeakMap<BrowserTabState, RecordingViewportState>();

  const recordingViewportState = (tab: BrowserTabState): RecordingViewportState => {
    let state = recordingViewports.get(tab);
    if (!state) {
      state = { target: null, applied: null, wanted: false, box: null, chain: Promise.resolve() };
      recordingViewports.set(tab, state);
    }
    return state;
  };

  /**
   * How much the fixed page has to shrink to fit the view's box. The pane
   * letterboxes the box to the viewport's shape, so this is the pane's own fit
   * factor; a parked view is exactly the viewport, so it is 1.
   */
  const recordingViewportFit = (box: { width: number; height: number } | null): number => {
    if (!box || !(box.width > 0) || !(box.height > 0)) return 1;
    return clampBuiltInBrowserEmulationViewScale(recordingViewportScaleIn(box));
  };

  /**
   * Bring Chromium in line with `state.target`. Runs on the tab's own queue,
   * and reads the target when it runs rather than when it was queued, so a
   * burst of pane drags or an on/off/on flip lands on the last answer.
   */
  const applyRecordingViewport = async (tab: BrowserTabState, state: RecordingViewportState): Promise<void> => {
    const target = state.target;
    if (target === state.applied) return;
    const wc = tab.webContents;
    if (wc.isDestroyed()) {
      state.applied = null;
      return;
    }
    if (target == null) {
      state.applied = null;
      if (!tab.debuggerHolds.has("recording-viewport")) return;
      try {
        // A device preset that replaced ours owns the override now; clearing
        // it here would take the person's iPhone away with our desktop.
        if (!tab.emulation && wc.debugger.isAttached()) {
          await deps.sendDebuggerCommand(wc, "Emulation.clearDeviceMetricsOverride").catch(() => {});
          // The page re-lays out at the pane's size; without a fresh frame the
          // view can sit black until the pointer moves over it.
          if (!wc.isDestroyed()) wc.invalidate?.();
        }
      } finally {
        deps.releaseDebuggerHold(tab, "recording-viewport");
      }
      return;
    }
    // Chromium reverts an override when the session that set it detaches, so
    // like a preset it owns a debugger hold for as long as it is in force.
    if (!tab.debuggerHolds.has("recording-viewport")) await deps.acquireDebuggerHold(tab, "recording-viewport");
    const { width, height } = BUILT_IN_BROWSER_RECORDING_VIEWPORT;
    await deps.sendDebuggerCommand(wc, "Emulation.setDeviceMetricsOverride", {
      width,
      height,
      // 0 keeps the display's own density, so the page stays as sharp as it
      // would be unemulated.
      deviceScaleFactor: 0,
      mobile: false,
      scale: target,
      screenWidth: width,
      screenHeight: height,
      positionX: 0,
      positionY: 0,
      screenOrientation: { type: "landscapePrimary", angle: 90 },
    });
    state.applied = target;
  };

  const queueRecordingViewport = (tab: BrowserTabState, state: RecordingViewportState): void => {
    state.chain = state.chain
      .then(() => applyRecordingViewport(tab, state))
      .catch((error: unknown) => {
        // DevTools open, a renderer mid-swap: the tab keeps laying out at its
        // box, which is what it did before this existed. The next change of
        // box or owner tries again.
        deps.logger()?.debug("built_in_browser.recording_viewport_failed", {
          tabId: tab.id,
          err: errorMessage(error),
        });
      });
  };

  /**
   * Re-derive one tab's override from its owner, recording and box. `box` is
   * the view's new bounds when the caller just placed it; omitted, the last
   * known box stands (a detached view has no surface to fit anyway).
   */
  const syncRecordingViewport = (
    tab: BrowserTabState,
    box?: { width: number; height: number } | null,
  ): void => {
    const state = recordingViewportState(tab);
    if (box && box.width > 0 && box.height > 0) state.box = { width: box.width, height: box.height };
    const target = tabUsesRecordingViewport(tab) ? recordingViewportFit(state.box) : null;
    if (target === state.target) return;
    state.target = target;
    queueRecordingViewport(tab, state);
  };

  /**
   * Re-send an override Chromium may have dropped behind our back: a
   * cross-process navigation, or a `setEmulation` clear that swept ours away
   * along with a preset that was never on.
   */
  const refreshRecordingViewport = (tab: BrowserTabState): void => {
    const state = recordingViewports.get(tab);
    if (!state || state.target == null) return;
    state.applied = null;
    queueRecordingViewport(tab, state);
  };

  /**
   * Every tab against its recording state, from `emitStatus` — the one place
   * every recording edge, handoff and DevTools toggle passes through. Costs
   * nothing but a comparison when nothing moved. A tab whose want flipped is
   * placed again: parked, its box is the viewport's size only while it wants
   * the viewport; on screen, its view is letterboxed only while it does.
   */
  const reconcileRecordingViewports = (): void => {
    let replace = false;
    for (const tab of deps.tabs()) {
      if (tab.webContents.isDestroyed()) continue;
      const state = recordingViewportState(tab);
      const wanted = tabUsesRecordingViewport(tab);
      if (wanted !== state.wanted) {
        state.wanted = wanted;
        replace = true;
      }
      syncRecordingViewport(tab);
    }
    if (replace) deps.reattachViews();
  };

  /**
   * The scale Chromium is drawing the tab's page at under our override, 1 when
   * none is in force. Synthesized mouse input is read in that drawn space.
   */
  const inputScale = (tab: BrowserTabState): number => recordingViewports.get(tab)?.applied ?? 1;

  /** Resolves once the tab's queued override calls have run. */
  const settleRecordingViewport = async (tab: BrowserTabState): Promise<void> => {
    await recordingViewports.get(tab)?.chain;
  };

  return {
    sync: syncRecordingViewport,
    refresh: refreshRecordingViewport,
    reconcile: reconcileRecordingViewports,
    settle: settleRecordingViewport,
    inputScale,
  };
}
