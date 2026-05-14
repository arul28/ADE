import { useCallback, useMemo, useState } from "react";
import {
  ArrowLeft,
  CheckCircle,
  ClockCounterClockwise,
  Copy,
  X,
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
  const elapsedMs = snapshot.usage?.durationMs
    ?? Math.max(0, Date.parse(snapshot.updatedAt) - Date.parse(snapshot.startedAt));
  const tokenText = formatTokenCount(snapshot.usage?.totalTokens);
  const durationText = formatDurationMs(elapsedMs);
  const parts = [
    tokenText ? `${tokenText} tok` : null,
    durationText,
    snapshot.usage?.toolUses ? `${snapshot.usage.toolUses} tool${snapshot.usage.toolUses === 1 ? "" : "s"}` : null,
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
        chipClassName: "border-emerald-400/15 text-emerald-300/90",
        icon: <CheckCircle size={12} weight="fill" className="text-emerald-400" />,
      };
    case "failed":
      return {
        label: "Failed",
        chipClassName: "border-red-500/20 text-red-300/90",
        icon: <XCircle size={12} weight="fill" className="text-red-400" />,
      };
    case "stopped":
      return {
        label: "Stopped",
        chipClassName: "border-amber-400/20 text-amber-300/90",
        icon: <ClockCounterClockwise size={12} weight="bold" className="text-amber-400" />,
      };
    default:
      return {
        label: "Running",
        chipClassName: "border-emerald-400/20 text-emerald-300",
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
  const copyId = snapshot.agentId ?? snapshot.taskId;

  const visibleTimeline = showAll ? timeline : timeline.slice(-MAX_VISIBLE_TIMELINE);
  const hiddenCount = timeline.length - visibleTimeline.length;

  const handleCopy = useCallback(() => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(copyId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [copyId]);

  return (
    <div className="flex flex-col">
      {/* Back button + header */}
      <div className="flex items-center gap-2.5 px-3 py-2 border-b border-white/[0.06]">
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-fg/40 transition-colors hover:bg-white/[0.04] hover:text-fg/70"
          onClick={onBack}
        >
          <ArrowLeft size={12} weight="bold" />
          Back
        </button>
        <span className="min-w-0 flex-1 truncate text-[13px] text-fg/70">
          {snapshot.description}
        </span>
        <span className={cn(
          "ade-chat-status-pill rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
          meta.chipClassName,
        )}>
          {meta.label}
        </span>
      </div>

      {/* Runtime stats */}
      {runtimeSummary || snapshot.background || snapshot.agentType ? (
        <div className="flex items-center gap-2 px-3 py-1.5">
          {snapshot.agentType ? (
            <span className="rounded border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[9px] text-fg/35">
              {snapshot.agentType}
            </span>
          ) : null}
          {snapshot.background ? (
            <span className="rounded border border-sky-400/12 bg-sky-500/[0.06] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-sky-300/55">
              bg
            </span>
          ) : null}
          {runtimeSummary ? (
            <span className="text-[11px] text-fg/40">{runtimeSummary}</span>
          ) : null}
        </div>
      ) : null}

      {snapshot.finalSummary ? (
        <div className="mx-3 mt-2 rounded-md border border-emerald-400/10 bg-emerald-500/[0.035] px-2.5 py-2 text-[12px] text-emerald-100/65">
          {snapshot.finalSummary}
        </div>
      ) : null}

      {/* Activity timeline */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {hiddenCount > 0 && (
          <button
            type="button"
            className="mb-2 text-[11px] text-fg/30 transition-colors hover:text-fg/50"
            onClick={() => setShowAll(true)}
          >
            Show {hiddenCount} earlier event{hiddenCount !== 1 ? "s" : ""}
          </button>
        )}

        {visibleTimeline.length === 0 ? (
          <div className="py-4 text-center text-[12px] text-fg/25">
            No activity recorded yet
          </div>
        ) : (
          <div className="space-y-0.5 border-l border-white/[0.06] ml-1 pl-3">
            {visibleTimeline.map((entry, index) => (
              <div key={`${entry.timestamp}-${index}`} className="flex items-start gap-2 py-0.5 relative before:absolute before:-left-3 before:top-[9px] before:h-px before:w-2 before:bg-white/[0.06]">
                <span className="shrink-0 font-mono text-[11px] text-fg/20 pt-px">
                  {formatTime(entry.timestamp)}
                </span>
                {entry.type === "started" ? (
                  <span className="text-[12px] text-fg/40">Started</span>
                ) : entry.type === "result" ? (
                  <div className="min-w-0 flex-1">
                    <span className={cn(
                      "text-[12px] font-medium",
                      entry.status === "completed" ? "text-emerald-300/70" :
                      entry.status === "failed" ? "text-red-300/70" :
                      "text-amber-300/70",
                    )}>
                      {entry.status === "completed" ? "Completed" : entry.status === "failed" ? "Failed" : "Stopped"}
                    </span>
                    {entry.summary ? (
                      <p className="mt-0.5 truncate text-[12px] text-fg/45">{entry.summary}</p>
                    ) : null}
                  </div>
                ) : (
                  <div className="min-w-0 flex-1">
                    {entry.lastToolName ? (
                      <span className="font-mono text-[12px] text-fg/45">{entry.lastToolName}</span>
                    ) : null}
                    {entry.summary ? (
                      <p className={cn(
                        "truncate text-[12px] text-fg/35",
                        entry.lastToolName && "mt-0.5",
                      )}>
                        {entry.summary}
                      </p>
                    ) : null}
                    {!entry.lastToolName && !entry.summary ? (
                      <span className="text-[12px] text-fg/25">Working...</span>
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
        <span className="select-all font-mono text-[10px] text-fg/20">{copyId}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-white/[0.06] px-2 py-0.5 text-[11px] text-fg/30 transition-all hover:border-white/[0.12] hover:text-fg/55"
            onClick={handleCopy}
            title="Copy agent id"
          >
            <Copy size={10} />
            {copied ? "Copied" : "Copy id"}
          </button>
          {snapshot.status === "running" && onInterruptTurn ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md border border-red-500/15 bg-red-500/[0.04] px-2 py-0.5 text-[11px] text-red-300/70 transition-all hover:bg-red-500/[0.08] hover:text-red-200"
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

type SubagentPanelTab = "subagents" | "teammates" | "background";

function tabLabel(tab: SubagentPanelTab): string {
  if (tab === "subagents") return "Subagents";
  if (tab === "teammates") return "Teammates";
  if (tab === "background") return "Background";
  return "Subagents";
}

export function ChatSubagentsPanel({
  snapshots,
  events,
  onInterruptTurn,
  className,
  variant = "drawer",
  onClose,
}: {
  snapshots: ChatSubagentSnapshot[];
  events: AgentChatEventEnvelope[];
  onInterruptTurn?: () => void;
  className?: string;
  variant?: "drawer" | "pane";
  onClose?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<{ mode: "list" } | { mode: "detail"; taskId: string }>({ mode: "list" });
  const [selectedTab, setSelectedTab] = useState<SubagentPanelTab>("subagents");

  const { activeCount, completedCount, failedCount, stoppedCount, backgroundRunningCount, tabCounts } = useMemo(() => {
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
    return {
      activeCount: active,
      completedCount: completed,
      failedCount: failed,
      stoppedCount: stopped,
      backgroundRunningCount: bgRunning,
      tabCounts: {
        subagents: snapshots.filter((s) => !s.background).length,
        teammates: 0,
        background: snapshots.filter((s) => s.background).length,
      },
    };
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

  // When only one category has content (e.g. Codex never emits Teammates and
  // often only emits non-background subagents), drop the tab strip so the
  // panel reads as a single labeled section instead of one lit-up tab next
  // to two empty ones.
  const nonEmptyTabs = (["subagents", "teammates", "background"] as SubagentPanelTab[])
    .filter((tab) => tabCounts[tab] > 0);
  const singleNonEmptyTab = nonEmptyTabs.length === 1 ? nonEmptyTabs[0] : null;
  const activeTab = singleNonEmptyTab ?? selectedTab;
  const visibleSnapshots = snapshots.filter((snapshot) => {
    if (activeTab === "subagents") return !snapshot.background;
    if (activeTab === "teammates") return false;
    if (activeTab === "background") return snapshot.background === true;
    return true;
  });

  const tabs: SubagentPanelTab[] = ["subagents", "teammates", "background"];
  const tabControls = singleNonEmptyTab ? (
    <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 py-2 text-[11px] font-medium text-fg/65">
      <span>{tabLabel(singleNonEmptyTab)}</span>
      <span className="rounded-full bg-white/[0.04] px-1.5 py-px font-mono text-[9px] text-fg/45">
        {tabCounts[singleNonEmptyTab]}
      </span>
    </div>
  ) : (
    <div className="flex shrink-0 items-center gap-1 border-b border-white/[0.06] px-2 py-1.5">
      {tabs.map((tab) => (
        <button
          key={tab}
          type="button"
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors",
            activeTab === tab
              ? "bg-white/[0.075] text-fg/78"
              : "text-fg/35 hover:bg-white/[0.04] hover:text-fg/58",
          )}
          onClick={() => {
            setSelectedTab(tab);
            setView({ mode: "list" });
          }}
        >
          <span>{tabLabel(tab)}</span>
          <span className={cn(
            "rounded-full px-1.5 py-px font-mono text-[9px]",
            activeTab === tab ? "bg-black/20 text-fg/55" : "bg-white/[0.04] text-fg/28",
          )}>
            {tabCounts[tab]}
          </span>
        </button>
      ))}
    </div>
  );

  const listContent = (
    <div className={cn(
      "space-y-1.5 px-1.5 py-1.5",
      variant === "pane" && "min-h-0 flex-1 overflow-y-auto px-2.5 py-2.5",
    )}>
      {visibleSnapshots.length ? visibleSnapshots.map((snapshot) => {
        const meta = statusMeta(snapshot.status);
        const runtimeSummary = summarizeRuntime(snapshot);
        const agentName = snapshot.agentType || snapshot.agentId || snapshot.taskId;
        const description = snapshot.description && snapshot.description !== agentName ? snapshot.description : null;

        return (
          <button
            key={snapshot.taskId}
            type="button"
            className={cn(
              "ade-chat-subagent-card group flex w-full items-center gap-2.5 rounded-xl px-3.5 py-3 text-left",
              snapshot.status === "running" && "ade-chat-subagent-card-active",
            )}
            onClick={() => setView({ mode: "detail", taskId: snapshot.taskId })}
            title={snapshot.description}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              {meta.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-fg/65 group-hover:text-fg/85">
                {agentName}
              </span>
              {description ? (
                <span className="mt-0.5 block truncate text-[11px] text-fg/35">
                  {description}
                </span>
              ) : null}
              {snapshot.finalSummary ? (
                <span className="mt-1 block truncate text-[11px] text-emerald-200/55">
                  ┊ {snapshot.finalSummary}
                </span>
              ) : snapshot.summary ? (
                <span className="mt-1 block truncate text-[11px] text-fg/32">
                  ▎ {snapshot.summary}
                </span>
              ) : null}
            </span>
            {snapshot.agentType ? (
              <span className="rounded border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[9px] text-fg/35">
                {snapshot.agentType}
              </span>
            ) : null}
            {snapshot.background ? (
              <span className="rounded border border-sky-400/12 bg-sky-500/[0.06] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-sky-300/55">
                bg
              </span>
            ) : null}
            {runtimeSummary ? (
              <span className="text-[11px] text-fg/40 group-hover:text-fg/50">
                {runtimeSummary}
              </span>
            ) : null}
            <span className={cn("ade-chat-status-pill rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider", meta.chipClassName)}>
              {meta.label}
            </span>
          </button>
        );
      }) : (
        <div className="flex h-24 items-center justify-center rounded-lg border border-white/[0.05] bg-white/[0.02] text-[12px] text-fg/28">
          {activeTab === "teammates" ? "No team active" : `No ${tabLabel(activeTab).toLowerCase()} subagents`}
        </div>
      )}
    </div>
  );

  const body = view.mode === "detail" && detailSnapshot ? (
    <SubagentDetailView
      snapshot={detailSnapshot}
      timeline={detailTimeline}
      onBack={() => setView({ mode: "list" })}
      onInterruptTurn={detailSnapshot.status === "running" ? onInterruptTurn : undefined}
    />
  ) : (
    <>
      {tabControls}
      {listContent}
    </>
  );

  if (variant === "pane") {
    return (
      <div className={cn("flex h-full min-h-0 flex-col", className)}>
        <div className="flex shrink-0 items-center gap-3 border-b border-white/[0.06] px-4 py-2.5">
          <TreeStructure size={14} className="text-fg/45" />
          <div className="min-w-0 flex-1">
            <div className="font-sans text-[12px] font-medium text-fg/80">Subagents</div>
            <div className="truncate text-[10px] text-fg/32">{summaryText}</div>
          </div>
          {onClose ? (
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-white/[0.06] bg-white/[0.03] text-fg/45 transition-colors hover:text-fg/80"
              onClick={onClose}
              title="Close subagents panel"
              aria-label="Close subagents panel"
            >
              <X size={12} weight="bold" />
            </button>
          ) : null}
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          {body}
        </div>
      </div>
    );
  }

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
      {body}
    </BottomDrawerSection>
  );
}
