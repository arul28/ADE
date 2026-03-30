import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { ArrowSquareOut, GridFour, List, X } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import type { TerminalSessionSummary } from "../../../shared/types";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";
import { TerminalView } from "../terminals/TerminalView";
import { TilingLayout } from "./TilingLayout";
import { useNavigate } from "react-router-dom";
import { sessionIndicatorState } from "../../lib/terminalAttention";
import { isChatToolType, isRunOwnedSession, primarySessionLabel, secondarySessionLabel } from "../../lib/sessions";
import { listSessionsCached } from "../../lib/sessionListCache";
import { defaultTrackedCliStartupCommand } from "../terminals/cliLaunch";
import { ToolLogo } from "../terminals/ToolLogos";
import { persistLaunchTracked, readLaunchTracked } from "../../lib/terminalLaunchPreferences";

const tabTrigger =
  "flex items-center gap-2 rounded-md px-2.5 py-2 text-xs font-semibold text-muted-fg data-[state=active]:text-fg data-[state=active]:bg-accent/10 data-[state=active]:ring-1 data-[state=active]:ring-accent/50";

function statusDotCls(indicator: ReturnType<typeof sessionIndicatorState>): string {
  if (indicator === "running-active") return "border-2 border-emerald-500 border-t-transparent bg-transparent";
  if (indicator === "running-needs-attention") return "border-2 border-amber-400 border-t-transparent bg-transparent";
  return "bg-red-500";
}

function sessionTabLabel(session: TerminalSessionSummary): string {
  const base = primarySessionLabel(session);
  const secondary = secondarySessionLabel(session);
  if (!secondary) return base.slice(0, 180);
  return `${base} · ${secondary}`.slice(0, 180);
}

const TOOL_BUTTONS = [
  { id: "claude", label: "Launch Claude", variant: "primary" as const, style: { backgroundColor: "#f97316", borderColor: "#f97316", color: "#fff" } },
  { id: "codex", label: "Launch Codex", variant: "primary" as const, style: { backgroundColor: "#3b82f6", borderColor: "#3b82f6", color: "#fff" } },
  { id: "shell", label: "Launch shell", variant: "outline" as const, style: undefined },
] as const;

const SESSION_TOOL_COLORS: Record<string, string> = {
  claude: "#f97316",
  codex: "#3b82f6",
  shell: "#22c55e",
};

export function LaneTerminalsPanel({ overrideLaneId }: { overrideLaneId?: string | null } = {}) {
  const navigate = useNavigate();
  const globalLaneId = useAppStore((s) => s.selectedLaneId);
  const laneId = overrideLaneId ?? globalLaneId;
  const globalFocusedSessionId = useAppStore((s) => s.focusedSessionId);
  const focusGlobalSession = useAppStore((s) => s.focusSession);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const lanes = useAppStore((s) => s.lanes);

  const laneName = useMemo(() => lanes.find((l) => l.id === laneId)?.name ?? null, [lanes, laneId]);

  const [sessions, setSessions] = useState<TerminalSessionSummary[]>([]);
  const [chatSessions, setChatSessions] = useState<TerminalSessionSummary[]>([]);
  const [viewMode, setViewMode] = useState<"tabs" | "grid">("tabs");
  const [closingSessionIds, setClosingSessionIds] = useState<Set<string>>(new Set());
  const [localFocusedSessionId, setLocalFocusedSessionId] = useState<string | null>(null);
  const [launchTracked, setLaunchTracked] = useState(readLaunchTracked());
  const laneSessionIdsRef = useRef<Set<string>>(new Set());
  const hasPollableSessionsRef = useRef(false);

  const focusedSessionId = overrideLaneId != null ? localFocusedSessionId : globalFocusedSessionId;
  const focusSession = useCallback(
    (sessionId: string | null) => {
      if (overrideLaneId != null) {
        setLocalFocusedSessionId(sessionId);
      } else {
        focusGlobalSession(sessionId);
      }
    },
    [overrideLaneId, focusGlobalSession]
  );

  const refresh = useCallback(async (options?: { force?: boolean }) => {
    if (!laneId) return;
    const rows = await listSessionsCached(
      { laneId, limit: 80 },
      options?.force ? { force: true } : undefined,
    );
    const visibleRows = rows.filter((row) => !isRunOwnedSession(row));
    const nonChatRows = visibleRows.filter((row) => !isChatToolType(row.toolType));
    const chatRows = visibleRows.filter((row) => isChatToolType(row.toolType));
    setSessions(nonChatRows);
    setChatSessions(chatRows);
    laneSessionIdsRef.current = new Set(visibleRows.map((row) => row.id));
    hasPollableSessionsRef.current = visibleRows.some((row) => row.status === "running");
    if (nonChatRows.length > 0) {
      const runningOnly = nonChatRows.filter((s) => s.status === "running" && Boolean(s.ptyId));
      const visible = viewMode === "tabs" && runningOnly.length ? runningOnly : nonChatRows;
      const currentExists = focusedSessionId && visible.some((s) => s.id === focusedSessionId);
      if (!currentExists && viewMode === "tabs") {
        focusSession(visible[0]!.id);
      }
    } else {
      focusSession(null);
    }
  }, [laneId, focusedSessionId, viewMode, focusSession]);

  useEffect(() => {
    setSessions([]);
    setChatSessions([]);
    setClosingSessionIds(new Set());
    laneSessionIdsRef.current = new Set();
    hasPollableSessionsRef.current = false;
    if (!laneId) return;
    refresh({ force: true }).catch(() => {});
  }, [laneId, overrideLaneId, refresh]);

  useEffect(() => {
    if (overrideLaneId == null) return;
    setLocalFocusedSessionId((current) => current ?? globalFocusedSessionId ?? null);
  }, [overrideLaneId, globalFocusedSessionId]);

  useEffect(() => {
    if (!laneId) return;
    const unsub = window.ade.pty.onExit((ev) => {
      if (!laneSessionIdsRef.current.has(ev.sessionId)) return;
      setClosingSessionIds((prev) => {
        if (!prev.has(ev.sessionId)) return prev;
        const next = new Set(prev);
        next.delete(ev.sessionId);
        return next;
      });
      refresh({ force: true }).catch(() => {});
      refreshLanes().catch(() => {});
    });
    return () => {
      try {
        unsub();
      } catch {}
    };
  }, [laneId, refresh, refreshLanes]);

  const closeSession = useCallback((session: TerminalSessionSummary) => {
    if (!session.ptyId) return;
    setClosingSessionIds((prev) => {
      if (prev.has(session.id)) return prev;
      const next = new Set(prev);
      next.add(session.id);
      return next;
    });
    setSessions((prev) =>
      prev.map((entry) =>
        entry.id === session.id
          ? {
              ...entry,
              ptyId: null,
              status: "disposed" as const,
              runtimeState: "killed" as const,
              endedAt: new Date().toISOString(),
              exitCode: null
            }
          : entry
      )
    );
    window.ade.pty.dispose({ ptyId: session.ptyId, sessionId: session.id })
      .then(() => {
        refresh({ force: true }).catch(() => {});
        refreshLanes().catch(() => {});
      })
      .catch(console.error)
      .finally(() => {
        setClosingSessionIds((prev) => {
          if (!prev.has(session.id)) return prev;
          const next = new Set(prev);
          next.delete(session.id);
          return next;
        });
      });
  }, [refresh, refreshLanes]);

  const runningSessions = useMemo(
    () => sessions.filter((s) => s.status === "running" && Boolean(s.ptyId)),
    [sessions]
  );
  const tabSessions = useMemo(() => {
    if (viewMode !== "tabs") return sessions;
    return runningSessions.length ? runningSessions : sessions;
  }, [sessions, viewMode, runningSessions]);

  // Only keep polling while this lane still has live sessions to watch.
  useEffect(() => {
    if (!laneId) return;
    const id = setInterval(() => {
      if (!hasPollableSessionsRef.current) return;
      refresh().catch(() => {});
    }, 15_000);
    return () => clearInterval(id);
  }, [laneId, refresh]);

  const launchTool = useCallback(
    (toolType: "claude" | "codex" | "shell") => {
      if (!laneId) return;
      const tracked = launchTracked;
      const title = toolType === "shell"
        ? "Shell"
        : toolType === "claude"
          ? "Claude Code"
          : "Codex";
      const startupCommand = toolType === "shell" ? undefined : defaultTrackedCliStartupCommand(toolType);

      window.ade.pty
        .create({
          laneId,
          cols: 100,
          rows: 30,
          title,
          tracked,
          toolType,
          startupCommand
        })
        .then(async ({ sessionId }) => {
          focusSession(sessionId);
          refresh({ force: true }).catch(() => {});
        })
        .catch(() => {});
    },
    [laneId, launchTracked, focusSession, refresh]
  );

  if (!laneId) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-3">
        <EmptyState title="No lane selected" description="Select a lane to view its sessions." />
      </div>
    );
  }

  const current = tabSessions.find((s) => s.id === focusedSessionId) ?? tabSessions[0] ?? null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0 flex items-center gap-2">
          <div className="flex items-center rounded border border-border bg-card/50 p-0.5">
            <button
              onClick={() => setViewMode("tabs")}
              className={cn("p-1 rounded hover:bg-muted", viewMode === "tabs" && "bg-muted text-fg shadow-sm")}
              title="Tab View"
            >
              <List size={14} />
            </button>
            <button
              onClick={() => setViewMode("grid")}
              className={cn("p-1 rounded hover:bg-muted", viewMode === "grid" && "bg-muted text-fg shadow-sm")}
              title="Tiling Grid"
            >
              <GridFour size={14} />
            </button>
          </div>
          <div className="h-4 w-px bg-border" />
          <div className="truncate text-xs font-semibold">{laneName ?? laneId}</div>
          <Chip className="text-[11px]">{runningSessions.length} running</Chip>
          {!launchTracked ? <Chip className="text-[11px]">Standalone</Chip> : null}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex flex-wrap items-center gap-1">
            {TOOL_BUTTONS.map((tool) => (
                <Button
                  key={tool.id}
                  variant={tool.variant}
                  size="sm"
                  className="h-7 w-7 p-0"
                  style={tool.style}
                  onClick={() => launchTool(tool.id)}
                  title={tool.label}
                  aria-label={tool.label}
                >
                  <ToolLogo toolType={tool.id} size={14} className={tool.style ? "text-white" : undefined} />
                </Button>
              ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-7 p-0"
            title="Open workspace view"
            onClick={() => {
              navigate(`/work?laneId=${encodeURIComponent(laneId)}&status=running`);
            }}
          >
            <ArrowSquareOut size={14} />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            title={launchTracked ? "Tracked launch mode" : "Untracked launch mode"}
            onClick={() => {
              const next = !launchTracked;
              setLaunchTracked(next);
              persistLaunchTracked(next);
            }}
          >
            {launchTracked ? "With context" : "Standalone"}
          </Button>
        </div>
      </div>

      {sessions.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-3">
          <EmptyState title="No sessions yet" description="No terminal sessions for this lane. Launch one above to get started." />
        </div>
      ) : viewMode === "tabs" ? (
        <Tabs.Root
          value={current?.id ?? ""}
          onValueChange={(v) => focusSession(v)}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <Tabs.List className="flex flex-wrap gap-1 rounded-lg border border-border bg-card/60 p-1">
            {tabSessions.map((s) => {
              const profileColor = s.toolType ? SESSION_TOOL_COLORS[s.toolType] : undefined;
              const indicator = sessionIndicatorState({
                status: s.status,
                lastOutputPreview: s.lastOutputPreview,
                runtimeState: s.runtimeState
              });
              const dotClass = statusDotCls(indicator);
              const dotSpin = !profileColor && indicator !== "ended";
              return (
              <Tabs.Trigger key={s.id} className={cn(tabTrigger)} value={s.id}>
                <span
                  className={cn("h-2 w-2 rounded-full", !profileColor && dotClass, dotSpin && "animate-spin")}
                  style={profileColor ? { backgroundColor: profileColor } : undefined}
                />
                <ToolLogo toolType={s.toolType} size={12} />
                <span className="max-w-[260px] truncate">{sessionTabLabel(s)}</span>
                {!s.tracked ? <span className="rounded border border-border px-1 text-[11px] text-muted-fg">Standalone</span> : null}
                {s.status === "running" && s.ptyId ? (
                  <span
                    role="button"
                    tabIndex={0}
                    className={cn(
                      "ml-1 inline-flex h-4 w-4 items-center justify-center rounded hover:bg-muted/60",
                      closingSessionIds.has(s.id) && "opacity-50 pointer-events-none"
                    )}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      closeSession(s);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        closeSession(s);
                      }
                    }}
                    title={closingSessionIds.has(s.id) ? "Closing…" : "Close / kill session"}
                  >
                    <X size={12} />
                  </span>
                ) : null}
              </Tabs.Trigger>
              );
            })}
          </Tabs.List>

          <div className="mt-2 flex min-h-0 min-w-0 flex-1 flex-col">
            {/* Render a header for the current running session */}
            {current && current.status === "running" && current.ptyId ? (
              <div className="flex items-center justify-between gap-2 rounded border border-border bg-card/50 px-2 py-1 mb-2 shrink-0">
                <div className="min-w-0 flex items-center gap-2">
                  <ToolLogo toolType={current.toolType} size={13} />
                  <div className="truncate text-xs font-semibold text-fg">{primarySessionLabel(current)}</div>
                  {!current.tracked ? <Chip className="text-[11px]">Standalone</Chip> : null}
                </div>
                <div className="shrink-0 text-xs text-muted-fg">{new Date(current.startedAt).toLocaleString()}</div>
              </div>
            ) : null}

            <div className="min-h-0 min-w-0 flex-1">
              {runningSessions.length > 0 ? (
                <div className="relative h-full w-full">
                  {runningSessions.map((session) =>
                    session.ptyId ? (
                      <TerminalView
                        key={session.id}
                        ptyId={session.ptyId}
                        sessionId={session.id}
                        isActive={current?.id === session.id}
                        className={`absolute inset-0 h-full w-full ${
                          current?.id === session.id ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
                        }`}
                      />
                    ) : null
                  )}
                  {current && current.status === "running" && current.ptyId ? null : (
                    <div className="absolute inset-0 flex items-center justify-center rounded border border-border bg-card/20 p-3">
                      <EmptyState title="Session not running" description="Pick a running session tab to view its output." />
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex h-full items-center justify-center rounded border border-border bg-card/20 p-3">
                  <EmptyState title="Session not running" description="Pick a running session tab to view its output." />
                </div>
              )}
            </div>

          </div>
        </Tabs.Root>
      ) : (
        /* TILE MODE */
        <div className="min-h-0 flex-1 border border-border bg-black/20 rounded-lg overflow-hidden">
          <TilingLayout
            sessions={[
              ...sessions.filter((s) => s.status === "running" && Boolean(s.ptyId)),
              ...chatSessions.filter((s) => s.status === "running"),
            ]}
            focusedSessionId={focusedSessionId}
            laneId={laneId}
            onFocus={focusSession}
            onClose={(id) => {
              const s = sessions.find((x) => x.id === id);
              if (s) closeSession(s);
            }}
            closingSessionIds={closingSessionIds}
          />
        </div>
      )}
    </div>
  );
}
