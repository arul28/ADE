import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Pulse as Activity,
  ArrowRight,
  Calendar,
  Clock,
  DownloadSimple as Download,
  FileText,
  Hash,
  ArrowClockwise as RefreshCw,
  Tag,
} from "@phosphor-icons/react";
import type { OperationRecord } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";
import { PaneTilingLayout, type PaneConfig, type PaneSplit } from "../ui/PaneTilingLayout";
import { statusToneOperation } from "../../lib/format";

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

const statusTone = (status: OperationRecord["status"]) => statusToneOperation(status);

function statusBorderColor(status: OperationRecord["status"]): string {
  if (status === "succeeded") return "border-l-emerald-500/70";
  if (status === "failed") return "border-l-red-500/70";
  if (status === "running") return "border-l-amber-500/70";
  return "border-l-border";
}

function statusDotGlow(status: OperationRecord["status"]): string {
  if (status === "succeeded") return "shadow-[0_0_6px_rgba(16,185,129,0.3)]";
  if (status === "failed") return "shadow-[0_0_6px_rgba(239,68,68,0.3)]";
  if (status === "running") return "shadow-[0_0_6px_rgba(245,158,11,0.3)]";
  return "";
}

type GroupedEvent = {
  rows: OperationRecord[];
  kind: string;
  count: number;
  representative: OperationRecord;
};

function groupConsecutiveEvents(events: OperationRecord[]): GroupedEvent[] {
  const groups: GroupedEvent[] = [];
  let i = 0;
  while (i < events.length) {
    const current = events[i]!;
    const groupRows: OperationRecord[] = [current];
    let j = i + 1;
    while (j < events.length && events[j]!.kind === current.kind) {
      groupRows.push(events[j]!);
      j++;
    }
    groups.push({
      rows: groupRows,
      kind: current.kind,
      count: groupRows.length,
      representative: current,
    });
    i = j;
  }
  return groups;
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

/* ── Timeline List Component ── */

function TimelineList({
  filtered,
  selected,
  onSelect,
}: {
  filtered: OperationRecord[];
  selected: OperationRecord | null;
  onSelect: (row: OperationRecord) => void;
}) {
  const groups = useMemo(() => groupConsecutiveEvents(filtered), [filtered]);
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());

  const selectedIdx = selected
    ? filtered.findIndex((r) => r.id === selected.id)
    : -1;

  const toggleGroup = (groupIdx: number) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupIdx)) next.delete(groupIdx);
      else next.add(groupIdx);
      return next;
    });
  };

  /* Compute a flat index counter so we can do alternating left/right and opacity */
  let flatIdx = 0;

  return (
    <div className="relative">
      {/* Center timeline line — gradient from amber (top/newest) to emerald (bottom/oldest) */}
      <div className="absolute left-1/2 top-0 bottom-0 w-[2px] -translate-x-1/2 rounded-full ade-timeline-line" />

      <div className="flex flex-col gap-2.5 py-2">
        {groups.map((group, groupIdx) => {
          const isCollapsed = group.count > 1 && !expandedGroups.has(groupIdx);
          const itemsToRender = isCollapsed ? [group.representative] : group.rows;

          const elements = itemsToRender.map((row) => {
            const currentFlatIdx = flatIdx++;
            const isLeft = currentFlatIdx % 2 === 0;
            const isSelected = selected?.id === row.id;
            const meta = parseMetadata(row.metadataJson);
            const desc = describeOperation(row, meta);

            /* Opacity dimming: events >20 items from selected get dimmed */
            const distance = selectedIdx >= 0 ? Math.abs(currentFlatIdx - selectedIdx) : 0;
            const dimmed = selectedIdx >= 0 && distance > 20;

            const dotColor =
              row.status === "succeeded"
                ? "bg-emerald-400"
                : row.status === "failed"
                  ? "bg-red-400"
                  : row.status === "running"
                    ? "bg-amber-400"
                    : "bg-muted-fg/50";

            const statusDot = (
              <div
                className={`h-3 w-3 shrink-0 rounded-full ring-2 ring-bg ${dotColor} ${statusDotGlow(row.status)}`}
              />
            );

            const card = (
              <button
                key={row.id}
                onClick={() => onSelect(row)}
                className={`group/entry relative w-full rounded-lg border p-3 text-left text-xs backdrop-blur-sm transition-all duration-150 ${
                  isSelected
                    ? "border-accent/30 bg-card/80 shadow-[0_0_16px_-4px_rgba(6,214,160,0.15)]"
                    : "border-border/10 bg-card/60 hover:bg-card/75 hover:border-border/20 hover:shadow-card-hover hover:-translate-y-[0.5px]"
                } ${dimmed ? "opacity-40" : ""}`}
              >
                {/* Status accent bar */}
                <div className={`absolute top-0 left-3 right-3 h-[2px] rounded-b-full ${
                  row.status === "succeeded" ? "bg-emerald-500/40" :
                  row.status === "failed" ? "bg-red-500/40" :
                  row.status === "running" ? "bg-amber-500/40" : "bg-border/20"
                }`} />
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="font-semibold leading-snug text-fg">{desc.title}</span>
                  {group.count > 1 && isCollapsed && (
                    <span className="inline-flex h-4 min-w-[1.25rem] items-center justify-center rounded-full bg-accent/15 px-1.5 text-[10px] font-bold text-accent">
                      x{group.count}
                    </span>
                  )}
                </div>
                <div className="mt-1 truncate text-[11px] text-muted-fg">{desc.detail}</div>
                <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-fg/70">
                  <span>{toRelativeTime(row.startedAt)}</span>
                  <Chip className={`text-[10px] px-1.5 py-0.5 ${statusTone(row.status)}`}>{row.status}</Chip>
                </div>
              </button>
            );

            return (
              <div
                key={row.id}
                className={`relative flex items-start ${isLeft ? "justify-start" : "justify-end"}`}
              >
                {/* Dot on center line */}
                <div className="absolute left-1/2 top-3 -translate-x-1/2 z-10">
                  {statusDot}
                </div>

                {/* Connector line from dot to card */}
                <div className={`absolute top-[18px] h-[1px] ${
                  isLeft
                    ? "left-[calc(45%-8px)] right-1/2"
                    : "left-1/2 right-[calc(45%-8px)]"
                } ${
                  row.status === "succeeded" ? "bg-emerald-500/20" :
                  row.status === "failed" ? "bg-red-500/20" :
                  row.status === "running" ? "bg-amber-500/20" : "bg-border/15"
                }`} />

                {/* Card on left or right side */}
                {isLeft ? (
                  <>
                    <div className="w-[45%] pr-5">{card}</div>
                    <div className="w-[55%]" />
                  </>
                ) : (
                  <>
                    <div className="w-[55%]" />
                    <div className="w-[45%] pl-5">{card}</div>
                  </>
                )}
              </div>
            );
          });

          return (
            <React.Fragment key={groupIdx}>
              {elements}
              {group.count > 1 && (
                <div className="relative flex justify-center py-1">
                  <button
                    onClick={() => toggleGroup(groupIdx)}
                    className="z-10 rounded-full border border-border/15 bg-card/70 backdrop-blur-sm px-3 py-1 text-[10px] font-medium text-muted-fg transition-all hover:bg-card/90 hover:border-accent/20 hover:text-fg hover:shadow-card"
                  >
                    {isCollapsed
                      ? `Show ${group.count - 1} more ${humanKind(group.kind)} events`
                      : `Collapse ${group.count} ${humanKind(group.kind)} events`}
                  </button>
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
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
      <div className="grid grid-cols-1 gap-3 px-4 py-3 mb-3 md:grid-cols-3">
        <label className="space-y-1.5">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-fg/70">Lane</div>
          <select
            className="h-8 w-full rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg outline-none transition-colors focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
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
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-fg/70">Kind</div>
          <select
            className="h-8 w-full rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg outline-none transition-colors focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
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
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-fg/70">Status</div>
          <select
            className="h-8 w-full rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg outline-none transition-colors focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
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
        <div className="mb-2 px-4 py-2 text-xs text-red-300">{exportError}</div>
      ) : null}
      {exportNotice ? (
        <div className="mb-2 px-4 py-2 text-xs text-muted-fg">{exportNotice}</div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {filtered.length === 0 ? (
          <EmptyState title="No history yet" description="Operations will be recorded as you work." />
        ) : (
          <TimelineList
            filtered={filtered}
            selected={selected}
            onSelect={(row) => {
              setSelectedOperationId(row.id);
              const nextParams = new URLSearchParams(params);
              nextParams.set("operationId", row.id);
              if (laneFilter !== "all") nextParams.set("laneId", laneFilter);
              else nextParams.delete("laneId");
              setParams(nextParams, { replace: true });
            }}
          />
        )}
      </div>
    </>
  );

  const detailContent = (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      {!selected ? (
        <EmptyState title="No event selected" description="Select an operation from the timeline." />
      ) : (
        <div className="space-y-3 text-xs">
          {/* Summary card - prominent with accent border */}
          <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm shadow-card p-4">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-fg">Summary</div>
            <div className="mt-2 text-sm font-bold leading-snug text-fg">{described?.title ?? selected.kind}</div>
            <div className="mt-1.5 text-xs leading-relaxed text-muted-fg">{described?.detail ?? (selected.laneName ?? "project")}</div>
          </div>

          {/* Error message with red left border accent */}
          {metaError ? (
            <div className="rounded-lg border border-red-500/20 border-l-[3px] border-l-red-500/60 bg-red-500/10 p-3 text-xs leading-relaxed text-red-300">
              {metaError}
            </div>
          ) : null}

          {/* 2x2 info grid with icons */}
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm shadow-card p-3">
              <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-fg">
                <Tag size={12} weight="regular" />
                Kind
              </div>
              <div className="mt-1.5 font-semibold text-fg">{selected.kind}</div>
            </div>
            <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm shadow-card p-3">
              <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-fg">
                <Activity size={12} weight="regular" />
                Status
              </div>
              <div className={`mt-1.5 font-semibold ${statusTone(selected.status)}`}>{selected.status}</div>
            </div>
            <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm shadow-card p-3">
              <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-fg">
                <Clock size={12} weight="regular" />
                Started
              </div>
              <div className="mt-1.5 font-mono text-[11px] text-fg/80">{new Date(selected.startedAt).toLocaleString()}</div>
            </div>
            <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm shadow-card p-3">
              <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-fg">
                <Calendar size={12} weight="regular" />
                Ended
              </div>
              <div className="mt-1.5 font-mono text-[11px] text-fg/80">{selected.endedAt ? new Date(selected.endedAt).toLocaleString() : <span className="text-amber-400">running</span>}</div>
            </div>
          </div>

          {/* Lane section */}
          <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm shadow-card p-3">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-fg">Lane</div>
            <div className="mt-1.5 font-semibold text-fg">{selected.laneName ?? "project"}</div>
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
          <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm shadow-card p-3">
            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-fg">
              <Hash size={12} weight="regular" />
              SHA Transition
            </div>
            <div className="mt-3 flex items-center gap-2">
              <div className="min-w-0 flex-1 rounded-lg border border-border/10 bg-surface-recessed px-2.5 py-2">
                <div className="text-[10px] font-medium uppercase tracking-wider text-muted-fg">Before</div>
                <div className="mt-0.5 truncate font-mono text-xs text-fg/80">{selected.preHeadSha ?? "(none)"}</div>
              </div>
              <ArrowRight size={16} weight="regular" className="shrink-0 text-accent/50" />
              <div className="min-w-0 flex-1 rounded-lg border border-border/10 bg-surface-recessed px-2.5 py-2">
                <div className="text-[10px] font-medium uppercase tracking-wider text-muted-fg">After</div>
                <div className="mt-0.5 truncate font-mono text-xs text-fg/80">{selected.postHeadSha ?? "(none)"}</div>
              </div>
            </div>
          </div>

          {/* Metadata (raw) with better summary styling */}
          <details className="group rounded-lg border border-border/10 bg-card backdrop-blur-sm shadow-card">
            <summary className="cursor-pointer select-none px-3 py-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-fg transition-colors hover:text-fg">
              Metadata (raw)
            </summary>
            <div className="border-t border-border/10 px-3 pb-3 pt-2">
              <pre className="overflow-auto rounded-lg border border-border/10 bg-surface-recessed p-2.5 font-mono text-xs leading-relaxed text-fg/80">
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
            <RefreshCw size={16} weight="regular" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px]"
            title="Export filtered events as JSON"
            disabled={exportBusy !== null}
            onClick={() => void exportOperations("json")}
          >
            <Download size={12} weight="regular" className="mr-1" />
            {exportBusy === "json" ? "JSON..." : "JSON"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px]"
            title="Export filtered events as CSV"
            disabled={exportBusy !== null}
            onClick={() => void exportOperations("csv")}
          >
            <Download size={12} weight="regular" className="mr-1" />
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
