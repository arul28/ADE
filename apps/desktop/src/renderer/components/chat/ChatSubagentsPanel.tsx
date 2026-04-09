import { useCallback, useMemo, useState } from "react";
import {
  ArrowLeft,
  CheckCircle,
  ClockCounterClockwise,
  Copy,
  XCircle,
  TreeStructure,
} from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { ChatStatusGlyph } from "./chatStatusVisuals";
import type { ChatSubagentSnapshot, SubagentTimelineEntry } from "./chatExecutionSummary";
import { deriveSubagentTimeline } from "./chatExecutionSummary";
import type { AgentChatEventEnvelope } from "../../../shared/types";
import { BottomDrawerSection } from "./BottomDrawerSection";

/* ── Formatting helpers ── */

function formatTokenCount(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatDurationMs(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (value >= 60_000) return `${Math.round(value / 60_000)}m`;
  return `${Math.max(1, Math.round(value / 1000))}s`;
}

function summarizeRuntime(snapshot: ChatSubagentSnapshot): string | null {
  const parts = [
    formatDurationMs(snapshot.usage?.durationMs),
    snapshot.usage?.toolUses ? `${snapshot.usage.toolUses} tool${snapshot.usage.toolUses === 1 ? "" : "s"}` : null,
    formatTokenCount(snapshot.usage?.totalTokens),
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" \u00b7 ") : null;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

/* ── Status helpers ── */

function statusMeta(status: ChatSubagentSnapshot["status"]): {
  label: string;
  chipClassName: string;
  icon: JSX.Element;
} {
  switch (status) {
    case "completed":
      return {
        label: "Done",
        chipClassName: "border-emerald-400/15 bg-emerald-500/[0.06] text-emerald-300/90",
        icon: <CheckCircle size={12} weight="fill" className="text-emerald-400" />,
      };
    case "failed":
      return {
        label: "Failed",
        chipClassName: "border-red-500/20 bg-red-500/[0.08] text-red-300/90",
        icon: <XCircle size={12} weight="fill" className="text-red-400" />,
      };
    case "stopped":
      return {
        label: "Stopped",
        chipClassName: "border-amber-400/20 bg-amber-500/[0.08] text-amber-300/90",
        icon: <ClockCounterClockwise size={12} weight="bold" className="text-amber-400" />,
      };
    default:
      return {
        label: "Running",
        chipClassName: "border-emerald-400/20 bg-emerald-500/[0.08] text-emerald-300",
        icon: <ChatStatusGlyph status="working" size={12} className="ade-glow-pulse" />,
      };
  }
}

/* ── Timeline detail view ── */

const MAX_VISIBLE_TIMELINE = 20;

function SubagentDetailView({
  snapshot,
  timeline,
  onBack,
  onInterruptTurn,
}: {
  snapshot: ChatSubagentSnapshot;
  timeline: SubagentTimelineEntry[];
  onBack: () => void;
  onInterruptTurn?: () => void;
}) {
  const meta = statusMeta(snapshot.status);
  const runtimeSummary = summarizeRuntime(snapshot);
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);

  const visibleTimeline = showAll ? timeline : timeline.slice(-MAX_VISIBLE_TIMELINE);
  const hiddenCount = timeline.length - visibleTimeline.length;

  const handleCopy = useCallback(() => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(snapshot.taskId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [snapshot.taskId]);

  return (
    <div className="flex flex-col">
      {/* Back button + header */}
      <div className="flex items-center gap-2.5 px-3 py-2 border-b border-white/[0.06]">
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-fg/40 transition-colors hover:bg-white/[0.04] hover:text-fg/70"
          onClick={onBack}
        >
          <ArrowLeft size={10} weight="bold" />
          Back
        </button>
        <span className="min-w-0 flex-1 truncate text-[11px] text-fg/70">
          {snapshot.description}
        </span>
        <span className={cn(
          "rounded-full border px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-widest",
          meta.chipClassName,
        )}>
          {meta.label}
        </span>
      </div>

      {/* Runtime stats */}
      {runtimeSummary || snapshot.background ? (
        <div className="flex items-center gap-2 px-3 py-1.5">
          {snapshot.background ? (
            <span className="rounded border border-sky-400/12 bg-sky-500/[0.06] px-1 py-px font-mono text-[7px] font-bold uppercase tracking-widest text-sky-300/55">
              bg
            </span>
          ) : null}
          {runtimeSummary ? (
            <span className="text-[10px] text-fg/40 font-mono">{runtimeSummary}</span>
          ) : null}
        </div>
      ) : null}

      {/* Activity timeline */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {hiddenCount > 0 && (
          <button
            type="button"
            className="mb-2 font-mono text-[9px] text-fg/30 transition-colors hover:text-fg/50"
            onClick={() => setShowAll(true)}
          >
            Show {hiddenCount} earlier event{hiddenCount !== 1 ? "s" : ""}
          </button>
        )}

        {visibleTimeline.length === 0 ? (
          <div className="py-4 text-center font-mono text-[10px] text-fg/25">
            No activity recorded yet
          </div>
        ) : (
          <div className="space-y-0.5 border-l border-white/[0.06] ml-1 pl-3">
            {visibleTimeline.map((entry, index) => (
              <div key={`${entry.timestamp}-${index}`} className="flex items-start gap-2 py-0.5 relative before:absolute before:-left-3 before:top-[9px] before:h-px before:w-2 before:bg-white/[0.06]">
                <span className="shrink-0 font-mono text-[9px] text-fg/20 pt-px">
                  {formatTime(entry.timestamp)}
                </span>
                {entry.type === "started" ? (
                  <span className="text-[10px] text-fg/40">Started</span>
                ) : entry.type === "result" ? (
                  <div className="min-w-0 flex-1">
                    <span className={cn(
                      "text-[10px] font-medium",
                      entry.status === "completed" ? "text-emerald-300/70" :
                      entry.status === "failed" ? "text-red-300/70" :
                      "text-amber-300/70",
                    )}>
                      {entry.status === "completed" ? "Completed" : entry.status === "failed" ? "Failed" : "Stopped"}
                    </span>
                    {entry.summary ? (
                      <p className="mt-0.5 truncate text-[10px] text-fg/45">{entry.summary}</p>
                    ) : null}
                  </div>
                ) : (
                  <div className="min-w-0 flex-1">
                    {entry.lastToolName ? (
                      <span className="font-mono text-[10px] text-fg/45">{entry.lastToolName}</span>
                    ) : null}
                    {entry.summary ? (
                      <p className={cn(
                        "truncate text-[10px] text-fg/35",
                        entry.lastToolName && "mt-0.5",
                      )}>
                        {entry.summary}
                      </p>
                    ) : null}
                    {!entry.lastToolName && !entry.summary ? (
                      <span className="text-[10px] text-fg/25">Working...</span>
                    ) : null}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 border-t border-white/[0.06] px-3 py-1.5">
        <span className="select-all font-mono text-[9px] text-fg/20">{snapshot.taskId}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-white/[0.06] px-2 py-0.5 font-mono text-[9px] text-fg/30 transition-all hover:border-white/[0.12] hover:text-fg/55"
            onClick={handleCopy}
            title="Copy agent id"
          >
            <Copy size={10} />
            {copied ? "Copied" : "Copy id"}
          </button>
          {snapshot.status === "running" && onInterruptTurn ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md border border-red-500/15 bg-red-500/[0.04] px-2 py-0.5 font-mono text-[9px] text-red-300/70 transition-all hover:bg-red-500/[0.08] hover:text-red-200"
              onClick={onInterruptTurn}
            >
              <XCircle size={10} />
              Stop
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ── Main component ── */

export function ChatSubagentsPanel({
  snapshots,
  events,
  onInterruptTurn,
  className,
}: {
  snapshots: ChatSubagentSnapshot[];
  events: AgentChatEventEnvelope[];
  onInterruptTurn?: () => void;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<{ mode: "list" } | { mode: "detail"; taskId: string }>({ mode: "list" });

  const { activeCount, completedCount, failedCount, stoppedCount, backgroundRunningCount } = useMemo(() => {
    let active = 0;
    let completed = 0;
    let failed = 0;
    let stopped = 0;
    let bgRunning = 0;
    for (const s of snapshots) {
      if (s.status === "running") {
        active++;
        if (s.background) bgRunning++;
      } else if (s.status === "completed") completed++;
      else if (s.status === "stopped") stopped++;
      else if (s.status === "failed") failed++;
    }
    return { activeCount: active, completedCount: completed, failedCount: failed, stoppedCount: stopped, backgroundRunningCount: bgRunning };
  }, [snapshots]);

  const summaryText = useMemo(() => {
    const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
    const parts: string[] = [plural(activeCount, "active")];
    if (backgroundRunningCount > 0) parts.push(`${backgroundRunningCount} bg`);
    if (completedCount > 0) parts.push(`${completedCount} done`);
    if (stoppedCount > 0) parts.push(`${stoppedCount} stopped`);
    if (failedCount > 0) parts.push(`${failedCount} failed`);
    return parts.join(" \u00b7 ");
  }, [activeCount, backgroundRunningCount, completedCount, failedCount, stoppedCount]);

  const detailSnapshot = useMemo(() => {
    if (view.mode !== "detail") return null;
    return snapshots.find((s) => s.taskId === view.taskId) ?? null;
  }, [view, snapshots]);

  const detailTimeline = useMemo(() => {
    if (view.mode !== "detail") return [];
    return deriveSubagentTimeline(events, view.taskId);
  }, [view, events]);

  if (!snapshots.length) return null;

  return (
    <BottomDrawerSection
      label="Subagents"
      icon={TreeStructure}
      summary={summaryText}
      expanded={expanded}
      onToggle={() => {
        setExpanded((v) => !v);
        if (expanded) setView({ mode: "list" });
      }}
      className={className}
    >
      {view.mode === "detail" && detailSnapshot ? (
        <SubagentDetailView
          snapshot={detailSnapshot}
          timeline={detailTimeline}
          onBack={() => setView({ mode: "list" })}
          onInterruptTurn={detailSnapshot.status === "running" ? onInterruptTurn : undefined}
        />
      ) : (
        <div className="space-y-1.5 px-1.5 py-1.5">
          {snapshots.map((snapshot) => {
            const meta = statusMeta(snapshot.status);
            const runtimeSummary = summarizeRuntime(snapshot);

            return (
              <button
                key={snapshot.taskId}
                type="button"
                className="group flex w-full items-center gap-2 rounded-xl border border-white/[0.06] bg-[#141220]/80 p-3 text-left transition-colors hover:bg-[#141220]"
                onClick={() => setView({ mode: "detail", taskId: snapshot.taskId })}
                title={snapshot.description}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {meta.icon}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-fg/65 group-hover:text-fg/85">
                  {snapshot.description}
                </span>
                {snapshot.background ? (
                  <span className="rounded border border-sky-400/12 bg-sky-500/[0.06] px-1 py-px font-mono text-[7px] font-bold uppercase tracking-widest text-sky-300/55">
                    bg
                  </span>
                ) : null}
                {runtimeSummary ? (
                  <span className="text-[10px] text-fg/40 font-mono group-hover:text-fg/50">
                    {runtimeSummary}
                  </span>
                ) : null}
                <span className={cn("rounded-full border px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-widest", meta.chipClassName)}>
                  {meta.label}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </BottomDrawerSection>
  );
}
