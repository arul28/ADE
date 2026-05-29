import { useEffect, useRef, useState } from "react";
import type { CodexThreadGoal } from "../../../../shared/types";
import { cn } from "../../ui/cn";

const AMBER = "#F59E0B";

type CodexGoalBannerProps = {
  goal: CodexThreadGoal;
  onEdit?: (nextObjective: string) => void;
  onClear?: () => void;
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

function statusPillClass(status: CodexThreadGoal["status"]): string {
  switch (status) {
    case "complete":
      return "bg-emerald-500/12 text-emerald-200/85 ring-1 ring-inset ring-emerald-400/25";
    case "paused":
      return "bg-fg/8 text-fg/55 ring-1 ring-inset ring-fg/15";
    case "cancelled":
      return "bg-fg/8 text-fg/45 ring-1 ring-inset ring-fg/15";
    case "blocked":
      return "bg-rose-500/12 text-rose-100 ring-1 ring-inset ring-rose-400/25";
    case "usage_limited":
      return "bg-sky-500/12 text-sky-100 ring-1 ring-inset ring-sky-400/25";
    case "budget_limited":
    case "active":
    default:
      return "bg-amber-500/12 text-amber-100 ring-1 ring-inset ring-amber-400/30";
  }
}

function statusLabel(status: CodexThreadGoal["status"]): string {
  if (!status || status === "unknown") return "active";
  if (status === "budget_limited") return "active";
  if (status === "usage_limited") return "usage hit";
  return status.replace("_", " ");
}

export function CodexGoalBanner({ goal, onEdit, onClear }: CodexGoalBannerProps) {
  const objective = (goal.objective ?? "").trim();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(objective);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(objective);
  }, [editing, objective]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  // Render nothing for an empty objective. Keep this after hook calls so we
  // never break the rules of hooks if the parent toggles between empty and
  // populated goal states without unmounting.
  if (!objective) return null;

  const tokensUsed = goal.tokensUsed ?? 0;
  const elapsed = formatElapsed(goal.timeUsedSeconds);
  const status = goal.status ?? "active";

  const submitEdit = () => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === objective) return;
    onEdit?.(next);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft(objective);
  };

  const clearGoal = () => {
    setEditing(false);
    setDraft(objective);
    onClear?.();
  };

  return (
    <div
      role="status"
      className="relative shrink-0 border-b border-amber-300/15 bg-amber-500/[0.045] px-4 py-2.5"
      style={{ boxShadow: "inset 3px 0 0 0 rgba(245,158,11,0.65)" }}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span aria-hidden className="select-none text-[15px] leading-none" style={{ color: AMBER }}>
          {"◎"}
        </span>

        {editing ? (
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={submitEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelEdit();
              }
            }}
            className="min-w-0 flex-1 rounded border border-amber-400/30 bg-amber-950/30 px-2 py-0.5 text-[length:calc(var(--chat-font-size)*12/14)] font-medium leading-tight text-amber-50 outline-none focus:border-amber-300/60"
            aria-label="Edit goal objective"
          />
        ) : onEdit ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            title={objective}
            className="min-w-0 flex-1 cursor-text truncate rounded text-left text-[length:calc(var(--chat-font-size)*12.5/14)] font-medium leading-tight text-amber-50 hover:text-amber-200"
          >
            {objective}
          </button>
        ) : (
          <span
            title={objective}
            className="min-w-0 flex-1 truncate text-[length:calc(var(--chat-font-size)*12.5/14)] font-medium leading-tight text-amber-50"
          >
            {objective}
          </span>
        )}

        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[length:calc(var(--chat-font-size)*10/14)] font-medium capitalize tracking-tight",
            statusPillClass(status),
          )}
        >
          {statusLabel(status)}
        </span>

        {onEdit && !editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="shrink-0 rounded p-1 text-amber-200/55 transition-colors hover:bg-amber-500/10 hover:text-amber-100"
            aria-label="Edit goal"
            title="Edit goal"
          >
            <span aria-hidden className="text-[13px] leading-none">{"✎"}</span>
          </button>
        ) : null}
        {onClear ? (
          <button
            type="button"
            onMouseDown={(e) => {
              if (editing) e.preventDefault();
            }}
            onClick={clearGoal}
            className="shrink-0 rounded p-1 text-amber-200/55 transition-colors hover:bg-amber-500/10 hover:text-amber-100"
            aria-label="Clear goal"
            title="Clear goal"
          >
            <span aria-hidden className="text-[13px] leading-none">{"✕"}</span>
          </button>
        ) : null}
      </div>

      <div className="mt-1.5 flex min-w-0 items-center gap-2 text-[length:calc(var(--chat-font-size)*10.5/14)] text-amber-100/65">
        <div className="h-1 min-w-0 flex-1 rounded-full bg-amber-950/35" aria-hidden />
        <span className="shrink-0 tabular-nums">
          {formatTokens(tokensUsed)}
        </span>
        {elapsed ? (
          <>
            <span aria-hidden className="text-amber-100/25">·</span>
            <span className="shrink-0 tabular-nums">{elapsed}</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

export default CodexGoalBanner;
