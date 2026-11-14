/**
 * ADE Web: the waiting tabs that `useWebTabsFollowComputers` opens again
 * itself when their computer is back, and the ones whose open runs now. The
 * waiting page (`ProjectWelcomeNoMachine`) leaves those to it, so one copy
 * gets one open: two opens of one project cancel each other's reads.
 */
let owned: ReadonlySet<string> = new Set();

export function setWebResumeOwnedTabs(ids: Iterable<string>): void {
  owned = new Set(ids);
}

export function isWebResumeOwnedTab(id: string): boolean {
  return owned.has(id);
}
