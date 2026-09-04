import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clock, GitCommit } from "@phosphor-icons/react";
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
import {
  HISTORY_KEY_STATE,
  resolveHistoryKey,
  strokeTargetIsTyping,
  type HistoryKeyState,
} from "./historyKeymap";
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
  // Every placement of this page remembers its own surface, lane, selection and
  // divider. See `host/uiState.ts` — one row for three windows made them fight.
  const placement = context.placement ?? null;
  const [lanes, setLanes] = useState<HistoryLane[]>([]);
  const [hydrated, setHydrated] = useState(false);
  /** What the pane is drawn at right now, moved on every pointer frame. */
  const [detailPx, setDetailPx] = useState(DETAIL_DEFAULT_PX);
  /**
   * What has been agreed as the reader's width, moved once per drag.
   *
   * The persistence effect reads THIS. Passing the live setter to both halves
   * of the split wrote a `ui-state` row on every pointer frame — a hundred
   * round trips through the bridge for one drag of a divider.
   */
  const [committedDetailPx, setCommittedDetailPx] = useState(DETAIL_DEFAULT_PX);
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

  /** The lane the host named on this envelope, if it named one. */
  const hostFocusLaneId = useMemo(() => historyFocusFromContext(context).laneId, [context]);

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
      const stored = await loadHistoryUiState(projectRoot, placement);
      if (cancelled) return;
      const host = historyFocusFromContext(context);
      const nextSurface: HistoryUiState["surface"] = host.surface ?? stored.surface;
      const nextLane = pickLane(listed, host.laneId, stored.focusLaneId);
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
      setCommittedDetailPx(stored.detailPx);
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [context, placement, projectRoot, reloadLanes, setFocusLaneId, setSelectedCommitSha, setSelectedEventId, setSurface]);

  useEffect(() => {
    if (!hydrated) return;
    void saveHistoryUiState(projectRoot, placement, {
      surface,
      focusLaneId,
      selectedCommitSha: surface === "commits" ? selectedCommitSha : null,
      selectedEventId: surface === "activity" ? selectedEventId : null,
      detailPx: committedDetailPx,
    });
  }, [committedDetailPx, focusLaneId, hydrated, placement, projectRoot, selectedCommitSha, selectedEventId, surface]);

  useHostSubscription([...HISTORY_HOST_KINDS], (frame) => {
    if (frame.kind === "lane") void reloadLanes();
    if (frame.kind === "operation") void fetchEvents({ silent: true });
  });

  /**
   * Keep the focused lane on a lane that still exists.
   *
   * A lane frame arrives when one is created, archived or deleted from
   * anywhere — another tab, the CLI, the phone. Without this the toolbar keeps
   * a lane id nothing lists, the DAG stays empty, and the git menu points its
   * verbs at a worktree that is gone.
   */
  useEffect(() => {
    if (!hydrated || lanes.length === 0) return;
    if (focusLaneId && lanes.some((lane) => lane.id === focusLaneId)) return;
    // Only a host lane the list actually has, or this would re-select a lane
    // that is gone on every frame and never settle.
    const stillListed = hostFocusLaneId && lanes.some((lane) => lane.id === hostFocusLaneId)
      ? hostFocusLaneId
      : null;
    const next = pickLane(lanes, stillListed, null);
    if (next && next !== focusLaneId) setFocusLaneId(next);
  }, [focusLaneId, hostFocusLaneId, hydrated, lanes, setFocusLaneId]);

  useHostRefresh(() => {
    void reloadLanes();
    void fetchEvents({ silent: true });
    setCommitRefreshToken((token) => token + 1);
  });

  useEffect(() => {
    if (!active || surface === "commits") return;
    void fetchEvents();
  }, [active, surface, fetchEvents]);

  /**
   * Refresh the ledger when the reader comes back to it. No timer.
   *
   * The compiled page polled every 4s while an operation was running, because a
   * renderer reading its own store had no other way to hear that one had moved.
   * A guest does: `host.subscribe` delivers an `operation` frame for exactly
   * that, and the subscription above refetches on it.
   *
   * Left as it was, the timer never stopped. `active` is hard-true for a page —
   * the entries pass nothing and the host does not tell a guest it is behind
   * another tab — so a History opened once kept a 4s interval running for the
   * life of the window, once per placement, whether or not anything was
   * running. `events` is in the dependency list, so each refetch rebuilt the
   * interval as well.
   */
  useEffect(() => {
    if (!active || surface !== "activity") return;
    const fullRefresh = () => {
      if (document.visibilityState !== "visible") return;
      void fetchEvents({ silent: true });
    };
    window.addEventListener("focus", fullRefresh);
    document.addEventListener("visibilitychange", fullRefresh);
    return () => {
      window.removeEventListener("focus", fullRefresh);
      document.removeEventListener("visibilitychange", fullRefresh);
    };
  }, [active, surface, fetchEvents]);

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
    setSelectedCommitSha(null);
  }, [setSelectedEventId, setSelectedCommit, setSelectedCommitSha]);

  /** What the palette's "Go to History" row always did: the graph, nothing open. */
  const handleHistoryHome = useCallback(() => {
    setSurface("commits");
    setSelectedEventId(null);
    setSelectedCommit(null);
    setSelectedCommitSha(null);
  }, [setSurface, setSelectedEventId, setSelectedCommit, setSelectedCommitSha]);

  const chordRef = useRef<HistoryKeyState>({ ...HISTORY_KEY_STATE });

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      const resolution = resolveHistoryKey(
        {
          key: event.key,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          isTyping: strokeTargetIsTyping(event.target),
        },
        chordRef.current,
        Date.now(),
      );
      chordRef.current = resolution.state;
      if (resolution.action === "close-detail") handleCloseDetail();
      if (resolution.action === "history-home") handleHistoryHome();
      // Only a chord this page ANSWERED is swallowed. `Mod+[` and Escape both
      // mean something to the host as well, and a guest that ate them whether
      // or not it acted would break the host's own Back.
      if (resolution.handled) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, handleCloseDetail, handleHistoryHome]);

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

  /**
   * The right pane with nothing chosen.
   *
   * `PaneTilingLayout` drew a titled pane whatever was in it, so an unselected
   * detail read as an empty pane rather than as a bug. Without the layout the
   * two panels render literally nothing — a blank 420px column with a divider
   * beside it, which reads as a page that failed to load.
   */
  const detailEmpty = (
    <EmptyState
      className="m-3 rounded-lg"
      icon={surface === "commits" ? GitCommit : Clock}
      title={surface === "commits" ? "No commit selected" : "No operation selected"}
      description={
        surface === "commits"
          ? "Pick a commit to read its message, files and git actions"
          : "Pick an operation to read its metadata and where it ran"
      }
    />
  );

  const hasDetail = surface === "commits"
    ? Boolean(selectedCommit && focusLaneId)
    : Boolean(selectedEvent);

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
        onDetailPxCommit={(next) => {
          setDetailPx(next);
          setCommittedDetailPx(next);
        }}
        timelineTitle={surface === "commits" ? "Commit graph" : "Timeline"}
        detailTitle={surface === "commits" ? "Commit" : "Event detail"}
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
        detail={hasDetail ? detailBody : detailEmpty}
      />
    </div>
  );
}

/**
 * Which lane's history this page draws.
 *
 * The compiled page preferred the lane selected elsewhere in the app — Lanes,
 * Work — over the first lane the daemon happened to list, so History and the
 * destructive git verbs in its menus were pointed at the lane the reader was
 * actually in. A guest hears that selection as the host's envelope: a
 * `pointer.laneId`, or a `{kind:"lane"}` subject on a press.
 *
 * So the ladder is the compiled one — the app's lane, then the reader's own
 * stored lane, then the first lane. A lane the host named is kept even when the
 * list does not have it yet, because the list is a snapshot and the host's word
 * is current; that is the one case where a lane id survives being unknown.
 */
export function pickLane(
  lanes: HistoryLane[],
  hostLaneId: string | null,
  storedLaneId: string | null,
): string | null {
  // A lane the host named wins outright, listed or not: the list is a snapshot
  // and the host's word is current, so a lane created a moment ago still opens.
  if (hostLaneId) return hostLaneId;
  if (storedLaneId && lanes.some((lane) => lane.id === storedLaneId)) return storedLaneId;
  return lanes[0]?.id ?? null;
}
