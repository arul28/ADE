import type {
  GraphFilterState,
  GraphLayoutPreset,
  GraphLayoutSnapshot,
  GraphPersistedState,
  GraphViewMode,
  LaneSummary
} from "../../../shared/types";

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

export function createDefaultState(): GraphPersistedState {
  const basePreset: GraphLayoutPreset = {
    name: "__default__",
    byViewMode: {
      stack: createSnapshot("stack"),
      risk: createSnapshot("risk"),
      activity: createSnapshot("activity"),
      all: createSnapshot("all")
    },
    updatedAt: new Date().toISOString()
  };
  return {
    presets: [basePreset],
    activePreset: "__default__"
  };
}

export function ensureGraphState(state: GraphPersistedState | null | undefined): GraphPersistedState {
  if (!state || !Array.isArray(state.presets) || state.presets.length === 0) {
    return createDefaultState();
  }
  const validPreset = state.presets.find((preset) => preset.name === state.activePreset) ?? state.presets[0]!;
  const normalizeSnapshot = (viewMode: GraphViewMode): GraphLayoutSnapshot => {
    const existing = validPreset.byViewMode?.[viewMode];
    if (!existing) return createSnapshot(viewMode);
    return {
      nodePositions: existing.nodePositions ?? {},
      collapsedLaneIds: existing.collapsedLaneIds ?? [],
      viewMode,
      filters: existing.filters ?? buildDefaultFilter(),
      updatedAt: existing.updatedAt ?? new Date().toISOString()
    };
  };
  return {
    activePreset: validPreset.name,
    presets: state.presets.map((preset) => ({
      name: preset.name,
      updatedAt: preset.updatedAt ?? new Date().toISOString(),
      byViewMode: {
        stack: preset.byViewMode?.stack ? { ...normalizeSnapshot("stack"), ...preset.byViewMode.stack, viewMode: "stack" } : createSnapshot("stack"),
        risk: preset.byViewMode?.risk ? { ...normalizeSnapshot("risk"), ...preset.byViewMode.risk, viewMode: "risk" } : createSnapshot("risk"),
        activity: preset.byViewMode?.activity ? { ...normalizeSnapshot("activity"), ...preset.byViewMode.activity, viewMode: "activity" } : createSnapshot("activity"),
        all: preset.byViewMode?.all ? { ...normalizeSnapshot("all"), ...preset.byViewMode.all, viewMode: "all" } : createSnapshot("all")
      }
    }))
  };
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
  environmentByLaneId: Record<string, { env: string; color: string | null }>
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

  const primary = lanes.find((lane) => lane.laneType === "primary") ?? lanes[0]!;
  positions[primary.id] = { x: 420, y: 240 };
  const rest = lanes.filter((lane) => lane.id !== primary.id);
  const core = rest.filter((lane) => Boolean(environmentByLaneId[lane.id]));
  const others = rest.filter((lane) => !environmentByLaneId[lane.id]);

  const innerRadius = Math.max(160, core.length * 26);
  core.forEach((lane, index) => {
    const angle = (index / Math.max(1, core.length)) * Math.PI * 2;
    positions[lane.id] = {
      x: 420 + Math.cos(angle) * innerRadius,
      y: 240 + Math.sin(angle) * innerRadius
    };
  });

  const outerRadius = Math.max(260, others.length * 26);
  others.forEach((lane, index) => {
    const angle = (index / Math.max(1, others.length)) * Math.PI * 2;
    positions[lane.id] = {
      x: 420 + Math.cos(angle) * outerRadius,
      y: 240 + Math.sin(angle) * outerRadius
    };
  });
  return positions;
}
