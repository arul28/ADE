import type {
  GraphFilterState,
  GraphLayoutSnapshot,
  GraphPersistedState,
  GraphViewMode,
  LaneSummary
} from "../../../shared/types";

export type GraphSessionState = Record<GraphViewMode, GraphLayoutSnapshot>;

function isGraphViewMode(value: unknown): value is GraphViewMode {
  return value === "stack" || value === "risk" || value === "activity" || value === "all";
}

export function buildDefaultFilter(): GraphFilterState {
  return {
    status: [],
    laneTypes: [],
    tags: [],
    hidePrimary: false,
    hideAttached: false,
    hideArchived: true,
    rootLaneId: null,
    search: ""
  };
}

export function createSnapshot(viewMode: GraphViewMode): GraphLayoutSnapshot {
  return {
    nodePositions: {},
    collapsedLaneIds: [],
    viewMode,
    filters: buildDefaultFilter(),
    updatedAt: new Date().toISOString()
  };
}

export function createSessionState(): GraphSessionState {
  return {
    stack: createSnapshot("stack"),
    risk: createSnapshot("risk"),
    activity: createSnapshot("activity"),
    all: createSnapshot("all")
  };
}

export function createGraphPreferences(lastViewMode: GraphViewMode = "all"): GraphPersistedState {
  return { lastViewMode };
}

function readLegacyLastViewMode(state: Record<string, unknown>): GraphViewMode | null {
  if (isGraphViewMode(state.viewMode)) return state.viewMode;
  if (!Array.isArray(state.presets)) return null;
  const presets = state.presets.filter((preset): preset is Record<string, unknown> => Boolean(preset) && typeof preset === "object");
  if (presets.length === 0) return null;
  const activePresetName = typeof state.activePreset === "string" ? state.activePreset : null;
  const activePreset = presets.find((preset) => preset.name === activePresetName) ?? presets[0] ?? null;
  if (!activePreset) return null;
  const byViewMode = activePreset.byViewMode;
  if (!byViewMode || typeof byViewMode !== "object") return null;
  for (const mode of ["all", "stack", "risk", "activity"] as const) {
    const snapshot = (byViewMode as Record<string, unknown>)[mode];
    if (snapshot && typeof snapshot === "object") {
      const candidate = (snapshot as Record<string, unknown>).viewMode;
      if (isGraphViewMode(candidate)) return candidate;
    }
  }
  return null;
}

export function normalizeGraphPreferences(state: unknown): {
  preferences: GraphPersistedState;
  migrated: boolean;
} {
  if (state && typeof state === "object") {
    const record = state as Record<string, unknown>;
    if (isGraphViewMode(record.lastViewMode)) {
      return {
        preferences: createGraphPreferences(record.lastViewMode),
        migrated: false
      };
    }

    const legacyViewMode = readLegacyLastViewMode(record);
    if (legacyViewMode) {
      return {
        preferences: createGraphPreferences(legacyViewMode),
        migrated: true
      };
    }
  }

  return {
    preferences: createGraphPreferences(),
    migrated: Boolean(state)
  };
}

/** Workspace primary lane and hierarchy relative to it (for overview layout and cards). */
export function laneHierarchyFromPrimary(lanes: LaneSummary[]): {
  primary: LaneSummary;
  depthByLaneId: Map<string, number>;
  parentNameByLaneId: Map<string, string | null>;
} {
  const primary = lanes.find((lane) => lane.laneType === "primary") ?? lanes[0]!;
  const byId = new Map(lanes.map((lane) => [lane.id, lane] as const));
  const depthByLaneId = new Map<string, number>();
  const parentNameByLaneId = new Map<string, string | null>();

  const depthFromPrimary = (laneId: string): number => {
    if (laneId === primary.id) return 0;
    const seen = new Set<string>();
    let hops = 0;
    let cur: LaneSummary | undefined = byId.get(laneId);
    while (cur && cur.id !== primary.id) {
      if (seen.has(cur.id)) return 10_000;
      seen.add(cur.id);
      if (!cur.parentLaneId) return 10_000;
      cur = byId.get(cur.parentLaneId);
      hops += 1;
    }
    return cur?.id === primary.id ? hops : 10_000;
  };

  for (const lane of lanes) {
    depthByLaneId.set(lane.id, depthFromPrimary(lane.id));
    const parent = lane.parentLaneId ? byId.get(lane.parentLaneId) : null;
    parentNameByLaneId.set(lane.id, parent?.name ?? null);
  }

  return { primary, depthByLaneId, parentNameByLaneId };
}

/** Shared auto-layout: primary centered on top row, descendants on deeper rows (same for every view mode). */
function layoutPrimaryCentricRows(
  lanes: LaneSummary[],
  activityScoreByLaneId: Record<string, number>,
  tieBreak: "stack" | "activity"
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  if (lanes.length === 0) return positions;

  const { depthByLaneId } = laneHierarchyFromPrimary(lanes);

  const compareLanes = (a: LaneSummary, b: LaneSummary) => {
    if (tieBreak === "activity") {
      const scoreA = activityScoreByLaneId[a.id] ?? 0;
      const scoreB = activityScoreByLaneId[b.id] ?? 0;
      if (scoreB !== scoreA) return scoreB - scoreA;
    }
    if (a.stackDepth !== b.stackDepth) return a.stackDepth - b.stackDepth;
    const nameCmp = a.name.localeCompare(b.name);
    if (nameCmp !== 0) return nameCmp;
    return a.createdAt.localeCompare(b.createdAt);
  };

  const depthBuckets = new Map<number, LaneSummary[]>();
  for (const lane of lanes) {
    const depth = depthByLaneId.get(lane.id) ?? 10_000;
    const list = depthBuckets.get(depth) ?? [];
    list.push(lane);
    depthBuckets.set(depth, list);
  }

  const X_PITCH = 252;
  const Y_STEP = 168;

  const finiteDepths = [...depthBuckets.keys()].filter((d) => d < 5000).sort((a, b) => a - b);
  const maxFiniteDepth = finiteDepths.length > 0 ? Math.max(...finiteDepths) : 0;

  for (const depth of finiteDepths) {
    const row = (depthBuckets.get(depth) ?? []).slice().sort(compareLanes);
    const rowWidth = Math.max(1, row.length) * X_PITCH;
    row.forEach((lane, index) => {
      const x = index * X_PITCH - (rowWidth - X_PITCH) / 2;
      positions[lane.id] = { x, y: depth * Y_STEP };
    });
  }

  const orphans = (depthBuckets.get(10_000) ?? []).slice().sort(compareLanes);
  if (orphans.length > 0) {
    const baseY = (maxFiniteDepth + 1) * Y_STEP + 40;
    const rowWidth = Math.max(1, orphans.length) * X_PITCH;
    orphans.forEach((lane, index) => {
      const x = index * X_PITCH - (rowWidth - X_PITCH) / 2;
      positions[lane.id] = { x, y: baseY };
    });
  }

  return positions;
}

export function computeAutoLayout(
  lanes: LaneSummary[],
  viewMode: GraphViewMode,
  activityScoreByLaneId: Record<string, number>,
  _environmentByLaneId: Record<string, { env: string; color: string | null }>
): Record<string, { x: number; y: number }> {
  const tieBreak: "stack" | "activity" = viewMode === "activity" ? "activity" : "stack";
  return layoutPrimaryCentricRows(lanes, activityScoreByLaneId, tieBreak);
}
