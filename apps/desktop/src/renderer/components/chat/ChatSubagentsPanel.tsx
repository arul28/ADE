import { useMemo, useState } from "react";
import {
  Check,
  Circle,
  CircleHalf,
  CircleNotch,
  StopCircle,
  TreeStructure,
  X,
} from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import type { ChatSubagentSnapshot } from "./chatExecutionSummary";
import { derivePlan } from "./chatExecutionSummary";
import type { ChatInfoPlanStep } from "../../../shared/chatSubagents";
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

function runtimeText(snapshot: ChatSubagentSnapshot): string | null {
  const elapsedMs = snapshot.usage?.durationMs
    ?? Math.max(0, Date.parse(snapshot.updatedAt) - Date.parse(snapshot.startedAt));
  const durationText = formatDurationMs(elapsedMs);
  const tokenText = formatTokenCount(snapshot.usage?.totalTokens);
  const parts = [snapshot.lastToolName, durationText, tokenText ? `${tokenText} tok` : null]
    .filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" · ") : null;
}

/* ── Glyphs (12 px monoline, single visual family) ──
 *
 * One stroke weight, one diameter, one baseline. Color shifts only on
 * completion; everything else stays in the fg ramp so the panel reads as a
 * single calm surface.
 */

const GLYPH_SIZE = 12;

function StatusGlyph({ status }: { status: ChatSubagentSnapshot["status"] }) {
  if (status === "running") {
    return (
      <CircleNotch
        aria-hidden
        size={GLYPH_SIZE}
        weight="bold"
        className="text-[color:var(--color-accent,#A78BFA)] motion-safe:animate-spin [animation-duration:2.4s]"
      />
    );
  }
  if (status === "completed") {
    return <Check aria-hidden size={GLYPH_SIZE} weight="bold" className="text-emerald-300/85" />;
  }
  if (status === "failed") {
    return <X aria-hidden size={GLYPH_SIZE} weight="bold" className="text-rose-300/80" />;
  }
  return <Circle aria-hidden size={GLYPH_SIZE} weight="regular" className="text-fg/30" />;
}

function PlanGlyph({ status }: { status: ChatInfoPlanStep["status"] }) {
  if (status === "completed") {
    return <Check aria-hidden size={GLYPH_SIZE} weight="bold" className="text-emerald-300/85" />;
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
    return <X aria-hidden size={GLYPH_SIZE} weight="bold" className="text-rose-300/80" />;
  }
  return <Circle aria-hidden size={GLYPH_SIZE} weight="regular" className="text-fg/25" />;
}

/* ── Section header — sentence case, paper-section feel ── */

function SectionHeader({
  label,
  hint,
}: {
  label: string;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between px-4 pb-2 pt-3.5">
      <span className="font-sans text-[11.5px] font-medium tracking-[0.005em] text-fg/55">
        {label}
      </span>
      {hint ? (
        <span className="font-sans text-[11px] tabular-nums text-fg/35">
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
 * One line per row. Glyph sits in a fixed 12 px column at x=16 so every
 * section shares the same left rail. Hover wash is 2.5 %; selected rows get a
 * 1 px accent rail in the left padding gutter (no chip, no card chrome).
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

function SubagentRow({
  snapshot,
  selected,
  onClick,
}: {
  snapshot: ChatSubagentSnapshot;
  selected: boolean;
  onClick: () => void;
}) {
  const runtime = runtimeText(snapshot);
  const name = meaningfulName(snapshot);
  const isRunning = snapshot.status === "running";
  const isMuted = snapshot.status === "completed" || snapshot.status === "stopped";
  const isFailed = snapshot.status === "failed";

  return (
    <button
      type="button"
      onClick={onClick}
      title={snapshot.description}
      data-selected={selected || undefined}
      className={cn(
        "group relative flex w-full items-center gap-3 px-4 py-1.5 text-left",
        "transition-colors duration-150",
        "hover:bg-white/[0.025]",
        "data-[selected=true]:bg-white/[0.035]",
        selected
          && "before:absolute before:left-0 before:top-1/2 before:h-3 before:w-px before:-translate-y-1/2 before:bg-[color:var(--color-accent,#A78BFA)]/55",
      )}
    >
      <span className="flex h-3 w-3 shrink-0 items-center justify-center">
        <StatusGlyph status={snapshot.status} />
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate font-sans text-[12.5px] leading-5",
          isRunning && "text-[color:var(--color-accent-bright,#C4B5FD)]",
          isFailed && "text-rose-200/85",
          isMuted && "text-fg/45",
          !isRunning && !isFailed && !isMuted && "text-fg/70",
        )}
      >
        {name}
        {snapshot.background ? (
          <span className="ml-1.5 font-sans text-[10.5px] tracking-[0.01em] text-fg/30">
            bg
          </span>
        ) : null}
      </span>
      {runtime ? (
        <span className="shrink-0 truncate font-sans text-[10.5px] tabular-nums text-fg/30 group-hover:text-fg/45">
          {runtime}
        </span>
      ) : null}
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
}: {
  snapshots: ChatSubagentSnapshot[];
  events: AgentChatEventEnvelope[];
  onInterruptTurn?: () => void;
  onSelectSubagent?: (selection: SubagentSelection) => void;
  selectedTaskId?: string | null;
  className?: string;
  variant?: "drawer" | "pane";
  onClose?: () => void;
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

  const hasAnything = Boolean(plan) || foreground.length > 0 || background.length > 0;

  const body = (
    <div className="flex min-h-0 flex-1 flex-col font-sans">
      {/* ── Progress ─────────────────────────────────────────────── */}
      {plan && plan.steps.length > 0 ? (
        <section className="pb-3">
          <SectionHeader
            label="Progress"
            hint={`${planComplete}/${planTotal} · ${planPercent}%`}
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
                    isCompleted && "text-fg/40",
                    isInProgress && "text-[color:var(--color-accent-bright,#C4B5FD)]",
                    !isCompleted && !isInProgress && !isFailed && "text-fg/55",
                    isFailed && "text-rose-200/85",
                  )}
                >
                  <span className="mt-[3px] flex h-3 w-3 shrink-0 items-center justify-center">
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
          "pb-2",
          (plan || background.length) && "border-t border-white/[0.04]",
        )}
      >
        <SectionHeader
          label="Subagents"
          hint={foreground.length ? `${foreground.length}` : undefined}
        />
        {foreground.length ? (
          <div className="pb-1">
            {foreground.map((snap) => (
              <SubagentRow
                key={snap.taskId}
                snapshot={snap}
                selected={selectedTaskId === snap.taskId}
                onClick={() => handleSelect(snap)}
              />
            ))}
          </div>
        ) : (
          <p className="px-4 pb-2 text-[11.5px] text-fg/30">
            None active.
          </p>
        )}
      </section>

      {/* ── Background tasks ─────────────────────────────────────── */}
      {background.length ? (
        <section className="border-t border-white/[0.04] pb-2">
          <SectionHeader label="Background tasks" hint={`${background.length}`} />
          <div className="pb-1">
            {background.map((snap) => (
              <SubagentRow
                key={snap.taskId}
                snapshot={snap}
                selected={selectedTaskId === snap.taskId}
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
      <div className={cn("flex h-full min-h-0 flex-col font-sans", className)}>
        {/* Single-line header: "Work" + dimmed summary clause + close.
            The TreeStructure icon moved into the toggle button where it
            actually means something. */}
        <div className="flex shrink-0 items-baseline gap-3 px-4 pb-2.5 pt-3.5">
          <span className="text-[12.5px] font-medium tracking-[0.005em] text-fg/80">
            Work
          </span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-fg/35">
            {headerSummary}
          </span>
          {onClose ? (
            <button
              type="button"
              className="-mr-1 inline-flex h-6 w-6 items-center justify-center rounded text-fg/35 transition-colors hover:bg-white/[0.04] hover:text-fg/70"
              onClick={onClose}
              title="Close work panel"
              aria-label="Close work panel"
            >
              <X size={11} weight="bold" />
            </button>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-white/[0.04]">
          {body}
        </div>
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
