import React, { useMemo } from "react";
import { GridFour, List, Monitor, X } from "@phosphor-icons/react";
import type { TerminalSessionSummary } from "../../../shared/types";
import { TerminalView } from "./TerminalView";
import { ToolLogo } from "./ToolLogos";
import { TilingLayout } from "../lanes/TilingLayout";
import { AgentChatPane } from "../chat/AgentChatPane";
import { cn } from "../ui/cn";

function isChatToolType(toolType: string | null | undefined): boolean {
  return toolType === "codex-chat" || toolType === "claude-chat";
}

function statusDotClass(session: TerminalSessionSummary): string {
  if (session.status === "running") return "bg-emerald-500";
  if (session.status === "failed") return "bg-red-500";
  if (session.status === "disposed") return "bg-red-400/70";
  return "bg-sky-500/70";
}

function truncateTabLabel(text: string, max = 20): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "...";
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
        <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border/5">
          <ViewModeToggle viewMode={viewMode} setViewMode={setViewMode} />
          <span className="text-[11px] text-muted-fg/60">{runningSessions.length} running</span>
        </div>
        <div className="min-h-0 flex-1 border border-border/5 bg-black/10 rounded-lg overflow-hidden m-1">
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
      <div className="flex items-center gap-1 border-b border-border/5 px-1 py-1 min-h-[36px]">
        <ViewModeToggle viewMode={viewMode} setViewMode={setViewMode} />
        <div className="mx-1 h-4 w-px bg-border/10" />
        <div className="flex-1 flex items-center gap-0.5 overflow-x-auto scrollbar-none min-w-0">
          {tabSessions.map((s) => (
            <button
              key={s.id}
              type="button"
              className={cn(
                "group/tab inline-flex items-center gap-1.5 shrink-0 rounded-md px-2 py-1 text-xs font-medium transition-all",
                activeTabId === s.id
                  ? "bg-accent/10 text-fg ring-1 ring-accent/30"
                  : "text-muted-fg/70 hover:bg-muted/30 hover:text-muted-fg",
              )}
              onClick={() => onSelectTab(s.id)}
            >
              <ToolLogo toolType={s.toolType} size={12} />
              <span className="max-w-[140px] truncate">
                {truncateTabLabel((s.goal ?? s.title).trim())}
              </span>
              <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", statusDotClass(s))} />
              <span
                role="button"
                tabIndex={0}
                className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded opacity-0 group-hover/tab:opacity-100 hover:bg-muted/60 transition-opacity"
                onClick={(e) => { e.stopPropagation(); onCloseTab(s.id); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onCloseTab(s.id); } }}
              >
                <X size={10} />
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Content area */}
      <div className="min-h-0 flex-1 bg-surface-recessed">
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
              <div className="absolute inset-0 flex items-center justify-center bg-bg/60 backdrop-blur-[2px]">
                <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm px-4 py-2.5 text-xs text-muted-fg shadow-card">
                  Select a running session to interact.
                </div>
              </div>
            )}
          </div>
        ) : tabSessions.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6">
            <div className="mb-3 rounded-lg border border-border/10 bg-card p-3.5">
              <Monitor size={24} weight="regular" className="text-muted-fg/35" />
            </div>
            <div className="text-sm font-semibold text-fg/50">No session selected</div>
            <div className="mt-1.5 max-w-xs text-center text-xs leading-relaxed text-muted-fg/50">
              Click a session from the list to open it here.
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center px-6">
            <div className="mb-3 rounded-lg border border-border/10 bg-card p-3.5">
              <Monitor size={24} weight="regular" className="text-muted-fg/35" />
            </div>
            <div className="text-sm font-semibold text-fg/50">Session not running</div>
            <div className="mt-1.5 max-w-xs text-center text-xs leading-relaxed text-muted-fg/50">
              This session has ended. Select a running session to view its terminal.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ViewModeToggle({
  viewMode,
  setViewMode,
}: {
  viewMode: "tabs" | "grid";
  setViewMode: (mode: "tabs" | "grid") => void;
}) {
  return (
    <div className="flex items-center rounded-md border border-border/15 bg-card/50 p-0.5">
      <button
        onClick={() => setViewMode("tabs")}
        className={cn(
          "p-1 rounded transition-colors",
          viewMode === "tabs" ? "bg-muted text-fg shadow-sm" : "text-muted-fg hover:bg-muted/50",
        )}
        title="Tab View"
      >
        <List size={13} />
      </button>
      <button
        onClick={() => setViewMode("grid")}
        className={cn(
          "p-1 rounded transition-colors",
          viewMode === "grid" ? "bg-muted text-fg shadow-sm" : "text-muted-fg hover:bg-muted/50",
        )}
        title="Tiling Grid"
      >
        <GridFour size={13} />
      </button>
    </div>
  );
}
