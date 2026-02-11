import React, { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { OperationRecord } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function statusTone(status: OperationRecord["status"]): string {
  if (status === "succeeded") return "text-emerald-400 border-emerald-900";
  if (status === "failed") return "text-red-400 border-red-900";
  if (status === "running") return "text-amber-400 border-amber-900";
  return "text-muted-fg border-border";
}

export function HistoryPage() {
  const lanes = useAppStore((s) => s.lanes);
  const [rows, setRows] = useState<OperationRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [laneFilter, setLaneFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<OperationRecord["status"] | "all">("all");
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const next = await window.ade.history.listOperations({
        laneId: laneFilter === "all" ? undefined : laneFilter,
        kind: kindFilter === "all" ? undefined : kindFilter,
        limit: 500
      });
      setRows(next);
      if (next.length && !next.some((row) => row.id === selectedOperationId)) {
        setSelectedOperationId(next[0]!.id);
      }
      if (!next.length) {
        setSelectedOperationId(null);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh().catch(() => {});
  }, [laneFilter, kindFilter]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (rows.some((row) => row.status === "running")) {
        refresh().catch(() => {});
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [rows]);

  const filtered = useMemo(() => {
    return rows.filter((row) => {
      if (statusFilter !== "all" && row.status !== statusFilter) return false;
      return true;
    });
  }, [rows, statusFilter]);

  const kinds = useMemo(() => {
    const set = new Set<string>();
    for (const row of rows) set.add(row.kind);
    return [...set].sort();
  }, [rows]);

  const selected = filtered.find((row) => row.id === selectedOperationId) ?? filtered[0] ?? null;
  const metadata = selected ? parseMetadata(selected.metadataJson) : null;

  return (
    <div className="flex h-full min-h-0 gap-3">
      <section className="flex min-h-0 w-[52%] flex-col rounded-lg border border-border bg-card/60">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <div>
            <div className="text-sm font-semibold">History Timeline</div>
            <div className="text-xs text-muted-fg">{loading ? "Loading…" : `${filtered.length} events`}</div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => refresh().catch(() => {})}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-2 border-b border-border p-3 md:grid-cols-3">
          <label className="space-y-1">
            <div className="text-[11px] text-muted-fg">Lane</div>
            <select
              className="h-8 w-full rounded border border-border bg-card/70 px-2 text-xs"
              value={laneFilter}
              onChange={(event) => setLaneFilter(event.target.value)}
            >
              <option value="all">All lanes</option>
              {lanes.map((lane) => (
                <option key={lane.id} value={lane.id}>
                  {lane.name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <div className="text-[11px] text-muted-fg">Kind</div>
            <select
              className="h-8 w-full rounded border border-border bg-card/70 px-2 text-xs"
              value={kindFilter}
              onChange={(event) => setKindFilter(event.target.value)}
            >
              <option value="all">All kinds</option>
              {kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <div className="text-[11px] text-muted-fg">Status</div>
            <select
              className="h-8 w-full rounded border border-border bg-card/70 px-2 text-xs"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as OperationRecord["status"] | "all")}
            >
              <option value="all">All status</option>
              <option value="running">running</option>
              <option value="succeeded">succeeded</option>
              <option value="failed">failed</option>
              <option value="canceled">canceled</option>
            </select>
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-2">
          {filtered.length === 0 ? (
            <EmptyState title="No operations yet" description="Git and pack operations will appear here as they run." />
          ) : (
            <div className="space-y-2">
              {filtered.map((row) => (
                <button
                  key={row.id}
                  className={`w-full rounded border px-3 py-2 text-left transition-colors ${
                    row.id === selected?.id
                      ? "border-accent bg-accent/10"
                      : "border-border bg-card/70 hover:bg-muted/40"
                  }`}
                  onClick={() => setSelectedOperationId(row.id)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="truncate text-xs font-semibold">{row.kind}</div>
                    <Chip className={`text-[10px] ${statusTone(row.status)}`}>{row.status}</Chip>
                  </div>
                  <div className="mt-1 truncate text-[11px] text-muted-fg">
                    lane: {row.laneName ?? "project"} · {new Date(row.startedAt).toLocaleString()}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="flex min-h-0 w-[48%] flex-col rounded-lg border border-border bg-card/60">
        <div className="border-b border-border px-3 py-2">
          <div className="text-sm font-semibold">Event Detail</div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {!selected ? (
            <EmptyState title="No event selected" description="Select an operation from the timeline." />
          ) : (
            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded border border-border bg-card/70 p-2">
                  <div className="text-[11px] text-muted-fg">Kind</div>
                  <div className="mt-1 font-semibold">{selected.kind}</div>
                </div>
                <div className="rounded border border-border bg-card/70 p-2">
                  <div className="text-[11px] text-muted-fg">Status</div>
                  <div className="mt-1 font-semibold">{selected.status}</div>
                </div>
                <div className="rounded border border-border bg-card/70 p-2">
                  <div className="text-[11px] text-muted-fg">Started</div>
                  <div className="mt-1">{new Date(selected.startedAt).toLocaleString()}</div>
                </div>
                <div className="rounded border border-border bg-card/70 p-2">
                  <div className="text-[11px] text-muted-fg">Ended</div>
                  <div className="mt-1">{selected.endedAt ? new Date(selected.endedAt).toLocaleString() : "running"}</div>
                </div>
              </div>

              <div className="rounded border border-border bg-card/70 p-2">
                <div className="text-[11px] text-muted-fg">Lane</div>
                <div className="mt-1">{selected.laneName ?? "project"}</div>
              </div>

              <div className="rounded border border-border bg-card/70 p-2">
                <div className="text-[11px] text-muted-fg">SHA Transition</div>
                <div className="mt-1 break-all">{selected.preHeadSha ?? "(none)"}</div>
                <div className="mt-1 text-muted-fg">to</div>
                <div className="mt-1 break-all">{selected.postHeadSha ?? "(none)"}</div>
              </div>

              <div className="rounded border border-border bg-card/70 p-2">
                <div className="text-[11px] text-muted-fg">Metadata</div>
                <pre className="mt-1 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed">
                  {metadata ? JSON.stringify(metadata, null, 2) : "(none)"}
                </pre>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
