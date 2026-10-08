import type { IssueRef } from "../../shared/issueRefs";
import { createPendingRequestChannel } from "./pendingRequestChannel";

/**
 * "Show me this issue" — one entry point for every surface in the app.
 *
 * The rule is: open it where you are. A page that has the Work tools pane on
 * screen shows the issue as a tab in that pane, next to the conversation it
 * came from. Every other page (Lanes, PRs, the command palette, a deeplink)
 * opens the same viewer in a sheet that floats over the page. Neither path
 * navigates away from what you were doing.
 *
 * Which of the two applies is decided by registration rather than by reading
 * the route: the Work page registers itself as the in-place host while it is
 * the active page, and the router differs between the desktop (hash) and the
 * web client (history), so a URL check here would be guessing.
 */

export type IssueOpenSource =
  | "chat-link"
  | "chip"
  | "session-card"
  | "lane"
  | "palette"
  | "deeplink"
  | "pr"
  | "issue-viewer";

export type IssueOpenRequest = {
  ref: IssueRef;
  /** The lane the click belongs to, when the surface knows it. */
  laneId?: string | null;
  /** A branch hint carried by `ade://linear-issue/<id>?branch=…` deeplinks. */
  branch?: string | null;
  source?: IssueOpenSource;
};

const toolChannel = createPendingRequestChannel<IssueOpenRequest>("issue-tool");
const sheetChannel = createPendingRequestChannel<IssueOpenRequest>("issue-sheet");

const inPlaceHosts = new Set<symbol>();

/**
 * Called by the Work page while it is the active page. Returns the release
 * function; a page that is kept warm in the background must release, or a click
 * on the Lanes page would open a tab in a pane nobody can see.
 */
export function registerIssueInPlaceHost(): () => void {
  const token = Symbol("issue-in-place-host");
  inPlaceHosts.add(token);
  return () => {
    inPlaceHosts.delete(token);
  };
}

export function hasIssueInPlaceHost(): boolean {
  return inPlaceHosts.size > 0;
}

/**
 * Open an issue where the user is. Every `IssueRef` provider has a native
 * viewer, so this always handles the request; the result keeps callers' URL
 * fallback in place for a provider added without one.
 */
export function openIssueRef(request: IssueOpenRequest): boolean {
  if (hasIssueInPlaceHost()) toolChannel.request(request);
  else sheetChannel.request(request);
  return true;
}

/** Always the sheet, whatever page is active (the pane's own "pop out"). */
export function openIssueInSheet(request: IssueOpenRequest): boolean {
  sheetChannel.request(request);
  return true;
}

export const subscribeIssueToolRequests = toolChannel.subscribe;
export const takePendingIssueToolRequest = toolChannel.takePending;
export const clearPendingIssueToolRequest = toolChannel.clearPending;

export const subscribeIssueSheetRequests = sheetChannel.subscribe;
export const takePendingIssueSheetRequest = sheetChannel.takePending;
export const clearPendingIssueSheetRequest = sheetChannel.clearPending;
