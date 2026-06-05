import { useMemo, useState } from "react";
import {
  Check,
  Circle,
  CircleHalf,
  StopCircle,
  TreeStructure,
  X,
} from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import type { ChatSubagentSnapshot } from "./chatExecutionSummary";
import { derivePlan } from "./chatExecutionSummary";
import type { ChatInfoPlanStep } from "../../../shared/chatSubagents";
import type { AgentChatEventEnvelope, CodexThreadGoal } from "../../../shared/types";
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
  // 3×3 cells inside an 18px box with a 1px gutter.
  const cell = 4;
  const gap = 1;
  const pad = 2;

  return (
    <span className="relative flex h-[18px] w-[18px] shrink-0 items-center justify-center">
      {isRunning ? (
        <span
          aria-hidden
          className="absolute inset-0 rounded-[5px] border motion-safe:animate-spin [animation-duration:3s]"
          style={{
            borderColor: "transparent",
            borderTopColor: color,
            opacity: 0.7,
          }}
        />
      ) : null}
      <svg
        aria-hidden
        width={18}
        height={18}
        viewBox="0 0 18 18"
        className={cn("rounded-[4px]", dimmed && "opacity-55")}
        style={{ backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }}
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

type SectionTone = "subagent" | "background" | "workflow" | "neutral";

const SECTION_DOT_CLASS: Record<SectionTone, string> = {
  subagent: "bg-[color:var(--color-accent,#A78BFA)]/70",
  background: "bg-cyan-300/65",
  workflow: "bg-amber-300/65",
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

function SubagentRow({
  snapshot,
  selected,
  category,
  onClick,
}: {
  snapshot: ChatSubagentSnapshot;
  selected: boolean;
  category: GlyphCategory;
  onClick: () => void;
}) {
  const name = meaningfulName(snapshot);
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

  return (
    <button
      type="button"
      onClick={onClick}
      title={snapshot.description}
      data-selected={selected || undefined}
      className={cn(
        "group relative flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left",
        "transition-colors duration-150",
        "hover:bg-white/[0.04]",
        selected
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
        ) : null}
      </span>

      <span className="flex shrink-0 items-center gap-1.5 font-sans text-[10.5px] tabular-nums">
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
  onInterruptTurn,
  onSelectSubagent,
  selectedTaskId,
  className,
  variant = "drawer",
  onClose,
  goal,
  onEditGoal,
  onClearGoal,
  goalPending = false,
}: {
  snapshots: ChatSubagentSnapshot[];
  events: AgentChatEventEnvelope[];
  onInterruptTurn?: () => void;
  onSelectSubagent?: (selection: SubagentSelection) => void;
  selectedTaskId?: string | null;
  className?: string;
  variant?: "drawer" | "pane";
  onClose?: () => void;
  goal?: CodexThreadGoal | null;
  onEditGoal?: (nextObjective: string) => void;
  onClearGoal?: () => void;
  goalPending?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

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
    const orderRunning = (snap: ChatSubagentSnapshot) => (snap.status === "running" ? 0 : 1);
    fg.sort((a, b) => orderRunning(a) - orderRunning(b));
    bg.sort((a, b) => orderRunning(a) - orderRunning(b));
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
    if (completedCount) parts.push(`${completedCount} done`);
    if (!parts.length && snapshots.length) parts.push(`${snapshots.length} tracked`);
    if (!parts.length) parts.push("idle");
    return parts.join(" · ");
  }, [runningCount, bgRunningCount, completedCount, snapshots.length]);

  const handleSelect = (snap: ChatSubagentSnapshot) => {
    if (!onSelectSubagent) return;
    onSelectSubagent({
      taskId: snap.taskId,
      agentId: snap.agentId ?? null,
      agentType: snap.agentType ?? null,
      status: snap.status,
      background: snap.background === true,
    });
  };

  const planComplete = plan?.steps.filter((step) => step.status === "completed").length ?? 0;
  const planTotal = plan?.steps.length ?? 0;
  const planPercent = planTotal > 0 ? Math.round((planComplete / planTotal) * 100) : 0;

  const hasGoal = Boolean(goal?.objective?.trim());
  const hasAnything = hasGoal || Boolean(plan) || foreground.length > 0 || background.length > 0;

  const body = (
    <div className="flex min-h-0 flex-1 flex-col font-sans">
      {/* ── Goal (Codex chat goal) ───────────────────────────────── */}
      {hasGoal && goal ? (
        <CodexGoalCard
          goal={goal}
          onEdit={onEditGoal}
          onClear={onClearGoal}
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

      {/* ── Subagents ────────────────────────────────────────────── */}
      <section
        className={cn(
          "pb-3",
          (plan || background.length) && "border-t border-white/[0.04]",
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
                category="subagent"
                onClick={() => handleSelect(snap)}
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
                category="background"
                onClick={() => handleSelect(snap)}
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

      {/* ── Interrupt action — ghost button, no chip ─────────────── */}
      {onInterruptTurn && runningCount > 0 ? (
        <div className="mt-auto px-4 pb-3 pt-2">
          <button
            type="button"
            onClick={onInterruptTurn}
            className={cn(
              "group inline-flex items-center gap-1.5 rounded-full px-2.5 py-1",
              "text-[11px] font-medium text-fg/45",
              "transition-colors hover:text-rose-200/85",
            )}
          >
            <StopCircle size={12} weight="regular" className="text-fg/40 group-hover:text-rose-300/80" />
            Stop running agents
          </button>
        </div>
      ) : null}
    </div>
  );

  if (variant === "pane") {
    return (
      <div className={cn(
        "flex h-full min-h-0 flex-col overflow-y-auto font-sans",
        className,
      )}>
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
