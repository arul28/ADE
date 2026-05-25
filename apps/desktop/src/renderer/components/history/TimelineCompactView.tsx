import React, { useState, useMemo, useCallback } from "react";
import { CaretUp, CaretDown } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import type { ColumnConfig, TimelineColumn, TimelineEvent } from "./timelineTypes";
import { CATEGORY_META } from "./eventTaxonomy";
import { relativeWhen, formatDate, formatDurationMs } from "../../lib/format";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type SortField = "startedAt" | "label" | "kind" | "status" | "laneName" | "durationMs" | "author" | "sha";
type SortDir = "asc" | "desc";

type TimelineCompactViewProps = {
  events: TimelineEvent[];
  columns: ColumnConfig[];
  selectedEventId: string | null;
  onSelectEvent: (id: string) => void;
};

/* ------------------------------------------------------------------ */
/*  Column definitions                                                 */
/* ------------------------------------------------------------------ */

type Column = {
  id: TimelineColumn;
  field: SortField;
  label: string;
  width: string; // Tailwind width class
  align?: "right";
};

const COLUMNS: Column[] = [
  { id: "timestamp", field: "startedAt", label: "Time", width: "w-[72px]" },
  { id: "graph", field: "kind", label: "Graph", width: "w-[34px]" },
  { id: "event", field: "label", label: "Event", width: "flex-1 min-w-[100px]" },
  { id: "lane", field: "laneName", label: "Lane", width: "w-[90px]" },
  { id: "author", field: "author", label: "Author", width: "w-[90px]" },
  { id: "status", field: "status", label: "Status", width: "w-[72px]" },
  { id: "duration", field: "durationMs", label: "Duration", width: "w-[56px]", align: "right" },
  { id: "sha", field: "sha", label: "Sha", width: "w-[64px]", align: "right" },
];

/* ------------------------------------------------------------------ */
/*  Status dot color mapping                                           */
/* ------------------------------------------------------------------ */

const STATUS_DOT: Record<string, string> = {
  running: "bg-amber-400",
  succeeded: "bg-emerald-400",
  failed: "bg-red-400",
  canceled: "bg-muted-fg",
};

function visibleColumnIds(columns: ColumnConfig[]): Set<TimelineColumn> {
  return new Set(columns.filter((column) => column.visible).map((column) => column.id));
}

function metadataText(event: TimelineEvent, keys: string[]): string {
  if (!event.metadata) return "";
  for (const key of keys) {
    const value = event.metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function eventActor(event: TimelineEvent): string {
  return metadataText(event, ["author", "actor", "user", "agent", "runtime", "model"]) || "—";
}

function eventSha(event: TimelineEvent): string {
  return (event.postHeadSha ?? event.preHeadSha ?? "").slice(0, 7) || "—";
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function TimelineCompactView({
  events,
  columns,
  selectedEventId,
  onSelectEvent,
}: TimelineCompactViewProps) {
  const [sortField, setSortField] = useState<SortField>("startedAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const visibleColumns = useMemo(() => visibleColumnIds(columns), [columns]);
  const activeColumns = useMemo(
    () => COLUMNS.filter((column) => visibleColumns.has(column.id)),
    [visibleColumns],
  );

  /* ---- sorting ---- */

  const sorted = useMemo(() => {
    return [...events].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "startedAt":
          cmp = Date.parse(a.startedAt) - Date.parse(b.startedAt);
          break;
        case "kind":
          cmp = a.kind.localeCompare(b.kind);
          break;
        case "label":
          cmp = a.label.localeCompare(b.label);
          break;
        case "status":
          cmp = a.status.localeCompare(b.status);
          break;
        case "laneName":
          cmp = (a.laneName ?? "").localeCompare(b.laneName ?? "");
          break;
        case "durationMs":
          cmp = (a.durationMs ?? -1) - (b.durationMs ?? -1);
          break;
        case "author":
          cmp = eventActor(a).localeCompare(eventActor(b));
          break;
        case "sha":
          cmp = eventSha(a).localeCompare(eventSha(b));
          break;
      }
      return sortDir === "desc" ? -cmp : cmp;
    });
  }, [events, sortField, sortDir]);

  const toggleSort = useCallback(
    (field: SortField) => {
      if (sortField === field) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortField(field);
        setSortDir("desc");
      }
    },
    [sortField],
  );

  /* ---- render ---- */

  if (events.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="font-mono text-[11px] text-muted-fg/50">
          No events match filters
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col min-h-0">
      {/* ---- header ---- */}
      <div className="flex items-center border-b border-white/[0.06] bg-white/[0.02] backdrop-blur-xl px-2">
        {activeColumns.map((col) => {
          const active = sortField === col.field;
          const SortIcon = sortDir === "asc" ? CaretUp : CaretDown;

          return (
            <button
              key={col.id}
              type="button"
              onClick={() => toggleSort(col.field)}
              className={cn(
                "flex h-7 items-center gap-0.5 px-1",
                col.width,
                col.align === "right" && "justify-end",
                "font-sans text-[9px] font-bold uppercase tracking-[1px]",
                active ? "text-fg" : "text-muted-fg hover:text-fg",
              )}
            >
              {col.label}
              {active && <SortIcon weight="bold" className="size-2.5" />}
            </button>
          );
        })}
      </div>

      {/* ---- body ---- */}
      <div className="flex-1 overflow-y-auto">
        {sorted.map((ev) => {
          const selected = ev.id === selectedEventId;
          const catMeta = CATEGORY_META[ev.category];

          return (
            <button
              key={ev.id}
              type="button"
              onClick={() => onSelectEvent(ev.id)}
              title={formatDate(ev.startedAt)}
              className={cn(
                "flex h-7 w-full items-center border-l-2 border-l-transparent px-2",
                "transition-colors duration-75",
                selected
                  ? "border-l-accent bg-white/[0.05]"
                  : "hover:bg-white/[0.03]",
              )}
            >
              {activeColumns.map((col) => (
                <CompactCell
                  key={`${ev.id}:${col.id}`}
                  column={col}
                  event={ev}
                  color={catMeta?.color ?? ev.color}
                />
              ))}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CompactCell({
  column,
  event,
  color,
}: {
  column: Column;
  event: TimelineEvent;
  color: string;
}) {
  switch (column.id) {
    case "timestamp":
      return (
        <span className="w-[72px] shrink-0 px-1 font-mono text-[10px] tabular-nums text-muted-fg">
          {relativeWhen(event.startedAt)}
        </span>
      );
    case "graph":
      return (
        <span className="flex w-[34px] shrink-0 items-center justify-center px-1">
          <span
            className="inline-block size-[6px] shrink-0 rounded-full"
            style={{ backgroundColor: color }}
          />
        </span>
      );
    case "event":
      return (
        <span className="flex min-w-[100px] flex-1 items-center gap-1.5 overflow-hidden px-1">
          <span className="truncate font-sans text-[10px] text-fg">{event.label}</span>
          <span className="hidden shrink-0 font-mono text-[9px] text-muted-fg/50 lg:inline">
            {event.kind}
          </span>
        </span>
      );
    case "lane":
      return (
        <span className="w-[90px] shrink-0 truncate px-1 font-mono text-[10px] text-muted-fg/60">
          {event.laneName ?? "—"}
        </span>
      );
    case "author":
      return (
        <span className="w-[90px] shrink-0 truncate px-1 font-mono text-[10px] text-muted-fg/60">
          {eventActor(event)}
        </span>
      );
    case "status":
      return (
        <span className="flex w-[72px] shrink-0 items-center gap-1.5 px-1">
          <span
            className={cn(
              "inline-block size-[6px] shrink-0 rounded-full",
              STATUS_DOT[event.status] ?? "bg-muted-fg",
            )}
          />
          <span className="font-mono text-[10px] text-muted-fg">{event.status}</span>
        </span>
      );
    case "duration":
      return (
        <span className="w-[56px] shrink-0 px-1 text-right font-mono text-[10px] tabular-nums text-muted-fg/60">
          {formatDurationMs(event.durationMs)}
        </span>
      );
    case "sha":
      return (
        <span className="w-[64px] shrink-0 truncate px-1 text-right font-mono text-[10px] text-muted-fg/60">
          {eventSha(event)}
        </span>
      );
  }
}
