import { useMemo } from "react";
import { GridFour, List, X } from "@phosphor-icons/react";
import type { LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import type { WorkDraftKind, WorkViewMode } from "../../state/appStore";
import { TerminalView } from "./TerminalView";
import { ToolLogo } from "./ToolLogos";
import { AgentChatPane } from "../chat/AgentChatPane";
import { WorkStartSurface } from "./WorkStartSurface";
import { MONO_FONT } from "../lanes/laneDesignTokens";
import { isChatToolType, primarySessionLabel, secondarySessionLabel, truncateSessionLabel } from "../../lib/sessions";
import { sessionStatusDot } from "../../lib/terminalAttention";

const THEME_CARD = "var(--color-card)";
const THEME_BORDER = "var(--color-border)";
const THEME_FG = "var(--color-fg)";
const THEME_MUTED = "var(--color-muted-fg)";

function SessionSurface({ session, isActive }: { session: TerminalSessionSummary; isActive: boolean }) {
  const isChat = isChatToolType(session.toolType);
  if (isChat) {
    return <AgentChatPane laneId={session.laneId} lockSessionId={session.id} />;
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
          border: "1px solid color-mix(in srgb, var(--color-error) 20%, transparent)",
          background: THEME_CARD,
          padding: "8px 14px",
          fontFamily: MONO_FONT,
          fontSize: 10,
          color: THEME_MUTED,
          textTransform: "uppercase",
          letterSpacing: "0.12em",
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
  onOpenChatSession: (sessionId: string) => void;
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

  if (viewMode === "grid") {
    return (
      <div className="flex h-full flex-col">
        <div
          className="flex items-center gap-3 px-3 py-1.5"
          style={{ borderBottom: `1px solid ${THEME_BORDER}` }}
        >
          <ViewModeToggle viewMode={viewMode} setViewMode={setViewMode} />
          <span
            style={{
              fontFamily: MONO_FONT,
              fontSize: 10,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "1px",
              color: "var(--color-muted-fg)",
            }}
          >
            GRID VIEW
          </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "2px 8px",
              fontSize: 10,
              fontWeight: 700,
              fontFamily: MONO_FONT,
              letterSpacing: "1px",
              color: "rgba(var(--tab-tint-rgb, 113, 113, 122), 0.95)",
              background: "rgba(var(--tab-tint-rgb, 113, 113, 122), 0.14)",
              border: "1px solid rgba(var(--tab-tint-rgb, 113, 113, 122), 0.24)",
              borderRadius: 0,
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
                        ? `1px solid ${laneColor}40`
                        : `1px solid ${THEME_BORDER}`,
                      background: THEME_CARD,
                    }}
                  >
                    <div
                      className="flex items-center gap-2 px-2 py-1.5"
                      style={{
                        borderBottom: `1px solid ${THEME_BORDER}`,
                        background: isActive ? `${laneColor}18` : THEME_CARD,
                      }}
                    >
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => onSelectItem(session.id)}
                      >
                        <span className="flex items-center gap-2" style={{ fontFamily: MONO_FONT, fontSize: 11 }}>
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
                              fontSize: 9,
                              fontWeight: 700,
                              fontFamily: MONO_FONT,
                              letterSpacing: "0.12em",
                              textTransform: "uppercase",
                              color: laneColor,
                              background: `${laneColor}16`,
                              border: `1px solid ${laneColor}33`,
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
                      <SessionSurface session={session} isActive={isActive} />
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
            borderBottom: `1px solid ${THEME_BORDER}`,
            background: THEME_CARD,
            height: 28,
            minHeight: 28,
            maxHeight: 28,
          }}
        >
        <ViewModeToggle viewMode={viewMode} setViewMode={setViewMode} />
          <div
            className="mx-1"
            style={{ width: 1, height: 14, background: THEME_BORDER }}
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
                  fontFamily: MONO_FONT,
                  fontSize: 10,
                  fontWeight: isActive ? 600 : 400,
                  background: "transparent",
                  color: isActive ? THEME_FG : "var(--color-muted-fg)",
                  cursor: "pointer",
                  border: "none",
                  borderBottom: isActive ? "1.5px solid var(--color-accent)" : "1.5px solid transparent",
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

      <div className="min-h-0 flex-1" style={{ background: THEME_CARD }}>
        {activeSession ? (
          <SessionSurface session={activeSession} isActive />
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
