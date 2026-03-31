import React, { useCallback, useMemo, useState } from "react";
import { Terminal } from "@phosphor-icons/react";
import { PaneTilingLayout, type PaneConfig, type PaneSplit } from "../ui/PaneTilingLayout";
import { useWorkSessions } from "./useWorkSessions";
import { SessionListPane } from "./SessionListPane";
import { WorkViewArea } from "./WorkViewArea";
import { SessionContextMenu, type SessionContextMenuState } from "./SessionContextMenu";
import { SessionInfoPopover, type InfoPopoverState } from "./SessionInfoPopover";
import type { TerminalSessionSummary } from "../../../shared/types";
import { SANS_FONT } from "../lanes/laneDesignTokens";
import { sortLanesForTabs } from "../lanes/laneUtils";

/* ---- Layout (2-pane: sessions | view) ---- */

const TERMINALS_TILING_TREE: PaneSplit = {
  type: "split",
  direction: "horizontal",
  children: [
    { node: { type: "pane", id: "sessions" }, defaultSize: 28, minSize: 15 },
    { node: { type: "pane", id: "view" }, defaultSize: 72, minSize: 40 },
  ],
};

/* ---- Main component ---- */

export function TerminalsPage() {
  const work = useWorkSessions();
  const sortedLanes = useMemo(() => sortLanesForTabs(work.lanes), [work.lanes]);

  /* Floating overlays */
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

  /* ---- Pane configs ---- */

  const paneConfigs: Record<string, PaneConfig> = useMemo(
    () => ({
      sessions: {
        title: "Sessions",
        icon: Terminal,
        meta: work.loading ? "loading" : `${work.filtered.length}`,
        children: (
          <SessionListPane
            lanes={sortedLanes}
            filtered={work.filtered}
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
          />
        ),
      },

      view: {
        title: "View",
        icon: Terminal,
        bodyClassName: "overflow-hidden",
        children: (
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
      },
    }),
    [work, sortedLanes, handleSelectSession, handleInfoClick, handleContextMenu, handleOpenChatSession],
  );

  return (
    <div className="flex h-full min-w-0 flex-col" style={{ background: "var(--color-bg)", fontFamily: SANS_FONT }}>
      {renameError ? (
        <div
          className="shrink-0 border-b border-red-500/25 px-4 py-2 text-[12px] text-red-300/95"
          style={{ background: "rgba(239, 68, 68, 0.08)" }}
          role="status"
        >
          {renameError}
        </div>
      ) : null}
      {/* Header */}
      <div
        style={{
          height: 44,
          display: "flex",
          alignItems: "center",
          padding: "0 18px",
          background: "var(--color-bg)",
          borderBottom: "1px solid rgba(255,255,255, 0.04)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              fontFamily: SANS_FONT,
              fontSize: 14,
              fontWeight: 600,
              color: "var(--color-fg)",
              letterSpacing: "-0.02em",
            }}
          >
            Work
          </span>
          {work.runningSessions.length > 0 ? (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "3px 10px",
                fontSize: 11,
                fontWeight: 500,
                fontFamily: SANS_FONT,
                color: "var(--color-success)",
                background: "rgba(34, 197, 94, 0.08)",
                borderRadius: 999,
              }}
            >
              <span
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: "50%",
                  background: "var(--color-success)",
                  animation: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
                }}
              />
              {work.runningSessions.length} running
            </span>
          ) : null}
        </div>
      </div>

      <PaneTilingLayout
        layoutId="work:tiling:v3"
        tree={TERMINALS_TILING_TREE}
        panes={paneConfigs}
        className="flex-1 min-h-0"
      />

      {/* Floating overlays */}
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
            .then(() => work.refresh({ showLoading: false }))
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
