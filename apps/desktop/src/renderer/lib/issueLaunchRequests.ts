import type { LaunchIssue } from "./linearBatchLaunch";
import { createPendingRequestChannel } from "./pendingRequestChannel";

export type IssueLaunchRequest = {
  issues: LaunchIssue[];
  laneOnly: boolean;
  /** The Linear quick view returns after a canceled launch request. */
  returnToLinearPane?: boolean;
  onOpenHarnessSettings?: () => void;
};

export type IssueLaunchProgress = {
  total: number;
  completed: number;
  failed: number;
  running: boolean;
};

const channel = createPendingRequestChannel<IssueLaunchRequest>("issue-launch");
const cancellationListeners = new Set<(nonce: string) => void>();
const requestClosedListeners = new Set<(nonce: string) => void>();
const progressListeners = new Set<(progress: IssueLaunchProgress | null) => void>();
let progress: IssueLaunchProgress | null = null;

/** Ask the app-wide issue launcher to configure and start lanes for these issues. */
export function requestIssueLaunch(
  issues: LaunchIssue[],
  options: { laneOnly?: boolean; returnToLinearPane?: boolean; onOpenHarnessSettings?: () => void } = {},
): { nonce: string } | null {
  if (issues.length === 0) return null;
  const request = channel.request({
    issues,
    laneOnly: options.laneOnly === true,
    ...(options.returnToLinearPane ? { returnToLinearPane: true } : {}),
    ...(options.onOpenHarnessSettings ? { onOpenHarnessSettings: options.onOpenHarnessSettings } : {}),
  });
  return { nonce: request.nonce };
}

export const takePendingIssueLaunchRequest = channel.takePending;
export const clearPendingIssueLaunchRequest = channel.clearPending;
export const subscribeIssueLaunchRequests = channel.subscribe;

export function notifyIssueLaunchCancelled(nonce: string): void {
  for (const listener of cancellationListeners) listener(nonce);
}

export function subscribeIssueLaunchCancellations(listener: (nonce: string) => void): () => void {
  cancellationListeners.add(listener);
  return () => cancellationListeners.delete(listener);
}

export function notifyIssueLaunchRequestClosed(nonce: string): void {
  for (const listener of requestClosedListeners) listener(nonce);
}

export function subscribeIssueLaunchRequestClosed(listener: (nonce: string) => void): () => void {
  requestClosedListeners.add(listener);
  return () => requestClosedListeners.delete(listener);
}

export function publishIssueLaunchProgress(next: IssueLaunchProgress | null): void {
  progress = next;
  for (const listener of progressListeners) listener(progress);
}

export function getIssueLaunchProgress(): IssueLaunchProgress | null {
  return progress;
}

export function subscribeIssueLaunchProgress(listener: (progress: IssueLaunchProgress | null) => void): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}
