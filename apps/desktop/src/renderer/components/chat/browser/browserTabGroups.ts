/**
 * Lane groups for the shared project browser.
 *
 * Tab order inside a group is the order the tabs were opened. Groups themselves
 * sort with the lane you are in first, then every other lane in the order its
 * first tab appeared, then tabs that belong to no lane.
 */
export type BrowserTabGroupFields = {
  groupLaneId?: string | null;
  ownerLaneId?: string | null;
};

export function browserTabGroupKey(tab: BrowserTabGroupFields): string | null {
  return tab.groupLaneId || tab.ownerLaneId || null;
}

export function orderBrowserTabsByLane<T extends BrowserTabGroupFields>(
  tabs: readonly T[],
  currentLaneId: string | null,
): T[] {
  const firstSeen = new Map<string, number>();
  tabs.forEach((tab, index) => {
    const key = browserTabGroupKey(tab) ?? "";
    if (!firstSeen.has(key)) firstSeen.set(key, index);
  });
  const rank = (key: string | null): number => {
    if (currentLaneId && key === currentLaneId) return 0;
    if (key) return 1;
    return 2;
  };
  return tabs
    .map((tab, index) => ({ tab, index }))
    .sort((left, right) => {
      const leftKey = browserTabGroupKey(left.tab);
      const rightKey = browserTabGroupKey(right.tab);
      const rankDiff = rank(leftKey) - rank(rightKey);
      if (rankDiff !== 0) return rankDiff;
      if (leftKey !== rightKey) {
        return (firstSeen.get(leftKey ?? "") ?? 0) - (firstSeen.get(rightKey ?? "") ?? 0);
      }
      return left.index - right.index;
    })
    .map((entry) => entry.tab);
}
