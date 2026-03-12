import React from "react";
import { cn } from "../ui/cn";
import type { TimelineEvent } from "./timelineTypes";
import { getStatusClasses } from "./eventTaxonomy";
import { relativeWhen, formatDurationMs } from "../../lib/format";

type TimelineRowProps = {
  event: TimelineEvent;
  selected: boolean;
  dimmed: boolean;
  laneColor: string;
  onClick: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
};

export function TimelineRow({
  event,
  selected,
  dimmed,
  laneColor,
  onClick,
  onMouseEnter,
  onMouseLeave,
}: TimelineRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={cn(
        "flex items-center w-full text-left transition-all group",
        "h-11 px-2 gap-2",
        "border-b border-white/[0.04]",
        selected && "bg-white/[0.05] border-l-[3px] border-l-[var(--color-accent)]",
        !selected && "hover:bg-white/[0.03]",
        dimmed && "opacity-30",
      )}
    >
      {/* Lane color indicator — bold bar */}
      <div
        className="w-[4px] h-6 shrink-0"
        style={{ backgroundColor: laneColor }}
      />

      {/* Timestamp */}
      <span className="font-mono text-[10px] text-[var(--color-muted-fg)] w-[60px] shrink-0 tabular-nums">
        {relativeWhen(event.startedAt)}
      </span>

      {/* Event icon + label */}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {/* Bold category color dot */}
        <div
          className="w-[8px] h-[8px] shrink-0"
          style={{ backgroundColor: event.color, borderRadius: event.shape === "circle" ? "50%" : "0" }}
        />
        <span className="font-sans text-[11px] text-[var(--color-fg)] truncate font-medium">
          {event.label}
        </span>
        {event.kind !== event.label && (
          <span className="font-mono text-[9px] text-[var(--color-muted-fg)]/40 truncate hidden group-hover:inline">
            {event.kind}
          </span>
        )}
      </div>

      {/* Lane name */}
      {event.laneName && (
        <span
          className="font-mono text-[9px] truncate max-w-[80px] shrink-0 font-bold"
          style={{ color: `${laneColor}CC` }}
        >
          {event.laneName}
        </span>
      )}

      {/* Status badge */}
      <span className={cn(
        "font-mono text-[9px] font-bold uppercase tracking-[0.5px] px-1.5 py-0.5 border rounded-md shrink-0",
        getStatusClasses(event.status),
      )}>
        {event.status === "running" ? "⏵" : event.status === "succeeded" ? "✓" : event.status === "failed" ? "✕" : "—"}
      </span>

      {/* Duration */}
      {event.durationMs != null && (
        <span className="font-mono text-[9px] text-[var(--color-muted-fg)]/60 w-[48px] shrink-0 text-right tabular-nums">
          {formatDurationMs(event.durationMs)}
        </span>
      )}
    </button>
  );
}
