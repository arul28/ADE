import { useEffect, useRef, useState } from "react";
import { PencilSimple, Target, X } from "@phosphor-icons/react";
import type { CodexThreadGoal } from "../../../../shared/types";
import { cn } from "../../ui/cn";

const AMBER = "#F59E0B";
const CODEX_GOAL_OBJECTIVE_MAX_CHARS = 4000;

type CodexGoalCardProps = {
  goal: CodexThreadGoal;
  onEdit?: (nextObjective: string) => void;
  onClear?: () => void;
  pending?: boolean;
};

function formatTokens(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatElapsed(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  if (minutes < 60) return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function statusTone(
  status: CodexThreadGoal["status"],
): { pill: string; rail: string; dot: string; label: string } {
  switch (status) {
    case "complete":
      return {
        pill: "bg-emerald-500/12 text-emerald-200/90 ring-1 ring-inset ring-emerald-400/30",
        rail: "bg-emerald-400/55",
        dot: "bg-emerald-300/85",
        label: "complete",
      };
    case "paused":
      return {
        pill: "bg-fg/8 text-fg/65 ring-1 ring-inset ring-fg/20",
        rail: "bg-fg/30",
        dot: "bg-fg/50",
        label: "paused",
      };
    case "blocked":
      return {
        pill: "bg-rose-500/12 text-rose-100 ring-1 ring-inset ring-rose-400/30",
        rail: "bg-rose-400/60",
        dot: "bg-rose-300/90",
        label: "blocked",
      };
    case "usage_limited":
      return {
        pill: "bg-sky-500/12 text-sky-100 ring-1 ring-inset ring-sky-400/30",
        rail: "bg-sky-400/60",
        dot: "bg-sky-300/90",
        label: "usage paused",
      };
    case "cancelled":
      return {
        pill: "bg-fg/8 text-fg/45 ring-1 ring-inset ring-fg/15",
        rail: "bg-fg/20",
        dot: "bg-fg/40",
        label: "cancelled",
      };
    case "budget_limited":
    case "active":
    default:
      return {
        pill: "bg-amber-500/12 text-amber-100 ring-1 ring-inset ring-amber-400/30",
        rail: "bg-amber-400/55",
        dot: "bg-amber-300/85",
        label: "active",
      };
  }
}

export function CodexGoalCard({ goal, onEdit, onClear, pending = false }: CodexGoalCardProps) {
  const objective = (goal.objective ?? "").trim();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(objective);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setDraft(objective);
  }, [editing, objective]);

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, [editing]);

  if (!objective) return null;

  const tokensUsed = Math.max(0, goal.tokensUsed ?? 0);
  const elapsed = formatElapsed(goal.timeUsedSeconds);
  const tone = statusTone(goal.status ?? "active");

  const submitEdit = () => {
    const next = draft.replace(/\s*[\r\n]+\s*/g, " ").trim();
    setEditing(false);
    if (pending || !next || next === objective) return;
    onEdit?.(next);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft(objective);
  };

  return (
    <section className="px-3 pb-3 pt-3">
      <div
        className={cn(
          "relative overflow-hidden rounded-lg border border-amber-400/15 bg-amber-500/[0.04]",
          "pl-3 pr-2 py-2.5",
          pending && "opacity-75",
        )}
      >
        <span
          aria-hidden
          className={cn("absolute inset-y-2 left-0 w-[2px] rounded-full", tone.rail)}
        />

        <header className="flex items-center gap-2">
          <Target
            size={13}
            weight="duotone"
            aria-hidden
            style={{ color: AMBER }}
            className="shrink-0"
          />
          <span className="font-sans text-[10.5px] font-semibold uppercase tracking-[0.08em] text-amber-200/65">
            Goal
          </span>
          <span
            className={cn(
              "ml-auto inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-sans text-[10px] font-medium tracking-tight",
              tone.pill,
            )}
          >
            <span aria-hidden className={cn("h-1 w-1 rounded-full", tone.dot)} />
            {pending ? "updating" : tone.label}
          </span>
        </header>

        {editing ? (
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={submitEdit}
            disabled={pending}
            maxLength={CODEX_GOAL_OBJECTIVE_MAX_CHARS}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelEdit();
              }
            }}
            rows={2}
            className={cn(
              "mt-1.5 block w-full resize-none rounded border border-amber-400/30 bg-amber-950/30",
              "px-2 py-1 font-sans text-[13px] leading-snug text-amber-50",
              "outline-none focus:border-amber-300/60",
            )}
            aria-label="Edit goal objective"
          />
        ) : (
          <button
            type="button"
            onClick={() => onEdit && setEditing(true)}
            title={onEdit ? "Edit goal" : objective}
            disabled={!onEdit || pending}
            className={cn(
              "mt-1.5 block w-full text-left font-sans text-[13px] leading-snug text-amber-50",
              onEdit && !pending && "cursor-text rounded hover:text-amber-100",
              (!onEdit || pending) && "cursor-default",
            )}
          >
            {objective}
          </button>
        )}

        <div className="mt-2 flex items-center gap-2">
          <div aria-hidden className="min-w-0 flex-1" />
          <span className="shrink-0 font-sans text-[10.5px] tabular-nums text-amber-100/70">
            {formatTokens(tokensUsed)}
          </span>
          {elapsed ? (
            <>
              <span aria-hidden className="text-amber-100/25">·</span>
              <span className="shrink-0 font-sans text-[10.5px] tabular-nums text-amber-100/70">
                {elapsed}
              </span>
            </>
          ) : null}
          <div className="ml-1 flex shrink-0 items-center gap-0.5">
            {onEdit && !editing ? (
              <button
                type="button"
                onClick={() => setEditing(true)}
                disabled={pending}
                className={cn(
                  "rounded p-1 text-amber-200/55 transition-colors hover:bg-amber-500/10 hover:text-amber-100",
                  pending && "cursor-default opacity-45 hover:bg-transparent hover:text-amber-200/55",
                )}
                aria-label="Edit goal"
                title="Edit goal"
              >
                <PencilSimple size={11} weight="regular" />
              </button>
            ) : null}
            {onClear ? (
              <button
                type="button"
                onMouseDown={(e) => {
                  if (editing) e.preventDefault();
                }}
                onClick={() => {
                  if (pending) return;
                  setEditing(false);
                  setDraft(objective);
                  onClear();
                }}
                disabled={pending}
                className={cn(
                  "rounded p-1 text-amber-200/55 transition-colors hover:bg-amber-500/10 hover:text-amber-100",
                  pending && "cursor-default opacity-45 hover:bg-transparent hover:text-amber-200/55",
                )}
                aria-label="Clear goal"
                title="Clear goal"
              >
                <X size={11} weight="regular" />
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

export default CodexGoalCard;
