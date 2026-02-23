import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { ArrowSquareOut, GridFour, List, GearSix, X } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import type {
  TerminalLaunchProfile,
  TerminalProfilesSnapshot,
  TerminalSessionSummary,
  TerminalToolType
} from "../../../shared/types";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";
import { TerminalView } from "../terminals/TerminalView";
import { TerminalSettingsDialog, readLaunchTracked, persistLaunchTracked } from "../terminals/TerminalSettingsDialog";
import { TilingLayout } from "./TilingLayout";
import { useNavigate } from "react-router-dom";
import { sessionIndicatorState } from "../../lib/terminalAttention";

const tabTrigger =
  "flex items-center gap-2 rounded-md px-2.5 py-2 text-xs font-semibold text-muted-fg data-[state=active]:text-fg data-[state=active]:bg-accent/10 data-[state=active]:ring-1 data-[state=active]:ring-accent/50";

const DEFAULT_PROFILE_IDS = ["claude", "codex", "shell"] as const;

function statusDot(status: string) {
  if (status === "running") return "border-2 border-emerald-500 border-t-transparent bg-transparent";
  if (status === "failed") return "bg-red-700";
  if (status === "disposed") return "bg-red-400/80";
  return "bg-border";
}

function sessionTabLabel(session: TerminalSessionSummary): string {
  const base = ((session.goal ?? "").trim() || session.title).trim() || "session";
  if (session.status === "running" && session.ptyId) return base;

  const tool = session.toolType ?? "shell";
  const outcome = session.exitCode != null ? `exit ${session.exitCode}` : session.status;
  const summary = (session.summary ?? "").trim();
  if (summary) return `${tool} · ${outcome} · ${summary}`.slice(0, 180);
  return `${tool} · ${outcome} · ${base}`.slice(0, 180);
}

function toolTypeFromProfileId(profileId: string): TerminalToolType | null {
  const id = profileId.trim().toLowerCase();
  if (id === "claude") return "claude";
  if (id === "codex") return "codex";
  if (id === "shell") return "shell";
  if (id === "aider") return "aider";
  if (id === "cursor") return "cursor";
  if (id === "continue") return "continue";
  return "other";
}

function isChatToolType(toolType: TerminalToolType | null | undefined): boolean {
  return toolType === "codex-chat" || toolType === "claude-chat";
}

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
  const [viewMode, setViewMode] = useState<"tabs" | "grid">("tabs");
  const [closingSessionIds, setClosingSessionIds] = useState<Set<string>>(new Set());
  const [localFocusedSessionId, setLocalFocusedSessionId] = useState<string | null>(null);
  const [terminalProfiles, setTerminalProfiles] = useState<TerminalProfilesSnapshot | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [launchTracked, setLaunchTracked] = useState(readLaunchTracked());
  const laneSessionIdsRef = useRef<Set<string>>(new Set());

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

  const refresh = useCallback(async () => {
    if (!laneId) return;
    const rows = await window.ade.sessions.list({ laneId, limit: 80 });
    const nonChatRows = rows.filter((row) => !isChatToolType(row.toolType));
    setSessions(nonChatRows);
    laneSessionIdsRef.current = new Set(nonChatRows.map((row) => row.id));
    if (rows.length > 0) {
      const runningOnly = rows.filter((s) => s.status === "running" && Boolean(s.ptyId));
      const visible = viewMode === "tabs" && runningOnly.length ? runningOnly : rows;
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
    setClosingSessionIds(new Set());
    laneSessionIdsRef.current = new Set();
    if (!laneId) return;
    refresh().catch(() => {});
  }, [laneId, overrideLaneId, refresh]);

  useEffect(() => {
    if (overrideLaneId == null) return;
    setLocalFocusedSessionId((current) => current ?? globalFocusedSessionId ?? null);
  }, [overrideLaneId, globalFocusedSessionId]);

  useEffect(() => {
    let cancelled = false;
    window.ade.terminalProfiles
      .get()
      .then((snapshot) => {
        if (cancelled) return;
        setTerminalProfiles(snapshot);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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
      refresh().catch(() => {});
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
        refresh().catch(() => {});
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
  }, [focusSession, focusedSessionId, refresh, refreshLanes]);

  if (!laneId) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-3">
        <EmptyState title="No lane selected" description="Select a lane to view its sessions." />
      </div>
    );
  }

  const runningSessions = useMemo(
    () => sessions.filter((s) => s.status === "running" && Boolean(s.ptyId)),
    [sessions]
  );
  const tabSessions = useMemo(() => {
    if (viewMode !== "tabs") return sessions;
    return runningSessions.length ? runningSessions : sessions;
  }, [sessions, viewMode, runningSessions]);

  const current = tabSessions.find((s) => s.id === focusedSessionId) ?? tabSessions[0] ?? null;

  const profileColorMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of terminalProfiles?.profiles ?? []) {
      if (p.color) m.set(p.id, p.color);
    }
    return m;
  }, [terminalProfiles]);

  const orderedProfiles = useMemo(() => {
    const profiles = terminalProfiles?.profiles ?? [];
    const byId = new Map(profiles.map((p) => [p.id, p] as const));
    const ordered: TerminalLaunchProfile[] = [];
    for (const id of DEFAULT_PROFILE_IDS) {
      const p = byId.get(id);
      if (p) ordered.push(p);
    }
    for (const p of profiles) {
      if ((DEFAULT_PROFILE_IDS as readonly string[]).includes(p.id)) continue;
      ordered.push(p);
    }
    return ordered.slice(0, 10);
  }, [terminalProfiles]);

  // Auto-refresh sessions every 5 seconds
  useEffect(() => {
    if (!laneId) return;
    const id = setInterval(() => {
      refresh().catch(() => {});
    }, 5_000);
    return () => clearInterval(id);
  }, [laneId, refresh]);

  const launchFromProfile = useCallback(
    (profile: TerminalLaunchProfile) => {
      if (!laneId) return;
      const title = profile.name || "Shell";
      const tracked = launchTracked;
      const initialCommand = (profile.command ?? "").trim();
      const toolType = toolTypeFromProfileId(profile.id);

      window.ade.pty
        .create({
          laneId,
          cols: 100,
          rows: 30,
          title,
          tracked,
          toolType,
          startupCommand: initialCommand || undefined
        })
        .then(async ({ sessionId }) => {
          focusSession(sessionId);
          refresh().catch(() => {});
        })
        .catch(() => {});
    },
    [laneId, launchTracked, focusSession, refresh]
  );

  const openSettings = useCallback(() => {
    setSettingsOpen(true);
  }, []);

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
          {!launchTracked ? <Chip className="text-[11px]">no context</Chip> : null}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex flex-wrap items-center gap-1">
            {orderedProfiles
              .filter((p) => (DEFAULT_PROFILE_IDS as readonly string[]).includes(p.id))
              .map((profile) => (
                <Button
                  key={profile.id}
                  variant={profile.id === "shell" ? "outline" : "primary"}
                  size="sm"
                  className="h-7 px-2 text-xs"
                  style={profile.color ? { backgroundColor: profile.color, borderColor: profile.color, color: "#fff" } : undefined}
                  onClick={() => launchFromProfile(profile)}
                  title={profile.command ? `${profile.name} (${profile.command})` : profile.name}
                >
                  {profile.color ? <span className="h-2 w-2 rounded-full bg-white/40" /> : null}
                  {profile.name}
                </Button>
              ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            title="Open in Terminals tab"
            onClick={() => {
              navigate(`/work?laneId=${encodeURIComponent(laneId)}&status=running`);
            }}
          >
            <ArrowSquareOut size={14} />
            Terminals
          </Button>
          <Button variant="outline" size="sm" className="h-7 w-7 p-0" title="Terminal settings" onClick={openSettings}>
            <GearSix size={16} />
          </Button>
        </div>
      </div>

      {sessions.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-3">
          <EmptyState title="No sessions yet" description="Start a terminal session for this lane." />
        </div>
      ) : viewMode === "tabs" ? (
        <Tabs.Root
          value={current?.id ?? ""}
          onValueChange={(v) => focusSession(v)}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <Tabs.List className="flex flex-wrap gap-1 rounded-lg border border-border bg-card/60 p-1">
            {tabSessions.map((s) => {
              const profileColor = s.toolType ? profileColorMap.get(s.toolType) : undefined;
              const indicator = sessionIndicatorState({
                status: s.status,
                lastOutputPreview: s.lastOutputPreview,
                runtimeState: s.runtimeState
              });
              const dotClass = indicator === "running-needs-attention"
                ? "border-2 border-amber-400 border-t-transparent bg-transparent"
                : statusDot(s.status);
              const dotSpin = !profileColor && (indicator === "running-active" || indicator === "running-needs-attention");
              return (
              <Tabs.Trigger key={s.id} className={cn(tabTrigger)} value={s.id}>
                <span
                  className={cn("h-2 w-2 rounded-full", !profileColor && dotClass, dotSpin && "animate-spin")}
                  style={profileColor ? { backgroundColor: profileColor } : undefined}
                />
                <span className="max-w-[260px] truncate">{sessionTabLabel(s)}</span>
                {!s.tracked ? <span className="rounded border border-border px-1 text-[11px] text-muted-fg">no ctx</span> : null}
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
                  <div className="truncate text-xs font-semibold text-fg">{current.title}</div>
                  {current.toolType ? <Chip className="text-[11px]">{current.toolType}</Chip> : null}
                  {!current.tracked ? <Chip className="text-[11px]">no context</Chip> : null}
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
                        className={`absolute inset-0 h-full w-full ${
                          current?.id === session.id ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
                        }`}
                      />
                    ) : null
                  )}
                  {current && current.status === "running" && current.ptyId ? null : (
                    <div className="absolute inset-0 flex items-center justify-center rounded border border-border bg-card/20 p-3">
                      <EmptyState title="Session not running" description="Pick a running session tab to view its terminal." />
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex h-full items-center justify-center rounded border border-border bg-card/20 p-3">
                  <EmptyState title="Session not running" description="Pick a running session tab to view its terminal." />
                </div>
              )}
            </div>

          </div>
        </Tabs.Root>
      ) : (
        /* TILE MODE */
        <div className="min-h-0 flex-1 border border-border bg-black/20 rounded-lg overflow-hidden">
          <TilingLayout
            sessions={sessions.filter((s) => s.status === "running" && Boolean(s.ptyId))}
            focusedSessionId={focusedSessionId}
            onFocus={focusSession}
            onClose={(id) => {
              const s = sessions.find((x) => x.id === id);
              if (s) closeSession(s);
            }}
            closingSessionIds={closingSessionIds}
          />
        </div>
      )}

      <TerminalSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        terminalProfiles={terminalProfiles}
        onProfilesSaved={(next) => {
          setTerminalProfiles(next);
        }}
        launchTracked={launchTracked}
        onLaunchTrackedChange={(v) => {
          setLaunchTracked(v);
          persistLaunchTracked(v);
        }}
      />
    </div>
  );
}
