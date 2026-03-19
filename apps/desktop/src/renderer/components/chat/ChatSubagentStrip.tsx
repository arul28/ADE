import { useMemo, useState } from "react";
import {
  CheckCircle,
  ClockCounterClockwise,
  Copy,
  SpinnerGap,
  XCircle,
} from "@phosphor-icons/react";
import { cn } from "../ui/cn";
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
  return parts.length ? parts.join(" • ") : null;
}

function statusMeta(status: ChatSubagentSnapshot["status"]): {
  label: string;
  chipClassName: string;
  icon: JSX.Element;
} {
  switch (status) {
    case "completed":
      return {
        label: "Completed",
        chipClassName: "border-emerald-400/18 bg-emerald-500/[0.08] text-emerald-200",
        icon: <CheckCircle size={12} weight="bold" className="text-emerald-300" />,
      };
    case "failed":
      return {
        label: "Failed",
        chipClassName: "border-red-500/18 bg-red-500/[0.08] text-red-200",
        icon: <XCircle size={12} weight="bold" className="text-red-300" />,
      };
    case "stopped":
      return {
        label: "Stopped",
        chipClassName: "border-amber-400/18 bg-amber-500/[0.08] text-amber-200",
        icon: <ClockCounterClockwise size={12} weight="bold" className="text-amber-300" />,
      };
    default:
      return {
        label: "Running",
        chipClassName: "border-sky-400/18 bg-sky-500/[0.08] text-sky-200",
        icon: <SpinnerGap size={12} weight="bold" className="animate-spin text-sky-300" />,
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

  return (
    <div className="w-[min(28rem,calc(100vw-3rem))] rounded-xl border border-white/[0.08] bg-[#111114] shadow-[0_20px_60px_-28px_rgba(0,0,0,0.8)]">
      <div className="flex items-start justify-between gap-3 border-b border-white/[0.05] px-3.5 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {meta.icon}
            <span className="truncate text-[12px] font-medium text-fg/86">{snapshot.description}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className={cn("inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em]", meta.chipClassName)}>
              {meta.label}
            </span>
            {runtimeSummary ? (
              <span className="font-mono text-[10px] text-fg/44">{runtimeSummary}</span>
            ) : null}
          </div>
        </div>
        {onDismiss ? (
          <button
            type="button"
            className="rounded-md border border-white/[0.06] px-2 py-1 font-mono text-[9px] uppercase tracking-[0.16em] text-fg/40 transition-colors hover:text-fg/72"
            onClick={onDismiss}
          >
            Close
          </button>
        ) : null}
      </div>
      <div className="space-y-3 px-3.5 py-3">
        <div className="rounded-lg border border-white/[0.05] bg-black/20 px-3 py-2.5 text-[12px] leading-[1.6] text-fg/72">
          {previewText(snapshot)}
        </div>
        <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] text-fg/42">
          <span>Task {snapshot.taskId}</span>
          {snapshot.status === "running" && snapshot.lastToolName?.trim() ? (
            <span>Tool {snapshot.lastToolName.trim()}</span>
          ) : null}
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-white/[0.06] px-2 py-1 transition-colors hover:text-fg/70"
            onClick={() => {
              if (typeof navigator !== "undefined" && navigator.clipboard) {
                void navigator.clipboard.writeText(snapshot.taskId);
              }
            }}
            title="Copy subagent id"
          >
            <Copy size={10} />
            Copy id
          </button>
          {snapshot.status === "running" && onInterruptTurn ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md border border-red-500/18 bg-red-500/[0.05] px-2 py-1 text-red-200 transition-colors hover:bg-red-500/[0.1]"
              onClick={onInterruptTurn}
            >
              <XCircle size={10} />
              Interrupt turn
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

  const visibleSnapshots = useMemo(() => snapshots.slice(0, 8), [snapshots]);
  const activeCount = useMemo(() => snapshots.filter((snapshot) => snapshot.status === "running").length, [snapshots]);
  const pinned = useMemo(() => snapshots.find((snapshot) => snapshot.taskId === pinnedTaskId) ?? null, [pinnedTaskId, snapshots]);
  const hovered = useMemo(() => snapshots.find((snapshot) => snapshot.taskId === hoveredTaskId) ?? null, [hoveredTaskId, snapshots]);

  if (!snapshots.length) return null;

  return (
    <div className={cn("relative space-y-2", className)}>
      <div className="flex items-center gap-2 px-3 pt-2">
        <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-fg/34">
          Subagents
        </div>
        <div className="font-mono text-[10px] text-fg/42">
          {activeCount > 0 ? `${activeCount} running` : `${snapshots.length} recent`}
        </div>
      </div>
      <div className="relative px-3 pb-1">
        {hovered && !pinned ? (
          <div className={cn("absolute left-3 z-20", placement === "composer" ? "bottom-full mb-2" : "top-full mt-2")}>
            <PreviewCard snapshot={hovered} onInterruptTurn={onInterruptTurn} />
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {visibleSnapshots.map((snapshot) => {
            const meta = statusMeta(snapshot.status);
            const runtimeSummary = summarizeRuntime(snapshot);
            const active = pinnedTaskId === snapshot.taskId;

            return (
              <button
                key={snapshot.taskId}
                type="button"
                className={cn(
                  "inline-flex max-w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors",
                  active ? "border-white/[0.14] bg-white/[0.06]" : "border-white/[0.07] bg-white/[0.02] hover:border-white/[0.12] hover:bg-white/[0.04]",
                )}
                onMouseEnter={() => setHoveredTaskId(snapshot.taskId)}
                onMouseLeave={() => setHoveredTaskId((current) => (current === snapshot.taskId ? null : current))}
                onClick={() => setPinnedTaskId((current) => (current === snapshot.taskId ? null : snapshot.taskId))}
                title={snapshot.description}
              >
                {meta.icon}
                <span className="max-w-[16rem] truncate text-[11px] text-fg/74">{snapshot.description}</span>
                {runtimeSummary ? (
                  <span className="font-mono text-[9px] text-fg/35">{runtimeSummary}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
      {pinned ? (
        <div className="px-3 pb-2">
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
