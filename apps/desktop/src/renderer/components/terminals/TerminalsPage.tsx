import React, { useCallback, useMemo, useState } from "react";
import {
  ArrowClockwise as RefreshCw,
  Stop as Square,
  Terminal,
} from "@phosphor-icons/react";
import { PaneTilingLayout, type PaneConfig, type PaneSplit } from "../ui/PaneTilingLayout";
import { useWorkSessions } from "./useWorkSessions";
import { SessionListPane } from "./SessionListPane";
import { WorkViewArea } from "./WorkViewArea";
import { SessionContextMenu, type SessionContextMenuState } from "./SessionContextMenu";
import { SessionInfoPopover, type InfoPopoverState } from "./SessionInfoPopover";
import type { TerminalSessionSummary } from "../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT, inlineBadge, outlineButton } from "../lanes/laneDesignTokens";

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
            onLaunchChat={(laneId) => work.handleLaunchChat(laneId).catch(() => {})}
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
    <div className="flex h-full min-w-0 flex-col" style={{ background: COLORS.pageBg, fontFamily: MONO_FONT }}>
      {/* Header */}
      <div
        style={{
          height: 64,
          display: "flex",
          alignItems: "center",
          padding: "0 24px",
          background: COLORS.recessedBg,
          borderBottom: `1px solid ${COLORS.border}`,
          flexShrink: 0,
        }}
      >
        {/* Left side */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            style={{
              fontFamily: MONO_FONT,
              fontSize: 12,
              fontWeight: 700,
              color: COLORS.textDim,
              letterSpacing: "1px",
            }}
          >
            01
          </span>
          <span
            style={{
              fontFamily: SANS_FONT,
              fontSize: 20,
              fontWeight: 700,
              color: COLORS.textPrimary,
              letterSpacing: "-0.02em",
            }}
          >
            WORK
          </span>
          {work.runningSessions.length > 0 ? (
            <span style={inlineBadge(COLORS.success)}>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: COLORS.success,
                  marginRight: 6,
                  animation: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
                }}
              />
              {work.runningSessions.length} RUNNING
            </span>
          ) : null}
        </div>

        {/* Right side */}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <button
            style={{
              ...outlineButton(),
              opacity: work.runningSessions.length === 0 ? 0.4 : 1,
              pointerEvents: work.runningSessions.length === 0 ? "none" : "auto",
            }}
            disabled={work.runningSessions.length === 0}
            onClick={() => work.closeAllRunning().catch(() => {})}
          >
            <Square size={14} weight="regular" />
            CLOSE ALL
          </button>
          <button
            style={{
              ...outlineButton({ padding: "0 8px" }),
            }}
            onClick={() => work.refresh().catch(() => {})}
            title="Refresh"
          >
            <RefreshCw size={14} weight="regular" />
          </button>
        </div>
      </div>
      {/* Accent line */}
      <div
        style={{
          height: 2,
          background: `linear-gradient(90deg, ${COLORS.accent}, transparent)`,
          flexShrink: 0,
        }}
      />

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
