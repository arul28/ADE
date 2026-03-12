import React, { useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Clock } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import { EmptyState } from "../ui/EmptyState";
import {
  PaneTilingLayout,
  type PaneConfig,
  type PaneSplit,
} from "../ui/PaneTilingLayout";
import { TimelineToolbar } from "./TimelineToolbar";
import { TimelineGraph } from "./TimelineGraph";
import { TimelineListView } from "./TimelineListView";
import { TimelineCompactView } from "./TimelineCompactView";
import { EventDetailPanel } from "./EventDetailPanel";
import { useTimelineStore } from "./useTimelineStore";
import type { TimelineEvent } from "./timelineTypes";

// ── Tiling layout tree (same split pattern as before) ────────────
const HISTORY_TILING_TREE: PaneSplit = {
  type: "split",
  direction: "horizontal",
  children: [
    { node: { type: "pane", id: "timeline" }, defaultSize: 60, minSize: 30 },
    { node: { type: "pane", id: "detail" }, defaultSize: 40, minSize: 20 },
  ],
};

export function HistoryPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // ── Store state ─────────────────────────────────────────────
  const events = useTimelineStore((s) => s.events);
  const wipNodes = useTimelineStore((s) => s.wipNodes);
  const viewMode = useTimelineStore((s) => s.viewMode);
  const selectedEventId = useTimelineStore((s) => s.selectedEventId);
  const hoveredLaneId = useTimelineStore((s) => s.hoveredLaneId);
  const loading = useTimelineStore((s) => s.loading);
  const error = useTimelineStore((s) => s.error);
  const fetchEvents = useTimelineStore((s) => s.fetchEvents);
  const setSelectedEventId = useTimelineStore((s) => s.setSelectedEventId);
  const setHoveredLaneId = useTimelineStore((s) => s.setHoveredLaneId);

  // ── App-level state (lanes) ─────────────────────────────────
  const lanes = useAppStore((s) => s.lanes ?? []);

  // ── Initial fetch & auto-refresh ───────────────────────────
  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  // Auto-refresh every 2.5s if any operations are running
  useEffect(() => {
    const hasRunning = events.some((e) => e.status === "running");
    if (!hasRunning) return;
    const interval = setInterval(() => fetchEvents(), 2500);
    return () => clearInterval(interval);
  }, [events, fetchEvents]);

  // ── URL sync: read selectedEventId from search params ──────
  useEffect(() => {
    const eventId = searchParams.get("eventId");
    if (eventId && eventId !== selectedEventId) {
      setSelectedEventId(eventId);
    }
  }, [searchParams, selectedEventId, setSelectedEventId]);

  // ── Handlers ───────────────────────────────────────────────
  const handleSelectEvent = useCallback(
    (id: string) => {
      setSelectedEventId(id);
      setSearchParams((prev) => {
        prev.set("eventId", id);
        return prev;
      });
    },
    [setSelectedEventId, setSearchParams],
  );

  const handleCloseDetail = useCallback(() => {
    setSelectedEventId(null);
    setSearchParams((prev) => {
      prev.delete("eventId");
      return prev;
    });
  }, [setSelectedEventId, setSearchParams]);

  const handleNavigateToLane = useCallback(
    (laneId: string) => {
      navigate(`/lanes?laneId=${laneId}`);
    },
    [navigate],
  );

  // ── Selected event object ──────────────────────────────────
  const selectedEvent: TimelineEvent | null = selectedEventId
    ? (events.find((e) => e.id === selectedEventId) ?? null)
    : null;

  // ── Lane data for graph ────────────────────────────────────
  const laneData = lanes.map((l) => ({
    id: l.id,
    name: l.name,
    color: l.color ?? null,
  }));

  // ── Timeline content (switches by view mode) ──────────────
  let timelineBody: React.ReactNode;

  if (loading && events.length === 0) {
    timelineBody = (
      <EmptyState
        icon={Clock}
        title="Loading timeline…"
        description="Fetching operations history"
      />
    );
  } else if (error) {
    timelineBody = (
      <EmptyState icon={Clock} title="Failed to load" description={error} />
    );
  } else if (events.length === 0) {
    timelineBody = (
      <EmptyState
        icon={Clock}
        title="No events yet"
        description="Operations will appear here as you work"
      />
    );
  } else {
    switch (viewMode) {
      case "graph":
        timelineBody = (
          <TimelineGraph
            events={events}
            lanes={laneData}
            wipNodes={wipNodes}
            selectedEventId={selectedEventId}
            hoveredLaneId={hoveredLaneId}
            onSelectEvent={handleSelectEvent}
            onHoverLane={setHoveredLaneId}
          />
        );
        break;
      case "list":
        timelineBody = (
          <TimelineListView
            events={events}
            selectedEventId={selectedEventId}
            onSelectEvent={handleSelectEvent}
          />
        );
        break;
      case "compact":
        timelineBody = (
          <TimelineCompactView
            events={events}
            selectedEventId={selectedEventId}
            onSelectEvent={handleSelectEvent}
          />
        );
        break;
    }
  }

  // ── Pane configs for PaneTilingLayout ──────────────────────
  const paneConfigs: Record<string, PaneConfig> = {
    timeline: {
      title: "Timeline",
      icon: Clock,
      bodyClassName: "flex flex-col",
      children: (
        <div className="flex flex-col flex-1 min-h-0">
          <TimelineToolbar />
          {timelineBody}
        </div>
      ),
    },
    detail: {
      title: "Event Detail",
      icon: Clock,
      bodyClassName: "flex flex-col",
      children: (
        <EventDetailPanel
          event={selectedEvent}
          onClose={handleCloseDetail}
          onNavigateToLane={handleNavigateToLane}
        />
      ),
    },
  };

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      <PaneTilingLayout
        layoutId="history:tiling:v2"
        tree={HISTORY_TILING_TREE}
        panes={paneConfigs}
        className="flex-1 min-h-0"
      />
    </div>
  );
}
