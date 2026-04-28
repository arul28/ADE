import React, { useMemo } from "react";
import * as PhosphorIcons from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import type { TimelineEvent } from "./timelineTypes";
import { CATEGORY_META, getStatusClasses } from "./eventTaxonomy";
import { relativeWhen, formatDurationMs } from "../../lib/format";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

type TimelineListViewProps = {
  events: TimelineEvent[];
  selectedEventId: string | null;
  onSelectEvent: (id: string) => void;
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function getTimeGroup(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "Unknown";
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  const startOfWeek = startOfToday - now.getDay() * 86_400_000;
  if (ts >= startOfToday) return "Today";
  if (ts >= startOfYesterday) return "Yesterday";
  if (ts >= startOfWeek) return "This Week";
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
  });
}

type GroupedEvents = { label: string; events: TimelineEvent[] };

function groupByTime(events: TimelineEvent[]): GroupedEvents[] {
  const map = new Map<string, TimelineEvent[]>();
  for (const ev of events) {
    const key = getTimeGroup(ev.startedAt);
    let list = map.get(key);
    if (!list) {
      list = [];
      map.set(key, list);
    }
    list.push(ev);
  }
  return Array.from(map, ([label, evs]) => ({ label, events: evs }));
}

const STATUS_CHAR: Record<string, string> = {
  running: "⏵",
  succeeded: "✓",
  failed: "✕",
  canceled: "—",
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function TimelineListView({
  events,
  selectedEventId,
  onSelectEvent,
}: TimelineListViewProps) {
  const groups = useMemo(() => groupByTime(events), [events]);

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
    <div className="flex flex-1 flex-col overflow-y-auto" data-tour="history.entries">
      {groups.map((group) => (
        <div key={group.label} className="flex flex-col gap-px">
          {/* Sticky group header */}
          <div
            className={cn(
              "sticky top-0 z-10 border-b border-white/[0.06] bg-white/[0.02] px-3 py-1.5 backdrop-blur-xl",
              "font-sans text-[10px] font-bold uppercase tracking-[1px] text-muted-fg/50",
            )}
          >
            {group.label}
          </div>

          {/* Event rows */}
          {group.events.map((ev) => {
            const selected = ev.id === selectedEventId;
            const catMeta = CATEGORY_META[ev.category];
            const Icon = (PhosphorIcons as unknown as Record<string, React.ElementType>)[
              ev.iconName
            ];

            return (
              <button
                key={ev.id}
                type="button"
                data-tour="history.entry"
                onClick={() => onSelectEvent(ev.id)}
                className={cn(
                  "flex w-full items-center gap-2 border-l-2 border-l-transparent px-2 py-1.5",
                  "transition-colors duration-75",
                  selected
                    ? "border-l-accent bg-white/[0.05]"
                    : "hover:bg-white/[0.03]",
                )}
              >
                {/* Category color bar */}
                <span
                  className="h-full w-[3px] shrink-0 self-stretch"
                  style={{ backgroundColor: catMeta?.color ?? ev.color }}
                />

                {/* Icon */}
                {Icon ? (
                  <Icon
                    weight="bold"
                    className="size-3.5 shrink-0"
                    style={{ color: catMeta?.color ?? ev.color }}
                  />
                ) : (
                  <span
                    className="size-[6px] shrink-0 rounded-full"
                    style={{ backgroundColor: catMeta?.color ?? ev.color }}
                  />
                )}

                {/* Label + kind */}
                <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                  <span className="truncate font-sans text-[11px] text-fg">
                    {ev.label}
                  </span>
                  <span className="shrink-0 font-mono text-[9px] text-muted-fg/60">
                    ({ev.kind})
                  </span>
                </span>

                {/* Lane */}
                {ev.laneName && (
                  <span className="flex shrink-0 items-center gap-1 font-mono text-[9px] text-muted-fg/60">
                    <span
                      className="inline-block size-[5px] rounded-full"
                      style={{ backgroundColor: ev.color }}
                    />
                    <span className="max-w-[72px] truncate">{ev.laneName}</span>
                  </span>
                )}

                {/* Status badge */}
                <span
                  className={cn(
                    "shrink-0 border rounded-md px-1.5 py-px font-mono text-[9px] font-bold uppercase tracking-[0.5px]",
                    getStatusClasses(ev.status),
                  )}
                >
                  {STATUS_CHAR[ev.status] ?? ""} {ev.status}
                </span>

                {/* Timestamp */}
                <span className="w-[60px] shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-fg">
                  {relativeWhen(ev.startedAt)}
                </span>

                {/* Duration */}
                <span className="w-[48px] shrink-0 text-right font-mono text-[9px] tabular-nums text-muted-fg/60">
                  {formatDurationMs(ev.durationMs)}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
