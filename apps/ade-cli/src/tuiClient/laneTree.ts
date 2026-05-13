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

/**
 * Compute the ASCII tree prefix shown to the left of a lane row in the stack
 * graph. The wireframe uses `├─`, `└─`, `│  ├─`, `│  └─` etc.
 *
 * `depth` is the lane's stackDepth (0 for roots). `isLast` indicates whether
 * the lane is the last sibling of its parent (so we should draw `└─` instead
 * of `├─`). Ancestors are rendered with `│  ` for non-last ancestors and `   `
 * for last ancestors — but ade rows don't track per-ancestor lastness, so we
 * approximate with `│  ` repeated for ancestors. The visual fidelity at
 * depth>2 is good enough for the TUI.
 */
export function stackPrefix(depth: number, isLast: boolean): string {
  if (depth <= 0) return "";
  let prefix = "";
  for (let i = 0; i < depth - 1; i += 1) prefix += "│  ";
  prefix += isLast ? "└─ " : "├─ ";
  return prefix;
}

/**
 * Stack tree row metadata for an ordered list of lanes returned by
 * `sortLanesForStackGraph`. For each lane, computes whether it's the last
 * sibling of its (effective) parent given the order — used to decide between
 * `├─` and `└─` glyphs.
 */
export function computeStackRowMeta(
  lanes: LaneSummary[],
): Array<{ depth: number; isLast: boolean; prefix: string }> {
  const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));
  const primaryId = lanes.find((l) => l.laneType === "primary")?.id ?? null;
  const effectiveParent = (lane: LaneSummary): string | null => {
    if (lane.laneType === "primary") return null;
    const pid = lane.parentLaneId && laneById.has(lane.parentLaneId) ? lane.parentLaneId : primaryId;
    if (!pid || pid === lane.id) return null;
    return pid;
  };
  // group lanes by parent in order to detect last-sibling
  const byParent = new Map<string | null, LaneSummary[]>();
  for (const lane of lanes) {
    const p = effectiveParent(lane);
    const arr = byParent.get(p) ?? [];
    arr.push(lane);
    byParent.set(p, arr);
  }
  const lastSiblingId = new Set<string>();
  for (const [, group] of byParent) {
    if (group.length > 0) lastSiblingId.add(group[group.length - 1].id);
  }
  return lanes.map((lane) => {
    const depth = lane.laneType === "primary" ? 0 : Math.max(0, lane.stackDepth || 0);
    const isLast = lastSiblingId.has(lane.id);
    return { depth, isLast, prefix: stackPrefix(depth, isLast) };
  });
}
