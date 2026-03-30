import { useMemo } from "react";
import { GridFour, List, X } from "@phosphor-icons/react";
import type { LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import type { WorkDraftKind, WorkViewMode } from "../../state/appStore";
import { TerminalView } from "./TerminalView";
import { ToolLogo } from "./ToolLogos";
import { AgentChatPane } from "../chat/AgentChatPane";
import { WorkStartSurface } from "./WorkStartSurface";
import { MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";
import { isChatToolType, primarySessionLabel, secondarySessionLabel, truncateSessionLabel } from "../../lib/sessions";
import { sessionStatusDot } from "../../lib/terminalAttention";

const THEME_CARD = "var(--color-card)";
const THEME_BORDER = "var(--color-border)";
const THEME_FG = "var(--color-fg)";
const THEME_MUTED = "var(--color-muted-fg)";

function SessionSurface({
  session,
  isActive,
  onOpenChatSession,
}: {
  session: TerminalSessionSummary;
  isActive: boolean;
  onOpenChatSession: (sessionId: string) => void | Promise<void>;
}) {
  const isChat = isChatToolType(session.toolType);
  if (isChat) {
    return <AgentChatPane laneId={session.laneId} lockSessionId={session.id} onSessionCreated={onOpenChatSession} />;
  }
  if (session.status === "running" && session.ptyId) {
    return (
      <TerminalView
        key={session.id}
        ptyId={session.ptyId}
        sessionId={session.id}
        className="h-full w-full"
      />
    );
  }

  return (
    <div
      className="flex h-full w-full items-center justify-center px-5"
      style={{
        background: THEME_CARD,
      }}
    >
      <div
        style={{
          background: "rgba(255,255,255, 0.03)",
          padding: "8px 14px",
          fontFamily: SANS_FONT,
          fontSize: 12,
          fontWeight: 400,
          color: THEME_MUTED,
          borderRadius: 8,
        }}
      >
        Session ended
      </div>
    </div>
  );
}

export function WorkViewArea({
  lanes,
  sessions,
  visibleSessions,
  activeItemId,
  viewMode,
  draftKind,
  setViewMode,
  onSelectItem,
  onCloseItem,
  onOpenChatSession,
  onLaunchPtySession,
  closingPtyIds,
}: {
  lanes: LaneSummary[];
  sessions: TerminalSessionSummary[];
  visibleSessions: TerminalSessionSummary[];
  activeItemId: string | null;
  viewMode: WorkViewMode;
  draftKind: WorkDraftKind;
  setViewMode: (mode: WorkViewMode) => void;
  onSelectItem: (sessionId: string) => void;
  onCloseItem: (sessionId: string) => void;
  onOpenChatSession: (sessionId: string) => void | Promise<void>;
  onLaunchPtySession: (args: {
    laneId: string;
    profile: "claude" | "codex" | "shell";
    title?: string;
    startupCommand?: string;
    tracked?: boolean;
  }) => Promise<unknown>;
  closingPtyIds: Set<string>;
}) {
  const sessionsById = useMemo(() => {
    const map = new Map<string, TerminalSessionSummary>();
    for (const session of sessions) map.set(session.id, session);
    return map;
  }, [sessions]);
  const laneColorById = useMemo(() => {
    const map = new Map<string, string>();
    for (const lane of lanes) {
      map.set(lane.id, lane.color ?? "rgba(var(--tab-tint-rgb, 113, 113, 122), 0.95)");
    }
    return map;
  }, [lanes]);

  const displaySessions = visibleSessions;
  const activeSession = activeItemId
    ? sessionsById.get(activeItemId) ?? displaySessions[0] ?? null
    : null;
  const runningTerminalSessions = useMemo(
    () => {
      const running = displaySessions.filter(
        (session) =>
          session.status === "running"
          && Boolean(session.ptyId)
          && !isChatToolType(session.toolType),
      );
      if (
        activeSession
        && activeSession.status === "running"
        && Boolean(activeSession.ptyId)
        && !isChatToolType(activeSession.toolType)
        && !running.some((session) => session.id === activeSession.id)
      ) {
        running.push(activeSession);
      }
      return running;
    },
    [activeSession, displaySessions],
  );

  if (viewMode === "grid") {
    return (
      <div className="flex h-full flex-col">
        <div
          className="flex items-center gap-3 px-3 py-1.5"
          style={{ borderBottom: "1px solid rgba(255,255,255, 0.04)" }}
        >
          <ViewModeToggle viewMode={viewMode} setViewMode={setViewMode} />
          <span
            style={{
              fontFamily: SANS_FONT,
              fontSize: 11,
              fontWeight: 500,
              color: "var(--color-muted-fg)",
            }}
          >
            Grid
          </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "1px 7px",
              fontSize: 11,
              fontWeight: 400,
              fontFamily: SANS_FONT,
              color: "var(--color-muted-fg)",
              background: "rgba(255,255,255, 0.05)",
              border: "none",
              borderRadius: 4,
            }}
          >
            {displaySessions.length}
          </span>
        </div>

        {displaySessions.length === 0 ? (
          <WorkStartSurface
            draftKind={draftKind}
            lanes={lanes}
            onOpenChatSession={onOpenChatSession}
            onLaunchPtySession={onLaunchPtySession}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-auto p-2">
            <div className={`grid gap-2 ${
              displaySessions.length === 1
                ? "grid-cols-1"
                : displaySessions.length === 2
                  ? "grid-cols-1 xl:grid-cols-2"
                  : "grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3"
            }`}>
              {displaySessions.map((session) => {
                const isActive = activeSession?.id === session.id;
                const dot = sessionStatusDot(session);
                const isBusy = session.ptyId ? closingPtyIds.has(session.ptyId) : false;
                const laneColor = laneColorById.get(session.laneId) ?? "rgba(var(--tab-tint-rgb, 113, 113, 122), 0.95)";
                const primary = primarySessionLabel(session);
                const secondary = secondarySessionLabel(session);
                return (
                  <div
                    key={session.id}
                    className="flex min-h-[260px] flex-col overflow-hidden"
                    style={{
                      border: isActive
                        ? "1px solid rgba(255,255,255, 0.08)"
                        : "1px solid rgba(255,255,255, 0.04)",
                      background: "transparent",
                      borderRadius: 10,
                    }}
                  >
                    <div
                      className="flex items-center gap-2 px-2 py-1.5"
                      style={{
                        borderBottom: "1px solid rgba(255,255,255, 0.04)",
                        background: isActive ? "rgba(255,255,255, 0.02)" : "transparent",
                      }}
                    >
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => onSelectItem(session.id)}
                      >
                        <span className="flex items-center gap-2" style={{ fontFamily: SANS_FONT, fontSize: 12 }}>
                          <span
                            title={dot.label}
                            className={`${dot.cls} h-2.5 w-2.5 shrink-0 ${dot.spinning ? " animate-spin" : ""}`}
                          />
                          <ToolLogo toolType={session.toolType} size={12} />
                          <span className="truncate" style={{ color: THEME_FG }}>
                            {truncateSessionLabel(primary)}
                          </span>
                        </span>
                        <span className="mt-1 flex items-center gap-2 pl-[22px]">
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              padding: "1px 6px",
                              fontSize: 10,
                              fontWeight: 400,
                              fontFamily: SANS_FONT,
                              color: "var(--color-muted-fg)",
                            }}
                          >
                            {session.laneName}
                          </span>
                          {secondary ? (
                            <span className="truncate" style={{ color: "var(--color-muted-fg)", fontSize: 10 }}>
                              {truncateSessionLabel(secondary, 36)}
                            </span>
                          ) : null}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onCloseItem(session.id)}
                        title={isBusy ? "Closing..." : "Close"}
                        disabled={isBusy}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 18,
                          height: 18,
                          border: "none",
                          cursor: isBusy ? "default" : "pointer",
                          opacity: isBusy ? 0.5 : 0.85,
                          color: "var(--color-muted-fg)",
                          background: "transparent",
                        }}
                      >
                        <X size={11} />
                      </button>
                    </div>
                    <div className="min-h-0 flex-1">
                      <SessionSurface session={session} isActive={isActive} onOpenChatSession={onOpenChatSession} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
        <div
          className="flex items-center gap-0 px-0.5"
          style={{
            borderBottom: "1px solid rgba(255,255,255, 0.04)",
            background: THEME_CARD,
            height: 28,
            minHeight: 28,
            maxHeight: 28,
          }}
        >
        <ViewModeToggle viewMode={viewMode} setViewMode={setViewMode} />
          <div
            className="mx-1"
            style={{ width: 1, height: 14, background: "rgba(255,255,255, 0.06)" }}
          />
        <div className="flex-1 flex items-center gap-0 overflow-x-auto scrollbar-none min-w-0">
          {displaySessions.map((session) => {
            const isActive = activeSession?.id === session.id;
            const dot = sessionStatusDot(session);
            const isBusy = session.ptyId ? closingPtyIds.has(session.ptyId) : false;
            const primary = primarySessionLabel(session);
            return (
              <button
                key={session.id}
                type="button"
                className="group/tab inline-flex shrink-0 items-center gap-1.5 transition-colors"
                style={{
                  padding: "0 8px",
                  height: 28,
                  fontFamily: SANS_FONT,
                  fontSize: 11,
                  fontWeight: isActive ? 500 : 400,
                  background: "transparent",
                  color: isActive ? THEME_FG : "var(--color-muted-fg)",
                  cursor: "pointer",
                  border: "none",
                  borderBottom: isActive ? "2px solid var(--color-accent)" : "2px solid transparent",
                  borderRadius: "0",
                  opacity: isActive ? 1 : 0.5,
                }}
                onClick={() => onSelectItem(session.id)}
              >
                <ToolLogo toolType={session.toolType} size={10} />
                <span className="max-w-[120px] truncate">
                  {truncateSessionLabel(primary, 20)}
                </span>
                <span
                  title={dot.label}
                  className={`${dot.cls} h-1.5 w-1.5 shrink-0${dot.spinning ? " animate-spin" : ""}`}
                />
                <span
                  role="button"
                  tabIndex={0}
                  className="inline-flex items-center justify-center opacity-0 group-hover/tab:opacity-100 transition-opacity"
                  style={{
                    width: 14,
                    height: 14,
                    cursor: isBusy ? "default" : "pointer",
                    color: "var(--color-muted-fg)",
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isBusy) return;
                    onCloseItem(session.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      if (isBusy) return;
                      onCloseItem(session.id);
                    }
                  }}
                >
                  <X size={8} />
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="relative min-h-0 flex-1" style={{ background: THEME_CARD }}>
        {runningTerminalSessions.length > 0 ? (
          <div className="absolute inset-0">
            {runningTerminalSessions.map((session) =>
              session.ptyId ? (
                <TerminalView
                  key={session.id}
                  ptyId={session.ptyId}
                  sessionId={session.id}
                  isActive={activeSession?.id === session.id}
                  // Keep live PTY-backed TUIs mounted across session-tab switches so
                  // full-screen apps like Codex/Claude do not need transcript rehydration.
                  className={`absolute inset-0 h-full w-full ${
                    activeSession?.id === session.id ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
                  }`}
                />
              ) : null,
            )}
          </div>
        ) : null}

        {activeSession ? (
          activeSession.status === "running" && activeSession.ptyId && !isChatToolType(activeSession.toolType) ? null : (
            <div className="absolute inset-0">
              <SessionSurface session={activeSession} isActive onOpenChatSession={onOpenChatSession} />
            </div>
          )
        ) : (
          <WorkStartSurface
            draftKind={draftKind}
            lanes={lanes}
            onOpenChatSession={onOpenChatSession}
            onLaunchPtySession={onLaunchPtySession}
          />
        )}
      </div>
    </div>
  );
}

function ViewModeToggle({
  viewMode,
  setViewMode,
}: {
  viewMode: WorkViewMode;
  setViewMode: (mode: WorkViewMode) => void;
}) {
  return (
    <div className="flex items-center gap-0">
      <button
        onClick={() => setViewMode("tabs")}
        className="transition-colors"
        style={{
          padding: "2px 4px",
          border: "none",
          cursor: "pointer",
          background: "transparent",
          color: viewMode === "tabs" ? THEME_FG : "var(--color-muted-fg)",
          opacity: viewMode === "tabs" ? 0.8 : 0.3,
        }}
        title="Tab View"
      >
        <List size={12} />
      </button>
      <button
        onClick={() => setViewMode("grid")}
        className="transition-colors"
        style={{
          padding: "2px 4px",
          border: "none",
          cursor: "pointer",
          background: "transparent",
          color: viewMode === "grid" ? THEME_FG : "var(--color-muted-fg)",
          opacity: viewMode === "grid" ? 0.8 : 0.3,
        }}
        title="Grid View"
      >
        <GridFour size={12} />
      </button>
    </div>
  );
}
