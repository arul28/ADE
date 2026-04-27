import { useMemo, useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  CaretDown,
  CaretRight,
  Chats,
  Check,
  Clipboard,
  Code,
  Columns,
  GitBranch,
  GridFour,
  List,
  Play,
  Plus,
  Rows,
  SidebarSimple,
  Terminal,
  X,
} from "@phosphor-icons/react";
import type { AgentChatSession, LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import type { WorkDraftKind, WorkViewMode } from "../../state/appStore";
import { TerminalView } from "./TerminalView";
import { ToolLogo } from "./ToolLogos";
import { AgentChatPane } from "../chat/AgentChatPane";
import { WorkStartSurface } from "./WorkStartSurface";
import { isChatToolType, primarySessionLabel, truncateSessionLabel, formatToolTypeLabel } from "../../lib/sessions";
import { sessionStatusDot } from "../../lib/terminalAttention";
import type { WorkTabGroup } from "./useWorkSessions";
import { SmartTooltip } from "../ui/SmartTooltip";
import { PaneTilingLayout, type PaneConfig } from "../ui/PaneTilingLayout";
import { cn } from "../ui/cn";
import { resolveTrackedCliResumeCommand } from "./cliLaunch";
import { buildWorkSessionTilingTree, type TilingPreset } from "./workSessionTiling";
import { laneSurfaceTint } from "../lanes/laneDesignTokens";

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
        background: "radial-gradient(circle at top, color-mix(in srgb, var(--color-fg) 5%, transparent) 0%, transparent 42%), var(--color-card)",
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

const MODE_OPTIONS: Array<{
  kind: WorkDraftKind;
  label: string;
  description: string;
  Icon: typeof Chats;
}> = [
  { kind: "chat", label: "Chat", description: "Compose a new ADE chat in this lane.", Icon: Chats },
  { kind: "cli", label: "CLI", description: "Start a tracked Claude Code or Codex CLI session.", Icon: Code },
  { kind: "shell", label: "Shell", description: "Open a plain terminal shell in this lane's worktree.", Icon: Terminal },
];

type SessionsPaneExpandAffordanceProps = {
  show: boolean;
  onExpand: () => void;
  listCount: number;
  runningCount: number;
  listLoading: boolean;
};

function SessionsPaneExpandAffordance({
  show,
  onExpand,
  listCount,
  runningCount,
  listLoading,
}: SessionsPaneExpandAffordanceProps) {
  if (!show) return null;
  let countHint: string;
  if (listLoading) {
    countHint = "Loading session list…";
  } else if (listCount > 0) {
    countHint = `${listCount} in list${runningCount > 0 ? `, ${runningCount} running` : ""}`;
  } else {
    countHint = "Session list is empty.";
  }
  return (
    <SmartTooltip
      content={{
        label: "Show sessions",
        description: `Expand the sessions sidebar. ${countHint}`,
      }}
    >
      <button
        type="button"
        className="ade-shell-control inline-flex shrink-0 items-center gap-1 px-1.5 py-1 text-[11px] font-medium"
        data-variant="ghost"
        data-tour="work.focusToolbar"
        onClick={onExpand}
      >
        <SidebarSimple size={13} weight="regular" />
        {!listLoading && listCount > 0 ? (
          <span className="min-w-[1ch] text-[10px] tabular-nums text-muted-fg/50">{listCount}</span>
        ) : null}
      </button>
    </SmartTooltip>
  );
}

function ModeSwitcherPills({
  draftKind,
  onShowDraftKind,
}: {
  draftKind: WorkDraftKind;
  onShowDraftKind: (kind: WorkDraftKind) => void;
}) {
  return (
    <div className="ade-liquid-glass-pill inline-flex items-center gap-0.5 rounded-full p-1">
      {MODE_OPTIONS.map((opt) => {
        const active = draftKind === opt.kind;
        const Icon = opt.Icon;
        return (
          <SmartTooltip
            key={opt.kind}
            content={{
              label: opt.label,
              description: opt.description,
              effect: active ? "This start mode is selected." : undefined,
            }}
          >
            <button
              type="button"
              className={cn(
                "inline-flex min-h-[36px] items-center gap-2 rounded-full px-3.5 py-2 text-[12px] font-medium transition-all",
                active && "ade-work-tab-active",
              )}
              style={{
                background: active ? undefined : "transparent",
                color: active ? "var(--color-fg)" : "var(--color-muted-fg)",
                cursor: "pointer",
                border: "none",
              }}
              onClick={() => onShowDraftKind(opt.kind)}
            >
              <Icon size={15} weight="regular" className="shrink-0 opacity-80" />
              {opt.label}
            </button>
          </SmartTooltip>
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
  sessionsPaneCollapsed = false,
  onExpandSessionsPane,
  sessionsPaneListCount = 0,
  sessionsPaneRunningCount = 0,
  sessionsListLoading = false,
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
    command?: string;
    args?: string[];
    tracked?: boolean;
  }) => Promise<unknown>;
  onShowDraftKind: (kind: WorkDraftKind) => void;
  onToggleTabGroupCollapsed?: (groupId: string) => void;
  closingPtyIds: Set<string>;
  onContextMenu?: (session: TerminalSessionSummary, e: React.MouseEvent) => void;
  onResumeSession?: (session: TerminalSessionSummary) => void;
  /** When the work sessions list pane is collapsed, show expand control in the work header. */
  sessionsPaneCollapsed?: boolean;
  onExpandSessionsPane?: () => void;
  sessionsPaneListCount?: number;
  sessionsPaneRunningCount?: number;
  sessionsListLoading?: boolean;
}) {
  const expandSessionsProps: SessionsPaneExpandAffordanceProps = {
    show: Boolean(sessionsPaneCollapsed && onExpandSessionsPane),
    onExpand: onExpandSessionsPane ?? (() => {}),
    listCount: sessionsPaneListCount,
    runningCount: sessionsPaneRunningCount,
    listLoading: sessionsListLoading,
  };
  const sessionsById = useMemo(() => {
    const map = new Map<string, TerminalSessionSummary>();
    for (const session of sessions) map.set(session.id, session);
    return map;
  }, [sessions]);

  const laneColorById = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const lane of lanes) map.set(lane.id, lane.color);
    return map;
  }, [lanes]);

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
  const handleContextMenu = useCallback((session: TerminalSessionSummary, e: React.MouseEvent): void => {
    if (onContextMenu) {
      e.preventDefault();
      onContextMenu(session, e);
    }
  }, [onContextMenu]);
  const [tilingPreset, setTilingPreset] = useState<TilingPreset>("auto");
  const gridSessionIdsKey = JSON.stringify(visibleSessions.map((session) => session.id));
  const gridTree = useMemo(
    () => buildWorkSessionTilingTree(JSON.parse(gridSessionIdsKey) as string[], tilingPreset),
    [gridSessionIdsKey, tilingPreset],
  );
  const applyTilingPreset = useCallback(async (preset: TilingPreset) => {
    const ids = JSON.parse(gridSessionIdsKey) as string[];
    const nextTree = buildWorkSessionTilingTree(ids, preset);
    try {
      await Promise.all([
        window.ade.tilingTree.set(gridLayoutId, nextTree),
        window.ade.layout.set(gridLayoutId, {}),
      ]);
    } catch {
      /* persistence is best-effort; UI state update below still applies */
    }
    setTilingPreset(preset);
  }, [gridLayoutId, gridSessionIdsKey]);
  const tilingPanes = useMemo<Record<string, PaneConfig>>(() => Object.fromEntries(
    visibleSessions.map((session) => {
      const dot = sessionStatusDot(session);
      const isBusy = session.ptyId ? closingPtyIds.has(session.ptyId) : false;
      const isActive = activeItemId === session.id;
      const rawLaneColor = laneColorById.get(session.laneId) ?? null;
      const laneAccentColor = rawLaneColor?.trim() ? rawLaneColor.trim() : null;
      return [session.id, {
        title: truncateSessionLabel(primarySessionLabel(session)),
        meta: session.laneName,
        minimizable: false,
        laneAccentColor,
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
  ), [activeItemId, closingPtyIds, handleContextMenu, laneColorById, onCloseItem, onOpenChatSession, onResumeSession, onSelectItem, visibleSessions]);
  const resolvedTabGroups = tabGroups ?? [];
  const hasGroupedTabs = resolvedTabGroups.length > 0;
  const toggleTabGroupCollapsed = onToggleTabGroupCollapsed ?? (() => {});

  if (viewMode === "grid") {
    return (
      <div className="flex h-full flex-col">
        <div className="ade-work-glass-header flex w-max max-w-full min-w-0 items-center gap-3 self-start px-3 py-1.5">
          <SessionsPaneExpandAffordance {...expandSessionsProps} />
          <ViewModeToggle viewMode={viewMode} setViewMode={setViewMode} />
          <span className="text-[11px] font-medium text-muted-fg">Grid</span>
          <span className="ade-liquid-glass-pill inline-flex items-center px-1.5 text-[10px] text-muted-fg/60 rounded">
            {visibleSessions.length}
          </span>
          {visibleSessions.length > 1 ? (
            <ArrangeMenu preset={tilingPreset} onSelect={applyTilingPreset} />
          ) : null}
        </div>

        {visibleSessions.length === 0 ? (
          <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center justify-center py-3">
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
            key={`${gridLayoutId}:${tilingPreset}`}
            layoutId={gridLayoutId}
            tree={gridTree}
            panes={tilingPanes}
            className="ade-work-grid-tiling flex-1 min-h-0 px-2 pb-2"
          />
        )}
      </div>
    );
  }

  /* ---- Tab view ---- */
  const tabBody = (
    <div className="relative min-h-0 flex-1" style={{ background: "var(--color-bg)" }}>
      {visibleSessions.map((session) => {
        const isActive = activeSession?.id === session.id;
        const runningTerminalSession = isRunningPtySession(session) ? session : null;

        return (
          <div
            key={session.id}
            className="absolute inset-0"
            hidden={!isActive}
          >
            {runningTerminalSession ? (
              <TerminalView
                key={runningTerminalSession.id}
                ptyId={runningTerminalSession.ptyId}
                sessionId={runningTerminalSession.id}
                isActive={isActive}
                isVisible={isActive}
                className="h-full w-full"
              />
            ) : (
              <SessionSurface
                session={session}
                isActive={isActive}
                terminalVisible={isActive}
                onOpenChatSession={onOpenChatSession}
                onResume={onResumeSession}
              />
            )}
          </div>
        );
      })}

      {!activeSession ? (
        <div className="absolute inset-0 flex flex-col">
          <div className="flex shrink-0 items-center justify-center py-3">
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
      ) : null}
    </div>
  );

  if (!hasGroupedTabs) {
    return (
      <div className="flex h-full flex-col">
        <div
          className="ade-work-glass-header flex min-h-10 w-max max-w-full min-w-0 items-center gap-0 self-start px-1.5 py-1.5"
          style={{
            minHeight: 40,
            maxHeight: 44,
          }}
        >
          <SessionsPaneExpandAffordance {...expandSessionsProps} />
          <ViewModeToggle viewMode={viewMode} setViewMode={setViewMode} />
          <div className="flex min-h-0 min-w-0 max-w-full items-center gap-0 overflow-y-hidden overflow-x-auto scrollbar-none">
            {visibleSessions.map((session) => {
              const isActive = activeSession?.id === session.id;
              const dot = sessionStatusDot(session);
              const isBusy = session.ptyId ? closingPtyIds.has(session.ptyId) : false;
              const primary = primarySessionLabel(session);
              return (
                <SmartTooltip
                  key={session.id}
                  content={{
                    label: truncateSessionLabel(primary, 28),
                    description: `Switch to this ${formatToolTypeLabel(session.toolType)} work tab.`,
                    effect: dot.label,
                  }}
                >
                  <button
                    type="button"
                    className="group/tab inline-flex shrink-0 items-center gap-1.5 transition-colors"
                    style={{
                      padding: "0 8px",
                      minHeight: 36,
                      height: 36,
                      fontSize: 11,
                      fontWeight: isActive ? 500 : 400,
                      background: "transparent",
                      color: isActive ? "var(--color-fg)" : "var(--color-muted-fg)",
                      cursor: "pointer",
                      border: "none",
                      borderBottom: isActive
                        ? "2px solid color-mix(in srgb, var(--color-fg) 42%, transparent)"
                        : "2px solid transparent",
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
                      title={isBusy ? "Closing..." : "Close tab"}
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
                </SmartTooltip>
              );
            })}
            <SmartTooltip content={{ label: "New Chat", description: "Start a new AI chat session in the current lane." }}>
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
                aria-label="Start a new chat"
              >
                <Plus size={11} weight="bold" />
              </button>
            </SmartTooltip>
          </div>
        </div>

        {tabBody}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div
        className="ade-work-glass-header flex min-h-10 w-max max-w-full min-w-0 items-center gap-1.5 self-start px-2 py-1.5"
        style={{ minHeight: 40, maxHeight: 44 }}
      >
        <SessionsPaneExpandAffordance {...expandSessionsProps} />
        <div className="shrink-0">
          <ViewModeToggle viewMode={viewMode} setViewMode={setViewMode} />
        </div>
        <div className="min-w-0 max-w-full self-stretch overflow-y-hidden overflow-x-auto scrollbar-none">
          <div className="flex h-full min-w-0 max-w-full items-center gap-1.5">
            {resolvedTabGroups.map((group) => {
              const hasActive = group.sessionIds.includes(activeSession?.id ?? "");
              const groupTint = group.kind === "lane" && group.laneColor
                ? laneSurfaceTint(group.laneColor, "default")
                : null;
              return (
                <div
                  key={group.id}
                  className={cn(
                    "ade-work-glass-group",
                    hasActive && "ade-work-glass-group-active",
                    "flex h-full min-h-8 max-w-full items-stretch overflow-hidden",
                    group.collapsed
                      ? "inline-flex w-auto shrink-0 grow-0 rounded-full"
                      : "inline-flex min-w-0 shrink-0 rounded-[13px]",
                  )}
                >
                  <div className="flex h-full min-w-0 max-w-full flex-row items-stretch">
                    <SmartTooltip
                      content={{
                        label: group.collapsed ? `Expand ${group.label}` : `Collapse ${group.label}`,
                        description: "Show or hide the work tabs in this group.",
                        effect: `${group.sessions.length} session${group.sessions.length === 1 ? "" : "s"} in this group.`,
                      }}
                    >
                      <button
                        type="button"
                        aria-expanded={!group.collapsed}
                        aria-controls={`tab-group-${group.id}`}
                        className="inline-flex shrink-0 items-center gap-1.5 px-2.5 text-left text-[11px] font-medium transition-colors"
                        style={{
                          minHeight: 32,
                          color: hasActive ? "var(--color-fg)" : "var(--color-muted-fg)",
                          cursor: "pointer",
                          border: "none",
                          ...(groupTint?.text
                            ? {
                              background: groupTint.background,
                              boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${groupTint.text} 16%, transparent)`,
                            }
                            : { background: "transparent" }),
                          borderRadius: group.collapsed ? 9999 : "12px 0 0 12px",
                        }}
                        onClick={() => toggleTabGroupCollapsed(group.id)}
                      >
                        {group.kind === "lane" ? (
                          <GitBranch
                            size={10}
                            className="shrink-0"
                            style={groupTint?.text ? { color: groupTint.text, opacity: 0.9 } : { color: "var(--color-muted-fg)", opacity: 0.6 }}
                            weight="regular"
                          />
                        ) : null}
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
                    </SmartTooltip>
                    {!group.collapsed ? (
                      <div
                        id={`tab-group-${group.id}`}
                        className="flex min-h-8 min-w-0 items-center gap-0.5 overflow-y-hidden overflow-x-auto py-0.5 pr-0.5 pl-0.5 scrollbar-none"
                        role="tablist"
                      >
                        {group.sessions.map((session) => {
                          const isActive = activeSession?.id === session.id;
                          const dot = sessionStatusDot(session);
                          const isBusy = session.ptyId ? closingPtyIds.has(session.ptyId) : false;
                          const primary = primarySessionLabel(session);
                          return (
                            <SmartTooltip
                              key={session.id}
                              content={{
                                label: truncateSessionLabel(primary, 28),
                                description: `Switch to this ${formatToolTypeLabel(session.toolType)} work tab.`,
                                effect: dot.label,
                              }}
                            >
                              <button
                                type="button"
                                className={cn(
                                  "group/tab inline-flex shrink-0 items-center gap-1.5 transition-all",
                                  isActive && "ade-work-tab-active",
                                )}
                                style={{
                                  padding: "0 8px",
                                  minHeight: 32,
                                  height: 32,
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
                                role="tab"
                                aria-selected={isActive}
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
                                  title={isBusy ? "Closing..." : "Close tab"}
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
                            </SmartTooltip>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
            <SmartTooltip content={{ label: "New Chat", description: "Start a new AI chat session in the current lane." }}>
              <button
                type="button"
                className="ade-work-new-chat-btn inline-flex shrink-0 items-center justify-center"
                style={{
                  width: 24,
                  height: 24,
                  cursor: "pointer",
                }}
                onClick={() => onShowDraftKind("chat")}
                aria-label="Start a new chat"
              >
                <Plus size={11} weight="bold" />
              </button>
            </SmartTooltip>
          </div>
        </div>
      </div>

      {tabBody}
    </div>
  );
}

const TILING_PRESET_OPTIONS: ReadonlyArray<{
  preset: TilingPreset;
  label: string;
  description: string;
  icon: React.ReactNode;
}> = [
  { preset: "auto", label: "Auto", description: "Balanced grid (default).", icon: <GridFour size={11} /> },
  { preset: "rows", label: "Rows", description: "Stack vertically, one full-width row per session.", icon: <Rows size={11} /> },
  { preset: "columns", label: "Columns", description: "Side by side, one full-height column per session.", icon: <Columns size={11} /> },
];

function ArrangeMenu({
  preset,
  onSelect,
}: {
  preset: TilingPreset;
  onSelect: (preset: TilingPreset) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const active = TILING_PRESET_OPTIONS.find((opt) => opt.preset === preset) ?? TILING_PRESET_OPTIONS[0]!;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div
      ref={containerRef}
      className="flex max-w-full min-w-0 shrink-0 items-center gap-1"
    >
      <SmartTooltip content={{ label: "Arrange grid layout", description: "Pick a preset shape for the grid: Auto, Rows, or Columns." }}>
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-haspopup="menu"
          aria-expanded={open}
          className="ade-liquid-glass-pill inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-[10px] font-medium transition-all"
          style={{
            color: "var(--color-muted-fg)",
            border: "none",
            cursor: "pointer",
          }}
          title="Arrange grid layout"
        >
          {active.icon}
          {active.label}
          <CaretDown size={9} />
        </button>
      </SmartTooltip>
      <AnimatePresence>
        {open ? (
          <motion.div
            key="arrange-menu"
            role="menu"
            initial={{ clipPath: "inset(0 100% 0 0)", opacity: 0.88 }}
            animate={{ clipPath: "inset(0 0% 0 0)", opacity: 1 }}
            exit={{ clipPath: "inset(0 100% 0 0)", opacity: 0.88 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className="ade-liquid-glass-pill z-50 flex min-w-0 max-w-[min(100vw-24px,32rem)] flex-none flex-row flex-nowrap items-stretch divide-x divide-white/10 overflow-hidden rounded-md py-0.5"
          >
            <div className="flex min-w-0 flex-row flex-nowrap items-stretch overflow-x-auto scrollbar-none">
              {TILING_PRESET_OPTIONS.map((opt) => {
                const isActive = opt.preset === preset;
                return (
                  <button
                    key={opt.preset}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    onClick={() => {
                      onSelect(opt.preset);
                      setOpen(false);
                    }}
                    className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap px-2.5 text-[11px] transition-colors"
                    style={{
                      background: "transparent",
                      color: isActive ? "var(--color-fg)" : "var(--color-muted-fg)",
                      border: "none",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                    title={opt.description}
                  >
                    <span className="inline-flex shrink-0 items-center justify-center">{opt.icon}</span>
                    <span className="shrink-0">{opt.label}</span>
                    <span className="inline-flex w-3 shrink-0 items-center justify-center">
                      {isActive ? <Check size={11} /> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
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
                color: active ? "var(--color-fg)" : "var(--color-muted-fg)",
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
