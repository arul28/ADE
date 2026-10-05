import { useEffect, useRef, useState } from "react";
import { PencilSimple, Target, X } from "@phosphor-icons/react";
import type { ClaudeActiveGoal, CodexThreadGoal } from "../../../shared/types";
import { cn } from "../ui/cn";
import { CodexGoalCard } from "./codex/CodexGoalCard";

const AMBER = "#F59E0B";

/**
 * Shared goal surface used by both providers. Codex keeps its full edit / clear /
 * status controls (delegated to {@link CodexGoalCard}); the Claude variant edits
 * and clears by sending `/goal …` between turns, since the CLI's `/goal` loop
 * owns the condition.
 */
export type GoalCardProps =
  | {
      variant: "codex";
      goal: CodexThreadGoal;
      onEdit?: (nextObjective: string) => void;
      onClear?: () => void;
      onSetStatus?: (status: Extract<NonNullable<CodexThreadGoal["status"]>, "active" | "paused" | "blocked" | "complete">) => void;
      pending?: boolean;
    }
  | {
      variant: "claude";
      goal: ClaudeActiveGoal;
      onEdit?: (condition: string) => void;
      onClear?: () => void;
      locked?: boolean;
    };

function ClaudeGoalCard({
  goal,
  onEdit,
  onClear,
  locked = false,
}: {
  goal: ClaudeActiveGoal;
  onEdit?: (condition: string) => void;
  onClear?: () => void;
  /** Claude takes `/goal` changes only between turns. */
  locked?: boolean;
}) {
  const condition = goal.condition.trim();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(condition);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editing) setDraft(condition);
  }, [condition, editing]);
  useEffect(() => {
    if (editing) textareaRef.current?.select();
  }, [editing]);
  if (!condition) return null;
  const lastReason = goal.lastReason?.trim();
  const canEdit = Boolean(onEdit) && !locked;

  const submit = () => {
    const next = draft.replace(/\s*[\r\n]+\s*/g, " ").trim();
    setEditing(false);
    if (next && next !== condition) onEdit?.(next);
  };

  return (
    <section className="px-3 pb-3 pt-3">
      <div className="relative overflow-hidden rounded-lg border border-amber-400/15 bg-amber-500/[0.04] pl-3 pr-2 py-2.5">
        <span aria-hidden className="absolute inset-y-2 left-0 w-[2px] rounded-full bg-amber-400/55" />

        <header className="flex items-center gap-2">
          <Target size={13} weight="duotone" aria-hidden style={{ color: AMBER }} className="shrink-0" />
          <span className="font-sans text-[10.5px] font-semibold uppercase tracking-[0.08em] text-amber-200/65">
            Goal
          </span>
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-amber-500/12 px-1.5 py-0.5 font-sans text-[10px] font-medium tracking-tight text-amber-100 ring-1 ring-inset ring-amber-400/30">
            <span aria-hidden className="h-1 w-1 rounded-full bg-amber-300/85" />
            {goal.iterations > 0 ? `iteration ${goal.iterations}` : "active"}
          </span>
        </header>

        {editing ? (
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={submit}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
              }
            }}
            rows={2}
            className="mt-1.5 block w-full resize-none rounded border border-amber-400/30 bg-amber-950/30 px-2 py-1 font-sans text-[13px] leading-snug text-amber-50 outline-none focus:border-amber-300/60"
            aria-label="Edit goal"
          />
        ) : (
          <button
            type="button"
            onClick={() => canEdit && setEditing(true)}
            disabled={!canEdit}
            title={canEdit ? "Edit goal" : condition}
            className={cn(
              "mt-1.5 block w-full text-left font-sans text-[13px] leading-snug text-amber-50",
              canEdit ? "cursor-text hover:text-amber-100" : "cursor-default",
            )}
          >
            {condition}
          </button>
        )}

        <div className="mt-2 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-sans text-[11px] leading-snug text-amber-100/55" title={lastReason}>
            {editing
              ? "Enter to save · Esc to cancel"
              : locked ? "Changes apply between turns" : lastReason ? `last check: ${lastReason}` : ""}
          </span>
          {onEdit && !editing ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              disabled={!canEdit}
              className="rounded p-1 text-amber-200/55 transition-colors hover:bg-amber-500/10 hover:text-amber-100 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
              aria-label="Edit goal"
              title="Edit goal"
            >
              <PencilSimple size={11} weight="bold" />
            </button>
          ) : null}
          {onClear && !editing ? (
            <button
              type="button"
              onClick={onClear}
              disabled={locked}
              className="rounded p-1 text-amber-200/55 transition-colors hover:bg-amber-500/10 hover:text-amber-100 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
              aria-label="Clear goal"
              title="Clear goal"
            >
              <X size={11} weight="bold" />
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/**
 * The quiet line a goal-capable chat shows when it has no goal: one tap to set
 * one. Lives in the same section the goal card takes, so a goal always has one
 * home in the chat actions pane.
 */
export function GoalEmptyRow({ onSet }: { onSet: () => void }) {
  return (
    <section className="px-3 pb-2 pt-3">
      <button
        type="button"
        onClick={onSet}
        className="group flex w-full items-center gap-2 rounded-lg border border-dashed border-white/[0.08] px-3 py-2 text-left transition-colors hover:border-amber-400/25 hover:bg-amber-500/[0.03]"
      >
        <Target size={13} weight="duotone" aria-hidden className="shrink-0 text-fg/35 group-hover:text-amber-300/80" />
        <span className="font-sans text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg/40 group-hover:text-amber-200/70">
          Goal
        </span>
        <span className="ml-auto font-sans text-[11px] text-fg/40 group-hover:text-amber-100/70">Set a goal</span>
      </button>
    </section>
  );
}

export function GoalCard(props: GoalCardProps) {
  if (props.variant === "claude") {
    return <ClaudeGoalCard goal={props.goal} onEdit={props.onEdit} onClear={props.onClear} locked={props.locked} />;
  }
  return (
    <CodexGoalCard
      goal={props.goal}
      onEdit={props.onEdit}
      onClear={props.onClear}
      onSetStatus={props.onSetStatus}
      pending={props.pending}
    />
  );
}

export default GoalCard;
