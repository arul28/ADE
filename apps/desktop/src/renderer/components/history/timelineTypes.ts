import type { OperationRecord } from "../../../shared/types";
import type { EventCategory, EventImportance, NodeShape } from "./eventTaxonomy";

// ── View Modes ───────────────────────────────────────────────────
export type ViewMode = "graph" | "list" | "compact";

// ── Timeline Event (enriched OperationRecord for rendering) ─────
export type TimelineEvent = OperationRecord & {
  /** Resolved display label */
  label: string;
  /** Event category for grouping/filtering */
  category: EventCategory;
  /** Icon name from Phosphor */
  iconName: string;
  /** Category color */
  color: string;
  /** Node shape for graph rendering */
  shape: NodeShape;
  /** Parsed metadata (from metadataJson) */
  metadata: Record<string, unknown> | null;
  /** Duration in ms (computed from startedAt/endedAt) */
  durationMs: number | null;
  /** Event importance level (controls default visibility) */
  importance: EventImportance;
};

// ── Lane Track (column in the graph view) ────────────────────────
export type LaneTrack = {
  laneId: string;
  laneName: string;
  color: string;
  /** Column index (left-to-right position) */
  columnIndex: number;
  /** Whether this lane is currently visible (not hidden) */
  visible: boolean;
  /** Whether this lane is soloed (only soloed lanes show) */
  soloed: boolean;
};

// ── Graph Layout Types ───────────────────────────────────────────

/** Position of an event node in the graph */
export type NodePosition = {
  eventId: string;
  /** X position (center of the node) */
  x: number;
  /** Y position (center of the node) */
  y: number;
  /** Column index this node belongs to */
  columnIndex: number;
  /** Track color */
  color: string;
  /** Node shape */
  shape: NodeShape;
};

/** Connector line between two events (causal relationship) */
export type ConnectorPath = {
  id: string;
  fromEventId: string;
  toEventId: string;
  /** SVG path data */
  d: string;
  /** Line color */
  color: string;
  /** Whether this is a cross-lane connector */
  crossLane: boolean;
  /** Dashed for cross-lane, solid for same-lane */
  dashed: boolean;
};

/** Time group separator in the graph */
export type TimeGroupSeparator = {
  label: string;
  y: number;
};

/** Complete computed layout for the graph */
export type GraphLayout = {
  /** Total height of the graph content */
  totalHeight: number;
  /** Width of the graph column area */
  graphWidth: number;
  /** Lane tracks (columns) */
  tracks: LaneTrack[];
  /** Node positions for all visible events */
  nodes: NodePosition[];
  /** Connector lines */
  connectors: ConnectorPath[];
  /** Time group separators */
  separators: TimeGroupSeparator[];
  /** Column width in px */
  columnWidth: number;
  /** Row height in px */
  rowHeight: number;
};

// ── Filter State ─────────────────────────────────────────────────

export type TimeRange = "1h" | "today" | "week" | "month" | "all";

export type TimelineFilters = {
  /** Selected lane IDs (empty = all) */
  laneIds: string[];
  /** Active event categories (empty = all) */
  categories: EventCategory[];
  /** Status filter (empty = all) */
  statuses: Array<"running" | "succeeded" | "failed" | "canceled">;
  /** Time range */
  timeRange: TimeRange;
  /** Search query (fuzzy match against labels/kinds) */
  searchQuery: string;
};

// ── Solo/Hide State ──────────────────────────────────────────────

export type LaneVisibility = {
  /** Lane IDs that are explicitly hidden */
  hiddenLaneIds: Set<string>;
  /** Lane IDs that are soloed (if any are soloed, only those show) */
  soloedLaneIds: Set<string>;
};

// ── Column Configuration ─────────────────────────────────────────

export type TimelineColumn =
  | "timestamp"
  | "graph"
  | "event"
  | "lane"
  | "author"
  | "status"
  | "duration"
  | "sha";

export type ColumnConfig = {
  id: TimelineColumn;
  label: string;
  /** Default width in px (0 = flex) */
  width: number;
  /** Whether this column is visible */
  visible: boolean;
  /** Whether this column is sortable */
  sortable: boolean;
};

export const DEFAULT_COLUMNS: ColumnConfig[] = [
  { id: "timestamp", label: "Time",     width: 72,  visible: true,  sortable: true },
  { id: "graph",     label: "Graph",    width: 0,   visible: true,  sortable: false },
  { id: "event",     label: "Event",    width: 0,   visible: true,  sortable: true },
  { id: "lane",      label: "Lane",     width: 100, visible: true,  sortable: true },
  { id: "author",    label: "Author",   width: 80,  visible: false, sortable: true },
  { id: "status",    label: "Status",   width: 80,  visible: true,  sortable: true },
  { id: "duration",  label: "Duration", width: 64,  visible: false, sortable: true },
  { id: "sha",       label: "SHA",      width: 72,  visible: false, sortable: false },
];

// ── WIP (Work in Progress) Node ──────────────────────────────────

export type WIPNode = {
  laneId: string;
  laneName: string;
  operations: OperationRecord[];
  color: string;
};

// ── Event Relationship ───────────────────────────────────────────

export type EventRelationship = {
  sourceEventId: string;
  targetEventId: string;
  /** Type of relationship */
  type: "caused" | "followed" | "related";
};

// ── Minimap Data ─────────────────────────────────────────────────

export type MinimapBucket = {
  /** Start time of the bucket */
  startTime: number;
  /** End time of the bucket */
  endTime: number;
  /** Number of events in this bucket */
  count: number;
  /** Breakdown by category */
  categories: Partial<Record<EventCategory, number>>;
};
