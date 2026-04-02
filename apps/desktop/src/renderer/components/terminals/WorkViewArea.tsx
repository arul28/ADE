import { useMemo } from "react";
import { GridFour, List, X } from "@phosphor-icons/react";
import type { LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import type { WorkDraftKind, WorkViewMode } from "../../state/appStore";
import { TerminalView } from "./TerminalView";
import { ToolLogo } from "./ToolLogos";
import { AgentChatPane } from "../chat/AgentChatPane";
import { WorkStartSurface } from "./WorkStartSurface";
import { isChatToolType, primarySessionLabel, secondarySessionLabel, truncateSessionLabel } from "../../lib/sessions";
import { sessionStatusDot } from "../../lib/terminalAttention";

function isRunningPtySession(
  session: TerminalSessionSummary | null | undefined,
): session is TerminalSessionSummary & { ptyId: string } {
  return Boolean(
    session
    && session.status === "running"
    && session.ptyId
    && !isChatToolType(session.toolType),
  );
}

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
    return <AgentChatPane laneId={session.laneId} laneLabel={session.laneName} lockSessionId={session.id} onSessionCreated={onOpenChatSession} />;
  }
  if (isRunningPtySession(session)) {
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
    <div className="flex h-full w-full items-center justify-center px-5" style={{ background: "var(--color-card)" }}>
      <div className="rounded-md px-3 py-2 text-[11px] text-muted-fg" style={{ background: "rgba(255,255,255,0.03)" }}>
        Session ended
      </div>
    </div>
  );
}

const MODE_OPTIONS: Array<{ kind: WorkDraftKind; label: string }> = [
  { kind: "chat", label: "Chat" },
  { kind: "cli", label: "CLI" },
  { kind: "shell", label: "Shell" },
];

function ModeSwitcherPills({
  draftKind,
  onShowDraftKind,
}: {
  draftKind: WorkDraftKind;
  onShowDraftKind: (kind: WorkDraftKind) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-full p-0.5" style={{ background: "rgba(255,255,255,0.04)" }}>
      {MODE_OPTIONS.map((opt) => {
        const active = draftKind === opt.kind;
        return (
          <button
            key={opt.kind}
            type="button"
            className="rounded-full px-3 py-1 text-[11px] font-medium transition-all"
            style={{
              background: active ? "rgba(255,255,255,0.10)" : "transparent",
              color: active ? "var(--color-fg)" : "var(--color-muted-fg)",
              cursor: "pointer",
              border: "none",
            }}
            onClick={() => onShowDraftKind(opt.kind)}
          >
            {opt.label}
          </button>
        );
      })}
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
  showingDraft,
  setViewMode,
  onSelectItem,
  onCloseItem,
  onOpenChatSession,
  onLaunchPtySession,
  onShowDraftKind,
  closingPtyIds,
  onContextMenu,
}: {
  lanes: LaneSummary[];
  sessions: TerminalSessionSummary[];
  visibleSessions: TerminalSessionSummary[];
  activeItemId: string | null;
  viewMode: WorkViewMode;
  draftKind: WorkDraftKind;
  showingDraft: boolean;
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
  onShowDraftKind: (kind: WorkDraftKind) => void;
  closingPtyIds: Set<string>;
  onContextMenu?: (session: TerminalSessionSummary, e: React.MouseEvent) => void;
}) {
  const sessionsById = useMemo(() => {
    const map = new Map<string, TerminalSessionSummary>();
    for (const session of sessions) map.set(session.id, session);
    return map;
  }, [sessions]);

  const displaySessions = visibleSessions;
  const activeSession = activeItemId
    ? sessionsById.get(activeItemId) ?? displaySessions[0] ?? null
    : null;
  const activeRunningTerminalSession = isRunningPtySession(activeSession) ? activeSession : null;

  function handleContextMenu(session: TerminalSessionSummary, e: React.MouseEvent): void {
    if (onContextMenu) {
      e.preventDefault();
      onContextMenu(session, e);
    }
  }

  if (viewMode === "grid") {
    return (
      <div className="flex h-full flex-col">
        <div
          className="flex items-center gap-3 px-3 py-1.5"
          style={{ borderBottom: "1px solid var(--work-pane-border)", background: "transparent" }}
        >
          <ViewModeToggle viewMode={viewMode} setViewMode={setViewMode} />
          <span className="text-[11px] font-medium text-muted-fg">Grid</span>
          <span className="inline-flex items-center px-1.5 text-[10px] text-muted-fg/60 rounded" style={{ background: "rgba(255,255,255,0.04)" }}>
            {displaySessions.length}
          </span>
        </div>

        {displaySessions.length === 0 ? (
          <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center justify-center py-2">
              <ModeSwitcherPills draftKind={draftKind} onShowDraftKind={onShowDraftKind} />
            </div>
            <div className="min-h-0 flex-1">
              <WorkStartSurface
                draftKind={draftKind}
                lanes={lanes}
                onOpenChatSession={onOpenChatSession}
                onLaunchPtySession={onLaunchPtySession}
              />
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto p-2">
            <div className="grid gap-2" style={{
              gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 360px), 1fr))",
              gridAutoRows: "minmax(240px, 33vh)",
            }}>
              {displaySessions.map((session) => {
                const isActive = activeSession?.id === session.id;
                const dot = sessionStatusDot(session);
                const isBusy = session.ptyId ? closingPtyIds.has(session.ptyId) : false;
                const primary = primarySessionLabel(session);
                const secondary = secondarySessionLabel(session);
                return (
                  <div
                    key={session.id}
                    className="flex min-h-0 flex-col overflow-hidden rounded-md"
                    onContextMenu={(e) => handleContextMenu(session, e)}
                    style={{
                      border: isActive
                        ? "1px solid rgba(255,255,255,0.08)"
                        : "1px solid rgba(255,255,255,0.04)",
                      background: "transparent",
                    }}
                  >
                    <div
                      className="flex items-center gap-2 px-2 py-1.5"
                      style={{
                        borderBottom: "1px solid rgba(255,255,255,0.04)",
                        background: isActive ? "rgba(255,255,255,0.02)" : "transparent",
                      }}
                    >
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => onSelectItem(session.id)}
                      >
                        <span className="flex items-center gap-2 text-[11px]">
                          <span
                            title={dot.label}
                            className={`${dot.cls} h-2 w-2 shrink-0${dot.spinning ? " animate-spin" : ""}`}
                          />
                          <ToolLogo toolType={session.toolType} size={11} />
                          <span className="truncate text-fg">
                            {truncateSessionLabel(primary)}
                          </span>
                        </span>
                        <span className="mt-0.5 flex items-center gap-2 pl-[18px]">
                          <span className="text-[10px] text-muted-fg/50">
                            {session.laneName}
                          </span>
                          {secondary ? (
                            <span className="truncate text-[10px] text-muted-fg/60">
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
                        className="inline-flex items-center justify-center w-5 h-5 text-muted-fg/50 hover:text-fg transition-colors"
                        style={{
                          border: "none",
                          background: "transparent",
                          cursor: isBusy ? "default" : "pointer",
                          opacity: isBusy ? 0.4 : 1,
                        }}
                      >
                        <X size={10} />
                      </button>
                    </div>
                    <div className="min-h-0 flex-1 overflow-auto">
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

  /* ---- Tab view ---- */
  return (
    <div className="flex h-full flex-col">
      <div
        className="flex items-center gap-0 px-0.5"
        style={{
          borderBottom: "1px solid var(--work-pane-border)",
          background: "transparent",
          height: 28,
          minHeight: 28,
          maxHeight: 28,
        }}
      >
        <ViewModeToggle viewMode={viewMode} setViewMode={setViewMode} />
        <div className="mx-1" style={{ width: 1, height: 14, background: "var(--work-pane-border)" }} />
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
                  fontSize: 11,
                  fontWeight: isActive ? 500 : 400,
                  background: "transparent",
                  color: isActive ? "var(--color-fg)" : "var(--color-muted-fg)",
                  cursor: "pointer",
                  border: "none",
                  borderBottom: isActive ? "2px solid var(--color-accent)" : "2px solid transparent",
                  borderRadius: "0",
                  opacity: isActive ? 1 : 0.5,
                }}
                onClick={() => onSelectItem(session.id)}
                onContextMenu={(e) => handleContextMenu(session, e)}
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

      <div className="relative min-h-0 flex-1" style={{ background: "var(--color-card)" }}>
        {activeRunningTerminalSession ? (
          <TerminalView
            key={activeRunningTerminalSession.id}
            ptyId={activeRunningTerminalSession.ptyId}
            sessionId={activeRunningTerminalSession.id}
            isActive
            className="absolute inset-0 h-full w-full"
          />
        ) : null}

        {activeSession ? (
          activeRunningTerminalSession ? null : (
            <div className="absolute inset-0">
              <SessionSurface session={activeSession} isActive onOpenChatSession={onOpenChatSession} />
            </div>
          )
        ) : (
          <div className="absolute inset-0 flex flex-col">
            {/* Mode switcher pills */}
            <div className="flex shrink-0 items-center justify-center py-2">
              <ModeSwitcherPills draftKind={draftKind} onShowDraftKind={onShowDraftKind} />
            </div>
            <div className="min-h-0 flex-1">
              <WorkStartSurface
                draftKind={draftKind}
                lanes={lanes}
                onOpenChatSession={onOpenChatSession}
                onLaunchPtySession={onLaunchPtySession}
              />
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
          color: viewMode === "tabs" ? "var(--color-fg)" : "var(--color-muted-fg)",
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
          color: viewMode === "grid" ? "var(--color-fg)" : "var(--color-muted-fg)",
          opacity: viewMode === "grid" ? 0.8 : 0.3,
        }}
        title="Grid View"
      >
        <GridFour size={12} />
      </button>
    </div>
  );
}
