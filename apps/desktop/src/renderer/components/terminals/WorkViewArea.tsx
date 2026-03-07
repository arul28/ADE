import { useMemo } from "react";
import { GridFour, List, Monitor, X } from "@phosphor-icons/react";
import type { TerminalSessionSummary } from "../../../shared/types";
import type { WorkViewMode } from "../../state/appStore";
import { useAppStore } from "../../state/appStore";
import { TerminalView } from "./TerminalView";
import { ToolLogo } from "./ToolLogos";
import { AgentChatPane } from "../chat/AgentChatPane";
import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";
import { isChatToolType, primarySessionLabel, secondarySessionLabel, truncateSessionLabel } from "../../lib/sessions";
import { sessionStatusDot } from "../../lib/terminalAttention";

/* Inject global keyframe once */
const BLINK_KEYFRAME_ID = "ade-industrial-blink";
if (typeof document !== "undefined" && !document.getElementById(BLINK_KEYFRAME_ID)) {
  const style = document.createElement("style");
  style.id = BLINK_KEYFRAME_ID;
  style.textContent = `@keyframes industrialBlink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }`;
  document.head.appendChild(style);
}

const THEME_CARD = "var(--color-card)";
const THEME_BORDER = "var(--color-border)";
const THEME_FG = "var(--color-fg)";
const THEME_MUTED = "var(--color-muted-fg)";
const THEME_RECESSED = "var(--color-surface-recessed)";
const THEME_CARD_OVERLAY = "color-mix(in srgb, var(--color-card) 86%, transparent)";
const THEME_RECESSED_OVERLAY = "color-mix(in srgb, var(--color-surface-recessed) 78%, transparent)";


function zeroPad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

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
        background: isActive ? THEME_CARD_OVERLAY : THEME_RECESSED_OVERLAY,
      }}
    >
      <div
        style={{
          borderRadius: 0,
          border: `1px solid ${COLORS.danger}40`,
          background: THEME_CARD,
          padding: "10px 14px",
          fontFamily: MONO_FONT,
          fontSize: 12,
          color: THEME_MUTED,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        Session ended
      </div>
    </div>
  );
}

export function WorkViewArea({
  sessions,
  visibleSessions,
  activeItemId,
  viewMode,
  setViewMode,
  onSelectItem,
  onCloseItem,
  closingPtyIds,
}: {
  sessions: TerminalSessionSummary[];
  visibleSessions: TerminalSessionSummary[];
  activeItemId: string | null;
  viewMode: WorkViewMode;
  setViewMode: (mode: WorkViewMode) => void;
  onSelectItem: (sessionId: string) => void;
  onCloseItem: (sessionId: string) => void;
  closingPtyIds: Set<string>;
}) {
  const sessionsById = useMemo(() => {
    const map = new Map<string, TerminalSessionSummary>();
    for (const session of sessions) map.set(session.id, session);
    return map;
  }, [sessions]);
  const lanes = useAppStore((s) => s.lanes);
  const laneColorById = useMemo(() => {
    const map = new Map<string, string>();
    for (const lane of lanes) {
      map.set(lane.id, lane.color ?? COLORS.accent);
    }
    return map;
  }, [lanes]);

  const displaySessions = visibleSessions.length > 0 ? visibleSessions : [];
  const activeSession = activeItemId
    ? sessionsById.get(activeItemId) ?? displaySessions[0] ?? null
    : displaySessions[0] ?? null;

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
              color: COLORS.textMuted,
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
              color: COLORS.accent,
              background: COLORS.accentSubtle,
              border: `1px solid ${COLORS.accentBorder}`,
              borderRadius: 0,
            }}
          >
            {displaySessions.length}
          </span>
        </div>

        {displaySessions.length === 0 ? (
          <EmptyState
            heading="No session selected"
            body="Click a session from the list to open it here."
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-auto p-2">
            <div className="grid grid-cols-1 gap-2 xl:grid-cols-2 2xl:grid-cols-3">
              {displaySessions.map((session) => {
                const isActive = activeSession?.id === session.id;
                const dot = sessionStatusDot(session);
                const isBusy = session.ptyId ? closingPtyIds.has(session.ptyId) : false;
                const laneColor = laneColorById.get(session.laneId) ?? COLORS.accent;
                const primary = primarySessionLabel(session);
                const secondary = secondarySessionLabel(session);
                return (
                  <div
                    key={session.id}
                    className="flex min-h-[260px] flex-col overflow-hidden"
                    style={{
                      border: isActive
                        ? `1px solid ${laneColor}`
                        : `1px solid ${THEME_BORDER}`,
                      background: `linear-gradient(180deg, ${laneColor}10 0%, ${THEME_RECESSED} 42%)`,
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
                            className={`${dot.cls} h-2.5 w-2.5 shrink-0 rounded-full${dot.spinning ? " animate-spin" : ""}`}
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
                            <span className="truncate" style={{ color: COLORS.textMuted, fontSize: 10 }}>
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
                          borderRadius: 0,
                          cursor: isBusy ? "default" : "pointer",
                          opacity: isBusy ? 0.5 : 0.85,
                          color: COLORS.textMuted,
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
          className="flex items-center gap-1 px-1 py-1 min-h-[36px]"
          style={{ borderBottom: `1px solid ${THEME_BORDER}` }}
        >
        <ViewModeToggle viewMode={viewMode} setViewMode={setViewMode} />
          <div
            className="mx-1 h-4"
            style={{ width: 1, background: THEME_BORDER }}
          />
        <div className="flex-1 flex items-center gap-0.5 overflow-x-auto scrollbar-none min-w-0">
          {displaySessions.map((session, idx) => {
            const isActive = activeSession?.id === session.id;
            const dot = sessionStatusDot(session);
            const isBusy = session.ptyId ? closingPtyIds.has(session.ptyId) : false;
            const laneColor = laneColorById.get(session.laneId) ?? COLORS.accent;
            const primary = primarySessionLabel(session);
            const secondary = secondarySessionLabel(session);
            return (
              <button
                key={session.id}
                type="button"
                className="group/tab inline-flex shrink-0 flex-col items-start gap-1 transition-all"
                style={{
                  padding: "9px 14px 10px",
                  minWidth: 220,
                  borderRadius: 0,
                  fontFamily: MONO_FONT,
                  fontSize: 11,
                  fontWeight: 500,
                  background: isActive ? `${laneColor}18` : "transparent",
                  backgroundImage: isActive
                    ? `linear-gradient(180deg, ${laneColor}22 0%, transparent 100%)`
                    : undefined,
                  color: isActive ? COLORS.textPrimary : COLORS.textMuted,
                  cursor: "pointer",
                  border: "none",
                  borderBottom: isActive ? `2px solid ${laneColor}` : "2px solid transparent",
                }}
                onClick={() => onSelectItem(session.id)}
              >
                <span className="flex w-full items-center gap-2">
                  <span
                    style={{
                      fontFamily: MONO_FONT,
                      fontSize: 10,
                      fontWeight: 700,
                      color: isActive ? laneColor : COLORS.textDim,
                    }}
                  >
                    {zeroPad(idx + 1)}
                  </span>
                  <ToolLogo toolType={session.toolType} size={12} />
                  <span className="max-w-[150px] truncate" style={{ color: THEME_FG }}>
                    {truncateSessionLabel(primary, 32)}
                  </span>
                  <span
                    title={dot.label}
                    className={`${dot.cls} ml-auto h-2.5 w-2.5 shrink-0 rounded-full${dot.spinning ? " animate-spin" : ""}`}
                  />
                  <span
                    role="button"
                    tabIndex={0}
                    className="inline-flex items-center justify-center opacity-0 group-hover/tab:opacity-100 transition-opacity"
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: 0,
                      cursor: isBusy ? "default" : "pointer",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.background = COLORS.outlineBorder;
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.background = "transparent";
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
                    <X size={10} />
                  </span>
                </span>
                <span className="flex w-full items-center gap-2 pl-[24px]">
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
                    <span className="max-w-[120px] truncate" style={{ color: COLORS.textMuted, fontSize: 10 }}>
                      {truncateSessionLabel(secondary, 24)}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1" style={{ background: THEME_RECESSED }}>
        {activeSession ? (
          <SessionSurface session={activeSession} isActive />
        ) : (
          <EmptyState
            heading="No session selected"
            body="Click a session from the list to open it here."
          />
        )}
      </div>
    </div>
  );
}

function EmptyState({ heading, body }: { heading: string; body: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      <div
        style={{
          marginBottom: 12,
          border: `1px solid ${THEME_BORDER}`,
          background: THEME_CARD,
          padding: 14,
          borderRadius: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Monitor size={24} weight="regular" style={{ color: COLORS.accent }} />
      </div>
      <div
        style={{
          fontFamily: SANS_FONT,
          fontSize: 14,
          fontWeight: 600,
          color: THEME_FG,
        }}
      >
        {heading}
      </div>
      <div
        style={{
          marginTop: 6,
          maxWidth: 280,
          textAlign: "center",
          fontFamily: MONO_FONT,
          fontSize: 12,
          lineHeight: "1.6",
          color: THEME_MUTED,
        }}
      >
        {body}
      </div>
      <div
        style={{
          marginTop: 16,
          fontFamily: MONO_FONT,
          fontSize: 12,
          color: COLORS.success,
        }}
      >
        <span>{"> "}</span>
        <span style={{ animation: "industrialBlink 1s step-end infinite" }}>_</span>
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
    <div
      className="flex items-center p-0.5"
      style={{
        border: `1px solid ${COLORS.outlineBorder}`,
        borderRadius: 0,
        background: "transparent",
      }}
    >
      <button
        onClick={() => setViewMode("tabs")}
        className="transition-colors"
        style={{
          padding: 4,
          borderRadius: 0,
          border: "none",
          cursor: "pointer",
          background: viewMode === "tabs" ? COLORS.accentSubtle : "transparent",
          color: viewMode === "tabs" ? COLORS.accent : COLORS.textMuted,
        }}
        onMouseEnter={(e) => {
          if (viewMode !== "tabs") (e.currentTarget as HTMLElement).style.color = COLORS.textSecondary;
        }}
        onMouseLeave={(e) => {
          if (viewMode !== "tabs") (e.currentTarget as HTMLElement).style.color = COLORS.textMuted;
        }}
        title="Tab View"
      >
        <List size={13} />
      </button>
      <button
        onClick={() => setViewMode("grid")}
        className="transition-colors"
        style={{
          padding: 4,
          borderRadius: 0,
          border: "none",
          cursor: "pointer",
          background: viewMode === "grid" ? COLORS.accentSubtle : "transparent",
          color: viewMode === "grid" ? COLORS.accent : COLORS.textMuted,
        }}
        onMouseEnter={(e) => {
          if (viewMode !== "grid") (e.currentTarget as HTMLElement).style.color = COLORS.textSecondary;
        }}
        onMouseLeave={(e) => {
          if (viewMode !== "grid") (e.currentTarget as HTMLElement).style.color = COLORS.textMuted;
        }}
        title="Grid View"
      >
        <GridFour size={13} />
      </button>
    </div>
  );
}
