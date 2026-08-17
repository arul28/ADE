import type { OpenProjectBinding } from "../../../../shared/types/core";

/**
 * "Open this path in the Work tab's Files panel" — a one-shot request channel.
 *
 * A filename clicked in a chat should open next to the conversation, not throw
 * the user into the Files tab. The chat surface and the embedded workbench sit
 * on opposite sides of the Work tree with no shared ancestor that owns files
 * state, so the request travels through a module channel rather than a prop
 * threaded through every layer between them. Same idiom as `pendingReveals`
 * and `pendingSessionAnchors`.
 *
 * Only the EMBEDDED (tools-pane) workbench listens here. A file that belongs to
 * another lane or another machine goes to the full Files tab instead, and that
 * still travels as router state so the destination stays deep-linkable.
 */

export type FilesOpenRequest = {
  /** Workspace-relative, forward-slash path. */
  path: string;
  /** Lane that owns the workspace, or null for the tab's default workspace. */
  laneId: string | null;
  /**
   * Machine that owns the file. Null means "the machine this project tab is
   * bound to", which is the only case the tools pane can serve today — a
   * foreign file is routed to the Files tab instead. Carried anyway so the
   * consumer never has to re-derive it.
   */
  pin: OpenProjectBinding | null;
  /** Directories reveal in the tree; files open in an editor tab. */
  pathType: "file" | "directory";
  line?: number;
  column?: number;
  /**
   * Distinguishes two requests for the same path so clicking the same filename
   * twice re-opens it, rather than being swallowed as a duplicate.
   */
  nonce: string;
};

type Listener = (request: FilesOpenRequest) => void;

const listeners = new Set<Listener>();

/**
 * Held for the gap between the request and the panel mounting: clicking a
 * filename also switches the Work sidebar to Files, and the workbench does not
 * exist yet at that moment. The consumer drains this on mount.
 */
let pendingRequest: FilesOpenRequest | null = null;

let nonceCounter = 0;

export function nextFilesOpenNonce(): string {
  nonceCounter += 1;
  return `files-open-${nonceCounter}`;
}

export function requestFilesOpenInTools(request: FilesOpenRequest): void {
  pendingRequest = request;
  for (const listener of listeners) listener(request);
}

/**
 * Called by a live consumer that has taken ownership of a broadcast request, so
 * the hold does not survive it. Without this, a request delivered to a mounted
 * panel stayed queued forever and the NEXT embedded workbench to mount — after
 * a lane switch, a project switch, or the sidebar tab being reopened — drained
 * it and re-opened a file the user had not asked for. `listeners.size` cannot
 * stand in for this: the Work page subscribes for the whole session just to
 * reveal the panel, so there is always at least one listener.
 */
export function clearPendingFilesOpenRequest(): void {
  pendingRequest = null;
}

/**
 * Consume whatever was requested before the panel mounted. Returns null when
 * there is nothing waiting, so a normal mount costs nothing.
 */
export function takePendingFilesOpenRequest(): FilesOpenRequest | null {
  const request = pendingRequest;
  pendingRequest = null;
  return request;
}

export function subscribeFilesOpenInTools(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: drops queued state so one test cannot leak into the next. */
export function resetFilesOpenRequestsForTests(): void {
  listeners.clear();
  pendingRequest = null;
  nonceCounter = 0;
}
