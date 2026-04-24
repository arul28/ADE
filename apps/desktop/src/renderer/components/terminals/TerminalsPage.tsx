import React, { useCallback, useEffect, useMemo, useState } from "react";
import { SidebarSimple } from "@phosphor-icons/react";
import { PaneTilingLayout, type PaneConfig, type PaneSplit } from "../ui/PaneTilingLayout";
import { useWorkSessions } from "./useWorkSessions";
import { SessionListPane } from "./SessionListPane";
import { WorkViewArea } from "./WorkViewArea";
import { SessionContextMenu, type SessionContextMenuState } from "./SessionContextMenu";
import { SessionInfoPopover, type InfoPopoverState } from "./SessionInfoPopover";
import type { AgentChatSession, TerminalSessionSummary } from "../../../shared/types";
import { isChatToolType } from "../../lib/sessions";
import { sortLanesForTabs } from "../lanes/laneUtils";
import { invalidateSessionListCache } from "../../lib/sessionListCache";

const TERMINALS_TILING_TREE: PaneSplit = {
  type: "split",
  direction: "horizontal",
  children: [
    { node: { type: "pane", id: "sessions" }, defaultSize: 24, minSize: 15 },
    { node: { type: "pane", id: "view" }, defaultSize: 76, minSize: 40 },
  ],
};

export function TerminalsPage() {
  const work = useWorkSessions();
  const sortedLanes = useMemo(() => sortLanesForTabs(work.lanes), [work.lanes]);

  const [contextMenu, setContextMenu] = useState<SessionContextMenuState>(null);
  const [infoPopover, setInfoPopover] = useState<InfoPopoverState>(null);
  const [sessionActionError, setSessionActionError] = useState<string | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);

  const selectableSessions = useMemo(
    () => [...work.runningFiltered, ...work.awaitingInputFiltered, ...work.endedFiltered],
    [work.awaitingInputFiltered, work.endedFiltered, work.runningFiltered],
  );

  useEffect(() => {
    const visibleIds = new Set(selectableSessions.map((session) => session.id));
    setSelectedSessionIds((prev) => {
      const next = new Set([...prev].filter((id) => visibleIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [selectableSessions]);

  const handleSelectSession = useCallback(
    (id: string, event?: React.MouseEvent, visibleSessionIds?: string[]) => {
      const useRange = event?.shiftKey === true;
      const useToggle = event?.metaKey === true || event?.ctrlKey === true;
      const orderedIds = visibleSessionIds?.length ? visibleSessionIds : selectableSessions.map((session) => session.id);

      if (useRange) {
        const anchorId = selectionAnchorId ?? id;
        const anchorIndex = orderedIds.indexOf(anchorId);
        const nextIndex = orderedIds.indexOf(id);
        if (anchorIndex >= 0 && nextIndex >= 0) {
          const [start, end] = anchorIndex <= nextIndex ? [anchorIndex, nextIndex] : [nextIndex, anchorIndex];
          const rangeIds = orderedIds.slice(start, end + 1);
          setSelectedSessionIds(new Set(rangeIds));
          setSelectionAnchorId(anchorId);
          work.setSelectedSessionId(id);
          return;
        }
      }

      if (useToggle) {
        setSelectedSessionIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        setSelectionAnchorId(id);
        work.setSelectedSessionId(id);
        return;
      }

      setSelectedSessionIds(new Set());
      setSelectionAnchorId(id);
      work.setSelectedSessionId(id);
      work.openSessionTab(id);
    },
    [selectableSessions, selectionAnchorId, work],
  );

  const handleInfoClick = useCallback(
    (session: TerminalSessionSummary, e: React.MouseEvent) => {
      setInfoPopover({ session, x: e.clientX, y: e.clientY });
    },
    [],
  );

  const handleContextMenu = useCallback(
    (session: TerminalSessionSummary, e: React.MouseEvent) => {
      setContextMenu({ session, x: e.clientX, y: e.clientY });
    },
    [],
  );

  const handleOpenChatSession = useCallback(
    (session: AgentChatSession) => {
      // Invalidate all cache entries so other views (e.g. Lanes tab) pick up
      // the new session on their next refresh.
      invalidateSessionListCache();
      work.selectLane(session.laneId);
      work.upsertOptimisticChatSession(session);
      work.focusSession(session.id);
      work.openSessionTab(session.id);
      void work.refresh({ showLoading: false, force: true }).catch((err: unknown) => {
        console.error("[TerminalsPage] refresh after opening chat session failed", {
          sessionId: session.id,
          laneId: session.laneId,
          err,
        });
      });
    },
    [work],
  );

  const handleGoToLane = useCallback(
    (session: TerminalSessionSummary) => {
      work.selectLane(session.laneId);
      work.focusSession(session.id);
      work.navigate(`/lanes?laneId=${encodeURIComponent(session.laneId)}&sessionId=${encodeURIComponent(session.id)}`);
    },
    [work],
  );

  const handleDeleteChat = useCallback(
    (session: TerminalSessionSummary) => {
      const label = (session.goal ?? session.title).trim() || "this chat";
      const confirmed = window.confirm(
        `Delete "${label}"?\n\nThis permanently removes the saved chat history from ADE.`,
      );
      if (!confirmed) return;

      setSessionActionError(null);
      setDeletingSessionId(session.id);
      void window.ade.agentChat.delete({ sessionId: session.id })
        .then(async () => {
          invalidateSessionListCache();
          work.removeSessionFromList(session.id);
          work.closeTab(session.id);
          setContextMenu((current) => (current?.session.id === session.id ? null : current));
          setInfoPopover((current) => (current?.session.id === session.id ? null : current));
          // Refresh is post-delete housekeeping; a failure here must not be
          // reported as "Delete failed" because the delete itself succeeded.
          await work.refresh({ showLoading: false, force: true }).catch((refreshErr: unknown) => {
            console.error("[TerminalsPage] refresh after delete failed", { sessionId: session.id, refreshErr });
          });
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[TerminalsPage] delete chat failed", { sessionId: session.id, err });
          setSessionActionError(`Delete failed: ${message}`);
          window.setTimeout(() => setSessionActionError(null), 6000);
        })
        .finally(() => {
          setDeletingSessionId((current) => (current === session.id ? null : current));
        });
    },
    [work],
  );

  const handleDeleteSession = useCallback(
    (session: TerminalSessionSummary) => {
      const label = (session.goal ?? session.title).trim() || "this session";
      const confirmed = window.confirm(
        `Delete "${label}"?\n\nThis permanently removes the saved terminal session from ADE.`,
      );
      if (!confirmed) return;

      setSessionActionError(null);
      setDeletingSessionId(session.id);
      void window.ade.sessions.delete({ sessionId: session.id })
        .then(async () => {
          invalidateSessionListCache();
          work.removeSessionFromList(session.id);
          work.closeTab(session.id);
          setContextMenu((current) => (current?.session.id === session.id ? null : current));
          setInfoPopover((current) => (current?.session.id === session.id ? null : current));
          await work.refresh({ showLoading: false, force: true }).catch((refreshErr: unknown) => {
            console.error("[TerminalsPage] refresh after session delete failed", { sessionId: session.id, refreshErr });
          });
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[TerminalsPage] delete session failed", { sessionId: session.id, err });
          setSessionActionError(`Delete failed: ${message}`);
          window.setTimeout(() => setSessionActionError(null), 6000);
        })
        .finally(() => {
          setDeletingSessionId((current) => (current === session.id ? null : current));
        });
    },
    [work],
  );

  const selectedSessions = useMemo(
    () => selectableSessions.filter((session) => selectedSessionIds.has(session.id)),
    [selectableSessions, selectedSessionIds],
  );

  const handleBulkCloseSelected = useCallback(() => {
    const running = selectedSessions.filter((session) => session.status === "running");
    if (!running.length) return;
    const confirmed = window.confirm(
      `Close ${running.length} running session${running.length === 1 ? "" : "s"}?\n\nThis terminates the underlying CLI, shell, or chat process for each selected running session.`,
    );
    if (!confirmed) return;

    setSessionActionError(null);
    void Promise.allSettled(
      running.map((session) => {
        if (isChatToolType(session.toolType)) {
          return work.closeChatSession(session.id);
        }
        if (session.ptyId) {
          return work.closeSession(session.ptyId, session.id);
        }
        return Promise.resolve();
      }),
    )
      .then((results) => {
        const failed = results.filter((result) => result.status === "rejected").length;
        if (failed > 0) {
          setSessionActionError(`Close failed for ${failed} selected session${failed === 1 ? "" : "s"}.`);
          window.setTimeout(() => setSessionActionError(null), 6000);
        }
        setSelectedSessionIds(new Set());
        setSelectionAnchorId(null);
        invalidateSessionListCache();
        return work.refresh({ showLoading: false, force: true });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setSessionActionError(`Close failed: ${message}`);
        window.setTimeout(() => setSessionActionError(null), 6000);
      });
  }, [selectedSessions, work]);

  const handleBulkDeleteSelected = useCallback(() => {
    const ended = selectedSessions.filter((session) => session.status !== "running");
    if (!ended.length) return;
    const confirmed = window.confirm(
      `Delete ${ended.length} ended session${ended.length === 1 ? "" : "s"}?\n\nThis permanently removes the selected saved session history from ADE.`,
    );
    if (!confirmed) return;

    setSessionActionError(null);
    setDeletingSessionId("bulk");
    void Promise.allSettled(
      ended.map((session) => (
        isChatToolType(session.toolType)
          ? window.ade.agentChat.delete({ sessionId: session.id })
          : window.ade.sessions.delete({ sessionId: session.id })
      )),
    )
      .then(async (results) => {
        const failed = results.filter((result) => result.status === "rejected").length;
        const succeededIds = ended
          .filter((_, index) => results[index]?.status === "fulfilled")
          .map((session) => session.id);
        for (const sessionId of succeededIds) {
          work.removeSessionFromList(sessionId);
          work.closeTab(sessionId);
        }
        setSelectedSessionIds(new Set());
        setSelectionAnchorId(null);
        setContextMenu(null);
        setInfoPopover(null);
        invalidateSessionListCache();
        await work.refresh({ showLoading: false, force: true }).catch((refreshErr: unknown) => {
          console.error("[TerminalsPage] refresh after bulk delete failed", { refreshErr });
        });
        if (failed > 0) {
          setSessionActionError(`Delete failed for ${failed} selected session${failed === 1 ? "" : "s"}.`);
          window.setTimeout(() => setSessionActionError(null), 6000);
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setSessionActionError(`Delete failed: ${message}`);
        window.setTimeout(() => setSessionActionError(null), 6000);
      })
      .finally(() => {
        setDeletingSessionId((current) => (current === "bulk" ? null : current));
      });
  }, [selectedSessions, work]);

  const handleResumeSession = useCallback(
    (session: TerminalSessionSummary) => {
      void work.resumeSession(session).catch(() => {});
    },
    [work],
  );

  const workViewArea = useMemo(
    () => (
      <WorkViewArea
        gridLayoutId={work.gridLayoutId}
        lanes={sortedLanes}
        sessions={work.sessions}
        visibleSessions={work.visibleSessions}
        tabGroups={work.tabGroups}
        tabVisibleSessionIds={work.tabVisibleSessionIds}
        activeItemId={work.activeItemId}
        viewMode={work.viewMode}
        draftKind={work.draftKind}
        setViewMode={work.setViewMode}
        onSelectItem={work.setActiveItemId}
        onCloseItem={work.closeTab}
        onOpenChatSession={handleOpenChatSession}
        onLaunchPtySession={work.launchPtySession}
        onShowDraftKind={work.showDraftKind}
        onToggleTabGroupCollapsed={work.toggleWorkTabGroupCollapsed}
        closingPtyIds={work.closingPtyIds}
        onContextMenu={handleContextMenu}
        onResumeSession={handleResumeSession}
      />
    ),
    [
      sortedLanes,
      work.gridLayoutId,
      work.sessions,
      work.visibleSessions,
      work.tabGroups,
      work.tabVisibleSessionIds,
      work.activeItemId,
      work.viewMode,
      work.draftKind,
      work.showDraftKind,
      work.setViewMode,
      work.setActiveItemId,
      work.closeTab,
      work.launchPtySession,
      work.toggleWorkTabGroupCollapsed,
      work.closingPtyIds,
      handleOpenChatSession,
      handleResumeSession,
      handleContextMenu,
    ],
  );

  const runningCount = work.runningSessions.length;
  const setFocusHidden = work.setWorkFocusSessionsHidden;

  const sessionsHeaderActions = useMemo(
    () => (
      <span data-tour="work.sessionsHeader" className="inline-flex items-center gap-1.5">
        {runningCount > 0 ? (
          <span
            className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
            style={{ color: "var(--color-success)", background: "rgba(34, 197, 94, 0.08)" }}
            title={`${runningCount} running`}
          >
            <span className="ade-status-dot ade-status-dot-active" style={{ width: 4, height: 4 }} />
            {runningCount}
          </span>
        ) : null}
        <button
          type="button"
          className="ade-shell-control rounded p-0.5"
          data-variant="ghost"
          title="Hide sidebar"
          onClick={() => setFocusHidden(true)}
        >
          <SidebarSimple size={13} weight="regular" />
        </button>
      </span>
    ),
    [runningCount, setFocusHidden],
  );

  const paneConfigs: Record<string, PaneConfig> = useMemo(
    () => ({
      sessions: {
        title: "Work",
        headerActions: sessionsHeaderActions,
        // tour anchor: wraps the sessions panel so the Work tour anchors
        // at the whole pane, not just an inner element.
        children: (
          <div className="h-full min-h-0 flex flex-col" data-tour="work.sessionsPane">
          <SessionListPane
            lanes={sortedLanes}
            runningFiltered={work.runningFiltered}
            awaitingInputFiltered={work.awaitingInputFiltered}
            endedFiltered={work.endedFiltered}
            loading={work.loading}
            filterLaneId={work.filterLaneId}
            setFilterLaneId={work.setFilterLaneId}
            filterStatus={work.filterStatus}
            setFilterStatus={work.setFilterStatus}
            q={work.q}
            setQ={work.setQ}
            selectedSessionId={work.selectedSessionId}
            selectedSessionIds={selectedSessionIds}
            draftKind={work.draftKind}
            showingDraft={work.activeItemId == null}
            onShowDraftKind={work.showDraftKind}
            onSelectSession={handleSelectSession}
            onClearSelection={() => {
              setSelectedSessionIds(new Set());
              setSelectionAnchorId(null);
            }}
            onBulkClose={handleBulkCloseSelected}
            onBulkDelete={handleBulkDeleteSelected}
            onResume={(s) => work.resumeSession(s).catch(() => {})}
            resumingSessionId={work.resumingSessionId}
            onInfoClick={handleInfoClick}
            onContextMenu={handleContextMenu}
            sessionListOrganization={work.sessionListOrganization}
            setSessionListOrganization={work.setSessionListOrganization}
            workCollapsedLaneIds={work.workCollapsedLaneIds}
            toggleWorkLaneCollapsed={work.toggleWorkLaneCollapsed}
            workCollapsedSectionIds={work.workCollapsedSectionIds}
            toggleWorkSectionCollapsed={work.toggleWorkSectionCollapsed}
            sessionsGroupedByLane={work.sessionsGroupedByLane}
          />
          </div>
        ),
      },

      view: {
        title: "",
        bodyClassName: "overflow-hidden",
        // tour anchor: wraps the view area so the Work tour can target it.
        children: (
          <div className="h-full min-h-0" data-tour="work.viewArea">
            {workViewArea}
          </div>
        ),
      },
    }),
    [
      work,
      sortedLanes,
      handleSelectSession,
      selectedSessionIds,
      handleBulkCloseSelected,
      handleBulkDeleteSelected,
      handleInfoClick,
      handleContextMenu,
      sessionsHeaderActions,
      workViewArea,
    ],
  );

  return (
    <div className="flex h-full min-w-0 flex-col" style={{ background: "var(--color-bg)" }}>
      {sessionActionError ? (
        <div
          className="shrink-0 border-b border-red-500/25 px-4 py-2 text-[12px] text-red-300/95"
          style={{ background: "rgba(239, 68, 68, 0.08)" }}
          role="status"
        >
          {sessionActionError}
        </div>
      ) : null}
      {work.workFocusSessionsHidden ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            className="flex h-8 shrink-0 items-center gap-2 px-2"
            style={{
              borderBottom: "1px solid var(--work-pane-border)",
              background: "var(--color-bg)",
            }}
            data-tour="work.focusToolbar"
          >
            <button
              type="button"
              className="ade-shell-control inline-flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium"
              data-variant="ghost"
              onClick={() => work.setWorkFocusSessionsHidden(false)}
            >
              <SidebarSimple size={13} weight="regular" />
              Sessions
            </button>
            {!work.loading && work.filtered.length > 0 ? (
              <span className="text-[10px] text-muted-fg/40">{work.filtered.length}</span>
            ) : null}
            {work.runningSessions.length > 0 ? (
              <span
                className="ml-auto inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                style={{ color: "var(--color-success)", background: "rgba(34, 197, 94, 0.08)" }}
              >
                <span className="ade-status-dot ade-status-dot-active" style={{ width: 4, height: 4 }} />
                {work.runningSessions.length} running
              </span>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-hidden" data-tour="work.viewArea">{workViewArea}</div>
        </div>
      ) : (
        <PaneTilingLayout
          layoutId="work:tiling:v3"
          tree={TERMINALS_TILING_TREE}
          panes={paneConfigs}
          className="ade-work-surface min-h-0 flex-1"
        />
      )}

      <SessionContextMenu
        menu={contextMenu}
        onClose={() => setContextMenu(null)}
        onCloseSession={({ ptyId, sessionId }) => work.closeSession(ptyId, sessionId).catch(() => {})}
        onEndChat={(id) => work.closeChatSession(id).catch(() => {})}
        onDeleteChat={handleDeleteChat}
        onDeleteSession={handleDeleteSession}
        deletingSessionId={deletingSessionId}
        onResume={handleResumeSession}
        onCopyResumeCommand={(cmd) => navigator.clipboard.writeText(cmd).catch(() => {})}
        onGoToLane={handleGoToLane}
        onCopySessionId={(id) => navigator.clipboard.writeText(id).catch(() => {})}
        onRename={(session, newTitle) => {
          setSessionActionError(null);
          const renamePromise = isChatToolType(session.toolType)
            ? window.ade.agentChat.updateSession({ sessionId: session.id, title: newTitle, manuallyNamed: true })
            : window.ade.sessions.updateMeta({ sessionId: session.id, title: newTitle, manuallyNamed: true });
          renamePromise
            .then(() => {
              invalidateSessionListCache();
              work.refresh({ showLoading: false, force: true }).catch((refreshErr: unknown) => {
                console.error("[TerminalsPage] refresh after rename failed", { sessionId: session.id, refreshErr });
              });
            })
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              console.error("[TerminalsPage] rename session failed", { sessionId: session.id, err });
              setSessionActionError(`Rename failed: ${message}`);
              window.setTimeout(() => setSessionActionError(null), 6000);
            });
        }}
      />

      <SessionInfoPopover
        popover={infoPopover}
        onClose={() => setInfoPopover(null)}
        onCloseSession={({ ptyId, sessionId }) => work.closeSession(ptyId, sessionId).catch(() => {})}
        onEndChat={(id) => work.closeChatSession(id).catch(() => {})}
        onDeleteChat={handleDeleteChat}
        onDeleteSession={handleDeleteSession}
        onResume={handleResumeSession}
        onGoToLane={handleGoToLane}
        closingPtyIds={work.closingPtyIds}
        closingChatSessionId={work.closingChatSessionId}
        deletingSessionId={deletingSessionId}
        resumingSessionId={work.resumingSessionId}
      />
    </div>
  );
}
