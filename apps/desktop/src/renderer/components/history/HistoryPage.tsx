import React, { Suspense, useEffect, useCallback, useRef, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Clock, GitBranch } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import { EmptyState } from "../ui/EmptyState";
import {
  PaneTilingLayout,
  type PaneConfig,
  type PaneSplit,
} from "../ui/PaneTilingLayout";
import { TimelineToolbar } from "./TimelineToolbar";
import { TimelineListView } from "./TimelineListView";
import { TimelineCompactView } from "./TimelineCompactView";
import { CommitHistoryView } from "./CommitHistoryView";
import {
  TimelineStoreProvider,
  createTimelineStore,
  useTimelineStore,
  type TimelineStoreApi,
} from "./useTimelineStore";
import type { TimelineEvent } from "./timelineTypes";
import type { GitCommitSummary } from "../../../shared/types";

const TimelineGraph = React.lazy(async () => {
  const mod = await import("./TimelineGraph");
  return { default: mod.TimelineGraph };
});

const EventDetailPanel = React.lazy(async () => {
  const mod = await import("./EventDetailPanel");
  return { default: mod.EventDetailPanel };
});

const CommitDetailPanel = React.lazy(async () => {
  const mod = await import("./CommitDetailPanel");
  return { default: mod.CommitDetailPanel };
});

const HISTORY_TILING_TREE: PaneSplit = {
  type: "split",
  direction: "horizontal",
  children: [
    { node: { type: "pane", id: "timeline" }, defaultSize: 60, minSize: 30 },
    { node: { type: "pane", id: "detail" }, defaultSize: 40, minSize: 20 },
  ],
};

export function HistoryPage({ active = true }: { active?: boolean } = {}) {
  const storeRef = useRef<TimelineStoreApi | null>(null);
  if (!storeRef.current) {
    storeRef.current = createTimelineStore();
  }
  return (
    <TimelineStoreProvider store={storeRef.current}>
      <HistoryPageContent active={active} />
    </TimelineStoreProvider>
  );
}

function HistoryPageContent({ active = true }: { active?: boolean } = {}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const syncingFromUrlRef = useRef(false);
  const lastWrittenUrlRef = useRef<string>("");
  const [commitRefreshToken, setCommitRefreshToken] = useState(0);

  const events = useTimelineStore((s) => s.events);
  const rawEvents = useTimelineStore((s) => s.rawEvents);
  const wipNodes = useTimelineStore((s) => s.wipNodes);
  const viewMode = useTimelineStore((s) => s.viewMode);
  const surface = useTimelineStore((s) => s.surface);
  const focusLaneId = useTimelineStore((s) => s.focusLaneId);
  const selectedCommitSha = useTimelineStore((s) => s.selectedCommitSha);
  const selectedCommit = useTimelineStore((s) => s.selectedCommit);
  const selectedEventId = useTimelineStore((s) => s.selectedEventId);
  const hoveredLaneId = useTimelineStore((s) => s.hoveredLaneId);
  const columns = useTimelineStore((s) => s.columns);
  const loading = useTimelineStore((s) => s.loading);
  const error = useTimelineStore((s) => s.error);
  const fetchEvents = useTimelineStore((s) => s.fetchEvents);
  const setSelectedEventId = useTimelineStore((s) => s.setSelectedEventId);
  const setSelectedCommit = useTimelineStore((s) => s.setSelectedCommit);
  const setSelectedCommitSha = useTimelineStore((s) => s.setSelectedCommitSha);
  const setFocusLaneId = useTimelineStore((s) => s.setFocusLaneId);
  const setSurface = useTimelineStore((s) => s.setSurface);
  const setHoveredLaneId = useTimelineStore((s) => s.setHoveredLaneId);

  const lanes = useAppStore((s) => s.lanes ?? []);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);

  // Hydrate store from URL (single effect to avoid sync loops)
  useEffect(() => {
    if (!active) return;
    const paramsKey = searchParams.toString();
    if (paramsKey === lastWrittenUrlRef.current) return;

    syncingFromUrlRef.current = true;

    const surfaceFromUrl = searchParams.get("surface");
    const requestedSurface =
      surfaceFromUrl === "activity" || surfaceFromUrl === "commits"
        ? surfaceFromUrl
        : null;
    const cleanedParams = new URLSearchParams(searchParams);
    let cleanedUrl = false;

    if (surfaceFromUrl === "activity" || surfaceFromUrl === "commits") {
      setSurface(surfaceFromUrl);
    } else if (surfaceFromUrl != null) {
      // Strip unrecognized surface values so we fall back to the store default.
      cleanedParams.delete("surface");
      cleanedUrl = true;
    }

    const laneFromUrl = searchParams.get("laneId");
    const laneIsKnown = laneFromUrl != null && lanes.some((l) => l.id === laneFromUrl);
    if (laneFromUrl && laneIsKnown) {
      if (focusLaneId !== laneFromUrl) setFocusLaneId(laneFromUrl);
    } else {
      if (laneFromUrl && !laneIsKnown && lanes.length > 0) {
        // Lane referenced in URL no longer exists — strip it and the dependent commit hash.
        cleanedParams.delete("laneId");
        cleanedParams.delete("commitSha");
        cleanedUrl = true;
      }
      if (!focusLaneId || !lanes.some((l) => l.id === focusLaneId)) {
        const fallback =
          (selectedLaneId && lanes.some((l) => l.id === selectedLaneId) ? selectedLaneId : null) ??
          lanes[0]?.id ??
          null;
        if (fallback && focusLaneId !== fallback) setFocusLaneId(fallback);
      }
    }

    const eventId = searchParams.get("eventId");
    if (eventId && requestedSurface === "commits") {
      cleanedParams.delete("eventId");
      cleanedUrl = true;
    } else if (eventId && eventId !== selectedEventId) {
      setSelectedEventId(eventId);
      setSurface("activity");
    }

    const commitSha = searchParams.get("commitSha");
    if (commitSha && requestedSurface === "activity") {
      cleanedParams.delete("commitSha");
      cleanedUrl = true;
    } else if (commitSha && commitSha !== selectedCommitSha) {
      setSelectedCommitSha(commitSha);
      setSurface("commits");
      if (laneFromUrl && lanes.some((l) => l.id === laneFromUrl)) {
        setFocusLaneId(laneFromUrl);
      }
    }

    if (cleanedUrl) {
      lastWrittenUrlRef.current = cleanedParams.toString();
      setSearchParams(cleanedParams, { replace: true });
    }

    queueMicrotask(() => {
      syncingFromUrlRef.current = false;
    });
  }, [
    active,
    lanes,
    selectedLaneId,
    focusLaneId,
    searchParams,
    selectedEventId,
    selectedCommitSha,
    setFocusLaneId,
    setSurface,
    setSelectedEventId,
    setSelectedCommitSha,
    setSearchParams,
  ]);

  useEffect(() => {
    if (!active || surface === "commits") return;
    void fetchEvents();
  }, [active, surface, fetchEvents]);

  useEffect(() => {
    if (!active || surface !== "activity") return;
    // Tight polling only refreshes the cheap operations feed; supplemental sources
    // Supplemental sources refresh on focus/visibility change instead.
    const tightRefresh = () => {
      if (document.visibilityState !== "visible") return;
      void fetchEvents({ silent: true, skipSupplemental: true });
    };
    const fullRefresh = () => {
      if (document.visibilityState !== "visible") return;
      void fetchEvents({ silent: true });
    };
    const hasRunning = events.some((e) => e.status === "running");
    const interval = hasRunning ? setInterval(tightRefresh, 4_000) : undefined;
    window.addEventListener("focus", fullRefresh);
    document.addEventListener("visibilitychange", fullRefresh);
    return () => {
      if (interval) clearInterval(interval);
      window.removeEventListener("focus", fullRefresh);
      document.removeEventListener("visibilitychange", fullRefresh);
    };
  }, [active, surface, events, fetchEvents]);

  useEffect(() => {
    if (!active || !focusLaneId || !selectedCommitSha || selectedCommit?.sha === selectedCommitSha) {
      return;
    }
    let cancelled = false;
    void window.ade.git
      .listRecentCommits({ laneId: focusLaneId, limit: 500 })
      .then(async (rows) => {
        if (cancelled) return;
        const found = rows.find((r) => r.sha === selectedCommitSha);
        if (found) {
          setSelectedCommit(found);
          return;
        }
        // Outside the loaded window — fall back to a targeted single-commit lookup.
        if (typeof window.ade.git.getCommit !== "function") return;
        try {
          const targeted = await window.ade.git.getCommit({
            laneId: focusLaneId,
            commitSha: selectedCommitSha,
          });
          if (!cancelled && targeted) setSelectedCommit(targeted);
        } catch {
          // Best-effort hydration; ignore failures.
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active, focusLaneId, selectedCommitSha, selectedCommit?.sha, setSelectedCommit]);

  useEffect(() => {
    if (!active || syncingFromUrlRef.current) return;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      let changed = false;
      if (next.get("surface") !== surface) {
        next.set("surface", surface);
        changed = true;
      }
      const laneParam = focusLaneId ?? "";
      if ((next.get("laneId") ?? "") !== laneParam) {
        if (laneParam) next.set("laneId", laneParam);
        else next.delete("laneId");
        changed = true;
      }
      const commitParam = selectedCommitSha ?? "";
      if (surface === "commits") {
        if (commitParam && next.get("commitSha") !== commitParam) {
          next.set("commitSha", commitParam);
          changed = true;
        } else if (!commitParam && next.has("commitSha")) {
          next.delete("commitSha");
          changed = true;
        }
      } else if (next.has("commitSha")) {
        next.delete("commitSha");
        changed = true;
      }
      const eventParam = selectedEventId ?? "";
      if (surface === "activity") {
        if (eventParam && next.get("eventId") !== eventParam) {
          next.set("eventId", eventParam);
          changed = true;
        } else if (!eventParam && next.has("eventId")) {
          next.delete("eventId");
          changed = true;
        }
      } else if (next.has("eventId")) {
        next.delete("eventId");
        changed = true;
      }
      if (!changed) return prev;
      lastWrittenUrlRef.current = next.toString();
      return next;
    }, { replace: true });
  }, [active, surface, focusLaneId, selectedCommitSha, selectedEventId, setSearchParams]);

  const handleSelectEvent = useCallback(
    (id: string) => {
      setSelectedEventId(id);
      setSelectedCommit(null);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("eventId", id);
        next.delete("commitSha");
        next.set("surface", "activity");
        lastWrittenUrlRef.current = next.toString();
        return next;
      });
    },
    [setSelectedEventId, setSelectedCommit, setSearchParams],
  );

  const handleSelectCommit = useCallback(
    (commit: GitCommitSummary) => {
      setSelectedCommit(commit);
      setSelectedEventId(null);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("commitSha", commit.sha);
        next.delete("eventId");
        next.set("surface", "commits");
        if (focusLaneId) next.set("laneId", focusLaneId);
        lastWrittenUrlRef.current = next.toString();
        return next;
      });
    },
    [setSelectedCommit, setSelectedEventId, setSearchParams, focusLaneId],
  );

  const handleCloseDetail = useCallback(() => {
    setSelectedEventId(null);
    setSelectedCommit(null);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("eventId");
      next.delete("commitSha");
      lastWrittenUrlRef.current = next.toString();
      return next;
    });
  }, [setSelectedEventId, setSelectedCommit, setSearchParams]);

  const handleNavigateToLane = useCallback(
    (laneId: string) => {
      navigate(`/lanes?laneId=${laneId}`);
    },
    [navigate],
  );

  const selectedEvent: TimelineEvent | null = selectedEventId
    ? (events.find((e) => e.id === selectedEventId) ?? null)
    : null;

  const relatedEventsForCommit = useMemo(() => {
    if (!selectedCommitSha) return [];
    return rawEvents
      .filter(
        (op) =>
          op.preHeadSha === selectedCommitSha ||
          op.postHeadSha === selectedCommitSha,
      )
      .map((op) => {
        const found = events.find((e) => e.id === op.id);
        return found;
      })
      .filter((e): e is TimelineEvent => e != null);
  }, [selectedCommitSha, rawEvents, events]);

  const focusLane = lanes.find((l) => l.id === focusLaneId) ?? null;

  const laneData = useMemo(
    () =>
      lanes.map((l) => ({
        id: l.id,
        name: l.name,
        color: l.color ?? null,
      })),
    [lanes],
  );

  const panelFallback = (
    <div className="flex flex-1 items-center justify-center font-mono text-[11px] text-muted-fg/40">
      Loading view…
    </div>
  );

  let timelineBody: React.ReactNode;

  if (surface === "commits") {
    timelineBody = (
      <CommitHistoryView
        laneId={focusLaneId}
        laneName={focusLane?.name ?? null}
        selectedSha={selectedCommitSha}
        onSelectCommit={handleSelectCommit}
        active={active}
        refreshToken={rawEvents.length + commitRefreshToken}
      />
    );
  } else if (loading && events.length === 0) {
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
        title={rawEvents.length > 0 ? "No matching events" : "No events yet"}
        description={
          rawEvents.length > 0
            ? "The current scope and filters hide all recorded activity"
            : "Operations will appear here as you work"
        }
      />
    );
  } else {
    switch (viewMode) {
      case "graph":
        timelineBody = (
          <Suspense fallback={panelFallback}>
            <TimelineGraph
              events={events}
              lanes={laneData}
              wipNodes={wipNodes}
              selectedEventId={selectedEventId}
              hoveredLaneId={hoveredLaneId}
              onSelectEvent={handleSelectEvent}
              onHoverLane={setHoveredLaneId}
            />
          </Suspense>
        );
        break;
      case "list":
        timelineBody = (
          <TimelineListView
            events={events}
            columns={columns}
            selectedEventId={selectedEventId}
            onSelectEvent={handleSelectEvent}
          />
        );
        break;
      case "compact":
        timelineBody = (
          <TimelineCompactView
            events={events}
            columns={columns}
            selectedEventId={selectedEventId}
            onSelectEvent={handleSelectEvent}
          />
        );
        break;
    }
  }

  const detailTitle = surface === "commits" ? "Commit" : "Event Detail";
  const detailBody =
    surface === "commits" ? (
      <Suspense fallback={panelFallback}>
        <CommitDetailPanel
          laneId={focusLaneId}
          commit={selectedCommit}
          relatedEvents={relatedEventsForCommit}
          onClose={handleCloseDetail}
          onNavigateToLane={handleNavigateToLane}
          navigate={(path) => navigate(path)}
        />
      </Suspense>
    ) : (
      <Suspense fallback={panelFallback}>
        <EventDetailPanel
          event={selectedEvent}
          onClose={handleCloseDetail}
          onNavigateToLane={handleNavigateToLane}
          navigate={(path) => navigate(path)}
        />
      </Suspense>
    );

  const paneConfigs: Record<string, PaneConfig> = {
    timeline: {
      title: surface === "commits" ? "Commit graph" : "Timeline",
      icon: Clock,
      bodyClassName: "flex flex-col",
      children: (
        <div className="flex min-h-0 flex-1 flex-col">
          <TimelineToolbar
            onCommitGitActionComplete={() => setCommitRefreshToken((value) => value + 1)}
          />
          {surface === "commits" ? (
            <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] bg-white/[0.02] px-3 py-1.5">
              <GitBranch size={14} className="shrink-0 text-accent" weight="bold" />
              <span className="font-sans text-[11px] font-bold uppercase tracking-[1px] text-muted-fg">
                Lane
              </span>
              <span className="truncate font-mono text-[12px] text-fg">
                {focusLane?.name ?? (focusLaneId ? focusLaneId : "Select a lane")}
              </span>
            </div>
          ) : null}
          {timelineBody}
        </div>
      ),
    },
    detail: {
      title: detailTitle,
      icon: Clock,
      bodyClassName: "flex flex-col",
      children: detailBody,
    },
  };

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      <PaneTilingLayout
        layoutId="history:tiling:v3"
        tree={HISTORY_TILING_TREE}
        panes={paneConfigs}
        className="min-h-0 flex-1"
      />
    </div>
  );
}
