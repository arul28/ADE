import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import type { OrchestratorTimelineEvent } from "../../../shared/types";
import { cn } from "../ui/cn";

type Props = {
  runId: string;
  initialTimeline: OrchestratorTimelineEvent[];
};

const EVENT_CONFIG: Record<string, { icon: string; color: string; label: string; category: string }> = {
  step_status_changed: { icon: "\u25CF", color: "text-blue-400", label: "Step", category: "Steps" },
  step_registered: { icon: "\u25CF", color: "text-blue-400", label: "Step", category: "Steps" },
  step_dependencies_resolved: { icon: "\u25CF", color: "text-blue-400", label: "Step", category: "Steps" },
  step_skipped: { icon: "\u25CF", color: "text-blue-400", label: "Step", category: "Steps" },
  step_superseded: { icon: "\u2248", color: "text-amber-300", label: "Superseded", category: "Steps" },
  autopilot_advance: { icon: "\u25B6", color: "text-violet-400", label: "Autopilot", category: "Workers" },
  autopilot_attempt_start_failed: { icon: "\u25B6", color: "text-red-400", label: "Autopilot", category: "Workers" },
  attempt_started: { icon: "\u25B6", color: "text-violet-400", label: "Attempt", category: "Workers" },
  attempt_completed: { icon: "\u25B6", color: "text-violet-400", label: "Attempt", category: "Workers" },
  attempt_blocked: { icon: "\u25B6", color: "text-amber-400", label: "Attempt", category: "Workers" },
  attempt_retry_scheduled: { icon: "\u25B6", color: "text-amber-400", label: "Retry", category: "Workers" },
  attempt_recovered_after_restart: { icon: "\u25B6", color: "text-cyan-400", label: "Recovery", category: "Workers" },
  worker_message_routed: { icon: "\u2709", color: "text-cyan-300", label: "Message", category: "Workers" },
  worker_status_reported: { icon: "\u25CB", color: "text-sky-300", label: "Status", category: "Workers" },
  worker_result_reported: { icon: "\u2713", color: "text-emerald-300", label: "Result", category: "Workers" },
  claim_acquired: { icon: "\u25A0", color: "text-amber-400", label: "Claim", category: "Workers" },
  claim_released: { icon: "\u25A1", color: "text-amber-300", label: "Release", category: "Workers" },
  claim_expired: { icon: "\u25A1", color: "text-amber-300", label: "Expired", category: "Workers" },
  claim_heartbeat: { icon: "\u25A1", color: "text-amber-200", label: "Heartbeat", category: "Workers" },
  context_snapshot_created: { icon: "\u25C6", color: "text-cyan-400", label: "Snapshot", category: "Quality" },
  context_pressure_warning: { icon: "\u26A0", color: "text-red-400", label: "Pressure", category: "Quality" },
  context_pack_bootstrap: { icon: "\u25C6", color: "text-cyan-300", label: "Bootstrap", category: "Quality" },
  validation_contract_unfulfilled: { icon: "\u26A0", color: "text-red-400", label: "Validation", category: "Quality" },
  validation_self_check_reminder: { icon: "\u2611", color: "text-amber-300", label: "Validation", category: "Quality" },
  validation_auto_spawned: { icon: "\u2699", color: "text-cyan-300", label: "Validation", category: "Quality" },
  validation_gate_blocked: { icon: "\u26D4", color: "text-amber-400", label: "Validation", category: "Quality" },
  validation_reported: { icon: "\u2714", color: "text-emerald-300", label: "Validation", category: "Quality" },
  validation_escalated: { icon: "\u26A0", color: "text-amber-400", label: "Validation", category: "Quality" },
  integration_chain_started: { icon: "\u2295", color: "text-emerald-400", label: "Merge", category: "Integration" },
  run_status_changed: { icon: "\u25C9", color: "text-green-400", label: "Run", category: "Steps" },
  run_created: { icon: "\u25C9", color: "text-green-400", label: "Run", category: "Steps" },
  run_resumed: { icon: "\u25C9", color: "text-green-400", label: "Run", category: "Steps" },
  run_canceled: { icon: "\u25C9", color: "text-red-400", label: "Run", category: "Steps" },
  phase_transition: { icon: "\u25B8", color: "text-indigo-400", label: "Phase", category: "Steps" },
  plan_revised: { icon: "\u267B", color: "text-indigo-300", label: "Plan", category: "Steps" },
  lane_transfer: { icon: "\u21C4", color: "text-orange-300", label: "Lane", category: "Steps" },
  tool_profiles_updated: { icon: "\u2699", color: "text-purple-300", label: "Tools", category: "Steps" },
  budget_warning: { icon: "\u26A0", color: "text-amber-400", label: "Budget Warning", category: "Quality" },
  budget_hard_cap_triggered: { icon: "\u26D4", color: "text-red-400", label: "Budget Hard Cap", category: "Quality" },
  mission_paused: { icon: "\u23F8", color: "text-amber-400", label: "Mission Paused", category: "Steps" },
  mission_resumed: { icon: "\u25B6", color: "text-emerald-400", label: "Mission Resumed", category: "Steps" },
  intervention_opened: { icon: "\u26A0", color: "text-red-400", label: "Intervention Opened", category: "Quality" },
  intervention_resolved: { icon: "\u2714", color: "text-emerald-400", label: "Intervention Resolved", category: "Quality" },
  recovery_loop_started: { icon: "\u21BB", color: "text-amber-400", label: "Recovery Started", category: "Quality" },
  recovery_loop_exhausted: { icon: "\u26D4", color: "text-red-400", label: "Recovery Exhausted", category: "Quality" },
  fan_out_dispatched: { icon: "\u25B6", color: "text-violet-400", label: "Fan-Out Dispatched", category: "Workers" },
  fan_out_complete: { icon: "\u2713", color: "text-emerald-300", label: "Fan-Out Complete", category: "Workers" },
  run_completing: { icon: "\u25C9", color: "text-green-400", label: "Run Completing", category: "Steps" },
  run_finalized: { icon: "\u25C9", color: "text-green-400", label: "Run Finalized", category: "Steps" },
  run_completion_requested: { icon: "\u25C9", color: "text-green-400", label: "Completion Requested", category: "Steps" },
  run_completion_blocked: { icon: "\u25C9", color: "text-amber-400", label: "Completion Blocked", category: "Steps" },
  run_activated: { icon: "\u25C9", color: "text-green-400", label: "Run Activated", category: "Steps" },
  run_reopened: { icon: "\u25C9", color: "text-green-400", label: "Run Reopened", category: "Steps" },
  integration_chain_stage: { icon: "\u2295", color: "text-emerald-400", label: "Integration Stage", category: "Integration" },
  coordinator_steering: { icon: "\u2709", color: "text-cyan-300", label: "User Steering", category: "Steps" },
  coordinator_broadcast: { icon: "\u2709", color: "text-cyan-300", label: "Coordinator Broadcast", category: "Workers" },
  budget_exceeded: { icon: "\u26D4", color: "text-red-400", label: "Budget Exceeded", category: "Quality" },
  budget_updated: { icon: "\u2699", color: "text-amber-300", label: "Budget Updated", category: "Quality" },
  worker_started: { icon: "\u25B6", color: "text-violet-400", label: "Worker Started", category: "Workers" },
  worker_failed: { icon: "\u2717", color: "text-red-400", label: "Worker Failed", category: "Workers" },
  integration_pr_step_inserted: { icon: "\u2295", color: "text-emerald-400", label: "PR Step Inserted", category: "Integration" },
};

const DEFAULT_CONFIG = { icon: "\u25CB", color: "text-muted-fg", label: "Event", category: "All Events" };

const CATEGORY_OPTIONS = ["All Events", "Steps", "Workers", "Quality", "Integration"];
type Severity = "all" | "warnings" | "errors";

function sortTimeline(events: OrchestratorTimelineEvent[]): OrchestratorTimelineEvent[] {
  return [...events].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

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

function eventSeverity(ev: OrchestratorTimelineEvent): "error" | "warning" | "info" {
  const r = ev.reason.toLowerCase();
  if (
    r.includes("failed") ||
    r.includes("error") ||
    ev.eventType === "context_pressure_warning" ||
    ev.eventType === "validation_contract_unfulfilled"
  ) {
    return "error";
  }
  if (
    r.includes("warning") ||
    r.includes("blocked") ||
    r.includes("paused") ||
    ev.eventType === "validation_self_check_reminder" ||
    ev.eventType === "validation_gate_blocked"
  ) {
    return "warning";
  }
  return "info";
}

type GroupedEvent = {
  events: OrchestratorTimelineEvent[];
  collapsed: boolean;
};

function groupConsecutive(events: OrchestratorTimelineEvent[]): GroupedEvent[] {
  const groups: GroupedEvent[] = [];
  for (const ev of events) {
    const last = groups[groups.length - 1];
    if (last && last.events[0].eventType === ev.eventType && last.events.length < 20) {
      last.events.push(ev);
      last.collapsed = last.events.length > 2;
    } else {
      groups.push({ events: [ev], collapsed: false });
    }
  }
  return groups;
}

export const OrchestratorActivityFeed = React.memo(function OrchestratorActivityFeed({ runId, initialTimeline }: Props) {
  const [events, setEvents] = useState<OrchestratorTimelineEvent[]>(() => sortTimeline(initialTimeline));
  const [category, setCategory] = useState("All Events");
  const [severity, setSeverity] = useState<Severity>("all");
  const [searchText, setSearchText] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const refreshTokenRef = useRef(0);

  const refreshTimeline = useCallback(async () => {
    if (!runId) return;
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    refreshInFlightRef.current = true;
    const token = refreshTokenRef.current;
    try {
      const latest = await window.ade.orchestrator.listTimeline({
        runId,
        limit: 400
      });
      if (token === refreshTokenRef.current) {
        setEvents(sortTimeline(latest));
      }
    } catch {
      // Ignore transient timeline refresh failures; live subscription/polling will retry.
    } finally {
      refreshInFlightRef.current = false;
      if (refreshQueuedRef.current) {
        refreshQueuedRef.current = false;
        void refreshTimeline();
      }
    }
  }, [runId]);

  const scheduleTimelineRefresh = useCallback((delayMs = 140) => {
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      void refreshTimeline();
    }, delayMs);
  }, [refreshTimeline]);

  useEffect(() => {
    refreshTokenRef.current += 1;
    setEvents(sortTimeline(initialTimeline));
    void refreshTimeline();
  }, [initialTimeline, refreshTimeline]);

  useEffect(() => {
    const unsub = window.ade.orchestrator.onEvent((ev) => {
      if (ev.runId !== runId) return;
      scheduleTimelineRefresh();
    });
    return () => {
      unsub();
    };
  }, [runId, scheduleTimelineRefresh]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshTimeline();
    }, 12_000);
    return () => window.clearInterval(interval);
  }, [refreshTimeline]);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

  // Auto-scroll to top (newest first)
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

  const filteredEvents = useMemo(() => {
    let result = events;

    // Category filter
    if (category !== "All Events") {
      result = result.filter((ev) => {
        const config = EVENT_CONFIG[ev.eventType] ?? DEFAULT_CONFIG;
        return config.category === category;
      });
    }

    // Severity filter
    if (severity === "warnings") {
      result = result.filter((ev) => {
        const s = eventSeverity(ev);
        return s === "warning" || s === "error";
      });
    } else if (severity === "errors") {
      result = result.filter((ev) => eventSeverity(ev) === "error");
    }

    // Text search
    if (searchText.trim()) {
      const lower = searchText.toLowerCase();
      result = result.filter((ev) =>
        ev.reason.toLowerCase().includes(lower) ||
        ev.eventType.toLowerCase().includes(lower) ||
        (ev.stepId && ev.stepId.toLowerCase().includes(lower))
      );
    }

    return result;
  }, [events, category, severity, searchText]);

  const grouped = useMemo(() => groupConsecutive(filteredEvents), [filteredEvents]);

  return (
    <div className="flex flex-col gap-2">
      {/* Compact filter controls */}
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="h-7 px-2 text-[10px] outline-none"
          style={{ background: "#0C0A10", border: "1px solid #27272A", color: "#FAFAFA", fontFamily: "JetBrains Mono, monospace", fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", borderRadius: 0 }}
        >
          {CATEGORY_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>

        <input
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="Filter events..."
          className="h-7 w-40 px-2 text-[11px] outline-none"
          style={{ background: "#0C0A10", border: "1px solid #27272A", color: "#FAFAFA", fontFamily: "JetBrains Mono, monospace", borderRadius: 0 }}
        />

        <div className="flex overflow-hidden" style={{ border: "1px solid #1E1B26", borderRadius: 0 }}>
          {(["all", "warnings", "errors"] as const).map((sev) => (
            <button
              key={sev}
              onClick={() => setSeverity(sev)}
              className="px-2 py-0.5 text-[11px] font-medium transition-colors"
              style={severity === sev
                ? { background: "#A78BFA18", color: "#A78BFA", fontFamily: "JetBrains Mono, monospace" }
                : { background: "#13101A", color: "#71717A", fontFamily: "JetBrains Mono, monospace" }
              }
            >
              {sev === "all" ? "All" : sev === "warnings" ? "Warnings" : "Errors"}
            </button>
          ))}
        </div>

        {(category !== "All Events" || severity !== "all" || searchText) && (
          <button
            onClick={() => { setCategory("All Events"); setSeverity("all"); setSearchText(""); }}
            className="text-[11px] transition-colors hover:text-white"
            style={{ color: "#71717A", fontFamily: "JetBrains Mono, monospace" }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Event list */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="relative max-h-[400px] overflow-y-auto"
        style={{ border: "1px solid #1E1B26", background: "#13101A", borderRadius: 0 }}
      >
        {!autoScroll && (
          <button
            onClick={() => {
              setAutoScroll(true);
              if (scrollRef.current) scrollRef.current.scrollTop = 0;
            }}
            className="sticky top-0 z-10 w-full px-2 py-1 text-[10px] text-center transition-colors"
            style={{ background: "#A78BFA", color: "#0F0D14", fontFamily: "JetBrains Mono, monospace", fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", borderRadius: 0 }}
          >
            Jump to latest
          </button>
        )}

        {grouped.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs" style={{ color: "#71717A", fontFamily: "JetBrains Mono, monospace" }}>
            {events.length === 0 ? "No events yet" : "No events match the active filters"}
          </div>
        ) : (
          <div style={{ borderColor: "#1E1B26" }} className="divide-y">
            {grouped.map((group) => {
              const first = group.events[0];
              const config = EVENT_CONFIG[first.eventType] ?? DEFAULT_CONFIG;

              if (group.collapsed && expandedId !== first.id) {
                // Show collapsed group
                return (
                  <button
                    key={first.id}
                    onClick={() => setExpandedId(first.id)}
                    className="w-full text-left px-3 py-1.5 transition-colors"
                    style={{ borderColor: "#1E1B26" }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#1A1720"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                  >
                    <div className="flex items-center gap-2">
                      <span className={cn("text-[12px] leading-none", config.color)}>
                        {config.icon}
                      </span>
                      <span
                        className="px-1.5 py-0.5 text-[10px]"
                        style={{ background: "#1E1B26", color: "#71717A", fontFamily: "JetBrains Mono, monospace", fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", borderRadius: 0 }}
                      >
                        {config.label}
                      </span>
                      <span className="text-xs" style={{ color: "#71717A", fontFamily: "JetBrains Mono, monospace" }}>
                        {group.events.length} {config.label.toLowerCase()} events
                      </span>
                      <span
                        className="ml-auto shrink-0 text-[11px]"
                        title={formatTimestamp(first.createdAt)}
                        style={{ color: "#52525B", fontFamily: "JetBrains Mono, monospace", fontSize: "10px" }}
                      >
                        {relativeTime(first.createdAt)}
                      </span>
                    </div>
                  </button>
                );
              }

              // Expanded: render all events in group
              return group.events.map((ev) => {
                const evConfig = EVENT_CONFIG[ev.eventType] ?? DEFAULT_CONFIG;
                const isExpanded = expandedId === ev.id;
                const sev = eventSeverity(ev);

                const rowStyle: React.CSSProperties = { borderColor: "#1E1B26" };
                if (sev === "error") {
                  rowStyle.borderLeft = "2px solid #EF4444";
                  rowStyle.background = "#EF444408";
                } else if (sev === "warning") {
                  rowStyle.borderLeft = "2px solid #F59E0B";
                  rowStyle.background = "#F59E0B08";
                }

                return (
                  <button
                    key={ev.id}
                    onClick={() => setExpandedId(isExpanded ? null : ev.id)}
                    className="w-full text-left px-3 py-2 transition-colors"
                    style={rowStyle}
                    onMouseEnter={(e) => {
                      if (sev === "info") (e.currentTarget as HTMLElement).style.background = "#1A1720";
                    }}
                    onMouseLeave={(e) => {
                      if (sev === "error") (e.currentTarget as HTMLElement).style.background = "#EF444408";
                      else if (sev === "warning") (e.currentTarget as HTMLElement).style.background = "#F59E0B08";
                      else (e.currentTarget as HTMLElement).style.background = "transparent";
                    }}
                  >
                    <div className="flex items-start gap-2">
                      <span className={cn("mt-0.5 text-[12px] leading-none", evConfig.color)}>
                        {evConfig.icon}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span
                            className="px-1.5 py-0.5 text-[10px]"
                            style={{ background: "#1E1B26", color: "#71717A", fontFamily: "JetBrains Mono, monospace", fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", borderRadius: 0 }}
                          >
                            {evConfig.label}
                          </span>
                          <span className="flex-1 truncate text-xs" style={{ color: "#FAFAFA" }}>
                            {ev.reason}
                          </span>
                          <span
                            className="shrink-0"
                            title={formatTimestamp(ev.createdAt)}
                            style={{ color: "#52525B", fontFamily: "JetBrains Mono, monospace", fontSize: "10px" }}
                          >
                            {relativeTime(ev.createdAt)}
                          </span>
                        </div>
                        {ev.stepId && (
                          <div className="mt-0.5 truncate" style={{ color: "#52525B", fontFamily: "JetBrains Mono, monospace", fontSize: "11px" }}>
                            step: {ev.stepId.slice(0, 8)}
                            {ev.attemptId ? ` / attempt: ${ev.attemptId.slice(0, 8)}` : ""}
                          </div>
                        )}
                        {isExpanded && ev.detail && (
                          <pre
                            className="mt-1.5 max-h-[200px] overflow-auto p-2 whitespace-pre-wrap break-all"
                            style={{ background: "#0C0A10", fontFamily: "JetBrains Mono, monospace", color: "#71717A", fontSize: "10px", borderRadius: 0 }}
                          >
                            {JSON.stringify(ev.detail, null, 2)}
                          </pre>
                        )}
                      </div>
                    </div>
                  </button>
                );
              });
            })}
          </div>
        )}
      </div>

      <div className="text-right" style={{ color: "#52525B", fontFamily: "JetBrains Mono, monospace", fontSize: "10px", textTransform: "uppercase", letterSpacing: "1px" }}>
        {filteredEvents.length} event{filteredEvents.length !== 1 ? "s" : ""}
        {filteredEvents.length !== events.length ? ` (filtered from ${events.length})` : ""}
      </div>
    </div>
  );
});
