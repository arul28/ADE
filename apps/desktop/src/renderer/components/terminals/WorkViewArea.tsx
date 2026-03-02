import React, { useMemo } from "react";
import { GridFour, List, Monitor, X } from "@phosphor-icons/react";
import type { TerminalSessionSummary } from "../../../shared/types";
import { TerminalView } from "./TerminalView";
import { ToolLogo } from "./ToolLogos";
import { TilingLayout } from "../lanes/TilingLayout";
import { AgentChatPane } from "../chat/AgentChatPane";
import { cn } from "../ui/cn";
import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";

/* Inject global keyframe once */
const BLINK_KEYFRAME_ID = "ade-industrial-blink";
if (typeof document !== "undefined" && !document.getElementById(BLINK_KEYFRAME_ID)) {
  const style = document.createElement("style");
  style.id = BLINK_KEYFRAME_ID;
  style.textContent = `@keyframes industrialBlink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }`;
  document.head.appendChild(style);
}

function isChatToolType(toolType: string | null | undefined): boolean {
  return toolType === "codex-chat" || toolType === "claude-chat" || toolType === "ai-chat";
}

function statusDotColor(session: TerminalSessionSummary): string {
  if (session.status === "running") return COLORS.success;
  if (session.status === "failed") return COLORS.danger;
  if (session.status === "disposed") return "#EF444470";
  return "#3B82F670";
}

function truncateTabLabel(text: string, max = 20): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "...";
}

function zeroPad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

export function WorkViewArea({
  sessions,
  runningSessions,
  openTabIds,
  activeTabId,
  viewMode,
  setViewMode,
  onSelectTab,
  onCloseTab,
  closingPtyIds,
  onCloseSession,
}: {
  sessions: TerminalSessionSummary[];
  runningSessions: TerminalSessionSummary[];
  openTabIds: string[];
  activeTabId: string | null;
  viewMode: "tabs" | "grid";
  setViewMode: (mode: "tabs" | "grid") => void;
  onSelectTab: (sessionId: string) => void;
  onCloseTab: (sessionId: string) => void;
  closingPtyIds: Set<string>;
  onCloseSession: (id: string) => void;
}) {
  const sessionsById = useMemo(() => {
    const map = new Map<string, TerminalSessionSummary>();
    for (const s of sessions) map.set(s.id, s);
    return map;
  }, [sessions]);

  const tabSessions = useMemo(
    () => openTabIds.map((id) => sessionsById.get(id)).filter((s): s is TerminalSessionSummary => s != null),
    [openTabIds, sessionsById],
  );

  const activeSession = activeTabId ? sessionsById.get(activeTabId) ?? null : null;
  const activeIsChat = isChatToolType(activeSession?.toolType);

  if (viewMode === "grid") {
    return (
      <div className="flex h-full flex-col">
        {/* Mode toggle header */}
        <div
          className="flex items-center gap-3 px-3 py-1.5"
          style={{ borderBottom: `1px solid ${COLORS.border}` }}
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
            {runningSessions.length}
          </span>
        </div>
        <div
          className="min-h-0 flex-1 overflow-hidden m-1"
          style={{
            border: `1px solid ${COLORS.border}`,
            borderRadius: 0,
            background: "rgba(0,0,0,0.1)",
          }}
        >
          <TilingLayout
            sessions={runningSessions}
            focusedSessionId={activeTabId}
            onFocus={onSelectTab}
            onClose={onCloseSession}
            closingSessionIds={closingPtyIds}
          />
        </div>
      </div>
    );
  }

  // Tab mode
  return (
    <div className="flex h-full flex-col">
      {/* Tab bar */}
      <div
        className="flex items-center gap-1 px-1 py-1 min-h-[36px]"
        style={{ borderBottom: `1px solid ${COLORS.border}` }}
      >
        <ViewModeToggle viewMode={viewMode} setViewMode={setViewMode} />
        <div
          className="mx-1 h-4"
          style={{ width: 1, background: COLORS.border }}
        />
        <div className="flex-1 flex items-center gap-0.5 overflow-x-auto scrollbar-none min-w-0">
          {tabSessions.map((s, idx) => {
            const isActive = activeTabId === s.id;
            return (
              <button
                key={s.id}
                type="button"
                className="group/tab inline-flex items-center gap-1.5 shrink-0 transition-all"
                style={{
                  padding: "10px 16px",
                  borderRadius: 0,
                  fontFamily: MONO_FONT,
                  fontSize: 11,
                  fontWeight: 500,
                  background: isActive ? COLORS.accentSubtle : "transparent",
                  color: isActive ? COLORS.textPrimary : COLORS.textMuted,
                  cursor: "pointer",
                  border: "none",
                  borderBottom: isActive ? `2px solid ${COLORS.accent}` : "2px solid transparent",
                }}
                onClick={() => onSelectTab(s.id)}
              >
                <span
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 11,
                    fontWeight: 700,
                    color: isActive ? COLORS.accent : COLORS.textDim,
                    marginRight: 4,
                  }}
                >
                  {zeroPad(idx + 1)}
                </span>
                <ToolLogo toolType={s.toolType} size={12} />
                <span
                  className="max-w-[140px] truncate"
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 11,
                  }}
                >
                  {truncateTabLabel((s.goal ?? s.title).trim())}
                </span>
                {/* Industrial status square */}
                <span
                  className="shrink-0"
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 0,
                    background: statusDotColor(s),
                  }}
                />
                <span
                  role="button"
                  tabIndex={0}
                  className="ml-0.5 inline-flex items-center justify-center opacity-0 group-hover/tab:opacity-100 transition-opacity"
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 0,
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.background = COLORS.outlineBorder;
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.background = "transparent";
                  }}
                  onClick={(e) => { e.stopPropagation(); onCloseTab(s.id); }}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onCloseTab(s.id); } }}
                >
                  <X size={10} />
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Content area */}
      <div className="min-h-0 flex-1" style={{ background: COLORS.recessedBg }}>
        {activeSession && activeIsChat ? (
          <AgentChatPane laneId={activeSession.laneId} lockSessionId={activeSession.id} />
        ) : runningSessions.length > 0 ? (
          <div className="relative h-full w-full">
            {runningSessions.map((session) =>
              session.ptyId ? (
                <TerminalView
                  key={session.id}
                  ptyId={session.ptyId}
                  sessionId={session.id}
                  className={cn(
                    "absolute inset-0 h-full w-full transition-opacity duration-150",
                    activeSession?.id === session.id ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
                  )}
                />
              ) : null,
            )}
            {activeSession?.status === "running" && activeSession.ptyId ? null : (
              <div className="absolute inset-0 flex items-center justify-center" style={{ background: "rgba(15,13,20,0.6)", backdropFilter: "blur(2px)" }}>
                <div
                  style={{
                    borderRadius: 0,
                    border: `1px solid ${COLORS.accentBorder}`,
                    background: COLORS.cardBg,
                    padding: "10px 16px",
                    fontFamily: MONO_FONT,
                    fontSize: 12,
                    color: COLORS.textMuted,
                  }}
                >
                  Select a running session to interact.
                </div>
              </div>
            )}
          </div>
        ) : tabSessions.length === 0 ? (
          <EmptyState
            heading="No session selected"
            body="Click a session from the list to open it here."
          />
        ) : (
          <EmptyState
            heading="Session not running"
            body="This session has ended. Select a running session to view its terminal."
          />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Empty state with industrial typography                            */
/* ------------------------------------------------------------------ */
function EmptyState({ heading, body }: { heading: string; body: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      <div
        style={{
          marginBottom: 12,
          border: `1px solid ${COLORS.border}`,
          background: COLORS.cardBg,
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
          color: COLORS.textPrimary,
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
          color: COLORS.textMuted,
        }}
      >
        {body}
      </div>
      {/* Decorative blinking terminal cursor */}
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

/* ------------------------------------------------------------------ */
/*  View mode toggle – industrial sharp-cornered switch               */
/* ------------------------------------------------------------------ */
function ViewModeToggle({
  viewMode,
  setViewMode,
}: {
  viewMode: "tabs" | "grid";
  setViewMode: (mode: "tabs" | "grid") => void;
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
        title="Tiling Grid"
      >
        <GridFour size={13} />
      </button>
    </div>
  );
}
