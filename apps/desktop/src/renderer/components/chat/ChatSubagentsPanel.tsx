import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  CaretDown,
  CaretRight,
  Check,
  Circle,
  CircleHalf,
  Pause,
  Play,
  TreeStructure,
  X,
} from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import type { ChatScheduledWorkSnapshot, ChatSubagentSnapshot } from "./chatExecutionSummary";
import { derivePlan } from "./chatExecutionSummary";
import type { TodoItemSnapshot } from "./chatExecutionSummary";
import { ChatTaskList } from "./ChatTasksPanel";
import type { ChatInfoPlanStep } from "../../../shared/chatSubagents";
import { isBackgroundShellCommand } from "../../../shared/chatSubagents";
import { backgroundCommandCwd, backgroundCommandLabel, scheduledNextFireLabel } from "../../../shared/chatScheduledWork";
import type { AgentChatEventEnvelope, CodexThreadGoal } from "../../../shared/types";
import type { SubagentCapability } from "../../../shared/subagentCapabilities";
import { BottomDrawerSection } from "./BottomDrawerSection";
import { CodexGoalCard } from "./codex/CodexGoalCard";
import { ChatSubagentGlyph, chatSubagentColor, chatSubagentDisplayName } from "./chatSubagentIdentity";

/* ── Formatting helpers ── */

function formatDurationMs(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (value >= 60_000) return `${Math.round(value / 60_000)}m`;
  return `${Math.max(1, Math.round(value / 1000))}s`;
}

const GLYPH_SIZE = 16;

type GlyphCategory = "subagent" | "background";

function PlanGlyph({ status }: { status: ChatInfoPlanStep["status"] }) {
  if (status === "completed") {
    return <Check aria-hidden size={GLYPH_SIZE} weight="bold" className="text-emerald-300/90" />;
  }
  if (status === "in_progress") {
    return (
      <CircleHalf
        aria-hidden
        size={GLYPH_SIZE}
        weight="fill"
        className="text-[color:var(--color-accent,#A78BFA)] motion-safe:ade-glow-pulse"
      />
    );
  }
  if (status === "failed") {
    return <X aria-hidden size={GLYPH_SIZE} weight="bold" className="text-rose-300/85" />;
  }
  return <Circle aria-hidden size={GLYPH_SIZE} weight="regular" className="text-fg/30" />;
}

/* ── Section header — sentence case, paper-section feel ── */

type SectionTone = "subagent" | "background" | "workflow" | "scheduled" | "neutral";

const SECTION_DOT_CLASS: Record<SectionTone, string> = {
  subagent: "bg-[color:var(--color-accent,#A78BFA)]/70",
  background: "bg-cyan-300/65",
  workflow: "bg-amber-300/65",
  scheduled: "bg-sky-300/65",
  neutral: "bg-fg/30",
};

function SectionHeader({
  label,
  hint,
  action,
  tone = "neutral",
  emphasized = false,
}: {
  label: string;
  hint?: string;
  action?: ReactNode;
  tone?: SectionTone;
  emphasized?: boolean;
}) {
  return (
    <div className={cn("flex items-center justify-between px-3.5", emphasized ? "pb-1.5 pt-3" : "pb-1 pt-2.5")}>
      <span
        className={cn(
          "flex items-center gap-1.5 font-sans uppercase tracking-[0.06em] text-fg/45",
          emphasized ? "text-[10.5px] font-medium" : "text-[10px] font-medium",
        )}
      >
        <span
          aria-hidden
          className={cn("inline-block h-1 w-1 rounded-full", SECTION_DOT_CLASS[tone])}
        />
        {label}
      </span>
      <span className="flex items-center gap-1.5">
        {hint ? (
          <span className="font-sans text-[10.5px] tabular-nums text-fg/35">
            {hint}
          </span>
        ) : null}
        {action}
      </span>
    </div>
  );
}

/* ── Progress bar — 1 px hairline rule ── */

function ProgressBar({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="mx-4 mb-1 h-px rounded-full bg-white/[0.05]">
      <div
        className="h-px rounded-full bg-[color:var(--color-accent,#A78BFA)]/55 transition-[width] duration-500 ease-out"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

/* ── Row ──
 *
 * Codex-style compact list row: per-agent identicon glyph on the left, name,
 * then status + elapsed time on the right. No card chrome, no saturated fill —
 * the row hugs its content with only a faint hover wash. Selection is a subtle
 * violet ring/tint, nothing more.
 */

const STATUS_LABEL: Record<ChatSubagentSnapshot["status"], string> = {
  running: "running",
  completed: "done",
  failed: "failed",
  stopped: "halted",
};

// Elapsed-time chip for the right rail — duration only (no tool/token noise),
// so the compact row stays scannable.
function elapsedText(snapshot: ChatSubagentSnapshot, nowMs?: number): string | null {
  const startedAt = Date.parse(snapshot.startedAt);
  const updatedAt = Date.parse(snapshot.updatedAt);
  const liveElapsedMs = snapshot.status === "running" && Number.isFinite(startedAt) && typeof nowMs === "number"
    ? Math.max(0, nowMs - startedAt)
    : null;
  const elapsedMs = snapshot.usage?.durationMs
    ?? liveElapsedMs
    ?? Math.max(0, updatedAt - startedAt);
  return formatDurationMs(elapsedMs);
}

// A runtime can emit more than one *kind* of subagent (Claude surfaces five via
// `taskType`). They all live in one list; a small chip discriminates the
// non-default kinds so the consolidation stays legible. `subagent` (the default)
// and `background` (its own section) get no chip. Workflow runs prefer their
// workflow name, which the row renders separately.
function kindBadge(snapshot: ChatSubagentSnapshot): string | null {
  if (snapshot.workflowName) return null; // workflowName chip covers this row
  switch (snapshot.taskType) {
    case "local_workflow":
      return "workflow";
    case "cron":
      return "scheduled";
    case "other":
      return "task";
    default:
      return null;
  }
}

const SCHEDULE_STATUS_LABEL: Record<ChatScheduledWorkSnapshot["status"], string> = {
  scheduled: "scheduled",
  paused: "paused",
  running: "running",
  fired: "fired",
  missed: "missed",
  completed: "done",
  cancelled: "cancelled",
  failed: "failed",
  stopped: "stopped",
};

function scheduledKindLabel(kind: ChatScheduledWorkSnapshot["kind"]): string {
  switch (kind) {
    case "wakeup":
      return "wakeup";
    case "cron":
      return "cron";
    case "loop":
      return "loop";
    case "remote_trigger":
      return "trigger";
    case "background_task":
      return "background";
  }
}

function scheduledDetail(snapshot: ChatScheduledWorkSnapshot): string | null {
  const parts = [
    snapshot.cron ? snapshot.cron : null,
    snapshot.reason ? snapshot.reason : null,
    snapshot.summary ? snapshot.summary : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" · ") : null;
}

function formatScheduleClock(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function ScheduledWorkRow({
  snapshot,
  schedulesPaused = false,
}: {
  snapshot: ChatScheduledWorkSnapshot;
  schedulesPaused?: boolean;
}) {
  const isPaused = schedulesPaused || snapshot.status === "paused";
  const isActive = snapshot.status === "running" || snapshot.status === "fired";
  const isProblem = snapshot.status === "failed" || snapshot.status === "missed";
  const isMuted = snapshot.status === "completed" || snapshot.status === "cancelled" || snapshot.status === "stopped";
  const detail = scheduledDetail(snapshot);
  const prompt = snapshot.prompt?.trim();
  // Relative next-fire label for cron/wakeup rows (e.g. "next in 3h · 9:00 AM").
  // Recomputed on a 30s tick so the countdown stays roughly fresh without churn.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (snapshot.kind !== "cron" && snapshot.kind !== "wakeup") return;
    if (isMuted) return;
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(intervalId);
  }, [snapshot.kind, isMuted]);
  const nextFire = isMuted ? null : scheduledNextFireLabel(snapshot, nowMs);
  const lastRun = snapshot.kind === "cron" ? formatScheduleClock(snapshot.lastRunAt) : null;
  const timing = [lastRun ? `last ran ${lastRun}` : null, nextFire]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return (
    <div
      data-paused={isPaused || undefined}
      className={cn(
        "group grid min-h-[42px] grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1.5",
        "transition-colors duration-150 hover:bg-white/[0.035]",
        isPaused && "opacity-45",
      )}
      title={prompt || detail || snapshot.title}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              isActive && "bg-sky-300/75 motion-safe:ade-glow-pulse",
              isProblem && "bg-rose-300/80",
              isMuted && "bg-fg/25",
              !isActive && !isProblem && !isMuted && "bg-sky-300/55",
            )}
          />
          <span
            className={cn(
              "min-w-0 truncate font-sans text-[12.5px] leading-5",
              isActive && "text-sky-100/90",
              isProblem && "text-rose-200/85",
              isMuted && "text-fg/45",
              isPaused && "text-fg/45",
              !isActive && !isProblem && !isMuted && "text-fg/70",
            )}
          >
            {snapshot.title}
          </span>
          <span className="shrink-0 rounded-sm bg-white/[0.05] px-1 py-px font-sans text-[9.5px] uppercase tracking-[0.05em] text-fg/40">
            {scheduledKindLabel(snapshot.kind)}
          </span>
        </div>
        {detail || prompt ? (
          <div className="min-w-0 truncate pl-3.5 font-sans text-[10.5px] leading-4 text-fg/38">
            {detail ?? prompt}
          </div>
        ) : null}
        {timing ? (
          <div className="min-w-0 truncate pl-3.5 font-sans text-[10px] leading-4 text-sky-300/45">
            {timing}
          </div>
        ) : null}
      </div>
      <span
        className={cn(
          "shrink-0 font-sans text-[10.5px] tabular-nums",
          isActive && "text-sky-300/75",
          isProblem && "text-rose-300/75",
          isMuted && "text-fg/35",
          !isActive && !isProblem && !isMuted && "text-fg/45",
        )}
      >
        {isPaused ? "paused" : SCHEDULE_STATUS_LABEL[snapshot.status]}
      </span>
    </div>
  );
}

function ScheduleHistoryRow({ snapshot }: { snapshot: ChatScheduledWorkSnapshot }) {
  const firedAt = formatScheduleClock(
    snapshot.firedAt ?? snapshot.lastRunAt ?? snapshot.updatedAt,
  );
  const parts = [
    `✓ ${snapshot.title}`,
    firedAt ? `fired ${firedAt}` : "fired",
    snapshot.late ? "late" : null,
  ].filter((part): part is string => Boolean(part));

  return (
    <div
      className="min-w-0 truncate rounded-md px-2 py-1.5 font-sans text-[11px] leading-5 text-fg/45"
      title={snapshot.prompt?.trim() || snapshot.reason?.trim() || snapshot.title}
    >
      {parts.join(" · ")}
    </div>
  );
}

// Duration between two ISO timestamps, formatted compactly (or null).
function backgroundDurationLabel(snapshot: ChatScheduledWorkSnapshot): string | null {
  const start = Date.parse(snapshot.createdAt);
  const end = Date.parse(snapshot.updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return formatDurationMs(end - start);
}

/**
 * Background command row: `$ <smart label>` + status. Expands (click) to reveal
 * the full original command in monospace, prefixed by a dim cwd chip when the
 * command carries a leading `cd <path> &&`. Terminal rows render their final
 * state (the backend now guarantees terminal events arrive).
 */
function BackgroundCommandRow({ snapshot }: { snapshot: ChatScheduledWorkSnapshot }) {
  const [expanded, setExpanded] = useState(false);
  const rawCommand = (snapshot.title || snapshot.prompt || snapshot.summary || "").trim();
  const label = backgroundCommandLabel(rawCommand) || rawCommand || "Background command";
  const cwd = backgroundCommandCwd(rawCommand);
  const duration = backgroundDurationLabel(snapshot);
  const isRunning = snapshot.status === "running" || snapshot.status === "fired";
  const isProblem = snapshot.status === "failed" || snapshot.status === "missed";
  const isMuted = snapshot.status === "completed" || snapshot.status === "cancelled" || snapshot.status === "stopped";

  return (
    <div className="rounded-md transition-colors duration-150 hover:bg-white/[0.035]">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1.5 px-2 py-1.5 text-left"
        title={rawCommand || label}
      >
        <span aria-hidden className="shrink-0 text-fg/30">
          {expanded ? <CaretDown size={11} weight="bold" /> : <CaretRight size={11} weight="bold" />}
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden className="shrink-0 font-mono text-[11px] text-cyan-300/55">$</span>
          <span className="min-w-0 truncate font-mono text-[11.5px] leading-5 text-fg/70">{label}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 font-sans text-[10.5px] tabular-nums">
          {duration ? <span className="text-fg/35">{duration}</span> : null}
          <span
            className={cn(
              "tracking-[0.01em]",
              isRunning && "text-cyan-300/70",
              isProblem && "text-rose-300/70",
              isMuted && "text-fg/35",
              !isRunning && !isProblem && !isMuted && "text-fg/45",
            )}
          >
            {SCHEDULE_STATUS_LABEL[snapshot.status]}
          </span>
        </span>
      </button>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="bg-command-details"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="mx-2 mb-1 mt-0.5 space-y-1 rounded-md bg-white/[0.025] px-2.5 py-2">
              {cwd ? (
                <span className="inline-block rounded-sm bg-white/[0.05] px-1.5 py-px font-mono text-[10px] text-fg/45">
                  {cwd}
                </span>
              ) : null}
              <div className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-fg/60">
                {rawCommand || label}
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function SubagentRow({
  snapshot,
  selected,
  category,
  expanded,
  probing,
  canViewFullTranscript,
  onClick,
}: {
  snapshot: ChatSubagentSnapshot;
  selected: boolean;
  category: GlyphCategory;
  expanded: boolean;
  /** True while we're checking whether this agent has a pullable transcript. */
  probing: boolean;
  /** Whether this runtime can surface a full child transcript (drives the
   * drawer's "transcript not ready yet" vs "live details only" footer). */
  canViewFullTranscript: boolean;
  onClick: () => void;
}) {
  const name = chatSubagentDisplayName(snapshot);
  const kindLabel = kindBadge(snapshot);
  const color = chatSubagentColor(snapshot.agentId ?? snapshot.taskId);
  const isRunning = snapshot.status === "running";
  const isCompleted = snapshot.status === "completed";
  const isStopped = snapshot.status === "stopped";
  const isFailed = snapshot.status === "failed";
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning) return;
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [isRunning]);
  const time = elapsedText(snapshot, nowMs);
  const statusLabel = STATUS_LABEL[snapshot.status];
  const runningLabelTint = category === "background"
    ? "text-cyan-100/90"
    : "text-[color:var(--color-accent-bright,#C4B5FD)]";

  // Tiny "what we know" facts for the inline drawer (agents without a pullable
  // transcript) — token usage + last tool, nothing heavy.
  const totalTokens = snapshot.usage?.totalTokens;
  const toolUses = snapshot.usage?.toolUses;
  const costUsd = snapshot.usage?.costUsd;
  const lastTool = snapshot.lastToolName?.trim();
  // Latest progress/result text (e.g. Cursor's task `text`, OpenCode's diff
  // summary) — shown only when it adds something beyond the description.
  const summaryRaw = (snapshot.finalSummary ?? snapshot.summary)?.trim();
  const summaryText = summaryRaw && summaryRaw !== snapshot.description?.trim() ? summaryRaw : null;

  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        title={snapshot.description || "View subagent details"}
        data-selected={selected || undefined}
        className={cn(
          "group relative flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left",
          "transition-colors duration-150",
          "hover:bg-white/[0.04]",
          (selected || expanded)
            && "bg-[color:color-mix(in_srgb,var(--color-accent)_10%,transparent)] ring-1 ring-inset ring-[color:color-mix(in_srgb,var(--color-accent)_30%,transparent)]",
        )}
      >
        <ChatSubagentGlyph id={snapshot.agentId ?? snapshot.taskId} color={color} status={snapshot.status} />

        <span
          className={cn(
            "min-w-0 flex-1 truncate font-sans text-[12.5px] leading-5",
            isRunning && runningLabelTint,
            isFailed && "text-rose-200/85",
            isCompleted && "text-fg/55",
            isStopped && "text-fg/45",
            !isRunning && !isFailed && !isCompleted && !isStopped && "text-fg/75",
          )}
        >
          {name}
          {snapshot.background ? (
            <span className="ml-1.5 rounded-sm bg-cyan-300/[0.1] px-1 py-px font-sans text-[9.5px] uppercase tracking-[0.05em] text-cyan-200/70">
              background
            </span>
          ) : null}
          {snapshot.workflowName ? (
            <span className="ml-1.5 font-sans text-[11px] tracking-[0.01em] text-amber-300/55">
              {snapshot.workflowName}
            </span>
          ) : kindLabel ? (
            <span className="ml-1.5 rounded-sm bg-white/[0.05] px-1 py-px font-sans text-[9.5px] uppercase tracking-[0.05em] text-fg/40">
              {kindLabel}
            </span>
          ) : null}
        </span>

        <span className="flex shrink-0 items-center gap-1.5 font-sans text-[10.5px] tabular-nums">
          {probing ? (
            <span
              aria-hidden
              className="h-3 w-3 animate-spin rounded-full border border-fg/20 border-t-fg/55 [animation-duration:0.7s]"
            />
          ) : null}
          <span
            className={cn(
              "tracking-[0.01em]",
              isRunning && (category === "background" ? "text-cyan-300/70" : "text-[color:var(--color-accent,#A78BFA)]/80"),
              isFailed && "text-rose-300/70",
              isStopped && "text-amber-300/55",
              isCompleted && "text-fg/35",
            )}
          >
            {statusLabel}
          </span>
          {time ? <span className="text-fg/35 group-hover:text-fg/50">{time}</span> : null}
        </span>
      </button>

      {/* No pullable transcript → a tiny details drawer slides out beneath the
          row instead of taking over the chat with an empty page. */}
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="details-drawer"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="mx-2 mb-1 mt-0.5 space-y-1 rounded-md bg-white/[0.025] px-2.5 py-2 font-sans text-[10.5px] leading-4 text-fg/55">
              {snapshot.description ? (
                <div className="break-words text-fg/65">{snapshot.description}</div>
              ) : null}
              {summaryText ? (
                <div className="break-words text-fg/50">{summaryText}</div>
              ) : null}
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 tabular-nums text-fg/45">
                {typeof totalTokens === "number" && totalTokens > 0 ? <span>{totalTokens.toLocaleString()} tokens</span> : null}
                {typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd > 0 ? <span>${costUsd < 0.1 ? costUsd.toFixed(4) : costUsd.toFixed(2)}</span> : null}
                {typeof toolUses === "number" && toolUses > 0 ? <span>{toolUses} tool{toolUses === 1 ? "" : "s"}</span> : null}
                {lastTool ? <span>last: {lastTool}</span> : null}
                {time ? <span>{time}</span> : null}
              </div>
              {/* Honest, runtime-aware footer: capable runtimes whose transcript
                  isn't ready yet say so (it can appear on a later poll); runtimes
                  that never expose a child transcript (e.g. Cursor) don't pretend
                  one is missing — the drawer above IS the detail. */}
              {canViewFullTranscript ? (
                <div className="text-fg/30">
                  {snapshot.status === "running" ? "Transcript not ready yet." : "No transcript recorded for this agent."}
                </div>
              ) : (
                <div className="text-fg/30">Live details only — this runtime doesn't expose a full transcript.</div>
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/* ── Main component ── */

export type SubagentSelection = {
  taskId: string;
  agentId: string | null;
  agentType: string | null;
  status: ChatSubagentSnapshot["status"];
  background: boolean;
};

export function ChatSubagentsPanel({
  snapshots,
  events,
  onSelectSubagent,
  onClearSelectedSubagent,
  probeSubagentTranscript,
  capability = null,
  selectedTaskId,
  className,
  variant = "drawer",
  onClose,
  goal,
  onEditGoal,
  onClearGoal,
  onSetGoalStatus,
  goalPending = false,
  todoItems = [],
  scheduleItems = [],
  backgroundItems = [],
  schedulesPaused = false,
  onToggleSchedulesPaused,
}: {
  snapshots: ChatSubagentSnapshot[];
  events: AgentChatEventEnvelope[];
  onSelectSubagent?: (selection: SubagentSelection) => void;
  onClearSelectedSubagent?: () => void;
  /** Probe (same fetch the takeover uses) for whether an agent has a pullable
   * transcript. Returns true → take over the chat; false → inline drawer. */
  probeSubagentTranscript?: (args: { taskId: string; agentId: string | null }) => Promise<boolean>;
  /** Per-runtime subagent capability — the single source of truth for whether a
   * subagent click can take over the chat (full transcript) or only opens the
   * inline drawer, and whether running agents take over immediately. Null →
   * treated as no transcript (drawer-only). See `shared/subagentCapabilities`. */
  capability?: SubagentCapability | null;
  selectedTaskId?: string | null;
  className?: string;
  variant?: "drawer" | "pane";
  onClose?: () => void;
  goal?: CodexThreadGoal | null;
  onEditGoal?: (nextObjective: string) => void;
  onClearGoal?: () => void;
  onSetGoalStatus?: (status: Extract<NonNullable<CodexThreadGoal["status"]>, "active" | "paused" | "blocked" | "complete">) => void;
  goalPending?: boolean;
  todoItems?: TodoItemSnapshot[];
  /** Schedule kinds only (wakeup/cron/loop/remote_trigger) — background tasks live in `backgroundItems`. */
  scheduleItems?: ChatScheduledWorkSnapshot[];
  /** Background command tasks (kind background_task). */
  backgroundItems?: ChatScheduledWorkSnapshot[];
  /** Whether all durable schedules for this chat are currently paused. */
  schedulesPaused?: boolean;
  /** Pause or resume all durable schedules for this chat. */
  onToggleSchedulesPaused?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [scheduleHistoryExpanded, setScheduleHistoryExpanded] = useState(false);
  // Which agent's inline details drawer is open (agents with no transcript).
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  // Which agent we're currently probing for a transcript (shows a row spinner).
  const [probingTaskId, setProbingTaskId] = useState<string | null>(null);
  // Cached probe outcomes per task so repeat clicks are instant. Running agents
  // are never cached — their transcript can appear after a later poll.
  const [probeResults, setProbeResults] = useState<Record<string, boolean>>({});

  const plan = useMemo(() => derivePlan(events), [events]);

  const { activeScheduleItems, scheduleHistoryItems } = useMemo(() => {
    const active: ChatScheduledWorkSnapshot[] = [];
    const history: ChatScheduledWorkSnapshot[] = [];
    for (const item of scheduleItems) {
      const isFiredOneShotWakeup = (item.kind === "wakeup" || item.kind === "loop")
        && item.recurring !== true
        && (item.status === "fired" || item.status === "completed");
      (isFiredOneShotWakeup ? history : active).push(item);
    }
    return { activeScheduleItems: active, scheduleHistoryItems: history };
  }, [scheduleItems]);

  const { subagents, runningCount, completedCount, bgRunningCount } = useMemo(() => {
    // ONE merged subagent list — foreground + background-run agents together.
    // Filter OUT historical command-as-subagent snapshots (old chats persisted
    // background shell commands as subagents); the shared predicate keys on
    // taskType/agentType/description.
    const list: ChatSubagentSnapshot[] = [];
    let running = 0;
    let completed = 0;
    let bgRunning = 0;
    for (const snap of snapshots) {
      if (isBackgroundShellCommand({
        taskType: snap.taskType,
        agentType: snap.agentType,
        description: snap.description,
      })) {
        continue;
      }
      list.push(snap);
      if (snap.status === "running") {
        running += 1;
        if (snap.background) bgRunning += 1;
      } else if (snap.status === "completed") {
        completed += 1;
      }
    }
    // Preserve the incoming spawn order (newest-first, fixed at spawn) — do NOT
    // re-sort by running/status, which would make rows jump as agents complete.
    return {
      subagents: list,
      runningCount: running,
      completedCount: completed,
      bgRunningCount: bgRunning,
    };
  }, [snapshots]);

  const headerSummary = useMemo(() => {
    const parts: string[] = [];
    if (runningCount) parts.push(`${runningCount} running`);
    if (bgRunningCount) parts.push(`${bgRunningCount} bg`);
    if (backgroundItems.length) parts.push(`${backgroundItems.length} background`);
    if (activeScheduleItems.length) parts.push(`${activeScheduleItems.length} scheduled`);
    if (scheduleHistoryItems.length) parts.push(`${scheduleHistoryItems.length} history`);
    if (completedCount) parts.push(`${completedCount} done`);
    if (!parts.length && subagents.length) parts.push(`${subagents.length} tracked`);
    if (!parts.length) parts.push("idle");
    return parts.join(" · ");
  }, [runningCount, bgRunningCount, backgroundItems.length, activeScheduleItems.length, scheduleHistoryItems.length, completedCount, subagents.length]);

  const takeover = (snap: ChatSubagentSnapshot) => {
    setExpandedTaskId(null);
    onSelectSubagent?.({
      taskId: snap.taskId,
      agentId: snap.agentId ?? null,
      agentType: snap.agentType ?? null,
      status: snap.status,
      background: snap.background === true,
    });
  };

  // Capability gates the click behavior. Runtimes that can't surface a child
  // transcript (Cursor, Droid, LM Studio) NEVER take over the chat — clicking a
  // row only opens the inline details drawer. Codex (rich metadata + a
  // guaranteed live thread) takes over immediately for running agents; Claude /
  // OpenCode probe first so a still-warming subagent falls back to the drawer
  // instead of an empty takeover page.
  const canTakeover = capability?.canViewFullTranscript ?? false;
  const immediateForRunning = canTakeover && (capability?.hasRichMetadata ?? false);

  const handleRowClick = (snap: ChatSubagentSnapshot) => {
    // Clicking the row whose drawer is open closes it.
    if (expandedTaskId === snap.taskId) {
      setExpandedTaskId(null);
      return;
    }
    // Already viewing this one's transcript — clicking again returns to parent.
    if (selectedTaskId === snap.taskId) {
      onClearSelectedSubagent?.();
      return;
    }

    // No full transcript for this runtime → always the inline drawer, no probe.
    if (!canTakeover) {
      setExpandedTaskId(snap.taskId);
      return;
    }

    if (immediateForRunning && snap.status === "running") {
      takeover(snap);
      return;
    }

    // Decide takeover-vs-drawer by asking the SAME fetch the takeover uses, so
    // we never replace the chat with an empty "No transcript" page. Running
    // agents re-probe every click (their transcript can appear later).
    const cached = snap.status === "running" ? undefined : probeResults[snap.taskId];
    if (cached === true) {
      takeover(snap);
      return;
    }
    if (cached === false) {
      setExpandedTaskId(snap.taskId);
      return;
    }
    if (!probeSubagentTranscript) {
      // Can't probe → never risk an empty takeover; show the inline drawer.
      setExpandedTaskId(snap.taskId);
      return;
    }

    setProbingTaskId(snap.taskId);
    void probeSubagentTranscript({ taskId: snap.taskId, agentId: snap.agentId ?? null })
      .then((hasTranscript) => {
        setProbingTaskId((current) => (current === snap.taskId ? null : current));
        setProbeResults((prev) => ({ ...prev, [snap.taskId]: hasTranscript }));
        if (hasTranscript) takeover(snap);
        else setExpandedTaskId(snap.taskId);
      })
      .catch(() => {
        setProbingTaskId((current) => (current === snap.taskId ? null : current));
        setProbeResults((prev) => ({ ...prev, [snap.taskId]: false }));
        setExpandedTaskId(snap.taskId);
      });
  };

  const planComplete = plan?.steps.filter((step) => step.status === "completed").length ?? 0;
  const planTotal = plan?.steps.length ?? 0;
  const planPercent = planTotal > 0 ? Math.round((planComplete / planTotal) * 100) : 0;
  const taskComplete = todoItems.filter((item) => item.status === "completed").length;
  const taskActive = todoItems.filter((item) => item.status === "in_progress").length;
  const taskHint = todoItems.length
    ? [
        `${taskComplete}/${todoItems.length} complete`,
        ...(taskActive ? [`${taskActive} active`] : []),
      ].join(" · ")
    : undefined;

  const hasGoal = Boolean(goal?.objective?.trim());
  const hasTasks = todoItems.length > 0;
  const hasSubagents = subagents.length > 0;
  const hasBackground = backgroundItems.length > 0;
  const hasScheduled = scheduleItems.length > 0;
  const hasAnything = hasGoal || Boolean(plan) || hasTasks || hasSubagents || hasBackground || hasScheduled;

  const body = (
    <div className="flex flex-col font-sans">
      {/* ── Goal (Codex chat goal) ───────────────────────────────── */}
      {hasGoal && goal ? (
        <CodexGoalCard
          goal={goal}
          onEdit={onEditGoal}
          onClear={onClearGoal}
          onSetStatus={onSetGoalStatus}
          pending={goalPending}
        />
      ) : null}

      {/* ── Progress ─────────────────────────────────────────────── */}
      {plan && plan.steps.length > 0 ? (
        <section className="pb-3">
          <SectionHeader
            label="Progress"
            hint={`${planComplete}/${planTotal} · ${planPercent}%`}
            tone="subagent"
          />
          <ProgressBar percent={planPercent} />
          <ul className="px-4 pt-2">
            {plan.steps.map((step, index) => {
              const isCompleted = step.status === "completed";
              const isInProgress = step.status === "in_progress";
              const isFailed = step.status === "failed";
              return (
                <li
                  key={`${index}-${step.text}`}
                  className={cn(
                    "flex items-start gap-2.5 py-[3px] text-[12.5px] leading-5",
                    isCompleted && "text-fg/45",
                    isInProgress && "text-[color:var(--color-accent-bright,#C4B5FD)]",
                    !isCompleted && !isInProgress && !isFailed && "text-fg/65",
                    isFailed && "text-rose-200/90",
                  )}
                >
                  <span className="mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    <PlanGlyph status={step.status} />
                  </span>
                  <span className="min-w-0 flex-1 break-words">{step.text}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {/* ── Tasks ───────────────────────────────────────────────── */}
      {hasTasks ? (
        <section
          className={cn(
            "pb-3",
            (hasGoal || plan) && "border-t border-white/[0.04]",
          )}
        >
          <SectionHeader
            label="Tasks"
            hint={taskHint}
            tone="workflow"
            emphasized
          />
          <ChatTaskList items={todoItems} className="px-1 pb-1 pt-0" />
        </section>
      ) : null}

      {/* ── Subagents (merged foreground + background-run agents) ──── */}
      {hasSubagents ? (
        <section
          className={cn(
            "pb-3",
            (hasGoal || plan || hasTasks) && "border-t border-white/[0.04]",
          )}
        >
          <SectionHeader
            label="Subagents"
            hint={`${subagents.length}`}
            tone="subagent"
            emphasized
          />
          <div className="space-y-px px-2 pb-1">
            {subagents.map((snap) => (
              <SubagentRow
                key={snap.taskId}
                snapshot={snap}
                selected={selectedTaskId === snap.taskId}
                expanded={expandedTaskId === snap.taskId}
                probing={probingTaskId === snap.taskId}
                canViewFullTranscript={canTakeover}
                category={snap.background ? "background" : "subagent"}
                onClick={() => handleRowClick(snap)}
              />
            ))}
          </div>
        </section>
      ) : null}

      {/* ── Background (background command tasks) ─────────────────── */}
      {hasBackground ? (
        <section
          className={cn(
            "pb-3",
            (hasGoal || plan || hasTasks || hasSubagents) && "border-t border-white/[0.04]",
          )}
        >
          <SectionHeader label="Background" hint={`${backgroundItems.length}`} tone="background" emphasized />
          <div className="space-y-px px-2 pb-1">
            {backgroundItems.map((item) => (
              <BackgroundCommandRow key={item.id} snapshot={item} />
            ))}
          </div>
        </section>
      ) : null}

      {/* ── Schedule (schedule kinds only) ───────────────────────── */}
      {hasScheduled ? (
        <section
          className={cn(
            "pb-3",
            (hasGoal || plan || hasTasks || hasSubagents || hasBackground) && "border-t border-white/[0.04]",
          )}
        >
          <SectionHeader
            label="Schedule"
            hint={`${activeScheduleItems.length}`}
            tone="scheduled"
            emphasized
            action={onToggleSchedulesPaused ? (
              <button
                type="button"
                onClick={onToggleSchedulesPaused}
                aria-label={schedulesPaused
                  ? "Resume scheduled work for this chat"
                  : "Pause scheduled work for this chat"}
                title={schedulesPaused
                  ? "Resume scheduled work for this chat"
                  : "Pause scheduled work for this chat"}
                className="flex h-5 w-5 items-center justify-center rounded-sm text-fg/35 transition-colors hover:bg-white/[0.05] hover:text-fg/65"
              >
                {schedulesPaused
                  ? <Play aria-hidden size={11} weight="fill" />
                  : <Pause aria-hidden size={11} weight="fill" />}
              </button>
            ) : null}
          />
          {activeScheduleItems.length ? (
            <div className="space-y-px px-2 pb-1">
              {activeScheduleItems.map((item) => (
                <ScheduledWorkRow
                  key={item.id}
                  snapshot={item}
                  schedulesPaused={schedulesPaused}
                />
              ))}
            </div>
          ) : null}
          {scheduleHistoryItems.length ? (
            <div className="px-2 pt-0.5">
              <button
                type="button"
                onClick={() => setScheduleHistoryExpanded((value) => !value)}
                aria-expanded={scheduleHistoryExpanded}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left font-sans text-[10.5px] text-fg/40 transition-colors hover:bg-white/[0.035] hover:text-fg/60"
              >
                <span aria-hidden>
                  {scheduleHistoryExpanded
                    ? <CaretDown size={10} weight="bold" />
                    : <CaretRight size={10} weight="bold" />}
                </span>
                History ({scheduleHistoryItems.length})
              </button>
              {scheduleHistoryExpanded ? (
                <div className="space-y-px pb-1">
                  {scheduleHistoryItems.map((item) => (
                    <ScheduleHistoryRow key={item.id} snapshot={item} />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {/* ── Single-agent empty state ─────────────────────────────── */}
      {!hasAnything ? (
        <div className="px-4 py-6 text-[12px] leading-5 text-fg/40">
          No agent activity for this chat.
          <span className="block pt-0.5 text-fg/25">Single-agent mode.</span>
        </div>
      ) : null}

    </div>
  );

  if (variant === "pane") {
    return (
      <div className={cn("flex flex-col font-sans", className)}>
        {body}
      </div>
    );
  }

  return (
    <BottomDrawerSection
      label="Subagents"
      icon={TreeStructure}
      summary={headerSummary}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      className={className}
    >
      {body}
    </BottomDrawerSection>
  );
}
