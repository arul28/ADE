import { useEffect, useRef, useState } from "react";
import { PencilSimple, Target, X } from "@phosphor-icons/react";
import type { ClaudeActiveGoal, CodexThreadGoal } from "../../../shared/types";
import { CodexGoalCard } from "./codex/CodexGoalCard";

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
  // Set once the editor is done (saved, or Escape): the blur that closing
  // can fire must not save again.
  const closedRef = useRef(false);
  useEffect(() => {
    if (!editing) setDraft(condition);
  }, [condition, editing]);
  useEffect(() => {
    if (editing) {
      closedRef.current = false;
      textareaRef.current?.select();
    }
  }, [editing]);
  useEffect(() => {
    if (locked) {
      closedRef.current = true;
      setEditing(false);
    }
  }, [locked]);
  if (!condition) return null;
  const lastReason = goal.lastReason?.trim();
  const canEdit = Boolean(onEdit) && !locked;
  const lockedTitle = "Claude takes goal changes between turns";

  const submit = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    const next = draft.replace(/\s*[\r\n]+\s*/g, " ").trim();
    setEditing(false);
    if (next && next !== condition) onEdit?.(next);
  };

  // Laid out like the drawer's other sections (Tasks, Schedule): an uppercase
  // header, then plain rows. The controls show on hover.
  return (
    <section className="group pb-2.5">
      <div className="flex items-center justify-between px-3.5 pb-1 pt-2.5">
        <span className="flex items-center gap-1.5 font-sans text-[10px] font-medium uppercase tracking-[0.06em] text-fg/45">
          <Target aria-hidden size={12} weight="bold" className="shrink-0 text-amber-300/75" />
          Goal
        </span>
        <span className="flex items-center gap-1">
          {goal.iterations > 0 ? (
            <span className="font-sans text-[10.5px] tabular-nums text-fg/35">
              {goal.iterations === 1 ? "1 check" : `${goal.iterations} checks`}
            </span>
          ) : null}
          {onEdit && !editing ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              disabled={!canEdit}
              aria-label="Edit goal"
              title={canEdit ? "Edit goal" : lockedTitle}
              className="flex h-5 w-5 items-center justify-center rounded-sm text-fg/30 opacity-0 transition-all hover:bg-white/[0.06] hover:text-fg/75 focus-visible:opacity-100 group-hover:opacity-100 disabled:hover:bg-transparent disabled:hover:text-fg/30"
            >
              <PencilSimple aria-hidden size={11} weight="bold" />
            </button>
          ) : null}
          {onClear && !editing ? (
            <button
              type="button"
              onClick={onClear}
              disabled={locked}
              aria-label="Clear goal"
              title={locked ? lockedTitle : "Clear goal"}
              className="flex h-5 w-5 items-center justify-center rounded-sm text-fg/30 opacity-0 transition-all hover:bg-white/[0.06] hover:text-rose-200/80 focus-visible:opacity-100 group-hover:opacity-100 disabled:hover:bg-transparent disabled:hover:text-fg/30"
            >
              <X aria-hidden size={11} weight="bold" />
            </button>
          ) : null}
        </span>
      </div>

      <div className="px-3.5">
        {editing ? (
          <>
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
                  closedRef.current = true;
                  setEditing(false);
                }
              }}
              rows={2}
              className="block w-full resize-none rounded-md bg-white/[0.04] px-2 py-1 font-sans text-[12.5px] leading-5 text-fg/85 outline-none ring-1 ring-inset ring-white/[0.08] focus:ring-white/[0.16]"
              aria-label="Edit goal"
            />
            <div className="mt-1 font-sans text-[10px] leading-4 text-fg/35">Enter to save · Esc to cancel</div>
          </>
        ) : (
          <p className="font-sans text-[12.5px] leading-5 text-fg/80">{condition}</p>
        )}
        {!editing && lastReason ? (
          <div className="mt-0.5 line-clamp-2 font-sans text-[10.5px] leading-4 text-fg/38" title={lastReason}>
            {lastReason}
          </div>
        ) : null}
      </div>
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
