/**
 * The fixed desktop layout for tabs an agent drives or records.
 *
 * An agent-owned or recording tab lays its page out at
 * `BUILT_IN_BROWSER_AGENT_VIEWPORT` (1280×800) with the same CDP override a
 * device preset uses, scaled to fit the view's box, so a narrow pane no longer
 * lays the page out as a thin strip and a recording is a desktop page.
 * Person-driven tabs, presets, DevTools and handoffs keep laying out at their
 * box.
 */

import type { WebContents } from "electron";
import { BUILT_IN_BROWSER_AGENT_VIEWPORT } from "../../../shared/types/builtInBrowser";
import type { Logger } from "../logging/logger";
import { clampBuiltInBrowserEmulationViewScale } from "./builtInBrowserCapabilities";
import { errorMessage } from "./builtInBrowserConstants";
import type { BrowserDebuggerHoldOwner, BrowserTabState } from "./builtInBrowserService";

/**
 * Whether the tab is laid out at `BUILT_IN_BROWSER_AGENT_VIEWPORT` rather than
 * at its box: an agent owns it, or it is being recorded.
 *
 * A device preset is an explicit ask and wins. DevTools needs the debugger the
 * override holds, and a handoff hands the tab to a person, who gets the page at
 * the size of the pane they are typing into — person-driven tabs keep laying
 * out at their box, as they always have.
 */
export function tabUsesAgentViewport(
  tab: Pick<BrowserTabState, "emulation" | "devToolsMode" | "handoff" | "ownerChatSessionId" | "recording">,
): boolean {
  if (tab.emulation || tab.devToolsMode !== null || tab.handoff) return false;
  return Boolean(tab.ownerChatSessionId) || Boolean(tab.recording);
}

export type BuiltInBrowserAgentViewport = ReturnType<typeof createBuiltInBrowserAgentViewport>;

export function createBuiltInBrowserAgentViewport(deps: {
  tabs: () => Iterable<BrowserTabState>;
  isParked: (tabId: string) => boolean;
  /** Re-places every view; a parked tab's box depends on whether it wants the viewport. */
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
   * Every tab against its owner and recording state, from `emitStatus` — the
   * one place every claim, release, recording edge, handoff and DevTools
   * toggle passes through. Costs nothing but a comparison when nothing moved.
   * A parked tab whose want flipped is re-parked, because its park box is the
   * viewport's size only while it wants the viewport.
   */
  const reconcileAgentViewports = (): void => {
    let repark = false;
    for (const tab of deps.tabs()) {
      if (tab.webContents.isDestroyed()) continue;
      const state = agentViewportState(tab);
      const wanted = tabUsesAgentViewport(tab);
      if (wanted !== state.wanted) {
        state.wanted = wanted;
        if (deps.isParked(tab.id)) repark = true;
      }
      syncAgentViewport(tab);
    }
    if (repark) deps.reattachViews();
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
