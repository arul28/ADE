import type { RemoteOpenProjectBinding } from "../../../shared/types";

/**
 * ADE Web: the waiting tabs that `useWebTabsFollowComputers` opens again
 * itself when their computer is back, and the ones whose open runs now. The
 * waiting page (`ProjectWelcomeNoMachine`) leaves those to it, so one copy
 * gets one open: two opens of one project cancel each other's reads.
 */
let owned: ReadonlySet<string> = new Set();
/** The copy each waiting tab had when its computer stopped. */
let stopped: readonly RemoteOpenProjectBinding[] = [];

export function setWebResumeOwnedTabs(ids: Iterable<string>, stoppedCopies: Iterable<RemoteOpenProjectBinding> = []): void {
  owned = new Set(ids);
  stopped = [...stoppedCopies];
}

export function isWebResumeOwnedTab(id: string): boolean {
  return owned.has(id);
}

/**
 * The copies of tabs whose computer stopped (asleep, or not answering). Home
 * opens one of these for its repository: opening it wakes a sleeping ADE
 * Cloud computer, and the waiting tab gives way to it once it connects.
 */
export function webStoppedTabCopies(): readonly RemoteOpenProjectBinding[] {
  return stopped;
}
