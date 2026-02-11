import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import type { TerminalSessionSummary, TerminalSessionStatus } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";
import { PaneHeader } from "../ui/PaneHeader";

export function TerminalsPage() {
  const navigate = useNavigate();
  const lanes = useAppStore((s) => s.lanes);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const focusSession = useAppStore((s) => s.focusSession);
  const selectLane = useAppStore((s) => s.selectLane);

  const [sessions, setSessions] = useState<TerminalSessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterLaneId, setFilterLaneId] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<TerminalSessionStatus | "all">("all");
  const [q, setQ] = useState("");

  const refresh = async () => {
    setLoading(true);
    try {
      const rows = await window.ade.sessions.list({ limit: 500 });
      setSessions(rows);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh().catch(() => {});
  }, []);

  useEffect(() => {
    const unsubExit = window.ade.pty.onExit(() => {
      refresh().catch(() => {});
    });
    const t = setInterval(() => {
      if (sessions.some((s) => s.status === "running")) {
        refresh().catch(() => {});
      }
    }, 2000);
    return () => {
      try {
        unsubExit();
      } catch {
        // ignore
      }
      clearInterval(t);
    };
  }, [sessions]);

  useEffect(() => {
    // Default to selected lane filter (toggleable by user selecting "all").
    if (selectedLaneId && filterLaneId === "all") {
      // Leave as "all" until user opts in.
    }
  }, [selectedLaneId, filterLaneId]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sessions.filter((s) => {
      if (filterLaneId !== "all" && s.laneId !== filterLaneId) return false;
      if (filterStatus !== "all" && s.status !== filterStatus) return false;
      if (!needle) return true;
      return (
        s.title.toLowerCase().includes(needle) ||
        s.laneName.toLowerCase().includes(needle) ||
        (s.lastOutputPreview ?? "").toLowerCase().includes(needle)
      );
    });
  }, [sessions, filterLaneId, filterStatus, q]);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-border bg-card/60 backdrop-blur">
      <PaneHeader
        title="Terminals"
        meta={loading ? "Loading…" : `${filtered.length} sessions`}
        right={
          <Button variant="ghost" size="sm" title="Refresh sessions" onClick={() => refresh().catch(() => {})}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        }
      />

      <div className="border-b border-border p-3">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-[240px_180px_1fr]">
          <label className="space-y-1">
            <div className="text-[11px] font-semibold text-muted-fg">Lane</div>
            <select
              className="h-9 w-full rounded-lg border border-border bg-card/70 px-2 text-sm outline-none"
              value={filterLaneId}
              onChange={(e) => setFilterLaneId(e.target.value)}
            >
              <option value="all">All lanes</option>
              {lanes.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1">
            <div className="text-[11px] font-semibold text-muted-fg">Status</div>
            <select
              className="h-9 w-full rounded-lg border border-border bg-card/70 px-2 text-sm outline-none"
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as any)}
            >
              <option value="all">All</option>
              <option value="running">Running</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="disposed">Disposed</option>
            </select>
          </label>

          <label className="space-y-1">
            <div className="text-[11px] font-semibold text-muted-fg">Search</div>
            <input
              className="h-9 w-full rounded-lg border border-border bg-card/70 px-3 text-sm outline-none placeholder:text-muted-fg"
              placeholder="title, lane, output preview…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {filtered.length === 0 ? (
          <EmptyState title="No sessions" description="Start a terminal from a lane, then use this view to jump between sessions." />
        ) : (
          <div className="space-y-2">
            {filtered.map((s) => (
              <div key={s.id} className="rounded-lg border border-border bg-card/70 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{s.title}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-fg">
                      <span className="truncate">lane: {s.laneName}</span>
                      <Chip className="text-[11px]">{s.status}</Chip>
                      {s.exitCode != null ? <Chip className="text-[11px]">exit {s.exitCode}</Chip> : null}
                      <Chip className="text-[11px]">{new Date(s.startedAt).toLocaleString()}</Chip>
                    </div>
                    {s.lastOutputPreview ? (
                      <div className="mt-2 truncate rounded border border-border bg-card/60 px-2 py-1 text-xs text-muted-fg">
                        {s.lastOutputPreview}
                      </div>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        selectLane(s.laneId);
                        focusSession(s.id);
                        navigate(`/lanes?laneId=${encodeURIComponent(s.laneId)}&sessionId=${encodeURIComponent(s.id)}`);
                      }}
                      title="Jump to lane"
                    >
                      Jump
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
