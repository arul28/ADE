import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
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

  return (
    <div className="flex h-full min-h-0 gap-3">
      <section className="flex min-h-0 w-[52%] flex-col rounded-2xl shadow-panel bg-[--color-surface-raised]">
        <div className="flex items-center justify-between border-b border-border/15 px-3 py-2">
          <div>
            <div className="text-sm font-semibold">History Timeline</div>
            <div className="text-xs text-muted-fg">{loading ? "Loading…" : `${filtered.length} events`}</div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => refresh().catch(() => {})}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-2 border-b border-border/15 p-3 md:grid-cols-3">
          <label className="space-y-1">
            <div className="text-[11px] text-muted-fg">Lane</div>
            <select
              className="h-8 w-full rounded-lg bg-muted/30 px-2 text-xs"
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
              className="h-8 w-full rounded-lg bg-muted/30 px-2 text-xs"
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
              className="h-8 w-full rounded-lg bg-muted/30 px-2 text-xs"
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
                  className={`w-full rounded-xl px-3 py-2 text-left transition-all ${
                    row.id === selected?.id
                      ? "shadow-card-hover bg-card/80"
                      : "shadow-card bg-card/50 hover:shadow-card-hover hover:bg-card/70"
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
                    <Chip className={`text-[10px] ${statusTone(row.status)}`}>{row.status}</Chip>
                  </div>
                  <div className="mt-1 truncate text-[11px] text-muted-fg">
                    {describeOperation(row, parseMetadata(row.metadataJson)).detail} · {toRelativeTime(row.startedAt)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="flex min-h-0 w-[48%] flex-col rounded-2xl shadow-panel bg-[--color-surface-raised]">
        <div className="border-b border-border/15 px-3 py-2">
          <div className="text-sm font-semibold">Event Detail</div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {!selected ? (
            <EmptyState title="No event selected" description="Select an operation from the timeline." />
          ) : (
            <div className="space-y-3 text-xs">
              <div className="rounded-xl bg-muted/20 p-2">
                <div className="text-[11px] text-muted-fg">Summary</div>
                <div className="mt-1 font-semibold">{described?.title ?? selected.kind}</div>
                <div className="mt-1 text-[11px] text-muted-fg">{described?.detail ?? (selected.laneName ?? "project")}</div>
              </div>

              {metaError ? (
                <div className="rounded-lg bg-red-500/10 p-2 text-[11px] text-red-200">
                  {metaError}
                </div>
              ) : null}

              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl bg-muted/20 p-2">
                  <div className="text-[11px] text-muted-fg">Kind</div>
                  <div className="mt-1 font-semibold">{selected.kind}</div>
                </div>
                <div className="rounded-xl bg-muted/20 p-2">
                  <div className="text-[11px] text-muted-fg">Status</div>
                  <div className="mt-1 font-semibold">{selected.status}</div>
                </div>
                <div className="rounded-xl bg-muted/20 p-2">
                  <div className="text-[11px] text-muted-fg">Started</div>
                  <div className="mt-1">{new Date(selected.startedAt).toLocaleString()}</div>
                </div>
                <div className="rounded-xl bg-muted/20 p-2">
                  <div className="text-[11px] text-muted-fg">Ended</div>
                  <div className="mt-1">{selected.endedAt ? new Date(selected.endedAt).toLocaleString() : "running"}</div>
                </div>
              </div>

              <div className="rounded-xl bg-muted/20 p-2">
                <div className="text-[11px] text-muted-fg">Lane</div>
                <div className="mt-1">{selected.laneName ?? "project"}</div>
                {selected.laneId ? (
                  <div className="mt-2 flex flex-wrap gap-2">
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
                      onClick={() => navigate(`/lanes?laneId=${encodeURIComponent(selected.laneId!)}&inspectorTab=packs`)}
                      title="Open lane packs"
                    >
                      Open packs
                    </Button>
                  </div>
                ) : null}
              </div>

              <div className="rounded-xl bg-muted/20 p-2">
                <div className="text-[11px] text-muted-fg">SHA Transition</div>
                <div className="mt-1 break-all">{selected.preHeadSha ?? "(none)"}</div>
                <div className="mt-1 text-muted-fg">to</div>
                <div className="mt-1 break-all">{selected.postHeadSha ?? "(none)"}</div>
              </div>

              <details className="rounded-xl bg-muted/20 p-2">
                <summary className="cursor-pointer text-[11px] text-muted-fg">Metadata (raw)</summary>
                <pre className="mt-2 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed">
                  {metadata ? JSON.stringify(metadata, null, 2) : "(none)"}
                </pre>
              </details>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
