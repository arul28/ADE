import type { WorkSidebarTab } from "../../state/appStore";
import { createPendingRequestChannel } from "../../lib/pendingRequestChannel";

/**
 * "Open this tool in the Work tools pane" — a one-shot request channel.
 *
 * The active tool is stored per LANE, and only the Work page knows which lane
 * the pane is currently following (it blends the focused session's lane, the
 * draft lane, and the selection). Surfaces outside that page — the app shell's
 * `builtInBrowser` open-request handler, the command palette — therefore cannot
 * write the state themselves without guessing the scope.
 *
 * They ask instead. A live Work page answers immediately; a Work page that has
 * not mounted yet (the request arrived while another tab was open, and the
 * handler navigated to /work) drains the held request on mount. The mechanics
 * are `createPendingRequestChannel`; only the payload is this module's.
 */
export type WorkToolRequest = {
  /** The tool to open, or null to return the pane to its picker page. */
  tool: WorkSidebarTab | null;
  /**
   * Distinguishes two requests for the same tool, so asking twice re-opens it
   * rather than being swallowed as a duplicate.
   */
  nonce: string;
};

const channel = createPendingRequestChannel<{ tool: WorkSidebarTab | null }>("work-tool");

export function requestWorkTool(tool: WorkSidebarTab | null): void {
  channel.request({ tool });
}

/**
 * Consume whatever was requested before the Work page mounted. Returns null
 * when nothing is waiting, so a normal mount costs nothing.
 */
export const takePendingWorkToolRequest = channel.takePending;

/**
 * Called by a live consumer that has already handled a broadcast request, so
 * the hold does not survive it and the next Work page to mount does not reopen
 * a tool nobody asked for.
 */
export const clearPendingWorkToolRequest = channel.clearPending;

export const subscribeWorkToolRequests = channel.subscribe;

/** Test seam: drops queued state so one test cannot leak into the next. */
export const resetWorkToolRequestsForTests = channel.resetForTests;
