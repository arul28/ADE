/**
 * Lane ordering for the Work sidebar's by-lane list.
 *
 * Deliberately separate from `sortLanesForTabs` (components/lanes/laneUtils.ts):
 * that helper is shared with the Lanes route and the workspace graph, neither of
 * which knows about session quietness, Work-scoped pins, or a user-chosen sort
 * mode. Keeping this here means the Lanes tab cannot regress when the Work
 * sidebar's ordering rules change.
 *
 * The whole module is pure — callers derive `quiet`/`pinned`/`lastActivityMs`
 * and hand over plain data — so the ordering rules are unit-testable without
 * mounting a sidebar.
 */

/** MIME type for a lane-header drag. Distinguishes it from a session-card drag. */
export const ADE_WORK_LANE_DND_MIME = "application/x-ade-work-lane";

export type WorkLaneSortMode = "activity" | "name" | "created" | "manual";

export const WORK_LANE_SORT_MODES: readonly WorkLaneSortMode[] = [
  "activity",
  "name",
  "created",
  "manual",
];

/**
 * Filing tier. Pins outrank quietness: a pinned lane stays up top even when
 * every one of its sessions has settled, and the caller uses the same `pinned`
 * flag to suppress the compact/dimmed quiet styling so a pinned lane never
 * renders as a shrunken row at position one.
 */
export type WorkLaneTier = "pinned" | "active" | "quiet";

export type WorkLaneOrderInput = {
  /** Lane id, or `${machineId}:${laneId}` for a cross-machine row. */
  id: string;
  name: string;
  laneType: string;
  createdAt: string;
  /** Most recent session activity in the lane; null when the lane has none. */
  lastActivityMs: number | null;
  /** Every session settled or snoozed. */
  quiet: boolean;
  pinned: boolean;
};

export function normalizeWorkLaneSortMode(value: unknown): WorkLaneSortMode {
  return WORK_LANE_SORT_MODES.includes(value as WorkLaneSortMode)
    ? value as WorkLaneSortMode
    : "created";
}

export function workLaneTier(input: Pick<WorkLaneOrderInput, "pinned" | "quiet">): WorkLaneTier {
  if (input.pinned) return "pinned";
  return input.quiet ? "quiet" : "active";
}

const TIER_RANK: Record<WorkLaneTier, number> = { pinned: 0, active: 1, quiet: 2 };

/** Parse with the NaN guard the lane list has always used for `createdAt`. */
function createdAtMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Descending numeric compare that always sorts `null` last, in either direction. */
function compareDescNullsLast(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

function compareByMode(
  a: WorkLaneOrderInput,
  b: WorkLaneOrderInput,
  mode: WorkLaneSortMode,
  manualIndex: ReadonlyMap<string, number>,
): number {
  switch (mode) {
    case "activity":
      return compareDescNullsLast(a.lastActivityMs, b.lastActivityMs);
    case "name":
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
    case "manual": {
      // Lanes with no recorded position sort after every placed lane, in the
      // fallback order below — so a newly created lane appears predictably
      // rather than jumping to an arbitrary slot.
      const ai = manualIndex.get(a.id) ?? Number.POSITIVE_INFINITY;
      const bi = manualIndex.get(b.id) ?? Number.POSITIVE_INFINITY;
      return ai === bi ? 0 : ai - bi;
    }
    case "created":
    default:
      return compareDescNullsLast(createdAtMs(a.createdAt), createdAtMs(b.createdAt));
  }
}

/**
 * Full ordering key, in priority order:
 *
 *   1. the primary lane, always first — in every mode, drag included
 *   2. tier: pinned → active → quiet
 *   3. the active sort mode
 *   4. createdAt desc, then id — a total, stable tiebreak
 *
 * Step 4 exists so the comparator is total: without it, two lanes that tie on
 * the mode key can swap places between renders and the list visibly jitters.
 */
export function compareWorkLanes(
  a: WorkLaneOrderInput,
  b: WorkLaneOrderInput,
  mode: WorkLaneSortMode,
  manualIndex: ReadonlyMap<string, number>,
): number {
  const aPrimary = a.laneType === "primary" ? 0 : 1;
  const bPrimary = b.laneType === "primary" ? 0 : 1;
  if (aPrimary !== bPrimary) return aPrimary - bPrimary;

  const tierDelta = TIER_RANK[workLaneTier(a)] - TIER_RANK[workLaneTier(b)];
  if (tierDelta !== 0) return tierDelta;

  const modeDelta = compareByMode(a, b, mode, manualIndex);
  if (modeDelta !== 0) return modeDelta;

  const createdDelta = compareDescNullsLast(createdAtMs(a.createdAt), createdAtMs(b.createdAt));
  if (createdDelta !== 0) return createdDelta;

  return a.id.localeCompare(b.id);
}

export function orderWorkLanes<T extends WorkLaneOrderInput>(
  lanes: readonly T[],
  mode: WorkLaneSortMode,
  manualOrder: readonly string[],
): T[] {
  // Build the position lookup once rather than paying an indexOf scan inside
  // every comparison.
  const manualIndex = new Map<string, number>();
  manualOrder.forEach((id, index) => {
    if (!manualIndex.has(id)) manualIndex.set(id, index);
  });
  return [...lanes].sort((a, b) => compareWorkLanes(a, b, mode, manualIndex));
}

/**
 * Move `movedLaneId` to either side of `targetLaneId` within a manual order.
 *
 * Returns `null` for anything that would not change the array — a self-drop, an
 * unknown id, or a drop that lands a lane back where it already was — so the
 * caller can skip the state write (and its persist) entirely.
 */
export function applyWorkLaneManualMove(args: {
  currentOrder: readonly string[];
  movedLaneId: string;
  targetLaneId: string;
  edge: "before" | "after";
}): string[] | null {
  const { currentOrder, movedLaneId, targetLaneId, edge } = args;
  if (movedLaneId === targetLaneId) return null;
  if (!currentOrder.includes(movedLaneId) || !currentOrder.includes(targetLaneId)) return null;

  const withoutMoved = currentOrder.filter((id) => id !== movedLaneId);
  const anchor = withoutMoved.indexOf(targetLaneId);
  if (anchor === -1) return null;

  const next = [...withoutMoved];
  next.splice(edge === "before" ? anchor : anchor + 1, 0, movedLaneId);

  const unchanged = next.length === currentOrder.length
    && next.every((id, index) => id === currentOrder[index]);
  return unchanged ? null : next;
}
