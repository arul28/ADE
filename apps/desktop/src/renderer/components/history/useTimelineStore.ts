import React, { createContext, useContext, type ReactNode } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { StateCreator } from "zustand";
import type { OperationRecord } from "../../../shared/types";
import type { GitCommitSummary } from "../../../shared/types";
import type {
  ColumnConfig,
  HistorySurface,
  LaneVisibility,
  HistoryMachineSource,
  TimelineEvent,
  TimelineRecord,
  TimelineFilters,
  TimelineColumn,
  TimeRange,
  ViewMode,
  WIPNode,
} from "./timelineTypes";
import { DEFAULT_COLUMNS } from "./timelineTypes";
import { getEventMeta } from "./eventTaxonomy";
import type { EventCategory, EventImportance } from "./eventTaxonomy";
import {
  fetchSupplementalTimelineRecords,
  sortTimelineRecords,
  type HistoryCtoRoute,
} from "./historyActivitySources";
import { withMachineTimeout } from "../../state/projectMachines";
import { foreignLaneKey, machineBlockedReason, shouldShowMachineChips } from "../../state/laneMachineRouting";
import { machineScopedId, type MachineReadLoad } from "../../state/foreignMachineReads";

// ── Machines ─────────────────────────────────────────────────────

export type { HistoryMachineSource };

/** Before the page publishes its machines, the bound machine is the only source. */
const IMPLICIT_ACTIVE_KEY = "bound";

function tagRecords(records: readonly OperationRecord[], machine: HistoryMachineSource | null): TimelineRecord[] {
  if (!machine) return records as TimelineRecord[];
  return records.map((record) => ({ ...record, machine }));
}

/** The note for a machine the timeline does not read right now. */
function offlineLoad(machine: HistoryMachineSource): MachineReadLoad {
  return {
    machineName: machine.machineName,
    status: "offline",
    message: machineBlockedReason({ ...machine, routable: true }),
  };
}

// ── Helpers ──────────────────────────────────────────────────────

function metadataDisplayLabel(
  metadata: Record<string, unknown> | null,
  fallback: string,
): string {
  if (!metadata) return fallback;
  for (const key of ["eventLabel", "title", "summary", "message", "subject"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return fallback;
}

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
    label: metadataDisplayLabel(parsed, meta.label),
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

/**
 * Lane identity for filters and chips. Lane ids are unique per machine, not
 * globally, so a lane on another machine is qualified by that machine (the same
 * `machineId:laneId` form the Lanes and Work tabs use). The bound machine's
 * lanes keep their bare id, so lane filters set from elsewhere still match.
 */
export function timelineLaneKey(event: Pick<TimelineEvent, "laneId" | "machine">): string | null {
  if (!event.laneId) return null;
  return event.machine && !event.machine.isActiveBinding
    ? foreignLaneKey(event.machine.machineId, event.laneId)
    : event.laneId;
}

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
  // Lane visibility (solo/hide). A lane filter names one machine's lane.
  const laneKey = timelineLaneKey(event);
  if (visibility.soloedLaneIds.size > 0) {
    if (laneKey && !visibility.soloedLaneIds.has(laneKey)) return false;
  }
  if (laneKey && visibility.hiddenLaneIds.has(laneKey)) return false;

  // Lane filter
  if (filters.laneIds.length > 0 && laneKey && !filters.laneIds.includes(laneKey)) return false;

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
    const metadataText = event.metadata
      ? Object.values(event.metadata)
          .filter((value) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
          .join(" ")
      : "";
    const haystack = `${event.label} ${event.kind} ${event.laneName ?? ""} ${event.status} ${metadataText}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }

  return true;
}

// ── Store Type ───────────────────────────────────────────────────

export type TimelineStore = {
  // ── Raw data ────────────────────────────────────────────────
  rawEvents: TimelineRecord[];
  /** Per-machine segments that `rawEvents` is merged from, keyed by machine id. */
  recordsByMachine: Record<string, TimelineRecord[]>;
  /** Machines the timeline reads from; the bound machine first. */
  machines: HistoryMachineSource[];
  /** Per-machine read state for machines other than the bound one. */
  machineLoads: Record<string, MachineReadLoad>;
  /** Where the CTO's sessions are read from (its home machine). */
  ctoRoute: HistoryCtoRoute;
  /** Enriched + filtered events ready for rendering */
  events: TimelineEvent[];
  /** Currently running operations (for WIP row) */
  wipNodes: WIPNode[];
  /** Whether data is loading */
  loading: boolean;
  /** Last fetch error */
  error: string | null;

  // ── View state ──────────────────────────────────────────────
  surface: HistorySurface;
  focusLaneId: string | null;
  /**
   * The machine that owns `focusLaneId` when it is not the tab's own machine.
   * Lane ids are unique per machine, so a lane on another machine is named by
   * both. Null means the tab's machine (the unpinned path).
   */
  focusLaneMachineId: string | null;
  selectedCommitSha: string | null;
  selectedCommit: GitCommitSummary | null;
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
  uniqueLanes: Array<{ id: string; name: string; machineName: string | null }>;
  uniqueCategories: EventCategory[];

  // ── Actions ─────────────────────────────────────────────────
  setSurface: (surface: HistorySurface) => void;
  /** Focus a lane on the tab's own machine. */
  setFocusLaneId: (laneId: string | null) => void;
  /** Focus a lane on a given machine; `machineId` null is the tab's machine. */
  setFocusLane: (laneId: string | null, machineId: string | null) => void;
  setSelectedCommitSha: (sha: string | null) => void;
  setSelectedCommit: (commit: GitCommitSummary | null) => void;
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
  toggleColumn: (columnId: TimelineColumn) => void;

  // Data actions
  fetchEvents: (opts?: {
    laneId?: string;
    kind?: string;
    limit?: number;
    silent?: boolean;
    skipSupplemental?: boolean;
    /** Read only the bound machine (tight polling for its running operations). */
    skipForeign?: boolean;
  }) => Promise<void>;
  setRawEvents: (events: OperationRecord[]) => void;
  /** Publish the machine set. Drops segments of machines that left. */
  setMachines: (machines: HistoryMachineSource[]) => void;
  setCtoRoute: (route: HistoryCtoRoute) => void;
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

const createTimelineState: StateCreator<TimelineStore> = (set, get) => {
  /** Latest read per machine; an older answer never overwrites a newer one. */
  const readSeqByMachine = new Map<string, number>();
  const nextReadSeq = (key: string) => {
    const seq = (readSeqByMachine.get(key) ?? 0) + 1;
    readSeqByMachine.set(key, seq);
    return seq;
  };
  const isLatestRead = (key: string, seq: number) => readSeqByMachine.get(key) === seq;

  function activeMachine(): HistoryMachineSource | null {
    return get().machines.find((machine) => machine.isActiveBinding) ?? null;
  }

  /** Replace one machine's segment and re-merge the whole timeline by time. */
  function commitSegment(key: string, records: TimelineRecord[]) {
    const recordsByMachine = { ...get().recordsByMachine, [key]: records };
    set({
      recordsByMachine,
      rawEvents: sortTimelineRecords(Object.values(recordsByMachine).flat()) as TimelineRecord[],
    });
    refilter();
  }

  function setMachineLoad(key: string, load: MachineReadLoad | null) {
    set((state) => {
      const next = { ...state.machineLoads };
      if (load) next[key] = load;
      else delete next[key];
      return { machineLoads: next };
    });
  }

  /**
   * Read one other machine. Never awaited by the bound machine's read, timed
   * out, and an offline machine keeps its last-reported rows (dimmed) instead
   * of being queried.
   */
  async function fetchForeignMachine(
    machine: HistoryMachineSource,
    args: { laneId?: string; kind?: string; limit: number },
  ) {
    const key = machine.machineId;
    if (!machine.pin) return;
    if (!machine.online) {
      setMachineLoad(key, offlineLoad(machine));
      return;
    }
    const seq = nextReadSeq(key);
    if (!get().recordsByMachine[key]) {
      setMachineLoad(key, { machineName: machine.machineName, status: "loading", message: null });
    }
    try {
      const rows = await withMachineTimeout(
        window.ade.history.listOperations(
          { laneId: args.laneId, kind: args.kind, limit: args.limit },
          machine.pin,
        ),
        machine.machineName,
      );
      if (!isLatestRead(key, seq)) return;
      if (!get().machines.some((candidate) => candidate.machineId === key)) return;
      const tagged = tagRecords(
        (Array.isArray(rows) ? rows : []).map((row) => ({ ...row, id: machineScopedId(key, row.id) })),
        machine,
      );
      commitSegment(key, tagged.slice(0, args.limit));
      setMachineLoad(key, null);
    } catch (err) {
      if (!isLatestRead(key, seq)) return;
      setMachineLoad(key, {
        machineName: machine.machineName,
        status: "error",
        message: err instanceof Error ? err.message : `Couldn't read ${machine.machineName}`,
      });
    }
  }

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
    const laneMap = new Map<string, { name: string; machineName: string | null }>();
    const catSet = new Set<EventCategory>();
    for (const e of enriched) {
      const laneKey = timelineLaneKey(e);
      if (laneKey && e.laneName) {
        laneMap.set(laneKey, {
          name: e.laneName,
          // Same chip rule as the rows: every lane names its machine once the
          // timeline spans more than one.
          machineName: e.machine && shouldShowMachineChips(get().machines.length) ? e.machine.machineName : null,
        });
      }
      catSet.add(e.category);
    }

    set({
      events: filtered,
      wipNodes,
      uniqueLanes: Array.from(laneMap.entries()).map(([id, lane]) => ({ id, ...lane })),
      uniqueCategories: Array.from(catSet),
    });
  }

  return {
    // ── Initial state ───────────────────────────────────────
    rawEvents: [],
    recordsByMachine: {},
    machines: [],
    machineLoads: {},
    ctoRoute: { skip: false, pin: null },
    events: [],
    wipNodes: [],
    loading: false,
    error: null,
    surface: "commits",
    focusLaneId: null,
    focusLaneMachineId: null,
    selectedCommitSha: null,
    selectedCommit: null,
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
    setSurface: (surface) =>
      set((state) => {
        if (surface === "activity") {
          return { surface, selectedCommit: null, selectedCommitSha: null };
        }
        if (state.selectedEventId) {
          return { surface, selectedEventId: null };
        }
        return { surface };
      }),
    setFocusLaneId: (laneId) =>
      set({
        focusLaneId: laneId,
        focusLaneMachineId: null,
        selectedCommit: null,
        selectedCommitSha: null,
      }),
    setFocusLane: (laneId, machineId) =>
      set({
        focusLaneId: laneId,
        focusLaneMachineId: laneId ? machineId : null,
        selectedCommit: null,
        selectedCommitSha: null,
      }),
    setSelectedCommitSha: (sha) => set({ selectedCommitSha: sha }),
    setSelectedCommit: (commit) =>
      set({
        selectedCommit: commit,
        selectedCommitSha: commit?.sha ?? null,
      }),
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
      const limit = opts?.limit ?? 500;
      // Every other machine reads in parallel and lands on its own; none of
      // them gates the bound machine's list or its loading state.
      for (const machine of opts?.skipForeign ? [] : get().machines) {
        if (machine.isActiveBinding) continue;
        void fetchForeignMachine(machine, { laneId: opts?.laneId, kind: opts?.kind, limit });
      }
      const local = activeMachine();
      const localKey = local?.machineId ?? IMPLICIT_ACTIVE_KEY;
      const seq = nextReadSeq(localKey);
      try {
        const skipSupplemental = Boolean(opts?.skipSupplemental) || Boolean(opts?.kind);
        const [raw, supplemental] = await Promise.all([
          window.ade.history.listOperations({
            laneId: opts?.laneId,
            kind: opts?.kind,
            limit,
          }),
          skipSupplemental ? Promise.resolve([]) : fetchSupplementalTimelineRecords(limit, get().ctoRoute),
        ]);
        if (!isLatestRead(localKey, seq)) return;
        if (skipSupplemental) {
          // Merge raw with whatever supplemental records are already in state so we
          // don't drop them while polling for in-progress operations.
          const existing = get().recordsByMachine[localKey] ?? [];
          const rawIds = new Set(raw.map((r) => r.id));
          const existingSupplemental = existing.filter((r) => !rawIds.has(r.id));
          const scopedExisting = opts?.laneId
            ? existingSupplemental.filter(
                (record) => record.laneId == null || record.laneId === opts.laneId,
              )
            : existingSupplemental;
          const combined = sortTimelineRecords([...tagRecords(raw, local), ...scopedExisting]).slice(0, limit);
          set({ loading: false });
          commitSegment(localKey, combined as TimelineRecord[]);
          return;
        }
        const scopedSupplemental = opts?.laneId
          ? supplemental.filter((record) => record.laneId == null || record.laneId === opts.laneId)
          : supplemental;
        const combined = sortTimelineRecords(
          tagRecords([...raw, ...scopedSupplemental], local),
        ).slice(0, limit);
        set({ loading: false });
        commitSegment(localKey, combined as TimelineRecord[]);
      } catch (err) {
        if (!isLatestRead(localKey, seq)) return;
        set({
          loading: false,
          error: err instanceof Error ? err.message : "Failed to fetch events",
        });
      }
    },
    setRawEvents: (events) => {
      const key = activeMachine()?.machineId ?? IMPLICIT_ACTIVE_KEY;
      set({ recordsByMachine: { [key]: events as TimelineRecord[] }, rawEvents: events as TimelineRecord[] });
      refilter();
    },
    setCtoRoute: (ctoRoute) => set({ ctoRoute }),
    setMachines: (machines) => {
      const previous = get();
      const byKey = new Map(machines.map((machine) => [machine.machineId, machine]));
      const nextActiveKey = machines.find((machine) => machine.isActiveBinding)?.machineId ?? IMPLICIT_ACTIVE_KEY;
      const recordsByMachine: Record<string, TimelineRecord[]> = {};
      for (const [key, records] of Object.entries(previous.recordsByMachine)) {
        // The bound machine's first read may have landed before machines were
        // published; it is the same machine under its real key.
        const targetKey = key === IMPLICIT_ACTIVE_KEY ? nextActiveKey : key;
        const machine = byKey.get(targetKey);
        if (!machine) continue;
        // Retag so a machine that went offline dims its rows in place.
        recordsByMachine[targetKey] = tagRecords(records, machine);
      }
      const machineLoads: Record<string, MachineReadLoad> = {};
      for (const machine of machines) {
        if (machine.isActiveBinding) continue;
        const load = previous.machineLoads[machine.machineId];
        if (!machine.online) {
          machineLoads[machine.machineId] = offlineLoad(machine);
        } else if (load && load.status !== "offline") {
          machineLoads[machine.machineId] = load;
        }
      }
      set({
        machines,
        machineLoads,
        recordsByMachine,
        rawEvents: sortTimelineRecords(Object.values(recordsByMachine).flat()) as TimelineRecord[],
      });
      refilter();
    },
  };
};

export type TimelineStoreApi = StoreApi<TimelineStore>;

const rootTimelineStore = createStore<TimelineStore>()(createTimelineState);
const TimelineStoreContext = createContext<TimelineStoreApi | null>(null);

export function createTimelineStore(): TimelineStoreApi {
  return createStore<TimelineStore>()(createTimelineState);
}

export function TimelineStoreProvider({
  store,
  children,
}: {
  store: TimelineStoreApi;
  children: ReactNode;
}) {
  return React.createElement(TimelineStoreContext.Provider, { value: store }, children);
}

type TimelineStoreHook = {
  <T>(selector: (state: TimelineStore) => T): T;
  getState: TimelineStoreApi["getState"];
  setState: TimelineStoreApi["setState"];
  subscribe: TimelineStoreApi["subscribe"];
};

export const useTimelineStore = ((selector: (state: TimelineStore) => unknown) => {
  const store = useContext(TimelineStoreContext) ?? rootTimelineStore;
  return useStore(store, selector);
}) as TimelineStoreHook;

useTimelineStore.getState = rootTimelineStore.getState;
useTimelineStore.setState = rootTimelineStore.setState;
useTimelineStore.subscribe = rootTimelineStore.subscribe;
