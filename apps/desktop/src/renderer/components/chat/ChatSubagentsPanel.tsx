import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  Circle,
  CircleHalf,
  TreeStructure,
  X,
} from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import type { ChatScheduledWorkSnapshot, ChatSubagentSnapshot } from "./chatExecutionSummary";
import { derivePlan } from "./chatExecutionSummary";
import type { TodoItemSnapshot } from "./chatExecutionSummary";
import { ChatTaskList } from "./ChatTasksPanel";
import type { ChatInfoPlanStep } from "../../../shared/chatSubagents";
import type { AgentChatEventEnvelope, CodexThreadGoal } from "../../../shared/types";
import type { SubagentCapability } from "../../../shared/subagentCapabilities";
import { BottomDrawerSection } from "./BottomDrawerSection";
import { CodexGoalCard } from "./codex/CodexGoalCard";

/* ── Formatting helpers ── */

function formatDurationMs(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (value >= 60_000) return `${Math.round(value / 60_000)}m`;
  return `${Math.max(1, Math.round(value / 1000))}s`;
}

// Deterministic per-agent identity color. Real persona names/colors are not on
// any provider wire, so we derive a stable hue from the agent id purely for
// visual distinction (à la the Codex desktop colored agent glyphs).
const AGENT_IDENTITY_COLORS = [
  "#e9a6a6", "#a6cfe9", "#b6e0aa", "#e6cba0", "#c8b0e6", "#eebfdc", "#9fe0d6", "#e0d79f",
];
function agentColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return AGENT_IDENTITY_COLORS[hash % AGENT_IDENTITY_COLORS.length]!;
}

/* ── Per-agent identity glyph ──
 *
 * Codex's Environment > Subagents list gives every agent a tiny distinct
 * logo/glyph. There are no real persona logos on any provider wire, so we
 * synthesise a deterministic 3×3 geometric identicon from the agent id — a
 * mirrored-grid "mini robot face" that is stable per agent and visually
 * distinct from its neighbours, tinted with the same agentColor() hash.
 *
 * Status is layered on top: a small badge in the corner (check / cross /
 * halted) and, while running, a subtle animated ring around the glyph — so the
 * spinner survives but never takes over the whole row.
 */

const GLYPH_SIZE = 16;

type GlyphCategory = "subagent" | "background";

// Cheap stable hash; independent from the color hash so shape ≠ hue lockstep.
function glyphHash(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// Deterministic mirrored 3×3 identicon (5 unique cells, left+center+mirrored
// right) → a small symmetric "face". Distinct per id, always legible at 16 px.
function identiconCells(id: string): boolean[] {
  const hash = glyphHash(id);
  // Force at least one lit cell so empty glyphs never happen.
  const left = [0, 1, 2].map((i) => Boolean((hash >> i) & 1));
  const center = [3, 4, 5].map((i) => Boolean((hash >> i) & 1));
  if (!left.some(Boolean) && !center.some(Boolean)) center[1] = true;
  // grid order: row-major 3×3, columns [left, center, mirror-of-left]
  return [
    left[0]!, center[0]!, left[0]!,
    left[1]!, center[1]!, left[1]!,
    left[2]!, center[2]!, left[2]!,
  ];
}

function AgentGlyph({
  id,
  color,
  status,
}: {
  id: string;
  color: string;
  status: ChatSubagentSnapshot["status"];
}) {
  const cells = identiconCells(id);
  const isRunning = status === "running";
  const dimmed = status === "completed" || status === "stopped";
  // 3×3 cells inside an 18px circle with a 1px gutter.
  const cell = 4;
  const gap = 1;
  const pad = 2;

  return (
    <span className="relative flex h-[18px] w-[18px] shrink-0 items-center justify-center">
      {/* Running indicator: a slow ring around the round glyph. */}
      {isRunning ? (
        <span
          aria-hidden
          className="absolute -inset-[2px] rounded-full border motion-safe:animate-spin [animation-duration:5s]"
          style={{ borderColor: "transparent", borderTopColor: color, opacity: 0.7 }}
        />
      ) : null}
      <svg
        aria-hidden
        width={18}
        height={18}
        viewBox="0 0 18 18"
        className={cn("rounded-full", dimmed && "opacity-55")}
        style={{ backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)` }}
      >
        {cells.map((lit, i) => {
          if (!lit) return null;
          const col = i % 3;
          const row = Math.floor(i / 3);
          return (
            <rect
              key={i}
              x={pad + col * (cell + gap)}
              y={pad + row * (cell + gap)}
              width={cell}
              height={cell}
              rx={1}
              fill={color}
            />
          );
        })}
      </svg>
      {status === "completed" ? (
        <Check aria-hidden size={9} weight="bold" className="absolute -bottom-0.5 -right-0.5 rounded-full bg-[color:var(--work-sidebar-bg,#1a1a1e)] text-emerald-300/90" />
      ) : null}
      {status === "failed" ? (
        <X aria-hidden size={9} weight="bold" className="absolute -bottom-0.5 -right-0.5 rounded-full bg-[color:var(--work-sidebar-bg,#1a1a1e)] text-rose-300/90" />
      ) : null}
    </span>
  );
}

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
  tone = "neutral",
  emphasized = false,
}: {
  label: string;
  hint?: string;
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
      {hint ? (
        <span className="font-sans text-[10.5px] tabular-nums text-fg/35">
          {hint}
        </span>
      ) : null}
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

// Some runtimes stamp a placeholder agentType on the wire (e.g. legacy OpenCode
// envelopes emitted before the description-first fix). Treat those as absent
// so the more meaningful description takes the row label.
const GENERIC_AGENT_TYPES = new Set(["opencode-subagent", "subagent"]);

function meaningfulName(snapshot: ChatSubagentSnapshot): string {
  const type = snapshot.agentType?.trim() ?? "";
  if (type.length && !GENERIC_AGENT_TYPES.has(type.toLowerCase())) return type;
  const description = snapshot.description?.trim();
  if (description) return description;
  return snapshot.agentId ?? snapshot.taskId;
}

const STATUS_LABEL: Record<ChatSubagentSnapshot["status"], string> = {
  running: "running",
  completed: "done",
  failed: "failed",
  stopped: "halted",
};

// Elapsed-time chip for the right rail — duration only (no tool/token noise),
// so the compact row stays scannable.
function elapsedText(snapshot: ChatSubagentSnapshot): string | null {
  const elapsedMs = snapshot.usage?.durationMs
    ?? Math.max(0, Date.parse(snapshot.updatedAt) - Date.parse(snapshot.startedAt));
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

function ScheduledWorkRow({ snapshot }: { snapshot: ChatScheduledWorkSnapshot }) {
  const isActive = snapshot.status === "running" || snapshot.status === "fired";
  const isProblem = snapshot.status === "failed" || snapshot.status === "missed";
  const isMuted = snapshot.status === "completed" || snapshot.status === "cancelled" || snapshot.status === "stopped";
  const detail = scheduledDetail(snapshot);
  const prompt = snapshot.prompt?.trim();

  return (
    <div
      className={cn(
        "group grid min-h-[42px] grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1.5",
        "transition-colors duration-150 hover:bg-white/[0.035]",
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
        {SCHEDULE_STATUS_LABEL[snapshot.status]}
      </span>
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
  const name = meaningfulName(snapshot);
  const kindLabel = kindBadge(snapshot);
  const color = agentColor(snapshot.agentId ?? snapshot.taskId);
  const isRunning = snapshot.status === "running";
  const isCompleted = snapshot.status === "completed";
  const isStopped = snapshot.status === "stopped";
  const isFailed = snapshot.status === "failed";
  const time = elapsedText(snapshot);
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
        <AgentGlyph id={snapshot.agentId ?? snapshot.taskId} color={color} status={snapshot.status} />

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
  scheduledItems = [],
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
  scheduledItems?: ChatScheduledWorkSnapshot[];
}) {
  const [expanded, setExpanded] = useState(false);
  // Which agent's inline details drawer is open (agents with no transcript).
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  // Which agent we're currently probing for a transcript (shows a row spinner).
  const [probingTaskId, setProbingTaskId] = useState<string | null>(null);
  // Cached probe outcomes per task so repeat clicks are instant. Running agents
  // are never cached — their transcript can appear after a later poll.
  const [probeResults, setProbeResults] = useState<Record<string, boolean>>({});

  const plan = useMemo(() => derivePlan(events), [events]);

  const { foreground, background, runningCount, completedCount, bgRunningCount } = useMemo(() => {
    const fg: ChatSubagentSnapshot[] = [];
    const bg: ChatSubagentSnapshot[] = [];
    let running = 0;
    let completed = 0;
    let bgRunning = 0;
    for (const snap of snapshots) {
      if (snap.background) {
        bg.push(snap);
        if (snap.status === "running") bgRunning += 1;
      } else {
        fg.push(snap);
      }
      if (snap.status === "running") running += 1;
      else if (snap.status === "completed") completed += 1;
    }
    // Preserve the incoming spawn order (newest-first, fixed at spawn) — do NOT
    // re-sort by running/status, which would make rows jump as agents complete.
    return {
      foreground: fg,
      background: bg,
      runningCount: running,
      completedCount: completed,
      bgRunningCount: bgRunning,
    };
  }, [snapshots]);

  const headerSummary = useMemo(() => {
    const parts: string[] = [];
    if (runningCount) parts.push(`${runningCount} running`);
    if (bgRunningCount) parts.push(`${bgRunningCount} bg`);
    if (scheduledItems.length) parts.push(`${scheduledItems.length} scheduled`);
    if (completedCount) parts.push(`${completedCount} done`);
    if (!parts.length && snapshots.length) parts.push(`${snapshots.length} tracked`);
    if (!parts.length) parts.push("idle");
    return parts.join(" · ");
  }, [runningCount, bgRunningCount, scheduledItems.length, completedCount, snapshots.length]);

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
  const hasScheduled = scheduledItems.length > 0;
  const hasAnything = hasGoal || Boolean(plan) || hasTasks || hasScheduled || foreground.length > 0 || background.length > 0;

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

      {/* ── Schedule ─────────────────────────────────────────────── */}
      {hasScheduled ? (
        <section
          className={cn(
            "pb-3",
            (hasGoal || plan || hasTasks) && "border-t border-white/[0.04]",
          )}
        >
          <SectionHeader
            label="Schedule"
            hint={`${scheduledItems.length}`}
            tone="scheduled"
            emphasized
          />
          <div className="space-y-px px-2 pb-1">
            {scheduledItems.map((item) => (
              <ScheduledWorkRow key={item.id} snapshot={item} />
            ))}
          </div>
        </section>
      ) : null}

      {/* ── Subagents ────────────────────────────────────────────── */}
      <section
        className={cn(
          "pb-3",
          (plan || hasTasks || hasScheduled || background.length) && "border-t border-white/[0.04]",
        )}
      >
        <SectionHeader
          label="Subagents"
          hint={foreground.length ? `${foreground.length}` : undefined}
          tone="subagent"
          emphasized
        />
        {foreground.length ? (
          <div className="space-y-px px-2 pb-1">
            {foreground.map((snap) => (
              <SubagentRow
                key={snap.taskId}
                snapshot={snap}
                selected={selectedTaskId === snap.taskId}
                expanded={expandedTaskId === snap.taskId}
                probing={probingTaskId === snap.taskId}
                canViewFullTranscript={canTakeover}
                category="subagent"
                onClick={() => handleRowClick(snap)}
              />
            ))}
          </div>
        ) : (
          <p className="px-3.5 pb-2 text-[11.5px] text-fg/35">
            None active.
          </p>
        )}
      </section>

      {/* ── Background tasks ─────────────────────────────────────── */}
      {background.length ? (
        <section className="border-t border-white/[0.04] pb-3">
          <SectionHeader label="Background" hint={`${background.length}`} tone="background" emphasized />
          <div className="space-y-px px-2 pb-1">
            {background.map((snap) => (
              <SubagentRow
                key={snap.taskId}
                snapshot={snap}
                selected={selectedTaskId === snap.taskId}
                expanded={expandedTaskId === snap.taskId}
                probing={probingTaskId === snap.taskId}
                canViewFullTranscript={canTakeover}
                category="background"
                onClick={() => handleRowClick(snap)}
              />
            ))}
          </div>
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
