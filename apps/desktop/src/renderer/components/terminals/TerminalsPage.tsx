import React, { useCallback, useMemo, useState } from "react";
import { SidebarSimple, Terminal } from "@phosphor-icons/react";
import { PaneTilingLayout, type PaneConfig, type PaneSplit } from "../ui/PaneTilingLayout";
import { useWorkSessions } from "./useWorkSessions";
import { SessionListPane } from "./SessionListPane";
import { WorkViewArea } from "./WorkViewArea";
import { SessionContextMenu, type SessionContextMenuState } from "./SessionContextMenu";
import { SessionInfoPopover, type InfoPopoverState } from "./SessionInfoPopover";
import type { TerminalSessionSummary } from "../../../shared/types";
import { sortLanesForTabs } from "../lanes/laneUtils";

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
  const [renameError, setRenameError] = useState<string | null>(null);

  const handleSelectSession = useCallback(
    (id: string) => {
      work.setSelectedSessionId(id);
      work.openSessionTab(id);
    },
    [work],
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
    async (sessionId: string) => {
      work.openSessionTab(sessionId);
      await work.refresh({ showLoading: false });
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

  const workViewArea = useMemo(
    () => (
      <WorkViewArea
        lanes={sortedLanes}
        sessions={work.sessions}
        visibleSessions={work.visibleSessions}
        activeItemId={work.activeItemId}
        viewMode={work.viewMode}
        draftKind={work.draftKind}
        setViewMode={work.setViewMode}
        onSelectItem={work.setActiveItemId}
        onCloseItem={work.closeTab}
        onOpenChatSession={handleOpenChatSession}
        onLaunchPtySession={work.launchPtySession}
        closingPtyIds={work.closingPtyIds}
        onContextMenu={handleContextMenu}
      />
    ),
    [
      sortedLanes,
      work.sessions,
      work.visibleSessions,
      work.activeItemId,
      work.viewMode,
      work.draftKind,
      work.setViewMode,
      work.setActiveItemId,
      work.closeTab,
      work.launchPtySession,
      work.closingPtyIds,
      handleOpenChatSession,
      handleContextMenu,
    ],
  );

  const runningCount = work.runningSessions.length;
  const setFocusHidden = work.setWorkFocusSessionsHidden;

  const sessionsHeaderActions = useMemo(
    () => (
      <>
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
      </>
    ),
    [runningCount, setFocusHidden],
  );

  const paneConfigs: Record<string, PaneConfig> = useMemo(
    () => ({
      sessions: {
        title: "Work",
        headerActions: sessionsHeaderActions,
        children: (
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
            draftKind={work.draftKind}
            showingDraft={work.activeItemId == null}
            onShowDraftKind={work.showDraftKind}
            onSelectSession={handleSelectSession}
            onResume={(s) => work.resumeSession(s).catch(() => {})}
            resumingSessionId={work.resumingSessionId}
            onInfoClick={handleInfoClick}
            onContextMenu={handleContextMenu}
            sessionListOrganization={work.sessionListOrganization}
            setSessionListOrganization={work.setSessionListOrganization}
            workCollapsedLaneIds={work.workCollapsedLaneIds}
            toggleWorkLaneCollapsed={work.toggleWorkLaneCollapsed}
            sessionsGroupedByLane={work.sessionsGroupedByLane}
          />
        ),
      },

      view: {
        title: "",
        bodyClassName: "overflow-hidden",
        children: workViewArea,
      },
    }),
    [
      work,
      sortedLanes,
      handleSelectSession,
      handleInfoClick,
      handleContextMenu,
      sessionsHeaderActions,
      workViewArea,
    ],
  );

  return (
    <div className="flex h-full min-w-0 flex-col" style={{ background: "var(--color-bg)" }}>
      {renameError ? (
        <div
          className="shrink-0 border-b border-red-500/25 px-4 py-2 text-[12px] text-red-300/95"
          style={{ background: "rgba(239, 68, 68, 0.08)" }}
          role="status"
        >
          {renameError}
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
          <div className="min-h-0 flex-1 overflow-hidden">{workViewArea}</div>
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
        onResume={(s) => work.resumeSession(s).catch(() => {})}
        onCopyResumeCommand={(cmd) => navigator.clipboard.writeText(cmd).catch(() => {})}
        onGoToLane={handleGoToLane}
        onCopySessionId={(id) => navigator.clipboard.writeText(id).catch(() => {})}
        onRename={(sessionId, newTitle) => {
          setRenameError(null);
          window.ade.agentChat.updateSession({ sessionId, title: newTitle, manuallyNamed: true })
            .then(() => {
              work.refresh({ showLoading: false }).catch((refreshErr: unknown) => {
                console.error("[TerminalsPage] refresh after rename failed", { sessionId, refreshErr });
              });
            })
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              console.error("[TerminalsPage] rename session failed", { sessionId, err });
              setRenameError(`Rename failed: ${message}`);
              window.setTimeout(() => setRenameError(null), 6000);
            });
        }}
      />

      <SessionInfoPopover
        popover={infoPopover}
        onClose={() => setInfoPopover(null)}
        onCloseSession={({ ptyId, sessionId }) => work.closeSession(ptyId, sessionId).catch(() => {})}
        onEndChat={(id) => work.closeChatSession(id).catch(() => {})}
        onResume={(s) => work.resumeSession(s).catch(() => {})}
        onGoToLane={handleGoToLane}
        closingPtyIds={work.closingPtyIds}
        closingChatSessionId={work.closingChatSessionId}
        resumingSessionId={work.resumingSessionId}
      />
    </div>
  );
}
