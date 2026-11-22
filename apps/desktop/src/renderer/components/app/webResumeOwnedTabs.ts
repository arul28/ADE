import type { RemoteOpenProjectBinding } from "../../../shared/types";

/**
 * ADE Web: the copy each ADE Cloud tab had when its computer stopped. Kept by
 * `useWebTabsFollowComputers`.
 */
let stopped: readonly RemoteOpenProjectBinding[] = [];

export function setWebStoppedTabCopies(stoppedCopies: Iterable<RemoteOpenProjectBinding>): void {
  stopped = [...stoppedCopies];
}

/**
 * The copies of tabs whose computer stopped (asleep, or not answering). Home
 * opens one of these for its repository: opening it wakes a sleeping ADE
 * Cloud computer, and the ADE Cloud tab gives way to it once it connects.
 */
export function webStoppedTabCopies(): readonly RemoteOpenProjectBinding[] {
  return stopped;
}
