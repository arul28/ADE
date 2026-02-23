import React, { useCallback, useMemo, useState } from "react";
import {
  ArrowClockwise as RefreshCw,
  Stop as Square,
  Terminal,
} from "@phosphor-icons/react";
import { PaneTilingLayout, type PaneConfig, type PaneSplit } from "../ui/PaneTilingLayout";
import { Button } from "../ui/Button";
import { useWorkSessions } from "./useWorkSessions";
import { SessionListPane } from "./SessionListPane";
import { WorkViewArea } from "./WorkViewArea";
import { SessionContextMenu, type SessionContextMenuState } from "./SessionContextMenu";
import { SessionInfoPopover, type InfoPopoverState } from "./SessionInfoPopover";
import type { TerminalSessionSummary } from "../../../shared/types";

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

  /* Floating overlays */
  const [contextMenu, setContextMenu] = useState<SessionContextMenuState>(null);
  const [infoPopover, setInfoPopover] = useState<InfoPopoverState>(null);

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
            lanes={work.lanes.map((l) => ({ id: l.id, name: l.name }))}
            filtered={work.filtered}
            runningFiltered={work.runningFiltered}
            endedFiltered={work.endedFiltered}
            loading={work.loading}
            filterLaneId={work.filterLaneId}
            setFilterLaneId={work.setFilterLaneId}
            filterStatus={work.filterStatus}
            setFilterStatus={work.setFilterStatus}
            q={work.q}
            setQ={work.setQ}
            selectedSessionId={work.selectedSessionId}
            onSelectSession={handleSelectSession}
            onResume={(s) => work.resumeSession(s).catch(() => {})}
            resumingSessionId={work.resumingSessionId}
            onLaunchPty={(laneId, profile) => work.handleLaunchPty(laneId, profile).catch(() => {})}
            onLaunchChat={(laneId, provider) => work.handleLaunchChat(laneId, provider).catch(() => {})}
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
            sessions={work.sessions}
            runningSessions={work.runningSessions}
            openTabIds={work.openTabIds}
            activeTabId={work.activeTabId}
            viewMode={work.viewMode}
            setViewMode={work.setViewMode}
            onSelectTab={(id) => {
              work.setActiveTabId(id);
              work.setSelectedSessionId(id);
            }}
            onCloseTab={work.closeTab}
            closingPtyIds={work.closingPtyIds}
            onCloseSession={(id) => {
              const session = work.sessions.find((s) => s.id === id);
              if (session?.ptyId) work.closeSession(session.ptyId).catch(() => {});
            }}
          />
        ),
      },
    }),
    [work, handleSelectSession, handleInfoClick, handleContextMenu],
  );

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      {/* Header */}
      <div className="px-3 py-2">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold tracking-tight text-fg/80">Work</span>
            {work.runningSessions.length > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                {work.runningSessions.length} running
              </span>
            ) : null}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              disabled={work.runningSessions.length === 0}
              onClick={() => work.closeAllRunning().catch(() => {})}
            >
              <Square size={14} weight="regular" />
              Close all
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => work.refresh().catch(() => {})}
              title="Refresh"
            >
              <RefreshCw size={14} weight="regular" />
            </Button>
          </div>
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
        onCloseSession={(ptyId) => work.closeSession(ptyId).catch(() => {})}
        onEndChat={(id) => work.closeChatSession(id).catch(() => {})}
        onResume={(s) => work.resumeSession(s).catch(() => {})}
        onCopyResumeCommand={(cmd) => navigator.clipboard.writeText(cmd).catch(() => {})}
        onGoToLane={handleGoToLane}
        onCopySessionId={(id) => navigator.clipboard.writeText(id).catch(() => {})}
      />

      <SessionInfoPopover
        popover={infoPopover}
        onClose={() => setInfoPopover(null)}
        onCloseSession={(ptyId) => work.closeSession(ptyId).catch(() => {})}
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
