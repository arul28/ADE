import React, { useState, useMemo, useCallback } from "react";
import { CaretUp, CaretDown } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import type { TimelineEvent } from "./timelineTypes";
import { getStatusClasses, CATEGORY_META } from "./eventTaxonomy";
import { relativeWhen, formatDate, formatDurationMs } from "../../lib/format";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type SortField = "startedAt" | "kind" | "status" | "laneName" | "durationMs";
type SortDir = "asc" | "desc";

type TimelineCompactViewProps = {
  events: TimelineEvent[];
  selectedEventId: string | null;
  onSelectEvent: (id: string) => void;
};

/* ------------------------------------------------------------------ */
/*  Column definitions                                                 */
/* ------------------------------------------------------------------ */

type Column = {
  field: SortField;
  label: string;
  width: string; // Tailwind width class
  align?: "right";
};

const COLUMNS: Column[] = [
  { field: "startedAt", label: "Time", width: "w-[72px]" },
  { field: "kind", label: "Event", width: "flex-1 min-w-[100px]" },
  { field: "kind", label: "Kind", width: "w-[90px]" },
  { field: "laneName", label: "Lane", width: "w-[90px]" },
  { field: "status", label: "Status", width: "w-[72px]" },
  { field: "durationMs", label: "Duration", width: "w-[56px]", align: "right" },
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

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function TimelineCompactView({
  events,
  selectedEventId,
  onSelectEvent,
}: TimelineCompactViewProps) {
  const [sortField, setSortField] = useState<SortField>("startedAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

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
        case "status":
          cmp = a.status.localeCompare(b.status);
          break;
        case "laneName":
          cmp = (a.laneName ?? "").localeCompare(b.laneName ?? "");
          break;
        case "durationMs":
          cmp = (a.durationMs ?? -1) - (b.durationMs ?? -1);
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
        {COLUMNS.map((col, i) => {
          const active = sortField === col.field;
          const SortIcon = sortDir === "asc" ? CaretUp : CaretDown;

          return (
            <button
              key={`${col.label}-${i}`}
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
              {/* Time */}
              <span className="w-[72px] shrink-0 px-1 font-mono text-[10px] tabular-nums text-muted-fg">
                {relativeWhen(ev.startedAt)}
              </span>

              {/* Event label + icon dot */}
              <span className="flex flex-1 min-w-[100px] items-center gap-1.5 px-1 overflow-hidden">
                <span
                  className="inline-block size-[6px] shrink-0 rounded-full"
                  style={{ backgroundColor: catMeta?.color ?? ev.color }}
                />
                <span className="truncate font-sans text-[10px] text-fg">
                  {ev.label}
                </span>
              </span>

              {/* Kind */}
              <span className="w-[90px] shrink-0 truncate px-1 font-mono text-[10px] text-muted-fg/60">
                {ev.kind}
              </span>

              {/* Lane */}
              <span className="w-[90px] shrink-0 truncate px-1 font-mono text-[10px] text-muted-fg/60">
                {ev.laneName ?? "—"}
              </span>

              {/* Status dot */}
              <span className="flex w-[72px] shrink-0 items-center gap-1.5 px-1">
                <span
                  className={cn(
                    "inline-block size-[6px] shrink-0 rounded-full",
                    STATUS_DOT[ev.status] ?? "bg-muted-fg",
                  )}
                />
                <span className="font-mono text-[10px] text-muted-fg">
                  {ev.status}
                </span>
              </span>

              {/* Duration */}
              <span className="w-[56px] shrink-0 text-right px-1 font-mono text-[10px] tabular-nums text-muted-fg/60">
                {formatDurationMs(ev.durationMs)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
