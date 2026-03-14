import React, { useRef } from "react";
import { EventNode } from "./EventNode";
import { LaneTrack } from "./LaneTrack";
import { ConnectorLine } from "./ConnectorLine";
import { WIPRow } from "./WIPRow";
import { TimelineRow } from "./TimelineRow";
import {
  useTimelineLayout,
  ROW_HEIGHT,
  COLUMN_WIDTH,
  GRAPH_PADDING_LEFT,
} from "./useTimelineLayout";
import type { TimelineEvent, WIPNode } from "./timelineTypes";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type TimelineGraphProps = {
  events: TimelineEvent[];
  lanes: Array<{ id: string; name: string; color: string | null }>;
  wipNodes: WIPNode[];
  selectedEventId: string | null;
  hoveredLaneId: string | null;
  onSelectEvent: (id: string) => void;
  onHoverLane: (id: string | null) => void;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TimelineGraph({
  events,
  lanes,
  wipNodes,
  selectedEventId,
  hoveredLaneId,
  onSelectEvent,
  onHoverLane,
}: TimelineGraphProps) {
  const layout = useTimelineLayout(events, lanes, wipNodes);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ---- Empty state --------------------------------------------------------

  if (events.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--color-muted-fg)] font-mono text-[11px]">
        No events match the current filters
      </div>
    );
  }

  // ---- Render -------------------------------------------------------------

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* WIP Row – pinned at top, above the headers */}
      {wipNodes.length > 0 && <WIPRow wipNodes={wipNodes} />}

      {/* Column Headers */}
      <div className="flex items-center border-b border-white/[0.06] bg-white/[0.02] backdrop-blur-xl shrink-0">
        {/* Graph-area lane indicators */}
        <div className="shrink-0" style={{ width: layout.graphWidth }}>
          <div
            className="flex items-center h-8"
            style={{ paddingLeft: GRAPH_PADDING_LEFT }}
          >
            {layout.tracks.map((track) => (
              <div
                key={track.laneId}
                className="flex items-center justify-center"
                style={{ width: COLUMN_WIDTH }}
                title={track.laneName}
                onMouseEnter={() => onHoverLane(track.laneId)}
                onMouseLeave={() => onHoverLane(null)}
              >
                <div
                  className="w-[8px] h-[8px]"
                  style={{ backgroundColor: track.color }}
                />
              </div>
            ))}
          </div>
        </div>

        {/* Summary column labels */}
        <div className="flex items-center flex-1 h-8 px-2 gap-3">
          <span className="font-sans text-[9px] font-bold uppercase tracking-[1px] text-[var(--color-muted-fg)] w-[60px]">
            Time
          </span>
          <span className="font-sans text-[9px] font-bold uppercase tracking-[1px] text-[var(--color-muted-fg)] flex-1">
            Event
          </span>
          <span className="font-sans text-[9px] font-bold uppercase tracking-[1px] text-[var(--color-muted-fg)] w-[80px]">
            Lane
          </span>
          <span className="font-sans text-[9px] font-bold uppercase tracking-[1px] text-[var(--color-muted-fg)] w-[48px]">
            Status
          </span>
        </div>
      </div>

      {/* Scrollable Content – graph + summary side-by-side */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden">
        <div className="flex" style={{ minHeight: layout.totalHeight }}>
          {/* ---- SVG Graph Area ---- */}
          <div
            className="shrink-0 relative"
            style={{ width: layout.graphWidth }}
          >
            <svg
              width={layout.graphWidth}
              height={layout.totalHeight}
              className="absolute inset-0"
            >
              {/* Lane track vertical lines */}
              {layout.tracks.map((track) => {
                const x =
                  GRAPH_PADDING_LEFT +
                  track.columnIndex * COLUMN_WIDTH +
                  COLUMN_WIDTH / 2;
                const dimmed =
                  hoveredLaneId != null && hoveredLaneId !== track.laneId;
                return (
                  <LaneTrack
                    key={track.laneId}
                    x={x}
                    y1={0}
                    y2={layout.totalHeight}
                    color={track.color}
                    dimmed={dimmed}
                  />
                );
              })}

              {/* Connector lines between related events */}
              {layout.connectors.map((conn) => {
                const dimmed = hoveredLaneId != null;
                return (
                  <ConnectorLine
                    key={conn.id}
                    d={conn.d}
                    color={conn.color}
                    dashed={conn.dashed}
                    dimmed={dimmed}
                  />
                );
              })}

              {/* Time-group separator lines */}
              {layout.separators.map((sep, i) => (
                <line
                  key={i}
                  x1={0}
                  y1={sep.y}
                  x2={layout.graphWidth}
                  y2={sep.y}
                  stroke="var(--color-border)"
                  strokeWidth={0.5}
                  strokeDasharray="4 4"
                  opacity={0.2}
                />
              ))}

              {/* Event nodes */}
              {layout.nodes.map((node) => {
                const event = events.find((e) => e.id === node.eventId);
                if (!event) return null;
                const isSelected = node.eventId === selectedEventId;
                const isRunning = event.status === "running";
                return (
                  <EventNode
                    key={node.eventId}
                    x={node.x}
                    y={node.y}
                    shape={node.shape}
                    color={node.color}
                    selected={isSelected}
                    running={isRunning}
                    onClick={() => onSelectEvent(node.eventId)}
                  />
                );
              })}
            </svg>
          </div>

          {/* ---- Event Summary Rows ---- */}
          <div className="flex-1 min-w-0">
            {events.map((event, i) => {
              const nodeY = layout.nodes[i]?.y ?? 0;
              const sep = layout.separators.find(
                (s) => Math.abs(s.y - nodeY + ROW_HEIGHT / 2) < 1,
              );
              const track = layout.tracks.find(
                (t) => t.laneId === (event.laneId ?? "__project__"),
              );
              const dimmed =
                hoveredLaneId != null && event.laneId !== hoveredLaneId;

              return (
                <React.Fragment key={event.id}>
                  {sep && i > 0 && (
                    <div className="flex items-center h-5 px-2 border-t border-white/[0.04]">
                      <span className="font-mono text-[9px] text-[var(--color-muted-fg)]/50 uppercase tracking-[1px]">
                        {sep.label}
                      </span>
                    </div>
                  )}
                  <TimelineRow
                    event={event}
                    selected={event.id === selectedEventId}
                    dimmed={dimmed}
                    laneColor={track?.color ?? "#8B8B9A"}
                    onClick={() => onSelectEvent(event.id)}
                    onMouseEnter={() =>
                      event.laneId ? onHoverLane(event.laneId) : undefined
                    }
                    onMouseLeave={() => onHoverLane(null)}
                  />
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
