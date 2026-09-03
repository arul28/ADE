/**
 * The graph, on a phone sheet: a list, not a canvas.
 *
 * A pan-and-zoom diagram on a 390px sheet is a diagram nobody can read, and
 * React Flow on a phone costs a WebGL-free canvas, a resize observer and a
 * gesture layer to draw something the reader will immediately pinch away from.
 * So the same data draws as the thing a phone is good at: a list, in stack
 * order, with the hierarchy shown by indent.
 *
 * It is the SAME BUNDLE and the same code path — the entry picks this subtree
 * instead of the canvas, and no React Flow component is mounted on this route.
 * The rows are the lane rows the canvas draws as cards: name, branch, the
 * conflict status, the sync verdict and the PR badge, in the same words.
 */

import React from "react";
import { CaretRight } from "@phosphor-icons/react";
import { Chip, EmptyState, cn } from "@ade-dev/ui";

import type { AutoRebaseLaneStatus, ConflictStatus, GitUpstreamSyncStatus, LaneSummary } from "../lib/types";
import type { GraphPrOverlay } from "../lib/graphTypes";
import { laneHierarchyFromPrimary } from "../lib/graphLayout";
import { toRelativeTime } from "../lib/graphHelpers";

export type PhoneLaneRow = {
  lane: LaneSummary;
  depth: number;
  status: ConflictStatus["status"] | "unknown";
  remoteSync: GitUpstreamSyncStatus | null;
  autoRebase: AutoRebaseLaneStatus | null;
  pr: GraphPrOverlay | null;
  lastActivityAt: string | null;
};

/** The card's sync ladder, in one place so the list and the card cannot drift. */
export function syncLabel(
  remoteSync: GitUpstreamSyncStatus | null,
  autoRebase: AutoRebaseLaneStatus | null,
  lane: LaneSummary,
  status: ConflictStatus["status"] | "unknown",
): { label: string; className: string } {
  if (remoteSync?.diverged) return { label: "Diverged", className: "text-red-300" };
  if (remoteSync?.upstreamState === "missing") return { label: "Remote missing", className: "text-amber-300" };
  if (autoRebase?.state === "rebaseConflict") return { label: "Rebase conflict", className: "text-red-300" };
  if (autoRebase?.state === "rebaseFailed") return { label: "Rebase failed", className: "text-red-300" };
  if (autoRebase?.state === "rebasePending") return { label: "Rebase pending", className: "text-amber-300" };
  if (remoteSync && (remoteSync.hasUpstream === false || remoteSync.ahead > 0)) {
    return {
      label: remoteSync.hasUpstream === false ? "Publish lane" : "Needs push",
      className: "text-emerald-300",
    };
  }
  if (remoteSync?.hasUpstream && remoteSync.recommendedAction === "pull") {
    return { label: "Needs pull", className: "text-sky-300" };
  }
  if (lane.status.behind > 0 || status === "behind-base") return { label: "Behind base", className: "text-amber-300" };
  if (autoRebase?.state === "autoRebased") return { label: "Auto-rebased", className: "text-emerald-300" };
  return { label: "In sync", className: "text-muted-fg" };
}

/**
 * Order the rows the way the canvas stacks them: primary first, then each lane
 * under its parent. `laneHierarchyFromPrimary` is the same depth map the layout
 * uses, so the indent on the phone and the row on the canvas agree by
 * construction rather than by two implementations that happen to match.
 */
export function buildPhoneRows(
  lanes: LaneSummary[],
  read: (lane: LaneSummary) => Omit<PhoneLaneRow, "lane" | "depth">,
): PhoneLaneRow[] {
  const { depthByLaneId } = laneHierarchyFromPrimary(lanes);
  const childrenByParent = new Map<string, LaneSummary[]>();
  const roots: LaneSummary[] = [];
  for (const lane of lanes) {
    const parentId = lane.parentLaneId;
    if (parentId && lanes.some((candidate) => candidate.id === parentId)) {
      const list = childrenByParent.get(parentId) ?? [];
      list.push(lane);
      childrenByParent.set(parentId, list);
    } else {
      roots.push(lane);
    }
  }
  const byDepthThenName = (a: LaneSummary, b: LaneSummary) =>
    (depthByLaneId.get(a.id) ?? 10_000) - (depthByLaneId.get(b.id) ?? 10_000)
    || a.name.localeCompare(b.name);

  const rows: PhoneLaneRow[] = [];
  const seen = new Set<string>();
  const walk = (lane: LaneSummary, depth: number): void => {
    if (seen.has(lane.id)) return;
    seen.add(lane.id);
    rows.push({ lane, depth, ...read(lane) });
    for (const child of (childrenByParent.get(lane.id) ?? []).slice().sort(byDepthThenName)) {
      walk(child, depth + 1);
    }
  };
  for (const root of roots.slice().sort(byDepthThenName)) walk(root, 0);
  // A cycle in the parent chain would leave lanes unvisited. They are still the
  // reader's lanes, so they land at the end rather than disappearing.
  for (const lane of lanes) if (!seen.has(lane.id)) walk(lane, 0);
  return rows;
}

export function LanePhoneList({
  rows,
  onOpenLane,
}: {
  rows: PhoneLaneRow[];
  onOpenLane: (laneId: string) => void;
}): React.ReactElement {
  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState title="No lanes yet" description="Create lanes to see your workspace graph." />
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-bg" data-ade-graph-view="phone-list">
      <ul className="divide-y divide-white/[0.05]">
        {rows.map((row) => {
          const sync = syncLabel(row.remoteSync, row.autoRebase, row.lane, row.status);
          return (
            <li key={row.lane.id}>
              <button
                type="button"
                data-lane-id={row.lane.id}
                data-lane-depth={row.depth}
                className="flex w-full items-center gap-2 px-3 py-3 text-left active:bg-white/[0.04]"
                style={{ paddingLeft: 12 + Math.min(row.depth, 6) * 14 }}
                onClick={() => onOpenLane(row.lane.id)}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {row.depth > 0 ? (
                      <CaretRight size={11} weight="bold" className="shrink-0 text-muted-fg/70" />
                    ) : null}
                    <span className="truncate text-sm font-semibold text-fg">{row.lane.name}</span>
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-muted-fg">{row.lane.branchRef}</div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    <Chip
                      className={cn(
                        "px-1.5 py-0 text-[10px]",
                        row.lane.status.dirty ? "text-amber-200" : "text-emerald-200",
                      )}
                    >
                      {row.lane.status.dirty ? "Dirty" : "Clean"}
                    </Chip>
                    <Chip className={cn("px-1.5 py-0 text-[10px]", sync.className)}>{sync.label}</Chip>
                    {row.pr ? (
                      <Chip className="px-1.5 py-0 text-[10px] text-sky-300" title={row.pr.title}>
                        PR #{row.pr.number}
                      </Chip>
                    ) : null}
                  </div>
                  <div className="mt-1 text-[10px] text-muted-fg">{toRelativeTime(row.lastActivityAt)}</div>
                </div>
                <CaretRight size={14} weight="bold" className="shrink-0 text-muted-fg/60" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
