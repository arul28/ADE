import { create } from "zustand";
import type { OperationRecord } from "../../../shared/types";
import type {
  ColumnConfig,
  LaneVisibility,
  TimelineEvent,
  TimelineFilters,
  TimeRange,
  ViewMode,
  WIPNode,
} from "./timelineTypes";
import { DEFAULT_COLUMNS } from "./timelineTypes";
import { getEventMeta } from "./eventTaxonomy";
import type { EventCategory, EventImportance } from "./eventTaxonomy";

// ── Helpers ──────────────────────────────────────────────────────

/** Enrich a raw OperationRecord into a TimelineEvent with resolved metadata. */
export function enrichEvent(op: OperationRecord): TimelineEvent {
  const meta = getEventMeta(op.kind);
  let parsed: Record<string, unknown> | null = null;
  if (op.metadataJson) {
    try {
      parsed = JSON.parse(op.metadataJson);
    } catch {
      // ignore malformed JSON
    }
  }
  let durationMs: number | null = null;
  if (op.startedAt && op.endedAt) {
    durationMs = Date.parse(op.endedAt) - Date.parse(op.startedAt);
    if (!Number.isFinite(durationMs) || durationMs < 0) durationMs = null;
  }
  return {
    ...op,
    label: meta.label,
    category: meta.category,
    iconName: meta.iconName,
    color: meta.categoryMeta.color,
    shape: meta.categoryMeta.shape,
    metadata: parsed,
    durationMs,
    importance: meta.importance,
  };
}

/** Minimum importance levels that pass each scope setting. */
const SCOPE_THRESHOLDS: Record<string, Set<EventImportance>> = {
  important: new Set(["high"]),
  standard:  new Set(["high", "medium"]),
  detailed:  new Set(["high", "medium", "low"]),
  all:       new Set(["high", "medium", "low", "noise"]),
};

/** Scope level names for the UI */
export type ScopeLevel = "important" | "standard" | "detailed" | "all";

/** Check if an event passes the current filters. */
function passesFilters(
  event: TimelineEvent,
  filters: TimelineFilters,
  visibility: LaneVisibility,
  scope: ScopeLevel,
): boolean {
  // Scope/importance filter (applied first — most events get filtered here)
  const allowed = SCOPE_THRESHOLDS[scope];
  if (!allowed.has(event.importance)) return false;
  // Lane visibility (solo/hide)
  if (visibility.soloedLaneIds.size > 0) {
    if (event.laneId && !visibility.soloedLaneIds.has(event.laneId)) return false;
  }
  if (event.laneId && visibility.hiddenLaneIds.has(event.laneId)) return false;

  // Lane filter
  if (filters.laneIds.length > 0 && event.laneId && !filters.laneIds.includes(event.laneId)) return false;

  // Category filter
  if (filters.categories.length > 0 && !filters.categories.includes(event.category)) return false;

  // Status filter
  if (filters.statuses.length > 0 && !filters.statuses.includes(event.status)) return false;

  // Time range
  if (filters.timeRange !== "all") {
    const now = Date.now();
    const eventTime = Date.parse(event.startedAt);
    if (Number.isFinite(eventTime)) {
      const delta = now - eventTime;
      const hour = 3_600_000;
      const day = 86_400_000;
      switch (filters.timeRange) {
        case "1h":    if (delta > hour) return false; break;
        case "today":  if (delta > day) return false; break;
        case "week":   if (delta > 7 * day) return false; break;
        case "month":  if (delta > 30 * day) return false; break;
      }
    }
  }

  // Search query
  if (filters.searchQuery) {
    const q = filters.searchQuery.toLowerCase();
    const haystack = `${event.label} ${event.kind} ${event.laneName ?? ""} ${event.status}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }

  return true;
}

// ── Store Type ───────────────────────────────────────────────────

type TimelineStore = {
  // ── Raw data ────────────────────────────────────────────────
  rawEvents: OperationRecord[];
  /** Enriched + filtered events ready for rendering */
  events: TimelineEvent[];
  /** Currently running operations (for WIP row) */
  wipNodes: WIPNode[];
  /** Whether data is loading */
  loading: boolean;
  /** Last fetch error */
  error: string | null;

  // ── View state ──────────────────────────────────────────────
  viewMode: ViewMode;
  selectedEventId: string | null;
  hoveredLaneId: string | null;
  /** Event scope/detail level (controls importance threshold) */
  scope: ScopeLevel;

  // ── Filters ─────────────────────────────────────────────────
  filters: TimelineFilters;
  visibility: LaneVisibility;

  // ── Columns ─────────────────────────────────────────────────
  columns: ColumnConfig[];

  // ── Unique values (for filter dropdowns) ────────────────────
  uniqueLanes: Array<{ id: string; name: string }>;
  uniqueCategories: EventCategory[];

  // ── Actions ─────────────────────────────────────────────────
  setViewMode: (mode: ViewMode) => void;
  setSelectedEventId: (id: string | null) => void;
  setHoveredLaneId: (id: string | null) => void;
  setScope: (scope: ScopeLevel) => void;

  // Filter actions
  setLaneFilter: (laneIds: string[]) => void;
  setCategoryFilter: (categories: EventCategory[]) => void;
  setStatusFilter: (statuses: Array<"running" | "succeeded" | "failed" | "canceled">) => void;
  setTimeRange: (range: TimeRange) => void;
  setSearchQuery: (query: string) => void;
  clearFilters: () => void;

  // Visibility actions
  toggleLaneHidden: (laneId: string) => void;
  toggleLaneSolo: (laneId: string) => void;
  clearSolo: () => void;

  // Column actions
  toggleColumn: (columnId: string) => void;

  // Data actions
  fetchEvents: (opts?: { laneId?: string; kind?: string; limit?: number; silent?: boolean }) => Promise<void>;
  setRawEvents: (events: OperationRecord[]) => void;
};

// ── Default filter state ─────────────────────────────────────────

const DEFAULT_FILTERS: TimelineFilters = {
  laneIds: [],
  categories: [],
  statuses: [],
  timeRange: "all",
  searchQuery: "",
};

const DEFAULT_VISIBILITY: LaneVisibility = {
  hiddenLaneIds: new Set(),
  soloedLaneIds: new Set(),
};

// ── Store ────────────────────────────────────────────────────────

export const useTimelineStore = create<TimelineStore>((set, get) => {
  /** Re-derive filtered events from raw data + current filters. */
  function refilter() {
    const { rawEvents, filters, visibility, scope } = get();
    const enriched = rawEvents.map(enrichEvent);
    const filtered = enriched.filter((e) => passesFilters(e, filters, visibility, scope));

    // Extract WIP nodes (running operations grouped by lane)
    const runningByLane = new Map<string, OperationRecord[]>();
    for (const op of rawEvents) {
      if (op.status === "running") {
        const key = op.laneId ?? "__project__";
        const arr = runningByLane.get(key) ?? [];
        arr.push(op);
        runningByLane.set(key, arr);
      }
    }
    const wipNodes: WIPNode[] = Array.from(runningByLane.entries()).map(([laneId, ops]) => ({
      laneId: laneId === "__project__" ? "" : laneId,
      laneName: ops[0]?.laneName ?? "Project",
      operations: ops,
      color: "#F59E0B",
    }));

    // Extract unique lanes & categories for filter dropdowns
    const laneMap = new Map<string, string>();
    const catSet = new Set<EventCategory>();
    for (const e of enriched) {
      if (e.laneId && e.laneName) laneMap.set(e.laneId, e.laneName);
      catSet.add(e.category);
    }

    set({
      events: filtered,
      wipNodes,
      uniqueLanes: Array.from(laneMap.entries()).map(([id, name]) => ({ id, name })),
      uniqueCategories: Array.from(catSet),
    });
  }

  return {
    // ── Initial state ───────────────────────────────────────
    rawEvents: [],
    events: [],
    wipNodes: [],
    loading: false,
    error: null,
    viewMode: "graph",
    selectedEventId: null,
    hoveredLaneId: null,
    scope: "standard",
    filters: { ...DEFAULT_FILTERS },
    visibility: { ...DEFAULT_VISIBILITY },
    columns: [...DEFAULT_COLUMNS],
    uniqueLanes: [],
    uniqueCategories: [],

    // ── View actions ────────────────────────────────────────
    setViewMode: (mode) => set({ viewMode: mode }),
    setSelectedEventId: (id) => set({ selectedEventId: id }),
    setHoveredLaneId: (id) => set({ hoveredLaneId: id }),
    setScope: (scope) => {
      set({ scope });
      refilter();
    },

    // ── Filter actions ──────────────────────────────────────
    setLaneFilter: (laneIds) => {
      set((s) => ({ filters: { ...s.filters, laneIds } }));
      refilter();
    },
    setCategoryFilter: (categories) => {
      set((s) => ({ filters: { ...s.filters, categories } }));
      refilter();
    },
    setStatusFilter: (statuses) => {
      set((s) => ({ filters: { ...s.filters, statuses } }));
      refilter();
    },
    setTimeRange: (timeRange) => {
      set((s) => ({ filters: { ...s.filters, timeRange } }));
      refilter();
    },
    setSearchQuery: (searchQuery) => {
      set((s) => ({ filters: { ...s.filters, searchQuery } }));
      refilter();
    },
    clearFilters: () => {
      set({ filters: { ...DEFAULT_FILTERS }, visibility: { ...DEFAULT_VISIBILITY }, scope: "standard" });
      refilter();
    },

    // ── Visibility actions ──────────────────────────────────
    toggleLaneHidden: (laneId) => {
      set((s) => {
        const next = new Set(s.visibility.hiddenLaneIds);
        if (next.has(laneId)) next.delete(laneId);
        else next.add(laneId);
        return { visibility: { ...s.visibility, hiddenLaneIds: next } };
      });
      refilter();
    },
    toggleLaneSolo: (laneId) => {
      set((s) => {
        const next = new Set(s.visibility.soloedLaneIds);
        if (next.has(laneId)) next.delete(laneId);
        else next.add(laneId);
        return { visibility: { ...s.visibility, soloedLaneIds: next } };
      });
      refilter();
    },
    clearSolo: () => {
      set((s) => ({ visibility: { ...s.visibility, soloedLaneIds: new Set() } }));
      refilter();
    },

    // ── Column actions ──────────────────────────────────────
    toggleColumn: (columnId) => {
      set((s) => ({
        columns: s.columns.map((c) =>
          c.id === columnId ? { ...c, visible: !c.visible } : c
        ),
      }));
    },

    // ── Data actions ────────────────────────────────────────
    fetchEvents: async (opts) => {
      if (!opts?.silent) {
        set({ loading: true, error: null });
      } else {
        set({ error: null });
      }
      try {
        const raw = await window.ade.history.listOperations({
          laneId: opts?.laneId,
          kind: opts?.kind,
          limit: opts?.limit ?? 350,
        });
        set({ rawEvents: raw, loading: false });
        refilter();
      } catch (err) {
        set({
          loading: false,
          error: err instanceof Error ? err.message : "Failed to fetch events",
        });
      }
    },
    setRawEvents: (events) => {
      set({ rawEvents: events });
      refilter();
    },
  };
});
