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

export function buildTreeDepth(lanes: LaneSummary[]): Map<string, number> {
  const byId = new Map(lanes.map((lane) => [lane.id, lane] as const));
  const cache = new Map<string, number>();
  const visit = (laneId: string): number => {
    const existing = cache.get(laneId);
    if (existing != null) return existing;
    const lane = byId.get(laneId);
    if (!lane || !lane.parentLaneId || !byId.has(lane.parentLaneId)) {
      cache.set(laneId, 0);
      return 0;
    }
    const depth = visit(lane.parentLaneId) + 1;
    cache.set(laneId, depth);
    return depth;
  };
  for (const lane of lanes) visit(lane.id);
  return cache;
}

export function computeAutoLayout(
  lanes: LaneSummary[],
  viewMode: GraphViewMode,
  activityScoreByLaneId: Record<string, number>,
  _environmentByLaneId: Record<string, { env: string; color: string | null }>
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  if (lanes.length === 0) return positions;

  if (viewMode === "stack") {
    const depthMap = buildTreeDepth(lanes);
    const lanesByDepth = new Map<number, LaneSummary[]>();
    for (const lane of lanes) {
      const depth = depthMap.get(lane.id) ?? 0;
      const list = lanesByDepth.get(depth) ?? [];
      list.push(lane);
      lanesByDepth.set(depth, list);
    }
    for (const [depth, levelLanes] of lanesByDepth.entries()) {
      levelLanes.sort((a, b) => a.name.localeCompare(b.name));
      levelLanes.forEach((lane, index) => {
        positions[lane.id] = { x: index * 220, y: depth * 170 };
      });
    }
    return positions;
  }

  if (viewMode === "risk") {
    const radius = Math.max(180, lanes.length * 24);
    const centerX = 380;
    const centerY = 260;
    lanes.forEach((lane, index) => {
      const angle = (index / lanes.length) * Math.PI * 2;
      positions[lane.id] = {
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius
      };
    });
    return positions;
  }

  if (viewMode === "activity") {
    const sorted = [...lanes].sort((a, b) => (activityScoreByLaneId[b.id] ?? 0) - (activityScoreByLaneId[a.id] ?? 0));
    const cols = Math.max(1, Math.ceil(Math.sqrt(sorted.length)));
    sorted.forEach((lane, index) => {
      positions[lane.id] = {
        x: (index % cols) * 230,
        y: Math.floor(index / cols) * 180
      };
    });
    return positions;
  }

  // Overview ("all"): primary at the top, then each generation of descendants on its own row.
  const { depthByLaneId } = laneHierarchyFromPrimary(lanes);

  const compareLanes = (a: LaneSummary, b: LaneSummary) => {
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
