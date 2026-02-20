import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import type { OrchestratorTimelineEvent, OrchestratorRuntimeEvent } from "../../../shared/types";
import { cn } from "../ui/cn";

type Props = {
  runId: string;
  initialTimeline: OrchestratorTimelineEvent[];
};

const EVENT_CONFIG: Record<string, { icon: string; color: string; label: string }> = {
  step_status_changed: { icon: "\u25CF", color: "text-blue-400", label: "Step" },
  autopilot_advance: { icon: "\u25B6", color: "text-violet-400", label: "Autopilot" },
  claim_acquired: { icon: "\u25A0", color: "text-amber-400", label: "Claim" },
  claim_released: { icon: "\u25A1", color: "text-amber-300", label: "Release" },
  context_snapshot_created: { icon: "\u25C6", color: "text-cyan-400", label: "Snapshot" },
  integration_chain_started: { icon: "\u2295", color: "text-emerald-400", label: "Merge" },
  context_pressure_warning: { icon: "\u26A0", color: "text-red-400", label: "Pressure" },
  run_status_changed: { icon: "\u25C9", color: "text-green-400", label: "Run" },
};

const DEFAULT_CONFIG = { icon: "\u25CB", color: "text-muted-fg", label: "Event" };

const ALL_EVENT_TYPES = Object.keys(EVENT_CONFIG);

function relativeTime(iso: string): string {
  const delta = Math.max(0, Date.now() - Date.parse(iso));
  if (delta < 1000) return "now";
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}

export function OrchestratorActivityFeed({ runId, initialTimeline }: Props) {
  const [events, setEvents] = useState<OrchestratorTimelineEvent[]>(() =>
    [...initialTimeline].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  );
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Subscribe to live orchestrator events
  useEffect(() => {
    const unsub = window.ade.orchestrator.onEvent((ev: OrchestratorRuntimeEvent) => {
      if (ev.runId !== runId) return;

      const syntheticEvent: OrchestratorTimelineEvent = {
        id: `rt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        runId: ev.runId ?? runId,
        stepId: ev.stepId ?? null,
        attemptId: ev.attemptId ?? null,
        claimId: ev.claimId ?? null,
        eventType: ev.type.replace("orchestrator-", "").replace(/-/g, "_"),
        reason: ev.reason,
        detail: null,
        createdAt: ev.at,
      };

      setEvents((prev) => [syntheticEvent, ...prev]);
    });
    return () => unsub();
  }, [runId]);

  // Update initialTimeline when it changes
  useEffect(() => {
    setEvents([...initialTimeline].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
  }, [initialTimeline]);

  // Auto-scroll to bottom (newest at top, so scroll to top)
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [events, autoScroll]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop } = scrollRef.current;
    setAutoScroll(scrollTop <= 10);
  }, []);

  const toggleFilter = useCallback((eventType: string) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(eventType)) {
        next.delete(eventType);
      } else {
        next.add(eventType);
      }
      return next;
    });
  }, []);

  const filteredEvents = useMemo(() => {
    if (activeFilters.size === 0) return events;
    return events.filter((ev) => activeFilters.has(ev.eventType));
  }, [events, activeFilters]);

  return (
    <div className="flex flex-col gap-2">
      {/* Filter bar */}
      <div className="flex flex-wrap gap-1">
        {ALL_EVENT_TYPES.map((type) => {
          const config = EVENT_CONFIG[type] ?? DEFAULT_CONFIG;
          const isActive = activeFilters.has(type);
          return (
            <button
              key={type}
              onClick={() => toggleFilter(type)}
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors",
                isActive
                  ? "bg-accent/20 text-accent border border-accent/40"
                  : "bg-muted/10 text-muted-fg border border-border/20 hover:bg-muted/20"
              )}
            >
              <span className={cn("mr-1", config.color)}>{config.icon}</span>
              {config.label}
            </button>
          );
        })}
        {activeFilters.size > 0 && (
          <button
            onClick={() => setActiveFilters(new Set())}
            className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-fg hover:text-fg transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {/* Event list */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="relative max-h-[400px] overflow-y-auto rounded border border-border/20 bg-card/60"
      >
        {!autoScroll && (
          <button
            onClick={() => {
              setAutoScroll(true);
              if (scrollRef.current) scrollRef.current.scrollTop = 0;
            }}
            className="sticky top-0 z-10 w-full bg-accent/90 px-2 py-1 text-[10px] font-medium text-accent-fg text-center hover:bg-accent transition-colors"
          >
            Jump to latest
          </button>
        )}

        {filteredEvents.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-muted-fg">
            {events.length === 0 ? "No events yet" : "No events match the active filters"}
          </div>
        ) : (
          <div className="divide-y divide-border/10">
            {filteredEvents.map((ev) => {
              const config = EVENT_CONFIG[ev.eventType] ?? DEFAULT_CONFIG;
              const isExpanded = expandedId === ev.id;
              return (
                <button
                  key={ev.id}
                  onClick={() => setExpandedId(isExpanded ? null : ev.id)}
                  className="w-full text-left px-3 py-2 hover:bg-muted/10 transition-colors"
                >
                  <div className="flex items-start gap-2">
                    <span className={cn("mt-0.5 text-[12px] leading-none", config.color)}>
                      {config.icon}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-muted/15 px-1.5 py-0.5 text-[10px] font-medium text-muted-fg">
                          {config.label}
                        </span>
                        <span className="flex-1 truncate text-[11px] text-fg">
                          {ev.reason}
                        </span>
                        <span className="shrink-0 text-[10px] text-muted-fg" title={formatTimestamp(ev.createdAt)}>
                          {relativeTime(ev.createdAt)}
                        </span>
                      </div>
                      {ev.stepId && (
                        <div className="mt-0.5 text-[10px] text-muted-fg/70 truncate">
                          step: {ev.stepId.slice(0, 8)}
                          {ev.attemptId ? ` / attempt: ${ev.attemptId.slice(0, 8)}` : ""}
                        </div>
                      )}
                      {isExpanded && ev.detail && (
                        <pre className="mt-1.5 max-h-[200px] overflow-auto rounded bg-muted/10 p-2 text-[10px] text-muted-fg font-mono whitespace-pre-wrap break-all">
                          {JSON.stringify(ev.detail, null, 2)}
                        </pre>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="text-[10px] text-muted-fg/60 text-right">
        {filteredEvents.length} event{filteredEvents.length !== 1 ? "s" : ""}
        {activeFilters.size > 0 ? ` (filtered from ${events.length})` : ""}
      </div>
    </div>
  );
}
