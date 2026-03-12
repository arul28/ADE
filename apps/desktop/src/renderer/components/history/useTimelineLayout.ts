import { useMemo } from "react";
import type {
  ConnectorPath,
  GraphLayout,
  LaneTrack,
  NodePosition,
  TimeGroupSeparator,
  TimelineEvent,
  WIPNode,
} from "./timelineTypes";
import type { NodeShape } from "./eventTaxonomy";
import { getLaneTrackColor } from "./eventTaxonomy";

// ── Constants ────────────────────────────────────────────────────
export const ROW_HEIGHT = 40;
export const COLUMN_WIDTH = 28;
export const NODE_RADIUS = 6;
export const TRACK_LINE_WIDTH = 1.5;
export const GRAPH_PADDING_LEFT = 12;
export const GRAPH_PADDING_TOP = 8;

// ── Time grouping helpers ────────────────────────────────────────

function getTimeGroup(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "Unknown";
  const now = new Date();
  const date = new Date(ts);
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  const startOfWeek = startOfToday - now.getDay() * 86_400_000;
  const startOfMonth = new Date(
    now.getFullYear(),
    now.getMonth(),
    1,
  ).getTime();

  if (ts >= startOfToday) return "Today";
  if (ts >= startOfYesterday) return "Yesterday";
  if (ts >= startOfWeek) return "This Week";
  if (ts >= startOfMonth) return "This Month";
  return date.toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
  });
}

// ── SVG path helpers ─────────────────────────────────────────────

/** Straight vertical connector between two nodes on the same track. */
function straightPath(x: number, y1: number, y2: number): string {
  return `M${x} ${y1} L${x} ${y2}`;
}

/** Bezier curve connector between two nodes on different tracks. */
function crossLanePath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): string {
  const midY = (y1 + y2) / 2;
  return `M${x1} ${y1} C${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
}

// ── Main Hook ────────────────────────────────────────────────────

export function useTimelineLayout(
  events: TimelineEvent[],
  lanes: Array<{ id: string; name: string; color: string | null }>,
  wipNodes: WIPNode[],
): GraphLayout {
  return useMemo(() => {
    if (events.length === 0) {
      return {
        totalHeight: 0,
        graphWidth: 0,
        tracks: [],
        nodes: [],
        connectors: [],
        separators: [],
        columnWidth: COLUMN_WIDTH,
        rowHeight: ROW_HEIGHT,
      };
    }

    // ── 1. Build lane tracks (columns) ──────────────────────
    const laneIdSet = new Set<string>();
    for (const e of events) {
      if (e.laneId) laneIdSet.add(e.laneId);
    }

    const tracks: LaneTrack[] = [];
    let colIdx = 0;
    const laneToCol = new Map<string, number>();

    for (const lane of lanes) {
      if (laneIdSet.has(lane.id)) {
        const color = getLaneTrackColor(lane.color, colIdx);
        tracks.push({
          laneId: lane.id,
          laneName: lane.name,
          color,
          columnIndex: colIdx,
          visible: true,
          soloed: false,
        });
        laneToCol.set(lane.id, colIdx);
        colIdx++;
      }
    }

    // Add any lane IDs from events that weren't in the lanes array
    for (const lid of laneIdSet) {
      if (!laneToCol.has(lid)) {
        const color = getLaneTrackColor(null, colIdx);
        tracks.push({
          laneId: lid,
          laneName: lid,
          color,
          columnIndex: colIdx,
          visible: true,
          soloed: false,
        });
        laneToCol.set(lid, colIdx);
        colIdx++;
      }
    }

    // Project-level track (rightmost)
    const hasProjectEvents = events.some((e) => !e.laneId);
    const projectColIdx = colIdx;
    if (hasProjectEvents) {
      tracks.push({
        laneId: "__project__",
        laneName: "Project",
        color: "#8B8B9A",
        columnIndex: projectColIdx,
        visible: true,
        soloed: false,
      });
      colIdx++;
    }

    const totalCols = colIdx;
    const graphWidth =
      GRAPH_PADDING_LEFT + totalCols * COLUMN_WIDTH + GRAPH_PADDING_LEFT;

    // ── 2. Compute node positions ───────────────────────────
    const nodes: NodePosition[] = [];
    let currentGroup = "";
    const separators: TimeGroupSeparator[] = [];

    // Reserve space at top for running operations
    const wipRowCount = wipNodes.length > 0 ? 1 : 0;
    const wipOffset = wipRowCount * ROW_HEIGHT;

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const y =
        GRAPH_PADDING_TOP + wipOffset + i * ROW_HEIGHT + ROW_HEIGHT / 2;
      const col = e.laneId
        ? (laneToCol.get(e.laneId) ?? projectColIdx)
        : projectColIdx;
      const x = GRAPH_PADDING_LEFT + col * COLUMN_WIDTH + COLUMN_WIDTH / 2;

      const track = tracks[col];
      nodes.push({
        eventId: e.id,
        x,
        y,
        columnIndex: col,
        color: track?.color ?? "#8B8B9A",
        shape: e.shape,
      });

      // Time group separator
      const group = getTimeGroup(e.startedAt);
      if (group !== currentGroup) {
        currentGroup = group;
        separators.push({
          label: group,
          y: y - ROW_HEIGHT / 2,
        });
      }
    }

    // ── 3. Compute connector lines ──────────────────────────
    const connectors: ConnectorPath[] = [];
    const lastNodeByLane = new Map<string, NodePosition>();

    for (const node of nodes) {
      const event = events.find((e) => e.id === node.eventId);
      if (!event) continue;
      const laneKey = event.laneId ?? "__project__";
      const prev = lastNodeByLane.get(laneKey);

      if (prev) {
        const isSameCol = prev.columnIndex === node.columnIndex;
        connectors.push({
          id: `${prev.eventId}->${node.eventId}`,
          fromEventId: prev.eventId,
          toEventId: node.eventId,
          d: isSameCol
            ? straightPath(prev.x, prev.y + NODE_RADIUS, node.y - NODE_RADIUS)
            : crossLanePath(
                prev.x,
                prev.y + NODE_RADIUS,
                node.x,
                node.y - NODE_RADIUS,
              ),
          color: node.color,
          crossLane: !isSameCol,
          dashed: !isSameCol,
        });
      }

      lastNodeByLane.set(laneKey, node);
    }

    const totalHeight =
      GRAPH_PADDING_TOP +
      wipOffset +
      events.length * ROW_HEIGHT +
      GRAPH_PADDING_TOP;

    return {
      totalHeight,
      graphWidth,
      tracks,
      nodes,
      connectors,
      separators,
      columnWidth: COLUMN_WIDTH,
      rowHeight: ROW_HEIGHT,
    };
  }, [events, lanes, wipNodes]);
}
