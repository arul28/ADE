/**
 * The fixed desktop layout for tabs being recorded.
 *
 * A recording tab lays its page out at `BUILT_IN_BROWSER_AGENT_VIEWPORT`
 * (1280×800) with the same CDP override a device preset uses, scaled to fit
 * the view's box, so a recording is a desktop page rather than whatever strip
 * the pane happened to be. Every other tab — agent-owned ones included — lays
 * out at its box: pinning a tab when an agent claimed it resized the page the
 * person was looking at on every claim, release and lease expiry.
 */

import type { WebContents } from "electron";
import { BUILT_IN_BROWSER_AGENT_VIEWPORT } from "../../../shared/types/builtInBrowser";
import type { Logger } from "../logging/logger";
import { clampBuiltInBrowserEmulationViewScale } from "./builtInBrowserCapabilities";
import { errorMessage } from "./builtInBrowserConstants";
import type { BrowserDebuggerHoldOwner, BrowserTabState } from "./builtInBrowserService";

/**
 * Whether the tab is laid out at `BUILT_IN_BROWSER_AGENT_VIEWPORT` rather than
 * at its box: it is being recorded.
 *
 * Ownership alone does not pin it. An agent works fine at the pane's size, and
 * its screenshots then match what the person sees. A device preset is an
 * explicit ask and wins; DevTools needs the debugger the override holds; and a
 * handoff hands the tab to a person, who gets the page at their pane's size.
 */
export function tabUsesAgentViewport(
  tab: Pick<BrowserTabState, "emulation" | "devToolsMode" | "handoff" | "recording">,
): boolean {
  if (tab.emulation || tab.devToolsMode !== null || tab.handoff) return false;
  return Boolean(tab.recording);
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
export function agentViewportViewRect<T extends { x: number; y: number; width: number; height: number }>(box: T): T {
  const { width: viewportWidth, height: viewportHeight } = BUILT_IN_BROWSER_AGENT_VIEWPORT;
  if (!(box.width > 0) || !(box.height > 0)) return box;
  const scale = Math.min(1, box.width / viewportWidth, box.height / viewportHeight);
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

export type BuiltInBrowserAgentViewport = ReturnType<typeof createBuiltInBrowserAgentViewport>;

export function createBuiltInBrowserAgentViewport(deps: {
  tabs: () => Iterable<BrowserTabState>;
  /** Re-places every view; a tab's box depends on whether it wants the viewport. */
  reattachViews: () => void;
  acquireDebuggerHold: (tab: BrowserTabState, owner: BrowserDebuggerHoldOwner) => Promise<void>;
  releaseDebuggerHold: (tab: BrowserTabState, owner: BrowserDebuggerHoldOwner) => void;
  sendDebuggerCommand: (wc: WebContents, method: string, params?: Record<string, unknown>) => Promise<unknown>;
  logger: () => Logger | null;
}) {
  /**
   * Per tab: the fit factor we want Chromium to draw the agent viewport at,
   * the one it last accepted, the view box it is fitted into, and the queue
   * the CDP calls run on. `target`/`applied` null means "no override of ours".
   */
  type AgentViewportState = {
    target: number | null;
    applied: number | null;
    wanted: boolean;
    box: { width: number; height: number } | null;
    chain: Promise<void>;
  };
  const agentViewports = new WeakMap<BrowserTabState, AgentViewportState>();

  const agentViewportState = (tab: BrowserTabState): AgentViewportState => {
    let state = agentViewports.get(tab);
    if (!state) {
      state = { target: null, applied: null, wanted: false, box: null, chain: Promise.resolve() };
      agentViewports.set(tab, state);
    }
    return state;
  };

  /**
   * How much the fixed page has to shrink to fit the view's box. The pane
   * letterboxes the box to the viewport's shape, so this is the pane's own fit
   * factor; a parked view is exactly the viewport, so it is 1.
   */
  const agentViewportFit = (box: { width: number; height: number } | null): number => {
    if (!box || !(box.width > 0) || !(box.height > 0)) return 1;
    return clampBuiltInBrowserEmulationViewScale(Math.min(
      1,
      box.width / BUILT_IN_BROWSER_AGENT_VIEWPORT.width,
      box.height / BUILT_IN_BROWSER_AGENT_VIEWPORT.height,
    ));
  };

  /**
   * Bring Chromium in line with `state.target`. Runs on the tab's own queue,
   * and reads the target when it runs rather than when it was queued, so a
   * burst of pane drags or an on/off/on flip lands on the last answer.
   */
  const applyAgentViewport = async (tab: BrowserTabState, state: AgentViewportState): Promise<void> => {
    const target = state.target;
    if (target === state.applied) return;
    const wc = tab.webContents;
    if (wc.isDestroyed()) {
      state.applied = null;
      return;
    }
    if (target == null) {
      state.applied = null;
      if (!tab.debuggerHolds.has("agent-viewport")) return;
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
        deps.releaseDebuggerHold(tab, "agent-viewport");
      }
      return;
    }
    // Chromium reverts an override when the session that set it detaches, so
    // like a preset it owns a debugger hold for as long as it is in force.
    if (!tab.debuggerHolds.has("agent-viewport")) await deps.acquireDebuggerHold(tab, "agent-viewport");
    const { width, height } = BUILT_IN_BROWSER_AGENT_VIEWPORT;
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

  const queueAgentViewport = (tab: BrowserTabState, state: AgentViewportState): void => {
    state.chain = state.chain
      .then(() => applyAgentViewport(tab, state))
      .catch((error: unknown) => {
        // DevTools open, a renderer mid-swap: the tab keeps laying out at its
        // box, which is what it did before this existed. The next change of
        // box or owner tries again.
        deps.logger()?.debug("built_in_browser.agent_viewport_failed", {
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
  const syncAgentViewport = (
    tab: BrowserTabState,
    box?: { width: number; height: number } | null,
  ): void => {
    const state = agentViewportState(tab);
    if (box && box.width > 0 && box.height > 0) state.box = { width: box.width, height: box.height };
    const target = tabUsesAgentViewport(tab) ? agentViewportFit(state.box) : null;
    if (target === state.target) return;
    state.target = target;
    queueAgentViewport(tab, state);
  };

  /**
   * Re-send an override Chromium may have dropped behind our back: a
   * cross-process navigation, or a `setEmulation` clear that swept ours away
   * along with a preset that was never on.
   */
  const refreshAgentViewport = (tab: BrowserTabState): void => {
    const state = agentViewports.get(tab);
    if (!state || state.target == null) return;
    state.applied = null;
    queueAgentViewport(tab, state);
  };

  /**
   * Every tab against its recording state, from `emitStatus` — the one place
   * every recording edge, handoff and DevTools toggle passes through. Costs
   * nothing but a comparison when nothing moved. A tab whose want flipped is
   * placed again: parked, its box is the viewport's size only while it wants
   * the viewport; on screen, its view is letterboxed only while it does.
   */
  const reconcileAgentViewports = (): void => {
    let replace = false;
    for (const tab of deps.tabs()) {
      if (tab.webContents.isDestroyed()) continue;
      const state = agentViewportState(tab);
      const wanted = tabUsesAgentViewport(tab);
      if (wanted !== state.wanted) {
        state.wanted = wanted;
        replace = true;
      }
      syncAgentViewport(tab);
    }
    if (replace) deps.reattachViews();
  };

  /**
   * The scale Chromium is drawing the tab's page at under our override, 1 when
   * none is in force. Synthesized mouse input is read in that drawn space.
   */
  const inputScale = (tab: BrowserTabState): number => agentViewports.get(tab)?.applied ?? 1;

  /** Resolves once the tab's queued override calls have run. */
  const settleAgentViewport = async (tab: BrowserTabState): Promise<void> => {
    await agentViewports.get(tab)?.chain;
  };

  return {
    sync: syncAgentViewport,
    refresh: refreshAgentViewport,
    reconcile: reconcileAgentViewports,
    settle: settleAgentViewport,
    inputScale,
  };
}
