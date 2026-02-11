import React, { useEffect, useMemo, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { Plus, RefreshCw } from "lucide-react";
import { useAppStore } from "../../state/appStore";
import type { TerminalSessionSummary } from "../../../shared/types";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";
import { TerminalView } from "../terminals/TerminalView";

const tabTrigger =
  "flex items-center gap-2 rounded-md px-2.5 py-2 text-xs font-semibold text-muted-fg data-[state=active]:text-fg data-[state=active]:bg-muted/60";

function statusDot(status: string) {
  if (status === "running") return "bg-accent";
  if (status === "failed") return "bg-red-700";
  if (status === "disposed") return "bg-muted-fg";
  return "bg-border";
}

export function LaneTerminalsPanel() {
  const laneId = useAppStore((s) => s.selectedLaneId);
  const focusedSessionId = useAppStore((s) => s.focusedSessionId);
  const focusSession = useAppStore((s) => s.focusSession);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const lanes = useAppStore((s) => s.lanes);

  const laneName = useMemo(() => lanes.find((l) => l.id === laneId)?.name ?? null, [lanes, laneId]);

  const [sessions, setSessions] = useState<TerminalSessionSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    if (!laneId) return;
    setLoading(true);
    try {
      const rows = await window.ade.sessions.list({ laneId, limit: 100 });
      setSessions(rows);
      if (rows.length > 0) {
        const next = focusedSessionId && rows.some((s) => s.id === focusedSessionId) ? focusedSessionId : rows[0]!.id;
        focusSession(next);
      } else {
        focusSession(null);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setSessions([]);
    if (!laneId) return;
    refresh().catch(() => {});
  }, [laneId]);

  useEffect(() => {
    // Keep session status fresh when terminals exit.
    const unsub = window.ade.pty.onExit((ev) => {
      if (!sessions.some((s) => s.id === ev.sessionId)) return;
      refresh().catch(() => {});
      refreshLanes().catch(() => {});
    });
    return () => {
      try {
        unsub();
      } catch {
        // ignore
      }
    };
  }, [sessions, laneId]);

  if (!laneId) {
    return <EmptyState title="No lane selected" description="Select a lane to view its sessions." />;
  }

  const current = sessions.find((s) => s.id === focusedSessionId) ?? sessions[0] ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold">{laneName ?? laneId}</div>
          <div className="truncate text-[11px] text-muted-fg">{loading ? "Loading…" : `${sessions.length} sessions`}</div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" title="Refresh sessions" onClick={() => refresh().catch(() => {})}>
            <RefreshCw className="h-4 w-4" />
          </Button>
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
      ) : (
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

          <div className="mt-2 min-h-0 flex-1">
            {current ? (
              current.status === "running" && current.ptyId ? (
                <TerminalView ptyId={current.ptyId} sessionId={current.id} className="h-full" />
              ) : (
                <div className="h-full overflow-auto rounded-lg border border-border bg-card/60 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{current.title}</div>
                      <div className="truncate text-xs text-muted-fg">
                        {current.status}
                        {current.exitCode != null ? ` (exit ${current.exitCode})` : ""}
                      </div>
                    </div>
                    <Chip className="text-[11px]">{new Date(current.startedAt).toLocaleString()}</Chip>
                  </div>

                  <div className="mt-3 space-y-2">
                    <div className="text-[11px] text-muted-fg">Transcript</div>
                    <pre className="whitespace-pre-wrap rounded-lg border border-border bg-card/70 p-2 text-[11px] leading-relaxed">
                      {current.id ? (
                        <TranscriptTail sessionId={current.id} />
                      ) : (
                        <span className="text-muted-fg">No transcript.</span>
                      )}
                    </pre>
                    <div className="truncate text-[11px] text-muted-fg">{current.transcriptPath}</div>
                  </div>
                </div>
              )
            ) : null}
          </div>
        </Tabs.Root>
      )}
    </div>
  );
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
