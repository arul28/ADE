import type { LaneLinearIssue, NormalizedLinearIssue } from "../../shared/types";
import { createPendingRequestChannel } from "./pendingRequestChannel";

/**
 * "Start a lane (and maybe an agent) for these Linear issues."
 *
 * The launch flow — the per-issue model picker, the bounded-parallel create
 * lane → session → kickoff run, and its status toast — has one owner: the
 * top-bar Linear host (`LinearQuickViewButton`). The issue viewer in the Work
 * tools pane and in the issue sheet asks for a launch through this channel
 * instead of carrying a second copy of that machinery.
 */
export type LinearLaunchRequest = {
  issues: Array<NormalizedLinearIssue | LaneLinearIssue>;
  laneOnly: boolean;
};

const channel = createPendingRequestChannel<LinearLaunchRequest>("linear-launch");

export function requestLinearIssueLaunch(request: LinearLaunchRequest): void {
  if (request.issues.length === 0) return;
  channel.request(request);
}

export const subscribeLinearLaunchRequests = channel.subscribe;
export const takePendingLinearLaunchRequest = channel.takePending;
export const clearPendingLinearLaunchRequest = channel.clearPending;
