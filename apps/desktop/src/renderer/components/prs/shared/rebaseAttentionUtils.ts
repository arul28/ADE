import type { AutoRebaseLaneStatus, LaneSummary, RebaseNeed } from "../../../../shared/types";

export type RebaseAttentionState = Exclude<AutoRebaseLaneStatus["state"], "autoRebased">;

export type RebaseAttentionItem = {
  key: string;
  laneId: string;
  laneName: string;
  parentLaneId: string | null;
  parentLaneName: string | null;
  state: RebaseAttentionState;
  updatedAt: string;
  conflictCount: number;
  message: string | null;
  stackDepth: number | null;
  chainTrail: string[];
};

function severity(value: AutoRebaseLaneStatus["state"]): number {
  if (value === "rebaseConflict") return 0;
  if (value === "rebaseFailed") return 1;
  if (value === "rebasePending") return 2;
  return 3;
}

function buildChainTrail(lanes: LaneSummary[], laneId: string): string[] {
  const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));
  const trail: string[] = [];
  const visited = new Set<string>();
  let current = laneById.get(laneId) ?? null;

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    trail.push(current.name);
    if (!current.parentLaneId) break;
    current = laneById.get(current.parentLaneId) ?? null;
  }

  if (!trail.length) return [laneId];
  return trail.reverse();
}

function filterStatuses(
  autoRebaseStatuses: AutoRebaseLaneStatus[],
  visibleRebaseNeeds: RebaseNeed[],
  view: "active" | "history",
): AutoRebaseLaneStatus[] {
  const laneIdsWithVisibleNeeds = new Set(visibleRebaseNeeds.map((need) => need.laneId));
  return autoRebaseStatuses.filter((status) => {
    if (laneIdsWithVisibleNeeds.has(status.laneId)) return false;
    if (view === "active") return status.state !== "autoRebased";
    return status.state === "autoRebased";
  });
}

function isRenderableRebaseAttentionStatus(
  status: AutoRebaseLaneStatus,
): status is AutoRebaseLaneStatus & { state: RebaseAttentionState } {
  return status.state !== "autoRebased";
}

export function filterRebaseAttentionStatuses(args: {
  autoRebaseStatuses: AutoRebaseLaneStatus[];
  visibleRebaseNeeds: RebaseNeed[];
  view: "active" | "history";
}): AutoRebaseLaneStatus[] {
  return filterStatuses(args.autoRebaseStatuses, args.visibleRebaseNeeds, args.view)
    .sort((a, b) => {
      const severityDelta = severity(a.state) - severity(b.state);
      if (severityDelta !== 0) return severityDelta;
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    });
}

export function buildRebaseAttentionItems(args: {
  autoRebaseStatuses: AutoRebaseLaneStatus[];
  lanes: LaneSummary[];
  visibleRebaseNeeds: RebaseNeed[];
  view: "active" | "history";
}): RebaseAttentionItem[] {
  return filterStatuses(args.autoRebaseStatuses, args.visibleRebaseNeeds, args.view)
    .filter(isRenderableRebaseAttentionStatus)
    .map((status) => {
      const lane = args.lanes.find((entry) => entry.id === status.laneId) ?? null;
      const parentLane = status.parentLaneId ? args.lanes.find((entry) => entry.id === status.parentLaneId) ?? null : null;
      return {
        key: status.laneId,
        laneId: status.laneId,
        laneName: lane?.name ?? status.laneId,
        parentLaneId: status.parentLaneId,
        parentLaneName: parentLane?.name ?? status.parentLaneId,
        state: status.state,
        updatedAt: status.updatedAt,
        conflictCount: status.conflictCount,
        message: status.message,
        stackDepth: lane?.stackDepth ?? null,
        chainTrail: buildChainTrail(args.lanes, status.laneId),
      } satisfies RebaseAttentionItem;
    })
    .sort((a, b) => {
      const severityDelta = severity(a.state) - severity(b.state);
      if (severityDelta !== 0) return severityDelta;
      const depthDelta = (b.stackDepth ?? -1) - (a.stackDepth ?? -1);
      if (depthDelta !== 0) return depthDelta;
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    });
}

export function formatRebaseAttentionSummary(item: RebaseAttentionItem): string {
  const parentLabel = item.parentLaneName ?? "its ancestor";
  switch (item.state) {
    case "rebaseConflict":
      return `${item.laneName} hit conflicts while auto-rebasing from ${parentLabel}.`;
    case "rebaseFailed":
      return `Auto-rebase failed for ${item.laneName}; manual follow-up is required.`;
    case "rebasePending":
      return `${item.laneName} is waiting for ${parentLabel} to finish rebasing first.`;
    default:
      return `${item.laneName} has auto-rebase activity.`;
  }
}

export function findRebaseAttentionStatus(
  autoRebaseStatuses: AutoRebaseLaneStatus[],
  selectedItemId: string | null,
): AutoRebaseLaneStatus | null {
  const normalizedId = String(selectedItemId ?? "").trim();
  if (!normalizedId) return null;
  const laneId = normalizedId.startsWith("attention:") ? normalizedId.slice("attention:".length) : normalizedId;
  return autoRebaseStatuses.find((status) => status.laneId === laneId) ?? null;
}
