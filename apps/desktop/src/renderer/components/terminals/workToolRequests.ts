import type { WorkSidebarTab } from "../../state/appStore";

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
 * handler navigated to /work) drains the held request on mount. Same idiom as
 * `filesOpenRequests`.
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

type Listener = (request: WorkToolRequest) => void;

const listeners = new Set<Listener>();

let pendingRequest: WorkToolRequest | null = null;
let nonceCounter = 0;

export function requestWorkTool(tool: WorkSidebarTab | null): void {
  nonceCounter += 1;
  const request: WorkToolRequest = { tool, nonce: `work-tool-${nonceCounter}` };
  pendingRequest = request;
  for (const listener of listeners) listener(request);
}

/**
 * Consume whatever was requested before the Work page mounted. Returns null
 * when nothing is waiting, so a normal mount costs nothing.
 */
export function takePendingWorkToolRequest(): WorkToolRequest | null {
  const request = pendingRequest;
  pendingRequest = null;
  return request;
}

/**
 * Called by a live consumer that has already handled a broadcast request, so
 * the hold does not survive it and the next Work page to mount does not reopen
 * a tool nobody asked for.
 */
export function clearPendingWorkToolRequest(): void {
  pendingRequest = null;
}

export function subscribeWorkToolRequests(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: drops queued state so one test cannot leak into the next. */
export function resetWorkToolRequestsForTests(): void {
  listeners.clear();
  pendingRequest = null;
  nonceCounter = 0;
}
