import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clock } from "@phosphor-icons/react";
import { EmptyState } from "@ade-dev/ui";

import type { PluginWebviewContext } from "../bridge";
import { HistorySplit } from "../components/HistorySplit";
import { getLanes, lookupCommit } from "../host/actions";
import { useHostRefresh } from "../host/refresh";
import { useHostSubscription } from "../host/useHostSubscription";
import {
  DETAIL_DEFAULT_PX,
  loadHistoryUiState,
  saveHistoryUiState,
  type HistoryUiState,
} from "../host/uiState";
import { openLink } from "../host/ui";
import { applyHistoryPath, historyFocusFromContext } from "../lib/historyFocus";
import { laneDeeplink, pathToDeeplink } from "../lib/deeplinks";
import type { HistoryLane, GitCommitSummary } from "../lib/types";
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
import { shouldHydrateCommitShaFromUrl } from "./historyUrlHydration";
import type { TimelineEvent } from "./timelineTypes";

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

export const HISTORY_HOST_KINDS = ["lane", "operation"] as const;

export function HistoryPage({
  context,
  active = true,
}: {
  context: PluginWebviewContext;
  active?: boolean;
}): React.ReactElement {
  const storeRef = useRef<TimelineStoreApi | null>(null);
  if (!storeRef.current) {
    storeRef.current = createTimelineStore();
  }
  return (
    <TimelineStoreProvider store={storeRef.current}>
      <HistoryPageContent context={context} active={active} />
    </TimelineStoreProvider>
  );
}

function HistoryPageContent({
  context,
  active = true,
}: {
  context: PluginWebviewContext;
  active?: boolean;
}): React.ReactElement {
  const projectRoot = context.project?.root ?? null;
  const [lanes, setLanes] = useState<HistoryLane[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [detailPx, setDetailPx] = useState(DETAIL_DEFAULT_PX);
  const [commitRefreshToken, setCommitRefreshToken] = useState(0);
  const [commitOnLaneHistory, setCommitOnLaneHistory] = useState(true);
  const [selectedCommitLaneId, setSelectedCommitLaneId] = useState<string | null>(null);

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

  const reloadLanes = useCallback(async () => {
    const listed = await getLanes();
    setLanes(listed);
    return listed;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const listed = await reloadLanes().catch(() => [] as HistoryLane[]);
      if (cancelled) return;
      const stored = await loadHistoryUiState(projectRoot);
      if (cancelled) return;
      const host = historyFocusFromContext(context);
      const nextSurface: HistoryUiState["surface"] = host.surface ?? stored.surface;
      const nextLane = pickLane(listed, host.laneId ?? stored.focusLaneId);
      const nextCommit = host.commitSha ?? (nextSurface === "commits" ? stored.selectedCommitSha : null);
      const nextEvent = host.eventId ?? (nextSurface === "activity" ? stored.selectedEventId : null);
      setSurface(nextSurface);
      if (nextLane) setFocusLaneId(nextLane);
      if (nextCommit && shouldHydrateCommitShaFromUrl({
        commitSha: nextCommit,
        requestedSurface: nextSurface,
        selectedCommitSha: null,
        focusLaneChanged: true,
      })) {
        setSelectedCommitSha(nextCommit);
      }
      if (nextEvent && nextSurface === "activity") setSelectedEventId(nextEvent);
      setDetailPx(stored.detailPx);
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [context, projectRoot, reloadLanes, setFocusLaneId, setSelectedCommitSha, setSelectedEventId, setSurface]);

  useEffect(() => {
    if (!hydrated) return;
    void saveHistoryUiState(projectRoot, {
      surface,
      focusLaneId,
      selectedCommitSha: surface === "commits" ? selectedCommitSha : null,
      selectedEventId: surface === "activity" ? selectedEventId : null,
      detailPx,
    });
  }, [detailPx, focusLaneId, hydrated, projectRoot, selectedCommitSha, selectedEventId, surface]);

  useHostSubscription([...HISTORY_HOST_KINDS], (frame) => {
    if (frame.kind === "lane") void reloadLanes();
    if (frame.kind === "operation") void fetchEvents({ silent: true });
  });

  useHostRefresh(() => {
    void reloadLanes();
    void fetchEvents({ silent: true });
    setCommitRefreshToken((token) => token + 1);
  });

  useEffect(() => {
    if (!active || surface === "commits") return;
    void fetchEvents();
  }, [active, surface, fetchEvents]);

  useEffect(() => {
    if (!active || surface !== "activity") return;
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
    const selectedCommitIsCurrentLane =
      selectedCommit?.sha === selectedCommitSha &&
      selectedCommitLaneId === focusLaneId;
    if (!active || !focusLaneId || !selectedCommitSha || selectedCommitIsCurrentLane) {
      if (!selectedCommitSha) {
        setCommitOnLaneHistory(true);
        setSelectedCommitLaneId(null);
      }
      return;
    }
    let cancelled = false;
    void lookupCommit(focusLaneId, selectedCommitSha)
      .then((result) => {
        if (cancelled) return;
        setCommitOnLaneHistory(result.inLaneHistory);
        setSelectedCommitLaneId(focusLaneId);
        if (result.commit) setSelectedCommit(result.commit);
      })
      .catch(() => {
        if (!cancelled) {
          setCommitOnLaneHistory(false);
          setSelectedCommitLaneId(focusLaneId);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active, focusLaneId, selectedCommitLaneId, selectedCommitSha, selectedCommit?.sha, setSelectedCommit]);

  const applyFocus = useCallback((focus: { surface: HistoryUiState["surface"] | null; laneId: string | null; commitSha: string | null; eventId: string | null }) => {
    if (focus.surface) setSurface(focus.surface);
    if (focus.laneId) setFocusLaneId(focus.laneId);
    if (focus.commitSha) {
      setSelectedCommitSha(focus.commitSha);
      setSelectedEventId(null);
      setSurface("commits");
    }
    if (focus.eventId) {
      setSelectedEventId(focus.eventId);
      setSelectedCommit(null);
      setSurface("activity");
    }
  }, [setFocusLaneId, setSelectedCommit, setSelectedCommitSha, setSelectedEventId, setSurface]);

  const handleNavigate = useCallback((path: string) => {
    const inPage = applyHistoryPath(path);
    if (inPage) {
      applyFocus(inPage);
      return;
    }
    const deeplink = pathToDeeplink(path);
    if (deeplink) void openLink(deeplink);
  }, [applyFocus]);

  const handleSelectEvent = useCallback(
    (id: string) => {
      setSelectedEventId(id);
      setSelectedCommit(null);
    },
    [setSelectedEventId, setSelectedCommit],
  );

  const handleSelectCommit = useCallback(
    (commit: GitCommitSummary) => {
      setSelectedCommit(commit);
      setSelectedEventId(null);
    },
    [setSelectedCommit, setSelectedEventId],
  );

  const handleCloseDetail = useCallback(() => {
    setSelectedEventId(null);
    setSelectedCommit(null);
  }, [setSelectedEventId, setSelectedCommit]);

  const handleNavigateToLane = useCallback((laneId: string) => {
    void openLink(laneDeeplink(laneId));
  }, []);

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
      .map((op) => events.find((e) => e.id === op.id))
      .filter((e): e is TimelineEvent => e != null);
  }, [selectedCommitSha, rawEvents, events]);

  const focusLane = lanes.find((l) => l.id === focusLaneId) ?? null;
  const focusLaneHasWorktree = Boolean(focusLane?.worktreePath?.trim());

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
        laneHasWorktree={focusLaneHasWorktree}
        selectedSha={selectedCommitSha}
        onSelectCommit={handleSelectCommit}
        active={active}
        refreshToken={rawEvents.length + commitRefreshToken}
        navigate={handleNavigate}
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
      default: {
        const _exhaustive: never = viewMode;
        void _exhaustive;
        timelineBody = null;
      }
    }
  }

  const detailBody =
    surface === "commits" ? (
      <Suspense fallback={panelFallback}>
        <CommitDetailPanel
          laneId={focusLaneId}
          laneHasWorktree={focusLaneHasWorktree}
          commit={selectedCommit}
          commitOnLaneHistory={commitOnLaneHistory}
          relatedEvents={relatedEventsForCommit}
          onClose={handleCloseDetail}
          onNavigateToLane={handleNavigateToLane}
          navigate={handleNavigate}
        />
      </Suspense>
    ) : (
      <Suspense fallback={panelFallback}>
        <EventDetailPanel
          event={selectedEvent}
          onClose={handleCloseDetail}
          onNavigateToLane={handleNavigateToLane}
          navigate={handleNavigate}
        />
      </Suspense>
    );

  return (
    <div
      className="flex h-full min-w-0 flex-col bg-bg"
      data-ade-history-view={surface}
      data-ade-history-lane={focusLaneId ?? ""}
    >
      <HistorySplit
        detailPx={detailPx}
        onDetailPx={setDetailPx}
        onDetailPxCommit={setDetailPx}
        timeline={(
          <div className="flex min-h-0 flex-1 flex-col">
            <TimelineToolbar
              lanes={lanes}
              onCommitGitActionComplete={() => setCommitRefreshToken((value) => value + 1)}
              navigate={handleNavigate}
            />
            {timelineBody}
          </div>
        )}
        detail={detailBody}
      />
    </div>
  );
}

function pickLane(lanes: HistoryLane[], wanted: string | null): string | null {
  if (wanted && lanes.some((lane) => lane.id === wanted)) return wanted;
  return lanes[0]?.id ?? wanted;
}
