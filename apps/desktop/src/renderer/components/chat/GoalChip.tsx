import React, { useRef, useState } from "react";
import { CaretDown, Pause, Play, PencilSimple, Target, X, type Icon as PhosphorIcon } from "@phosphor-icons/react";
import type { ClaudeActiveGoal, CodexThreadGoal } from "../../../shared/types";
import { AnchoredMenu } from "../ui/AnchoredMenu";
import { cn } from "../ui/cn";
import { promptDialog } from "../ui/dialog";
import { Z_LAYERS } from "../ui/zLayers";

export type GoalChipProps =
  | {
      variant: "codex";
      goal: CodexThreadGoal;
      pending?: boolean;
      onEdit: (objective: string) => void;
      onClear: () => void;
      onSetStatus: (status: "active" | "paused") => void;
    }
  | {
      variant: "claude";
      goal: ClaudeActiveGoal;
      /** Claude takes `/goal` only between turns. */
      turnActive: boolean;
      onEdit: (condition: string) => void;
      onClear: () => void;
    };

const STATUS_LABEL: Partial<Record<NonNullable<CodexThreadGoal["status"]>, string>> = {
  active: "active",
  paused: "paused",
  blocked: "blocked",
  usage_limited: "waiting on usage limit",
  budget_limited: "budget reached",
  complete: "reached",
};

function compactTokens(value: number | null | undefined): string | null {
  if (!value || !Number.isFinite(value) || value <= 0) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M tokens`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k tokens`;
  return `${value} tokens`;
}

/**
 * The chat's goal as a one-line chip above the prompt box, next to the other
 * composer pills. Click opens a small sheet with the full objective and the
 * controls the provider supports: Codex goals pause and resume; Claude goals
 * (its native `/goal`) can only be changed or cleared, between turns.
 */
export function GoalChip(props: GoalChipProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const objective = props.variant === "codex" ? (props.goal.objective ?? "").trim() : props.goal.condition.trim();
  if (!objective) return null;

  const status = props.variant === "codex" ? props.goal.status ?? "active" : "active";
  const paused = props.variant === "codex" && status === "paused";
  const iteration = props.variant === "claude" && props.goal.iterations > 0 ? `iteration ${props.goal.iterations}` : null;
  const tokens = props.variant === "codex" ? compactTokens(props.goal.tokensUsed) : null;
  const statusLabel = props.variant === "codex" ? STATUS_LABEL[status] ?? status : "active";
  const claudeLocked = props.variant === "claude" && props.turnActive;
  const busy = props.variant === "codex" ? props.pending === true : false;
  const lastReason = props.variant === "claude" ? props.goal.lastReason?.trim() : null;

  const edit = async () => {
    setOpen(false);
    const next = await promptDialog({
      title: "Edit goal",
      message: props.variant === "claude"
        ? "Claude keeps working across turns until this is true."
        : "Codex keeps working toward this until it is met, paused, or cleared.",
      defaultValue: objective,
      confirmLabel: "Set goal",
    });
    const trimmed = next?.replace(/\s*[\r\n]+\s*/g, " ").trim();
    if (trimmed && trimmed !== objective) props.onEdit(trimmed);
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        data-testid="chat-goal-chip"
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 font-sans text-[11px] transition-colors",
          paused
            ? "border-white/[0.10] bg-white/[0.03] text-fg/55 hover:bg-white/[0.06]"
            : "border-amber-400/25 bg-amber-500/[0.07] text-amber-50/90 hover:bg-amber-500/[0.11]",
        )}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={objective}
      >
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", paused ? "bg-fg/35" : "animate-pulse bg-amber-300/90")} aria-hidden />
        <Target size={12} weight="duotone" className="shrink-0 text-amber-300/80" aria-hidden />
        <span className="shrink-0 font-semibold uppercase tracking-[0.08em] text-[9.5px] text-amber-200/70">Goal</span>
        <span className="min-w-0 truncate">{objective}</span>
        {iteration || tokens ? (
          <span className="shrink-0 text-[10px] text-amber-100/50">· {iteration ?? tokens}</span>
        ) : null}
        <CaretDown size={8} weight="bold" className="shrink-0 opacity-60" aria-hidden />
      </button>
      <AnchoredMenu
        open={open}
        anchorRef={anchorRef}
        onClose={() => setOpen(false)}
        placement="top-start"
        zIndex={Z_LAYERS.popover}
        role="dialog"
        aria-label="Goal"
        className="w-[340px] rounded-xl border border-amber-400/15 bg-[#17151a] p-3 shadow-2xl shadow-black/40"
      >
        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-amber-200/65">
          <Target size={12} weight="duotone" aria-hidden />
          Goal · {statusLabel}
          {iteration ? <span className="normal-case tracking-normal text-amber-100/45">· {iteration}</span> : null}
          {tokens ? <span className="normal-case tracking-normal text-amber-100/45">· {tokens}</span> : null}
        </div>
        <p className="mt-2 font-sans text-[13px] leading-snug text-amber-50">{objective}</p>
        {lastReason ? (
          <p className="mt-1.5 font-sans text-[11.5px] leading-snug text-amber-100/55">last check: {lastReason}</p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <GoalAction icon={PencilSimple} label="Edit" disabled={busy || claudeLocked} onClick={() => void edit()} />
          {props.variant === "codex" ? (
            paused ? (
              <GoalAction icon={Play} label="Resume" disabled={busy} onClick={() => { setOpen(false); props.onSetStatus("active"); }} />
            ) : (
              <GoalAction icon={Pause} label="Pause" disabled={busy} onClick={() => { setOpen(false); props.onSetStatus("paused"); }} />
            )
          ) : null}
          <GoalAction icon={X} label="Clear" disabled={busy || claudeLocked} onClick={() => { setOpen(false); props.onClear(); }} />
        </div>
        {claudeLocked ? (
          <p className="mt-2 font-sans text-[10.5px] text-fg/45">Claude takes goal changes between turns.</p>
        ) : null}
      </AnchoredMenu>
    </>
  );
}

function GoalAction({
  icon: Icon,
  label,
  disabled,
  onClick,
}: {
  icon: PhosphorIcon;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1 font-sans text-[11px] text-fg/75 transition-colors hover:bg-white/[0.07] disabled:pointer-events-none disabled:opacity-40"
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={11} weight="bold" />
      {label}
    </button>
  );
}
