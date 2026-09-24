import { useEffect, useRef, useState } from "react";
import { PencilSimple } from "@phosphor-icons/react";
import type { CodexThreadGoal } from "../../../../shared/types";
import { CodexLogo } from "../../terminals/ToolLogos";
import { Banner, NoticeBadge, type NoticeAction, type NoticeTone } from "../../ui/notice";

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

function statusTone(status: CodexThreadGoal["status"]): NoticeTone {
  switch (status) {
    case "complete":
      return "success";
    case "paused":
    case "cancelled":
      return "neutral";
    case "blocked":
      return "error";
    case "usage_limited":
      return "info";
    case "budget_limited":
    case "active":
    default:
      return "warning";
  }
}

function statusLabel(status: CodexThreadGoal["status"]): string {
  if (!status || status === "unknown") return "active";
  if (status === "budget_limited") return "active";
  if (status === "usage_limited") return "usage paused";
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

  const tone = statusTone(status);

  const title = editing ? (
    <input
      ref={inputRef}
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => {
        // Tabbing to the × clears the goal; committing the draft first would
        // send a second write. (A mouse press on × is stopped in onMouseDownCapture.)
        if ((e.relatedTarget as HTMLElement | null)?.closest(".ade-notice-close")) return;
        submitEdit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submitEdit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelEdit();
        }
      }}
      className="w-full min-w-0 rounded-md border border-border bg-transparent px-2 py-0.5 font-medium leading-tight text-fg outline-none focus:border-accent"
      aria-label="Edit goal objective"
    />
  ) : onEdit ? (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title={objective}
      className="block max-w-full cursor-text truncate border-none bg-transparent p-0 text-left font-[inherit] text-inherit"
    >
      {objective}
    </button>
  ) : (
    <span title={objective} className="block max-w-full truncate">
      {objective}
    </span>
  );

  const actions: NoticeAction[] = [];
  if (onEdit && !editing) {
    actions.push({
      label: "Edit goal",
      variant: "link",
      icon: <PencilSimple size={12} />,
      onClick: () => setEditing(true),
    });
  }

  return (
    // Pressing the clear (×) while editing must not blur the input first: the
    // blur would commit the draft, and clearing throws the goal away anyway.
    <div
      style={{ display: "contents" }}
      onMouseDownCapture={(e) => {
        if (editing && (e.target as HTMLElement).closest(".ade-notice-close")) e.preventDefault();
      }}
    >
      <Banner
        layout="inline"
        style={{ margin: "6px 8px", flexShrink: 0 }}
        model={{
          id: "codex-goal",
          tone,
          icon: <CodexLogo size={13} />,
          ariaLabel: objective,
          title,
          actions,
          dismiss: onClear ? { onDismiss: clearGoal, title: "Clear goal", label: "Clear goal" } : false,
          extra: (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] tabular-nums text-muted-fg">
              <NoticeBadge tone={tone}><span className="capitalize">{statusLabel(status)}</span></NoticeBadge>
              <span>{formatTokens(tokensUsed)}</span>
              {elapsed ? (
                <>
                  <span aria-hidden>·</span>
                  <span>{elapsed}</span>
                </>
              ) : null}
            </div>
          ),
        }}
      />
    </div>
  );
}

export default CodexGoalBanner;
