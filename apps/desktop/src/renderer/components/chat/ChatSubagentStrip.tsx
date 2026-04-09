import { useCallback, useMemo, useState } from "react";
import {
  CheckCircle,
  ClockCounterClockwise,
  Copy,
  XCircle,
  TreeStructure,
  ArrowsOutSimple,
} from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { ChatStatusGlyph } from "./chatStatusVisuals";
import type { ChatSubagentSnapshot } from "./chatExecutionSummary";

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

function statusMeta(status: ChatSubagentSnapshot["status"]): {
  label: string;
  chipClassName: string;
  icon: JSX.Element;
  accentColor: string;
} {
  switch (status) {
    case "completed":
      return {
        label: "Done",
        chipClassName: "border-emerald-400/15 bg-emerald-500/[0.06] text-emerald-300/90",
        icon: <CheckCircle size={12} weight="fill" className="text-emerald-400" />,
        accentColor: "emerald",
      };
    case "failed":
      return {
        label: "Failed",
        chipClassName: "border-red-500/20 bg-red-500/[0.08] text-red-300/90",
        icon: <XCircle size={12} weight="fill" className="text-red-400" />,
        accentColor: "red",
      };
    case "stopped":
      return {
        label: "Stopped",
        chipClassName: "border-amber-400/20 bg-amber-500/[0.08] text-amber-300/90",
        icon: <ClockCounterClockwise size={12} weight="bold" className="text-amber-400" />,
        accentColor: "amber",
      };
    default:
      return {
        label: "Running",
        chipClassName: "border-emerald-400/20 bg-emerald-500/[0.08] text-emerald-300",
        icon: <ChatStatusGlyph status="working" size={12} className="ade-glow-pulse" />,
        accentColor: "emerald",
      };
  }
}

function previewText(snapshot: ChatSubagentSnapshot): string {
  if (snapshot.summary?.trim()) return snapshot.summary.trim();
  if (snapshot.status === "running") {
    if (snapshot.lastToolName?.trim()) {
      return `Running. Last tool: ${snapshot.lastToolName.trim()}.`;
    }
    return "Running. Waiting for the next progress update.";
  }
  return "No summary was returned for this subagent.";
}

function PreviewCard({
  snapshot,
  onDismiss,
  onInterruptTurn,
}: {
  snapshot: ChatSubagentSnapshot;
  onDismiss?: () => void;
  onInterruptTurn?: () => void;
}) {
  const meta = statusMeta(snapshot.status);
  const runtimeSummary = summarizeRuntime(snapshot);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(snapshot.taskId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [snapshot.taskId]);

  return (
    <div className="w-[min(30rem,calc(100vw-3rem))] overflow-hidden rounded-xl border border-white/[0.06] bg-[#141220]/80 shadow-[0_24px_80px_-20px_rgba(0,0,0,0.9)]">
      {/* Accent top bar */}
      <div className={cn(
        "h-px w-full",
        meta.accentColor === "emerald" && "bg-gradient-to-r from-transparent via-emerald-400/30 to-transparent",
        meta.accentColor === "red" && "bg-gradient-to-r from-transparent via-red-400/30 to-transparent",
        meta.accentColor === "amber" && "bg-gradient-to-r from-transparent via-amber-400/30 to-transparent",
        meta.accentColor === "violet" && "bg-gradient-to-r from-transparent via-violet-400/30 to-transparent",
      )} />

      {/* Header */}
      <div className="flex items-start justify-between gap-3 px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            {meta.icon}
            <span className="truncate text-[13px] font-medium tracking-[-0.01em] text-fg/90">
              {snapshot.description}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className={cn(
              "inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em]",
              meta.chipClassName,
            )}>
              {meta.label}
            </span>
            {snapshot.background ? (
              <span className="inline-flex items-center rounded-md border border-sky-400/12 bg-sky-500/[0.06] px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-sky-300/60">
                Background
              </span>
            ) : null}
            {runtimeSummary ? (
              <span className="text-[10px] text-fg/40 font-mono">{runtimeSummary}</span>
            ) : null}
          </div>
        </div>
        {onDismiss ? (
          <button
            type="button"
            className="rounded-md border border-white/[0.06] px-2 py-1 font-mono text-[9px] uppercase tracking-[0.14em] text-fg/35 transition-all hover:border-white/[0.12] hover:text-fg/65"
            onClick={onDismiss}
          >
            Close
          </button>
        ) : null}
      </div>

      {/* Body */}
      <div className="border-t border-white/[0.04] px-4 py-3.5">
        <div className="rounded-lg border border-white/[0.04] bg-black/30 px-3.5 py-3 text-[12px] leading-[1.7] text-fg/65">
          {previewText(snapshot)}
        </div>
      </div>

      {/* Footer */}
      <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.04] px-4 py-2.5">
        <span className="font-mono text-[9px] text-fg/25 select-all">{snapshot.taskId}</span>
        {snapshot.status === "running" && snapshot.lastToolName?.trim() ? (
          <span className="rounded-md border border-white/[0.05] bg-white/[0.02] px-1.5 py-0.5 font-mono text-[9px] text-fg/35">
            {snapshot.lastToolName.trim()}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-white/[0.06] px-2 py-1 font-mono text-[9px] text-fg/35 transition-all hover:border-white/[0.12] hover:text-fg/60"
            onClick={handleCopy}
            title="Copy agent id"
          >
            <Copy size={10} />
            {copied ? "Copied" : "Copy id"}
          </button>
          {snapshot.status === "running" && onInterruptTurn ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md border border-red-500/15 bg-red-500/[0.04] px-2 py-1 font-mono text-[9px] text-red-300/70 transition-all hover:bg-red-500/[0.08] hover:text-red-200"
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

export function ChatSubagentStrip({
  snapshots,
  placement = "composer",
  onInterruptTurn,
  className,
}: {
  snapshots: ChatSubagentSnapshot[];
  placement?: "composer" | "read-only";
  onInterruptTurn?: () => void;
  className?: string;
}) {
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null);
  const [pinnedTaskId, setPinnedTaskId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const visibleSnapshots = useMemo(
    () => (expanded ? snapshots : snapshots.slice(0, 6)),
    [snapshots, expanded],
  );
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
  const pinned = useMemo(
    () => snapshots.find((s) => s.taskId === pinnedTaskId) ?? null,
    [pinnedTaskId, snapshots],
  );
  const hovered = useMemo(
    () => snapshots.find((s) => s.taskId === hoveredTaskId) ?? null,
    [hoveredTaskId, snapshots],
  );
  const summaryText = useMemo(() => {
    const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
    const parts: string[] = [plural(activeCount, "active agent")];
    if (backgroundRunningCount > 0) parts.push(`${backgroundRunningCount} background`);
    if (completedCount > 0) parts.push(`${completedCount} done`);
    if (stoppedCount > 0) parts.push(`${stoppedCount} stopped`);
    if (failedCount > 0) parts.push(`${failedCount} failed`);
    return parts.join(" \u00b7 ");
  }, [activeCount, backgroundRunningCount, completedCount, failedCount, stoppedCount]);

  if (!snapshots.length) return null;

  return (
    <div className={cn("relative", className)}>
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
          expanded
            ? "border-white/[0.12] bg-white/[0.04]"
            : "border-white/[0.05] bg-white/[0.015] hover:border-white/[0.08] hover:bg-white/[0.03]",
        )}
        onClick={() => setExpanded((v) => !v)}
        title="Show or hide subagent details"
      >
        <div className="flex items-center gap-2">
          <TreeStructure size={12} weight="bold" className="text-violet-400/45" />
          <span className="font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-fg/30">
            Agents
          </span>
        </div>
        <div className="min-w-0 flex-1 truncate text-[11px] text-fg/58">
          {summaryText}
        </div>
        {backgroundRunningCount > 0 ? (
          <span className="rounded-full border border-sky-400/10 bg-sky-500/[0.04] px-2 py-0.5 font-mono text-[9px] text-sky-300/65">
            {backgroundRunningCount} bg
          </span>
        ) : null}
        {snapshots.length > 6 ? (
          <span className="font-mono text-[9px] text-fg/25">
            +{snapshots.length - 6} more
          </span>
        ) : null}
        <ArrowsOutSimple size={10} className={cn("text-fg/30 transition-transform", expanded ? "rotate-45" : "")} />
      </button>

      {expanded ? (
        <div className="relative px-1.5 pt-2">
          {hovered && !pinned ? (
            <div className={cn(
              "absolute left-3 z-30",
              placement === "composer" ? "bottom-full mb-2" : "top-full mt-2",
            )}>
              <PreviewCard snapshot={hovered} onInterruptTurn={onInterruptTurn} />
            </div>
          ) : null}

          <div className="space-y-1.5">
            {visibleSnapshots.map((snapshot) => {
              const meta = statusMeta(snapshot.status);
              const runtimeSummary = summarizeRuntime(snapshot);
              const active = pinnedTaskId === snapshot.taskId;

              return (
                <button
                  key={snapshot.taskId}
                  type="button"
                  className={cn(
                    "group flex w-full items-center gap-2 rounded-xl border p-3 text-left transition-colors",
                    active
                      ? "border-white/[0.12] bg-[#141220]"
                      : "border-white/[0.06] bg-[#141220]/80 hover:border-white/[0.1] hover:bg-[#141220]",
                  )}
                  onMouseEnter={() => setHoveredTaskId(snapshot.taskId)}
                  onMouseLeave={() => setHoveredTaskId((cur) => (cur === snapshot.taskId ? null : cur))}
                  onFocus={() => setHoveredTaskId(snapshot.taskId)}
                  onBlur={() => setHoveredTaskId((cur) => (cur === snapshot.taskId ? null : cur))}
                  onClick={() => setPinnedTaskId((cur) => (cur === snapshot.taskId ? null : snapshot.taskId))}
                  title={snapshot.description}
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-white/[0.05] bg-white/[0.02]">
                    {meta.icon}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-fg/72 group-hover:text-fg/88">
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

          {pinned ? (
            <div className="pt-2">
              <PreviewCard
                snapshot={pinned}
                onDismiss={() => setPinnedTaskId(null)}
                onInterruptTurn={onInterruptTurn}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {!expanded && pinned ? (
        <div className="px-1.5 pt-2">
          <PreviewCard
            snapshot={pinned}
            onDismiss={() => setPinnedTaskId(null)}
            onInterruptTurn={onInterruptTurn}
          />
        </div>
      ) : null}
    </div>
  );
}
