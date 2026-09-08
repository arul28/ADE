import type { OpenProjectBinding } from "../../../../shared/types/core";
import { createPendingRequestChannel } from "../../../lib/pendingRequestChannel";

/**
 * "Open this path in the Work tab's Files panel" — a one-shot request channel.
 *
 * A filename clicked in a chat should open next to the conversation, not throw
 * the user into the Files tab. The chat surface and the embedded workbench sit
 * on opposite sides of the Work tree with no shared ancestor that owns files
 * state, so the request travels through a module channel rather than a prop
 * threaded through every layer between them. The mechanics are
 * `createPendingRequestChannel`; only the payload is this module's.
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

const channel = createPendingRequestChannel<FilesOpenRequest>("files-open");

/**
 * Callers here assemble the whole request (path, lane, pin, position) before
 * sending it, so the nonce is minted separately rather than by `request`.
 */
export const nextFilesOpenNonce = channel.nextNonce;

export function requestFilesOpenInTools(request: FilesOpenRequest): void {
  channel.request(request);
}

/**
 * Called by a live consumer that has taken ownership of a broadcast request, so
 * the hold does not survive it. Without this, a request delivered to a mounted
 * panel stayed queued forever and the NEXT embedded workbench to mount — after
 * a lane switch, a project switch, or the sidebar tab being reopened — drained
 * it and re-opened a file the user had not asked for. Listener count cannot
 * stand in for this: the Work page subscribes for the whole session just to
 * reveal the panel, so there is always at least one listener.
 */
export const clearPendingFilesOpenRequest = channel.clearPending;

/**
 * Consume whatever was requested before the panel mounted. Returns null when
 * there is nothing waiting, so a normal mount costs nothing.
 */
export const takePendingFilesOpenRequest = channel.takePending;

export const subscribeFilesOpenInTools = channel.subscribe;

/** Test seam: drops queued state so one test cannot leak into the next. */
export const resetFilesOpenRequestsForTests = channel.resetForTests;
