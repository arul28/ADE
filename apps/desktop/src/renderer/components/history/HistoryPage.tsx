import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Activity, ArrowRight, Calendar, Clock, Download, FileText, Hash, RefreshCw, Tag } from "lucide-react";
import type { OperationRecord } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";
import { PaneTilingLayout, type PaneConfig, type PaneSplit } from "../ui/PaneTilingLayout";
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

function statusBorderColor(status: OperationRecord["status"]): string {
  if (status === "succeeded") return "border-l-emerald-500/70";
  if (status === "failed") return "border-l-red-500/70";
  if (status === "running") return "border-l-amber-500/70";
  return "border-l-border";
}

function toRelativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const deltaMs = Math.max(0, Date.now() - ts);
  const mins = Math.floor(deltaMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function humanKind(kind: string): string {
  const raw = kind.replace(/[._]/g, " ").replace(/\s+/g, " ").trim();
  if (!raw) return kind;
  return raw.slice(0, 1).toUpperCase() + raw.slice(1);
}

const HISTORY_TILING_TREE: PaneSplit = {
  type: "split",
  direction: "horizontal",
  children: [
    { node: { type: "pane", id: "timeline" }, defaultSize: 45, minSize: 25 },
    { node: { type: "pane", id: "detail" }, defaultSize: 55, minSize: 25 }
  ]
};

function describeOperation(row: OperationRecord, meta: Record<string, unknown> | null): { title: string; detail: string } {
  const lane = row.laneName ?? "project";
  const reason = typeof meta?.reason === "string" ? (meta.reason as string) : typeof meta?.trigger === "string" ? (meta.trigger as string) : null;
  const msg = typeof meta?.message === "string" ? (meta.message as string) : null;

  if (row.kind === "pack_update_lane") {
    return { title: "Lane pack refreshed", detail: `${lane}${reason ? ` · trigger: ${reason}` : ""}` };
  }
  if (row.kind === "pack_update_project") {
    return { title: "Project pack refreshed", detail: `${reason ? `trigger: ${reason}` : lane}` };
  }

  if (row.kind === "git.commit" || row.kind === "git_commit") {
    const commitMsg = typeof meta?.message === "string" ? (meta.message as string) : null;
    return { title: "Git commit", detail: `${lane}${commitMsg ? ` · ${commitMsg}` : ""}` };
  }

  if (row.kind.startsWith("git.") || row.kind.startsWith("git_")) {
    return { title: `Git: ${humanKind(row.kind.replace(/^git[._]/, ""))}`, detail: `${lane}${msg ? ` · ${msg}` : ""}` };
  }

  return { title: humanKind(row.kind), detail: lane };
}

export function HistoryPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const lanes = useAppStore((s) => s.lanes);
  const [rows, setRows] = useState<OperationRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [laneFilter, setLaneFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<OperationRecord["status"] | "all">("all");
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState<"csv" | "json" | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const operationIdParam = params.get("operationId");
  const laneIdParam = params.get("laneId");

  useEffect(() => {
    if (laneIdParam && laneIdParam !== laneFilter) {
      setLaneFilter(laneIdParam);
    }
    if (operationIdParam && operationIdParam !== selectedOperationId) {
      setSelectedOperationId(operationIdParam);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = async () => {
    setLoading(true);
    try {
      const next = await window.ade.history.listOperations({
        laneId: laneFilter === "all" ? undefined : laneFilter,
        kind: kindFilter === "all" ? undefined : kindFilter,
        limit: 500
      });
      setRows(next);
      if (operationIdParam && next.some((row) => row.id === operationIdParam)) {
        setSelectedOperationId(operationIdParam);
      } else if (next.length && !next.some((row) => row.id === selectedOperationId)) {
        setSelectedOperationId(next[0]!.id);
      }
      if (!next.length) {
        setSelectedOperationId(null);
      }
    } finally {
      setLoading(false);
    }
  };

  const exportOperations = async (format: "csv" | "json") => {
    setExportBusy(format);
    setExportError(null);
    setExportNotice(null);
    try {
      const result = await window.ade.history.exportOperations({
        laneId: laneFilter === "all" ? undefined : laneFilter,
        kind: kindFilter === "all" ? undefined : kindFilter,
        status: statusFilter,
        format,
        limit: 1000
      });
      if (result.cancelled) {
        setExportNotice("Export canceled.");
        return;
      }
      setExportNotice(`Exported ${result.rowCount} event(s) to ${result.savedPath}`);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExportBusy(null);
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
  const described = selected ? describeOperation(selected, metadata) : null;
  const metaError =
    metadata && typeof (metadata as any).error === "string"
      ? String((metadata as any).error)
      : metadata && typeof (metadata as any).errorMessage === "string"
        ? String((metadata as any).errorMessage)
        : null;

  const timelineContent = (
    <>
      <div className="grid grid-cols-1 gap-3 border-b border-border/15 px-4 py-3 md:grid-cols-3">
        <label className="space-y-1.5">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-fg/70">Lane</div>
          <select
            className="h-8 w-full rounded-lg border border-border/30 bg-muted/20 px-2 text-xs text-fg outline-none transition-colors focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
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
        <label className="space-y-1.5">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-fg/70">Kind</div>
          <select
            className="h-8 w-full rounded-lg border border-border/30 bg-muted/20 px-2 text-xs text-fg outline-none transition-colors focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
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
        <label className="space-y-1.5">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-fg/70">Status</div>
          <select
            className="h-8 w-full rounded-lg border border-border/30 bg-muted/20 px-2 text-xs text-fg outline-none transition-colors focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
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
      {exportError ? (
        <div className="border-b border-border/15 px-4 py-2 text-[11px] text-red-300">{exportError}</div>
      ) : null}
      {exportNotice ? (
        <div className="border-b border-border/15 px-4 py-2 text-[11px] text-muted-fg">{exportNotice}</div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {filtered.length === 0 ? (
          <EmptyState title="No operations yet" description="Git and pack operations will appear here as they run." />
        ) : (
          <div className="relative ml-2.5">
            {/* Vertical timeline connector line */}
            <div className="absolute left-0 top-2 bottom-2 w-px bg-border/30" />
            <div className="space-y-1">
              {filtered.map((row) => (
                <div key={row.id} className="relative pl-5">
                  {/* Timeline dot */}
                  <div className={`absolute left-[-3px] top-3.5 h-[7px] w-[7px] rounded-full border-2 border-card ${
                    row.status === "succeeded" ? "bg-emerald-500" :
                    row.status === "failed" ? "bg-red-500" :
                    row.status === "running" ? "bg-amber-500" :
                    "bg-muted-fg/50"
                  }`} />
                  <button
                    className={`w-full rounded border-l-[3px] px-3 py-2.5 text-left transition-all duration-150 ${statusBorderColor(row.status)} ${
                      row.id === selected?.id
                        ? "shadow-card-hover bg-card/90 scale-[1.01] ring-1 ring-accent/15"
                        : "shadow-card bg-card/50 hover:shadow-card-hover hover:bg-card/70 hover:scale-[1.005]"
                    }`}
                    onClick={() => {
                      setSelectedOperationId(row.id);
                      const nextParams = new URLSearchParams(params);
                      nextParams.set("operationId", row.id);
                      if (laneFilter !== "all") nextParams.set("laneId", laneFilter);
                      else nextParams.delete("laneId");
                      setParams(nextParams, { replace: true });
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="truncate text-xs font-semibold">{describeOperation(row, parseMetadata(row.metadataJson)).title}</div>
                      <Chip className={`shrink-0 text-[10px] ${statusTone(row.status)}`}>{row.status}</Chip>
                    </div>
                    <div className="mt-1 truncate text-[11px] text-muted-fg">
                      {describeOperation(row, parseMetadata(row.metadataJson)).detail} · {toRelativeTime(row.startedAt)}
                    </div>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );

  const detailContent = (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      {!selected ? (
        <EmptyState title="No event selected" description="Select an operation from the timeline." />
      ) : (
        <div className="space-y-4 text-xs">
          {/* Summary card - prominent */}
          <div className="rounded bg-card/80 shadow-card p-4">
            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-fg/60">Summary</div>
            <div className="mt-2 text-sm font-bold leading-snug">{described?.title ?? selected.kind}</div>
            <div className="mt-1.5 text-[11px] leading-relaxed text-muted-fg">{described?.detail ?? (selected.laneName ?? "project")}</div>
          </div>

          {/* Error message with red left border accent */}
          {metaError ? (
            <div className="rounded border-l-[3px] border-l-red-500/70 bg-red-500/8 p-3 text-[11px] leading-relaxed text-red-300">
              {metaError}
            </div>
          ) : null}

          {/* 2x2 info grid with icons */}
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded bg-card/60 shadow-card p-3">
              <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-fg/60">
                <Tag className="h-3 w-3" />
                Kind
              </div>
              <div className="mt-1.5 font-semibold">{selected.kind}</div>
            </div>
            <div className="rounded bg-card/60 shadow-card p-3">
              <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-fg/60">
                <Activity className="h-3 w-3" />
                Status
              </div>
              <div className={`mt-1.5 font-semibold ${statusTone(selected.status)}`}>{selected.status}</div>
            </div>
            <div className="rounded bg-card/60 shadow-card p-3">
              <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-fg/60">
                <Clock className="h-3 w-3" />
                Started
              </div>
              <div className="mt-1.5">{new Date(selected.startedAt).toLocaleString()}</div>
            </div>
            <div className="rounded bg-card/60 shadow-card p-3">
              <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-fg/60">
                <Calendar className="h-3 w-3" />
                Ended
              </div>
              <div className="mt-1.5">{selected.endedAt ? new Date(selected.endedAt).toLocaleString() : <span className="text-amber-400">running</span>}</div>
            </div>
          </div>

          {/* Lane section */}
          <div className="rounded bg-card/60 shadow-card p-3">
            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-fg/60">Lane</div>
            <div className="mt-1.5 font-semibold">{selected.laneName ?? "project"}</div>
            {selected.laneId ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate(`/lanes?laneId=${encodeURIComponent(selected.laneId!)}`)}
                  title="Open lane"
                >
                  Open lane
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate(`/lanes?laneId=${encodeURIComponent(selected.laneId!)}&inspectorTab=context`)}
                  title="Open lane context"
                >
                  Open context
                </Button>
              </div>
            ) : null}
          </div>

          {/* SHA Transition with code block before -> after visual */}
          <div className="rounded bg-card/60 shadow-card p-3">
            <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-fg/60">
              <Hash className="h-3 w-3" />
              SHA Transition
            </div>
            <div className="mt-3 flex items-center gap-2">
              <div className="min-w-0 flex-1 rounded-lg bg-muted/30 px-2.5 py-1.5">
                <div className="text-[10px] font-medium uppercase tracking-wider text-muted-fg/50">Before</div>
                <div className="mt-0.5 truncate font-mono text-[11px]">{selected.preHeadSha ?? "(none)"}</div>
              </div>
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-fg/40" />
              <div className="min-w-0 flex-1 rounded-lg bg-muted/30 px-2.5 py-1.5">
                <div className="text-[10px] font-medium uppercase tracking-wider text-muted-fg/50">After</div>
                <div className="mt-0.5 truncate font-mono text-[11px]">{selected.postHeadSha ?? "(none)"}</div>
              </div>
            </div>
          </div>

          {/* Metadata (raw) with better summary styling */}
          <details className="group rounded bg-card/60 shadow-card">
            <summary className="cursor-pointer select-none px-3 py-2.5 text-[10px] font-medium uppercase tracking-wider text-muted-fg/60 transition-colors hover:text-muted-fg">
              Metadata (raw)
            </summary>
            <div className="border-t border-border/20 px-3 pb-3 pt-2">
              <pre className="overflow-auto rounded-lg bg-muted/20 p-2.5 font-mono text-[11px] leading-relaxed">
                {metadata ? JSON.stringify(metadata, null, 2) : "(none)"}
              </pre>
            </div>
          </details>
        </div>
      )}
    </div>
  );

  const paneConfigs: Record<string, PaneConfig> = {
    timeline: {
      title: "Timeline",
      icon: Clock,
      meta: <span className="text-xs text-muted-fg">{loading ? "Loading\u2026" : `${filtered.length} events`}</span>,
      headerActions: (
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" title="Refresh" onClick={() => refresh().catch(() => {})}>
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[10px]"
            title="Export filtered events as JSON"
            disabled={exportBusy !== null}
            onClick={() => void exportOperations("json")}
          >
            <Download className="mr-1 h-3 w-3" />
            {exportBusy === "json" ? "JSON..." : "JSON"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[10px]"
            title="Export filtered events as CSV"
            disabled={exportBusy !== null}
            onClick={() => void exportOperations("csv")}
          >
            <Download className="mr-1 h-3 w-3" />
            {exportBusy === "csv" ? "CSV..." : "CSV"}
          </Button>
        </div>
      ),
      bodyClassName: "flex flex-col",
      children: timelineContent
    },
    detail: {
      title: "Event Detail",
      icon: FileText,
      bodyClassName: "flex flex-col",
      children: detailContent
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      <PaneTilingLayout
        layoutId="history:tiling:v1"
        tree={HISTORY_TILING_TREE}
        panes={paneConfigs}
        className="flex-1 min-h-0"
      />
    </div>
  );
}
