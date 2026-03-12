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
        "h-10 px-2 gap-2",
        "border-b border-border/5",
        selected && "bg-accent/8 border-l-2 border-l-accent/40",
        !selected && "hover:bg-card/40",
        dimmed && "opacity-40",
      )}
    >
      {/* Lane color indicator */}
      <div
        className="w-[3px] h-5 shrink-0"
        style={{ backgroundColor: laneColor }}
      />

      {/* Timestamp */}
      <span className="font-mono text-[10px] text-muted-fg w-[60px] shrink-0 tabular-nums">
        {relativeWhen(event.startedAt)}
      </span>

      {/* Event icon + label */}
      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        <div
          className="w-[6px] h-[6px] shrink-0"
          style={{ backgroundColor: event.color, borderRadius: event.shape === "circle" ? "50%" : "0" }}
        />
        <span className="font-mono text-[11px] text-fg truncate">
          {event.label}
        </span>
        {event.kind !== event.label && (
          <span className="font-mono text-[9px] text-muted-fg/50 truncate hidden group-hover:inline">
            {event.kind}
          </span>
        )}
      </div>

      {/* Lane name */}
      {event.laneName && (
        <span className="font-mono text-[9px] text-muted-fg truncate max-w-[80px] shrink-0">
          {event.laneName}
        </span>
      )}

      {/* Status badge */}
      <span className={cn(
        "font-mono text-[9px] font-bold uppercase tracking-[0.5px] px-1.5 py-0.5 border shrink-0",
        getStatusClasses(event.status),
      )}>
        {event.status === "running" ? "⏵" : event.status === "succeeded" ? "✓" : event.status === "failed" ? "✕" : "—"}
      </span>

      {/* Duration */}
      {event.durationMs != null && (
        <span className="font-mono text-[9px] text-muted-fg/60 w-[48px] shrink-0 text-right tabular-nums">
          {formatDurationMs(event.durationMs)}
        </span>
      )}
    </button>
  );
}
