/**
 * `workTools.openBrowserTab`: the phone opens one of a lane's dev servers in
 * the person's desktop browser, to watch it from the phone.
 *
 * Only a page this lane serves on this machine's loopback may open, so a phone
 * cannot point the person's signed-in browser at an arbitrary site or at
 * another lane's server. A server the lane already shows is reused.
 */

import { BUILT_IN_BROWSER_NO_PROJECT_WINDOW_MESSAGE } from "../../../../desktop/src/shared/types/builtInBrowser";
import type { BuiltInBrowserCreateTabArgs } from "../../../../desktop/src/shared/types/builtInBrowser";
import { isBuiltInBrowserForwardedToDesktop } from "../../../../desktop/src/shared/types/builtInBrowserRemote";
import { parseLoopbackUrl } from "../../../../desktop/src/shared/remoteLoopbackUrl";
import { DesktopBridgeUnavailableError } from "../builtInBrowser/desktopBridgeClient";
import type { WorkToolsStateService } from "../workTools/workToolsStateService";

/** The browser call this needs: open a tab, as the person would. */
export type WorkToolsBrowserTabOpener = {
  createTab(input: BuiltInBrowserCreateTabArgs & {
    /**
     * Routing only, read by the remote-browser forwarder: when this machine
     * has no desktop and the page goes to one elsewhere, that desktop brings
     * its Browser pane up for it (it takes a quiet open only into a pane
     * already showing).
     */
    revealWhenForwarded?: boolean;
  }): Promise<unknown>;
};

/** What `workTools.openBrowserTab` answers. */
export type WorkToolsOpenBrowserTabResult = {
  ok: true;
  /** The tab to watch. Null when a desktop on another machine opened the page. */
  tabId: string | null;
  /** The lane already had a tab on this server. */
  reused: boolean;
  /** The desktop on another machine that opened it, when it was not this one. */
  openedOn?: string | null;
  /** That desktop asks its person to allow the tunnel before the page loads. */
  awaitingApproval?: boolean;
};

const NO_DESKTOP_FOR_PAGE_MESSAGE =
  "No ADE desktop is open to show this page. Open ADE on a computer, or use the lane's Linux Desktop.";

const NOT_A_LANE_PAGE_MESSAGE = "ADE only opens a lane's own dev servers from the phone";

/**
 * The loopback URL a phone may ask for, with its port: http(s) on this
 * machine's loopback and no sign-in in it. Whether the lane serves the port
 * is checked after.
 */
function loopbackPageUrl(raw: string): { url: URL; port: number } {
  try {
    new URL(raw.trim());
  } catch {
    throw new Error("That isn't a web address ADE can open.");
  }
  const parsed = parseLoopbackUrl(raw);
  if (!parsed) throw new Error(`${NOT_A_LANE_PAGE_MESSAGE}, on localhost.`);
  if (parsed.url.username || parsed.url.password) {
    throw new Error(`${NOT_A_LANE_PAGE_MESSAGE}, and this address carries a sign-in.`);
  }
  return parsed;
}

/** Read the bridge's answer: this machine's tab, or a desktop elsewhere that took the page. */
function openBrowserTabResult(opened: unknown): WorkToolsOpenBrowserTabResult {
  if (isBuiltInBrowserForwardedToDesktop(opened)) {
    // No desktop here: the page went to one that holds this lane on another
    // machine, which tunnels the port. Nobody took it, so nothing opened.
    if (!opened.acknowledged) throw new Error(NO_DESKTOP_FOR_PAGE_MESSAGE);
    return {
      ok: true,
      tabId: null,
      reused: false,
      openedOn: typeof opened.desktopLabel === "string" && opened.desktopLabel.trim() ? opened.desktopLabel.trim() : null,
      ...(opened.awaitingApproval === true ? { awaitingApproval: true } : {}),
    };
  }
  const record = opened && typeof opened === "object" ? opened as Record<string, unknown> : {};
  const tabId = typeof record.targetTabId === "string" && record.targetTabId.trim() ? record.targetTabId.trim() : null;
  if (!tabId) throw new Error("The browser didn't say which tab it opened. Pull to refresh to find it.");
  return { ok: true, tabId, reused: false };
}

export async function openLaneDevServerInBrowser(input: {
  laneId: string;
  rawUrl: string;
  workTools: Pick<WorkToolsStateService, "getLaneState" | "listDevServers">;
  browser: WorkToolsBrowserTabOpener | null | undefined;
}): Promise<WorkToolsOpenBrowserTabResult> {
  const { laneId, workTools, browser } = input;
  if (!browser) throw new Error("The browser isn't available on this machine.");
  const { url, port } = loopbackPageUrl(input.rawUrl);
  // The lane state has the tabs to reuse and the servers already known; a
  // fresh scan only when the port is not among them (a server just started).
  const state = await workTools.getLaneState({ laneId });
  const servesPort = state.devServers?.some((server) => server.port === port) === true
    || (await workTools.listDevServers({ laneId })).servers.some((server) => server.port === port);
  if (!servesPort) {
    throw new Error(`Nothing in this lane is serving port ${port}. Start the dev server, then try again.`);
  }
  // The page is already up in this lane: watch that tab rather than open a
  // second copy of the same server.
  const existing = state.browser?.tabs.find((tab) => tab.url && parseLoopbackUrl(tab.url)?.port === port);
  if (existing) return { ok: true, tabId: existing.id, reused: true };
  let opened: unknown;
  try {
    // A background tab, grouped with the lane but owned by nobody: this is the
    // person opening it, not an agent, so no lease and no consent gate, and
    // the desktop user keeps the tab they are looking at.
    opened = await browser.createTab({
      url: url.toString(),
      groupLaneId: laneId,
      activate: false,
      openPanel: false,
      revealWhenForwarded: true,
    });
  } catch (error) {
    if (error instanceof DesktopBridgeUnavailableError) throw new Error(NO_DESKTOP_FOR_PAGE_MESSAGE);
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(BUILT_IN_BROWSER_NO_PROJECT_WINDOW_MESSAGE)) {
      throw new Error("ADE on this computer doesn't have this project open, so it can't show the page. Open the project in ADE first.");
    }
    throw error;
  }
  return openBrowserTabResult(opened);
}
