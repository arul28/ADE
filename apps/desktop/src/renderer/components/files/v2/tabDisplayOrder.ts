import type { LaneSummary } from "../../../../shared/types";
import type { EditorTab } from "./editorGroupsStore";

function laneOrderIndex(laneId: string | null, lanes: readonly LaneSummary[]): number {
  if (laneId == null) return -1;
  const idx = lanes.findIndex((lane) => lane.id === laneId);
  return idx >= 0 ? idx : lanes.length;
}

/** Group tabs by lane (stable lane order) while preserving within-lane open order. */
export function orderTabsByLane(tabs: readonly EditorTab[], lanes: readonly LaneSummary[]): EditorTab[] {
  if (tabs.length <= 1) return [...tabs];
  const laneBuckets = new Map<string | null, EditorTab[]>();
  for (const tab of tabs) {
    const bucket = laneBuckets.get(tab.laneId) ?? [];
    bucket.push(tab);
    laneBuckets.set(tab.laneId, bucket);
  }
  const laneKeys = [...laneBuckets.keys()].sort((a, b) => laneOrderIndex(a, lanes) - laneOrderIndex(b, lanes));
  return laneKeys.flatMap((laneId) => laneBuckets.get(laneId) ?? []);
}

export function filterTabsForScope(
  tabs: readonly EditorTab[],
  scope: "all" | "lane",
  currentLaneId: string | null,
  currentWorkspaceId: string,
): EditorTab[] {
  if (scope === "all") return [...tabs];
  return tabs.filter((tab) =>
    currentLaneId != null ? tab.laneId === currentLaneId : tab.workspaceId === currentWorkspaceId,
  );
}

export function isLaneGroupBoundary(tabs: readonly EditorTab[], index: number): boolean {
  if (index <= 0) return false;
  const prev = tabs[index - 1];
  const curr = tabs[index];
  if (!prev || !curr) return false;
  return prev.laneId !== curr.laneId;
}
