import type { LaneSummary } from "../../../desktop/src/shared/types/lanes";

/**
 * Sort lanes into a stack-graph DFS order (mirrors the desktop
 * `sortLanesForStackGraph` in apps/desktop/src/renderer/components/lanes/laneUtils.ts).
 * Primary lane is the root; lanes with a parent are placed under their parent;
 * orphans hang off primary. Within each parent's children we sort by createdAt asc
 * with a name tiebreak.
 */
export function sortLanesForStackGraph(lanes: LaneSummary[]): LaneSummary[] {
  const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));
  const childrenByParent = new Map<string, LaneSummary[]>();
  const roots: LaneSummary[] = [];
  const primary = lanes.find((lane) => lane.laneType === "primary") ?? null;
  const primaryId = primary?.id ?? null;

  for (const lane of lanes) {
    if (lane.laneType === "primary") {
      roots.push(lane);
      continue;
    }
    const effectiveParentId =
      lane.parentLaneId && laneById.has(lane.parentLaneId) ? lane.parentLaneId : primaryId;
    if (!effectiveParentId || effectiveParentId === lane.id) {
      roots.push(lane);
      continue;
    }
    const children = childrenByParent.get(effectiveParentId) ?? [];
    children.push(lane);
    childrenByParent.set(effectiveParentId, children);
  }

  const byCreatedAsc = (a: LaneSummary, b: LaneSummary) => {
    const aTs = Date.parse(a.createdAt);
    const bTs = Date.parse(b.createdAt);
    if (!Number.isNaN(aTs) && !Number.isNaN(bTs) && aTs !== bTs) return aTs - bTs;
    return a.name.localeCompare(b.name);
  };
  roots.sort((a, b) => {
    const aPrimary = a.laneType === "primary" ? 1 : 0;
    const bPrimary = b.laneType === "primary" ? 1 : 0;
    if (aPrimary !== bPrimary) return bPrimary - aPrimary;
    return byCreatedAsc(a, b);
  });
  for (const [, children] of childrenByParent.entries()) {
    children.sort(byCreatedAsc);
  }

  const out: LaneSummary[] = [];
  const visit = (lane: LaneSummary) => {
    out.push(lane);
    for (const child of childrenByParent.get(lane.id) ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  const seen = new Set(out.map((lane) => lane.id));
  return out.concat(lanes.filter((lane) => !seen.has(lane.id)).sort(byCreatedAsc));
}
