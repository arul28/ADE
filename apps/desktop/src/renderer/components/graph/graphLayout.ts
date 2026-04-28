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

/**
 * Session snapshots can end up with a partial `filters` object (e.g. only `{ search }` if the
 * previous `snapshot.filters` was undefined when spreading). Coalesce with defaults so
 * filter UI and `*.length` checks never see undefined array fields.
 */
export function coalesceGraphFilters(
  active: Partial<GraphFilterState> | null | undefined,
): GraphFilterState {
  const base = buildDefaultFilter();
  if (active == null) return base;
  return {
    status: Array.isArray(active.status) ? active.status : base.status,
    laneTypes: Array.isArray(active.laneTypes) ? active.laneTypes : base.laneTypes,
    tags: Array.isArray(active.tags) ? active.tags : base.tags,
    hidePrimary: typeof active.hidePrimary === "boolean" ? active.hidePrimary : base.hidePrimary,
    hideAttached: typeof active.hideAttached === "boolean" ? active.hideAttached : base.hideAttached,
    hideArchived: typeof active.hideArchived === "boolean" ? active.hideArchived : base.hideArchived,
    rootLaneId: active.rootLaneId !== undefined ? active.rootLaneId : base.rootLaneId,
    search: typeof active.search === "string" ? active.search : base.search,
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
  primary: LaneSummary | null;
  depthByLaneId: Map<string, number>;
  parentNameByLaneId: Map<string, string | null>;
} {
  const primary = lanes.find((lane) => lane.laneType === "primary") ?? lanes[0] ?? null;
  if (!primary) {
    return { primary: null, depthByLaneId: new Map(), parentNameByLaneId: new Map() };
  }
  const byId = new Map(lanes.map((lane) => [lane.id, lane] as const));
  const depthByLaneId = new Map<string, number>();
  const parentNameByLaneId = new Map<string, string | null>();

  depthByLaneId.set(primary.id, 0);

  const resolveDepth = (startId: string): number => {
    const chain: string[] = [];
    const onChain = new Set<string>();
    let cursor: LaneSummary | undefined = byId.get(startId);
    let baseDepth = 10_000;
    while (cursor) {
      const cached = depthByLaneId.get(cursor.id);
      if (cached !== undefined) {
        baseDepth = cached;
        break;
      }
      if (onChain.has(cursor.id)) {
        baseDepth = 10_000;
        break;
      }
      chain.push(cursor.id);
      onChain.add(cursor.id);
      if (!cursor.parentLaneId) {
        baseDepth = 10_000;
        break;
      }
      cursor = byId.get(cursor.parentLaneId);
    }
    if (baseDepth === 10_000) {
      for (const id of chain) depthByLaneId.set(id, 10_000);
      return 10_000;
    }
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      baseDepth += 1;
      depthByLaneId.set(chain[i]!, baseDepth);
    }
    return depthByLaneId.get(startId) ?? 10_000;
  };

  for (const lane of lanes) {
    if (!depthByLaneId.has(lane.id)) resolveDepth(lane.id);
    const parent = lane.parentLaneId ? byId.get(lane.parentLaneId) : null;
    parentNameByLaneId.set(lane.id, parent?.name ?? null);
  }

  return { primary, depthByLaneId, parentNameByLaneId };
}

/** Shared auto-layout: primary centered on top row, descendants on deeper rows (same for every view mode). */
function layoutPrimaryCentricRows(
  lanes: LaneSummary[],
  activityScoreByLaneId: Record<string, number>,
  tieBreak: "stack" | "activity",
  precomputedDepthByLaneId?: Map<string, number>
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  if (lanes.length === 0) return positions;

  const depthByLaneId = precomputedDepthByLaneId ?? laneHierarchyFromPrimary(lanes).depthByLaneId;

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
  _environmentByLaneId: Record<string, { env: string; color: string | null }>,
  precomputedDepthByLaneId?: Map<string, number>
): Record<string, { x: number; y: number }> {
  const tieBreak: "stack" | "activity" = viewMode === "activity" ? "activity" : "stack";
  return layoutPrimaryCentricRows(lanes, activityScoreByLaneId, tieBreak, precomputedDepthByLaneId);
}
