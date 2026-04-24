import { useMemo, useCallback, useEffect, useRef, useState } from "react";
import { CaretDown, CaretRight, Clipboard, GitBranch, GridFour, List, Play, Plus, X } from "@phosphor-icons/react";
import type { AgentChatSession, LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import type { WorkDraftKind, WorkViewMode } from "../../state/appStore";
import { TerminalView } from "./TerminalView";
import { ToolLogo } from "./ToolLogos";
import { AgentChatPane } from "../chat/AgentChatPane";
import { WorkStartSurface } from "./WorkStartSurface";
import { isChatToolType, primarySessionLabel, secondarySessionLabel, truncateSessionLabel, formatToolTypeLabel } from "../../lib/sessions";
import { sessionStatusDot } from "../../lib/terminalAttention";
import type { WorkTabGroup } from "./useWorkSessions";
import { SmartTooltip } from "../ui/SmartTooltip";
import { PaneTilingLayout, type PaneConfig } from "../ui/PaneTilingLayout";
import { cn } from "../ui/cn";
import { resolveTrackedCliResumeCommand } from "./cliLaunch";
import { buildWorkSessionTilingTree } from "./workSessionTiling";

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
  shouldAutofocus = false,
  layoutVariant = "standard",
  terminalVisible = isActive,
  onOpenChatSession,
  onResume,
}: {
  session: TerminalSessionSummary;
  isActive: boolean;
  shouldAutofocus?: boolean;
  layoutVariant?: "standard" | "grid-tile";
  terminalVisible?: boolean;
  onOpenChatSession: (session: AgentChatSession) => void | Promise<void>;
  onResume?: (session: TerminalSessionSummary) => void;
}) {
  const isChat = isChatToolType(session.toolType);
  if (isChat) {
    return (
      <AgentChatPane
        laneId={session.laneId}
        laneLabel={session.laneName}
        lockSessionId={session.id}
        hideSessionTabs
        onSessionCreated={onOpenChatSession}
        layoutVariant={layoutVariant}
        isTileActive={isActive}
        shouldAutofocusComposer={shouldAutofocus}
      />
    );
  }
  if (isRunningPtySession(session)) {
    return (
      <TerminalView
        key={session.id}
        ptyId={session.ptyId}
        sessionId={session.id}
        isActive={isActive}
        isVisible={terminalVisible}
        className="h-full w-full"
      />
    );
  }

  const resumeCommand = resolveTrackedCliResumeCommand(session);
  const label = primarySessionLabel(session);
  const toolLabel = session.toolType ? formatToolTypeLabel(session.toolType) : null;
  const rawSummary = session.summary?.trim() || session.goal?.trim() || null;
  // Don't show summary if it just repeats the title
  const summary = rawSummary && rawSummary !== label && !rawSummary.startsWith(label) ? rawSummary : null;
  const endedTime = session.endedAt
    ? new Date(session.endedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;

  return (
    <div
      className="flex h-full w-full items-center justify-center px-6"
      style={{
        background: "radial-gradient(circle at top, color-mix(in srgb, var(--color-accent-glow-strong) 30%, transparent) 0%, transparent 40%), var(--color-card)",
      }}
    >
      <div className="ade-liquid-glass-menu flex w-full max-w-md flex-col gap-4 rounded-lg px-5 py-5">
        {/* Header: tool logo + session name */}
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md" style={{ background: "rgba(255,255,255,0.05)" }}>
            <ToolLogo toolType={session.toolType} size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-fg">{label}</div>
            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-fg/70">
              {toolLabel && <span>{toolLabel}</span>}
              {toolLabel && endedTime && <span>·</span>}
              {endedTime && <span>Ended {endedTime}</span>}
              {session.exitCode != null && session.exitCode !== 0 && (
                <>
                  <span>·</span>
                  <span className="text-red-400">Exit {session.exitCode}</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Summary */}
        {summary && (
          <div className="text-[12px] leading-relaxed text-muted-fg">
            {summary.length > 300 ? `${summary.slice(0, 300).trimEnd()}…` : summary}
          </div>
        )}

        {/* Session ID */}
        <div className="flex items-center gap-2 text-[10px] text-muted-fg/50">
          <span className="font-mono">{session.id}</span>
        </div>

        {/* Resume command */}
        {resumeCommand && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-fg/50">Resume command</span>
            <ResumeCommandBlock command={resumeCommand} />
          </div>
        )}

        {/* Resume button */}
        {resumeCommand && onResume && (
          <button
            type="button"
            onClick={() => onResume(session)}
            className="ade-work-new-chat-btn flex items-center justify-center gap-2 px-4 py-2 text-[12px] font-medium"
            style={{ cursor: "pointer" }}
          >
            <Play size={14} weight="fill" />
            Resume session
          </button>
        )}
      </div>
    </div>
  );
}

function ResumeCommandBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<number | null>(null);
  const copy = useCallback(async () => {
    if (copyTimeoutRef.current != null) {
      window.clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = null;
    }
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      copyTimeoutRef.current = window.setTimeout(() => {
        copyTimeoutRef.current = null;
        setCopied(false);
      }, 1500);
    } catch (err) {
      console.warn("[WorkViewArea] Failed to copy resume command:", err);
    }
  }, [command]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current != null) {
        window.clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = null;
      }
    };
  }, []);

  return (
    <div
      className="ade-chat-recessed group relative flex items-center rounded-md px-3 py-2 font-mono text-[11px] text-fg/80"
    >
      <span className="flex-1 select-all break-all">{command}</span>
      <button
        type="button"
        onClick={copy}
        className="ml-2 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
        style={{ cursor: "pointer", background: "none", border: "none", color: "var(--color-muted-fg)" }}
        title="Copy to clipboard"
      >
        {copied ? <span className="text-[10px] text-green-400">Copied</span> : <Clipboard size={14} />}
      </button>
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
    <div className="ade-liquid-glass-pill inline-flex items-center rounded-full p-0.5">
      {MODE_OPTIONS.map((opt) => {
        const active = draftKind === opt.kind;
        return (
          <button
            key={opt.kind}
            type="button"
            className={`rounded-full px-3 py-1 text-[11px] font-medium transition-all${active ? " ade-work-tab-active" : ""}`}
            style={{
              background: active ? undefined : "transparent",
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
  gridLayoutId,
  lanes,
  sessions,
  visibleSessions,
  tabGroups,
  tabVisibleSessionIds,
  activeItemId,
  viewMode,
  draftKind,
  onResumeSession,
  setViewMode,
  onSelectItem,
  onCloseItem,
  onOpenChatSession,
  onLaunchPtySession,
  onShowDraftKind,
  onToggleTabGroupCollapsed,
  closingPtyIds,
  onContextMenu,
}: {
  gridLayoutId: string;
  lanes: LaneSummary[];
  sessions: TerminalSessionSummary[];
  visibleSessions: TerminalSessionSummary[];
  tabGroups?: WorkTabGroup[];
  tabVisibleSessionIds?: string[];
  activeItemId: string | null;
  viewMode: WorkViewMode;
  draftKind: WorkDraftKind;
  setViewMode: (mode: WorkViewMode) => void;
  onSelectItem: (sessionId: string) => void;
  onCloseItem: (sessionId: string) => void;
  onOpenChatSession: (session: AgentChatSession) => void | Promise<void>;
  onLaunchPtySession: (args: {
    laneId: string;
    profile: "claude" | "codex" | "shell";
    title?: string;
    startupCommand?: string;
    tracked?: boolean;
  }) => Promise<unknown>;
  onShowDraftKind: (kind: WorkDraftKind) => void;
  onToggleTabGroupCollapsed?: (groupId: string) => void;
  closingPtyIds: Set<string>;
  onContextMenu?: (session: TerminalSessionSummary, e: React.MouseEvent) => void;
  onResumeSession?: (session: TerminalSessionSummary) => void;
}) {
  const sessionsById = useMemo(() => {
    const map = new Map<string, TerminalSessionSummary>();
    for (const session of sessions) map.set(session.id, session);
    return map;
  }, [sessions]);

  const tabVisibleSessions = useMemo(
    () => (tabVisibleSessionIds ?? visibleSessions.map((session) => session.id))
      .map((sessionId) => sessionsById.get(sessionId))
      .filter((session): session is TerminalSessionSummary => session != null),
    [sessionsById, tabVisibleSessionIds, visibleSessions],
  );
  const showingDraft = activeItemId == null;
  const activeSession = showingDraft
    ? null
    : sessionsById.get(activeItemId) ?? tabVisibleSessions[0] ?? visibleSessions[0] ?? null;
  const activeRunningTerminalSession = isRunningPtySession(activeSession) ? activeSession : null;
  const handleContextMenu = useCallback((session: TerminalSessionSummary, e: React.MouseEvent): void => {
    if (onContextMenu) {
      e.preventDefault();
      onContextMenu(session, e);
    }
  }, [onContextMenu]);
  const gridTree = useMemo(
    () => buildWorkSessionTilingTree(visibleSessions.map((session) => session.id)),
    [visibleSessions],
  );
  const tilingPanes = useMemo<Record<string, PaneConfig>>(() => Object.fromEntries(
    visibleSessions.map((session) => {
      const dot = sessionStatusDot(session);
      const isBusy = session.ptyId ? closingPtyIds.has(session.ptyId) : false;
      const isActive = activeItemId === session.id;
      return [session.id, {
        title: truncateSessionLabel(primarySessionLabel(session)),
        meta: session.laneName,
        minimizable: false,
        className: cn("h-full ade-work-glass-tile", isActive && "ade-work-glass-tile-active"),
        bodyClassName: "overflow-hidden",
        headerActions: (
          <>
            <span
              title={dot.label}
              className={`${dot.cls} h-2 w-2 shrink-0${dot.spinning ? " animate-spin" : ""}`}
            />
            <button
              type="button"
              onClick={() => onCloseItem(session.id)}
              onMouseDown={(e) => e.stopPropagation()}
              title={isBusy ? "Closing..." : "Close"}
              disabled={isBusy}
              className="inline-flex h-5 w-5 items-center justify-center text-muted-fg/50 transition-colors hover:text-fg"
              style={{
                border: "none",
                background: "transparent",
                cursor: isBusy ? "default" : "pointer",
                opacity: isBusy ? 0.4 : 1,
              }}
            >
              <X size={10} />
            </button>
          </>
        ),
        onPaneMouseDown: () => onSelectItem(session.id),
        onPaneContextMenu: (e) => handleContextMenu(session, e),
        children: (
          <div className="min-h-0 h-full flex-1 overflow-hidden">
            <SessionSurface
              session={session}
              isActive={isActive}
              shouldAutofocus={isActive}
              terminalVisible
              layoutVariant="grid-tile"
              onOpenChatSession={onOpenChatSession}
              onResume={onResumeSession}
            />
          </div>
        ),
      } satisfies PaneConfig];
    }),
  ), [activeItemId, closingPtyIds, handleContextMenu, onCloseItem, onOpenChatSession, onResumeSession, onSelectItem, visibleSessions]);
  const resolvedTabGroups = tabGroups ?? [];
  const hasGroupedTabs = resolvedTabGroups.length > 0;
  const toggleTabGroupCollapsed = onToggleTabGroupCollapsed ?? (() => {});

  if (viewMode === "grid") {
    return (
      <div className="flex h-full flex-col">
        <div className="ade-work-glass-header flex items-center gap-3 px-3 py-1.5">
          <ViewModeToggle viewMode={viewMode} setViewMode={setViewMode} />
          <span className="text-[11px] font-medium text-muted-fg">Grid</span>
          <span className="ade-liquid-glass-pill inline-flex items-center px-1.5 text-[10px] text-muted-fg/60 rounded">
            {visibleSessions.length}
          </span>
        </div>

        {visibleSessions.length === 0 ? (
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
          <PaneTilingLayout
            layoutId={gridLayoutId}
            tree={gridTree}
            panes={tilingPanes}
            className="flex-1 min-h-0 px-2 pb-2"
          />
        )}
      </div>
    );
  }

  /* ---- Tab view ---- */
  if (!hasGroupedTabs) {
    return (
      <div className="flex h-full flex-col">
        <div
          className="ade-work-glass-header flex items-center gap-0 px-0.5"
          style={{
            height: 32,
            minHeight: 32,
            maxHeight: 32,
          }}
        >
          <ViewModeToggle viewMode={viewMode} setViewMode={setViewMode} />
          <div className="mx-1" style={{ width: 1, height: 14, background: "var(--work-pane-border)" }} />
          <div className="flex-1 flex items-center gap-0 overflow-x-auto scrollbar-none min-w-0">
            {visibleSessions.map((session) => {
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
                    height: 32,
                    fontSize: 11,
                    fontWeight: isActive ? 500 : 400,
                    background: "transparent",
                    color: isActive ? "var(--color-fg)" : "var(--color-muted-fg)",
                    cursor: "pointer",
                    border: "none",
                    borderBottom: isActive ? "2px solid var(--color-accent)" : "2px solid transparent",
                    borderRadius: "0",
                    opacity: isActive ? 1 : 0.65,
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
            <SmartTooltip content={{ label: "New Chat", description: "Start a new AI chat session." }}>
              <button
                type="button"
                className="ade-work-new-chat-btn inline-flex shrink-0 items-center justify-center"
                style={{
                  width: 22,
                  height: 22,
                  marginLeft: 4,
                  cursor: "pointer",
                }}
                onClick={() => onShowDraftKind("chat")}
                title="New Chat"
                aria-label="Start a new chat"
              >
                <Plus size={11} weight="bold" />
              </button>
            </SmartTooltip>
          </div>
        </div>

        <div className="relative min-h-0 flex-1" style={{ background: "var(--color-bg)" }}>
          {activeRunningTerminalSession ? (
            <TerminalView
              key={activeRunningTerminalSession.id}
              ptyId={activeRunningTerminalSession.ptyId}
              sessionId={activeRunningTerminalSession.id}
              isActive
              isVisible
              className="absolute inset-0 h-full w-full"
            />
          ) : null}

          {activeSession ? (
            activeRunningTerminalSession ? null : (
              <div className="absolute inset-0">
                <SessionSurface session={activeSession} isActive terminalVisible onOpenChatSession={onOpenChatSession} onResume={onResumeSession} />
              </div>
            )
          ) : (
            <div className="absolute inset-0 flex flex-col">
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

  return (
    <div className="flex h-full flex-col">
      <div className="ade-work-glass-header flex items-start gap-1.5 px-1 py-1">
        <div className="shrink-0">
          <ViewModeToggle viewMode={viewMode} setViewMode={setViewMode} />
        </div>
        <div className="mx-1 mt-1" style={{ width: 1, height: 14, background: "var(--work-pane-border)" }} />
        <div className="min-w-0 flex-1 overflow-x-auto scrollbar-none">
          <div className="flex items-stretch gap-1.5">
            {resolvedTabGroups.map((group) => {
              const hasActive = group.sessionIds.includes(activeSession?.id ?? "");
              return (
                <div
                  key={group.id}
                  className={`ade-work-glass-group${hasActive ? " ade-work-glass-group-active" : ""} inline-flex shrink-0 flex-col overflow-hidden ${group.collapsed ? "rounded-full" : "rounded-xl"}`}
                >
                  <button
                    type="button"
                    aria-expanded={!group.collapsed}
                    aria-controls={`tab-group-${group.id}`}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-left text-[11px] font-medium transition-colors"
                    style={{
                      color: hasActive ? "var(--color-fg)" : "var(--color-muted-fg)",
                      cursor: "pointer",
                    }}
                    onClick={() => toggleTabGroupCollapsed(group.id)}
                    title={`${group.collapsed ? "Expand" : "Collapse"} ${group.label}`}
                  >
                    {group.kind === "lane" ? <GitBranch size={10} className="shrink-0 text-muted-fg/60" /> : null}
                    <span className="max-w-[130px] truncate">{group.label}</span>
                    <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[9px] text-muted-fg/40">
                      {group.sessions.length}
                    </span>
                    {group.collapsed ? (
                      <CaretRight size={10} className="shrink-0 text-muted-fg/35" />
                    ) : (
                      <CaretDown size={10} className="shrink-0 text-muted-fg/35" />
                    )}
                  </button>
                  {!group.collapsed ? (
                    <div id={`tab-group-${group.id}`} className="flex min-w-0 items-stretch gap-0.5 overflow-x-auto scrollbar-none border-t border-white/[0.04] px-0.5 py-0.5">
                      {group.sessions.map((session) => {
                        const isActive = activeSession?.id === session.id;
                        const dot = sessionStatusDot(session);
                        const isBusy = session.ptyId ? closingPtyIds.has(session.ptyId) : false;
                        const primary = primarySessionLabel(session);
                        return (
                          <button
                            key={session.id}
                            type="button"
                            className={`group/tab inline-flex shrink-0 items-center gap-1.5 transition-all${isActive ? " ade-work-tab-active" : ""}`}
                            style={{
                              padding: "0 8px",
                              height: 28,
                              fontSize: 11,
                              fontWeight: isActive ? 500 : 400,
                              background: isActive ? undefined : "transparent",
                              color: isActive ? "var(--color-fg)" : "var(--color-muted-fg)",
                              cursor: "pointer",
                              border: "none",
                              borderRadius: 6,
                              opacity: isActive ? 1 : 0.7,
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
                              className="inline-flex items-center justify-center opacity-0 transition-opacity group-hover/tab:opacity-100"
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
                  ) : null}
                </div>
              );
            })}
            <SmartTooltip content={{ label: "New Chat", description: "Start a new AI chat session." }}>
              <button
                type="button"
                className="ade-work-new-chat-btn inline-flex shrink-0 items-center justify-center"
                style={{
                  width: 22,
                  height: 22,
                  marginTop: 3,
                  cursor: "pointer",
                }}
                onClick={() => onShowDraftKind("chat")}
                title="New Chat"
                aria-label="Start a new chat"
              >
                <Plus size={11} weight="bold" />
              </button>
            </SmartTooltip>
          </div>
        </div>
      </div>

      <div className="relative min-h-0 flex-1" style={{ background: "var(--color-bg)" }}>
        {activeRunningTerminalSession ? (
          <TerminalView
            key={activeRunningTerminalSession.id}
            ptyId={activeRunningTerminalSession.ptyId}
            sessionId={activeRunningTerminalSession.id}
            isActive
            isVisible
            className="absolute inset-0 h-full w-full"
          />
        ) : null}

        {activeSession ? (
          activeRunningTerminalSession ? null : (
            <div className="absolute inset-0">
              <SessionSurface session={activeSession} isActive terminalVisible onOpenChatSession={onOpenChatSession} onResume={onResumeSession} />
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
    <div
      className="ade-liquid-glass-pill inline-flex items-center rounded-full p-0.5"
      style={{
        height: 24,
      }}
    >
      {([
        { mode: "tabs" as const, icon: <List size={11} />, label: "Tabs", title: "Tab View", description: "Display sessions as tabs in a single panel." },
        { mode: "grid" as const, icon: <GridFour size={11} />, label: "Grid", title: "Grid View", description: "Display sessions side by side in a tiled grid." },
      ]).map(({ mode, icon, label, title, description }) => {
        const active = viewMode === mode;
        return (
          <SmartTooltip key={mode} content={{ label: title, description }}>
            <button
              type="button"
              aria-pressed={active}
              onClick={() => setViewMode(mode)}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 text-[10px] font-medium transition-all${active ? " ade-work-tab-active" : ""}`}
              style={{
                height: 20,
                background: active ? undefined : "transparent",
                color: active ? "var(--color-accent)" : "var(--color-muted-fg)",
                border: "none",
                cursor: "pointer",
              }}
              title={title}
            >
              {icon}
              {label}
            </button>
          </SmartTooltip>
        );
      })}
    </div>
  );
}
