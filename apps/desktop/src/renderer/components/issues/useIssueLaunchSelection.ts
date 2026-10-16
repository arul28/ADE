import { useCallback, useEffect, useRef, useState } from "react";
import type { LaunchIssue } from "../../lib/linearBatchLaunch";
import { requestIssueLaunch } from "../../lib/issueLaunchRequests";

type IssueKey = string | number;

/** Shared multi-select, range selection, Escape, and launch behavior for tracker lists. */
export function useIssueLaunchSelection<T, K extends IssueKey>({
  visibleItems,
  launchItems,
  getKey,
  toLaunchIssue,
  canSelect = () => true,
}: {
  visibleItems: readonly T[];
  launchItems: readonly T[];
  getKey: (item: T) => K;
  toLaunchIssue: (item: T) => LaunchIssue | null;
  /** Tracker-specific exclusion rules stay with the list that owns them. */
  canSelect?: (item: T) => boolean;
}) {
  const [selectedKeys, setSelectedKeys] = useState<Set<K>>(() => new Set());
  const anchorRef = useRef<K | null>(null);

  const clear = useCallback(() => {
    setSelectedKeys(new Set());
    anchorRef.current = null;
  }, []);

  useEffect(() => {
    if (selectedKeys.size === 0) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") clear();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clear, selectedKeys.size]);

  const toggleAt = useCallback((key: K, index: number, shiftKey: boolean) => {
    if (!canSelect(visibleItems[index]!)) return;
    setSelectedKeys((current) => {
      const next = new Set(current);
      const anchorIndex = visibleItems.findIndex((item) => getKey(item) === anchorRef.current);
      if (shiftKey && anchorIndex >= 0) {
        const [start, end] = [Math.min(anchorIndex, index), Math.max(anchorIndex, index)];
        for (const item of visibleItems.slice(start, end + 1)) {
          if (canSelect(item)) next.add(getKey(item));
        }
      } else if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      anchorRef.current = key;
      return next;
    });
  }, [canSelect, getKey, visibleItems]);

  const launchSelectedIssues = useCallback((laneOnly: boolean) => {
    const launchIssues = launchItems
      .filter((item) => selectedKeys.has(getKey(item)) && canSelect(item))
      .map(toLaunchIssue)
      .filter((issue): issue is LaunchIssue => issue !== null);
    requestIssueLaunch(launchIssues, { laneOnly });
    clear();
  }, [canSelect, clear, getKey, launchItems, selectedKeys, toLaunchIssue]);

  return {
    selectedKeys,
    selectedCount: selectedKeys.size,
    isSelected: (key: K) => selectedKeys.has(key),
    toggleAt,
    launchSelectedIssues,
  };
}
