import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { Grid, LayoutList, Plus, RefreshCw, Square } from "lucide-react";
import { useAppStore } from "../../state/appStore";
import type { TerminalSessionSummary } from "../../../shared/types";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";
import { TerminalView } from "../terminals/TerminalView";
import { SessionDeltaCard } from "../terminals/SessionDeltaCard";
import { TilingLayout } from "./TilingLayout";

const tabTrigger =
  "flex items-center gap-2 rounded-md px-2.5 py-2 text-xs font-semibold text-muted-fg data-[state=active]:text-fg data-[state=active]:bg-muted/60";

function statusDot(status: string) {
  if (status === "running") return "bg-accent";
  if (status === "failed") return "bg-red-700";
  if (status === "disposed") return "bg-muted-fg";
  return "bg-border";
}

function TranscriptTail({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState<string>("Loading…");
  useEffect(() => {
    let cancelled = false;
    window.ade.sessions
      .readTranscriptTail({ sessionId, maxBytes: 220_000 })
      .then((t) => {
        if (cancelled) return;
        setText(t.trim().length ? t : "(empty)");
      })
      .catch(() => {
        if (cancelled) return;
        setText("(failed to read transcript)");
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);
  return <>{text}</>;
}

export function LaneTerminalsPanel({ overrideLaneId }: { overrideLaneId?: string | null } = {}) {
  const globalLaneId = useAppStore((s) => s.selectedLaneId);
  const laneId = overrideLaneId ?? globalLaneId;
  const globalFocusedSessionId = useAppStore((s) => s.focusedSessionId);
  const focusGlobalSession = useAppStore((s) => s.focusSession);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const lanes = useAppStore((s) => s.lanes);

  const laneName = useMemo(() => lanes.find((l) => l.id === laneId)?.name ?? null, [lanes, laneId]);

  const [sessions, setSessions] = useState<TerminalSessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<"tabs" | "grid">("tabs");
  const [closingSessionIds, setClosingSessionIds] = useState<Set<string>>(new Set());
  const [localFocusedSessionId, setLocalFocusedSessionId] = useState<string | null>(null);
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
    setLoading(true);
    try {
      const rows = await window.ade.sessions.list({ laneId, status: "running", limit: 100 });
      setSessions(rows);
      laneSessionIdsRef.current = new Set(rows.map((row) => row.id));
      if (rows.length > 0) {
        const currentExists = focusedSessionId && rows.some((s) => s.id === focusedSessionId);
        if (!currentExists && viewMode === "tabs") {
          focusSession(rows[0].id);
        }
      } else {
        focusSession(null);
      }
    } finally {
      setLoading(false);
    }
  }, [laneId, focusedSessionId, viewMode, focusSession]);

  useEffect(() => {
    setSessions([]);
    setClosingSessionIds(new Set());
    laneSessionIdsRef.current = new Set();
    if (overrideLaneId != null) {
      setLocalFocusedSessionId(globalFocusedSessionId);
    }
    if (!laneId) return;
    refresh().catch(() => {});
  }, [laneId, overrideLaneId, globalFocusedSessionId, refresh]);

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
    setSessions((prev) => {
      const idx = prev.findIndex((entry) => entry.id === session.id);
      if (idx === -1) return prev;
      const nextSessions = prev.filter((entry) => entry.id !== session.id);
      laneSessionIdsRef.current = new Set(nextSessions.map((entry) => entry.id));
      if (focusedSessionId === session.id) {
        const replacement = nextSessions[Math.min(idx, Math.max(0, nextSessions.length - 1))]?.id ?? null;
        focusSession(replacement);
      }
      return nextSessions;
    });
    window.ade.pty.dispose({ ptyId: session.ptyId })
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
    return <EmptyState title="No lane selected" description="Select a lane to view its sessions." />;
  }

  const current = sessions.find((s) => s.id === focusedSessionId) ?? sessions[0] ?? null;
  const canCloseCurrent = Boolean(current?.ptyId) && !closingSessionIds.has(current?.id ?? "");

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
              <LayoutList className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setViewMode("grid")}
              className={cn("p-1 rounded hover:bg-muted", viewMode === "grid" && "bg-muted text-fg shadow-sm")}
              title="Tiling Grid"
            >
              <Grid className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="h-4 w-px bg-border" />
          <div className="truncate text-xs font-semibold">{laneName ?? laneId}</div>
          <Chip className="text-[10px]">{sessions.length}</Chip>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" title="Refresh sessions" onClick={() => refresh().catch(() => {})}>
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
          {viewMode === "tabs" && (
            <Button
              variant="outline"
              size="sm"
              disabled={!canCloseCurrent}
              title={canCloseCurrent ? "Close current session" : "Cannot close (no PTY handle)"}
              onClick={() => current && closeSession(current)}
            >
              <Square className="h-4 w-4" />
              {current && closingSessionIds.has(current.id) ? "Closing…" : "Close"}
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            title="New session"
            onClick={() => {
              window.ade.pty
                .create({ laneId, cols: 100, rows: 30, title: "Shell" })
                .then(({ sessionId }) => {
                  focusSession(sessionId);
                  refresh().catch(() => {});
                })
                .catch(() => {});
            }}
          >
            <Plus className="h-4 w-4" />
            New
          </Button>
        </div>
      </div>

      {sessions.length === 0 ? (
        <EmptyState title="No sessions yet" description="Start a terminal session for this lane." />
      ) : viewMode === "tabs" ? (
        <Tabs.Root
          value={current?.id ?? ""}
          onValueChange={(v) => focusSession(v)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <Tabs.List className="flex flex-wrap gap-1 rounded-lg border border-border bg-card/60 p-1">
            {sessions.map((s) => (
              <Tabs.Trigger key={s.id} className={cn(tabTrigger)} value={s.id}>
                <span className={cn("h-2 w-2 rounded-full", statusDot(s.status))} />
                <span className="max-w-[180px] truncate">{s.title}</span>
              </Tabs.Trigger>
            ))}
          </Tabs.List>

          <div className="mt-2 min-h-0 flex-1 relative">
            {current ? (
              current.status === "running" && current.ptyId ? (
                <TerminalView ptyId={current.ptyId} sessionId={current.id} className="h-full" />
              ) : (
                <div className="h-full overflow-auto rounded-lg border border-border bg-card/60 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{current.title}</div>
                      <div className="truncate text-xs text-muted-fg">{current.status}</div>
                    </div>
                    <Chip className="text-[11px]">{new Date(current.startedAt).toLocaleString()}</Chip>
                  </div>
                  <div className="mt-3 space-y-2">
                    <SessionDeltaCard sessionId={current.id} />
                    <pre className="whitespace-pre-wrap rounded-lg border border-border bg-card/70 p-2 text-[11px] leading-relaxed">
                      {current.id ? <TranscriptTail sessionId={current.id} /> : <span className="text-muted-fg">No transcript.</span>}
                    </pre>
                  </div>
                </div>
              )
            ) : null}
          </div>
        </Tabs.Root>
      ) : (
        /* TILE MODE */
        <div className="min-h-0 flex-1 border border-border bg-black/20 rounded-lg overflow-hidden">
          <TilingLayout
            sessions={sessions}
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
    </div>
  );
}
