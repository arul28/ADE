import React, { useCallback, useId, useState } from "react";
import { Lightbulb } from "@phosphor-icons/react";
import {
  CTO_LEARNED_AREA_LABEL,
  type CtoLearnedArea,
  type CtoLearnedChange,
} from "../../../../shared/types/chat";
import { showToast } from "../../app/toast/toastStore";
import { useChatRuntimeScope } from "../ChatRuntimeScope";
import "./ctoChat.css";

/** The verb a change reads as, by what it changed and how. */
const VERB: Record<CtoLearnedArea, Record<CtoLearnedChange["op"], string>> = {
  project_notes: { added: "Remembered", changed: "Updated a note", removed: "Forgot" },
  user_notes: { added: "Noted about you", changed: "Updated a note about you", removed: "Forgot about you" },
  rules: { added: "New rule", changed: "Sharpened a rule", removed: "Dropped a rule" },
  skill: { added: "Saved a skill", changed: "Updated a skill", removed: "Deleted a skill" },
};

function changeTitle(change: CtoLearnedChange): string {
  const parts = [change.text];
  if (change.detail) parts.push(change.detail);
  if (change.previous) parts.push(`Was: ${change.previous}`);
  return parts.join("\n");
}

/**
 * What one CTO turn changed in its rules, skills and notes: one quiet line
 * ("Remembered · <the note>"), the whole text on hover and on click. A single
 * change has its Undo on the line; several list their own Undo when opened.
 * Undo goes to the chat's machine (its pin); the host draws the row again
 * with the change marked undone, so this row keeps no undone state of its own
 * beyond the call in flight.
 */
export function CtoLearnedRow({ learnId, changes }: { learnId: string; changes: readonly CtoLearnedChange[] }) {
  const { pin } = useChatRuntimeScope();
  const [pending, setPending] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const canUndo = Boolean(window.ade?.cto?.undoLearned && pin);

  const runUndo = useCallback(async (changeId: string) => {
    const call = window.ade?.cto?.undoLearned;
    if (!call || !pin) return;
    setPending(changeId);
    try {
      const result = await call({ learnId, changeId }, pin);
      if (!result.undone) showToast({ tone: "warning", title: "Couldn't undo that", message: result.note });
      else if (result.note) showToast({ tone: "info", title: "Undone", message: result.note });
    } catch (error) {
      showToast({
        tone: "error",
        title: "Couldn't undo that",
        message: error instanceof Error && error.message ? error.message : undefined,
      });
    } finally {
      setPending(null);
    }
  }, [learnId, pin]);

  const first = changes[0];
  if (!first) return null;
  const single = changes.length === 1;
  const allUndone = changes.every((change) => change.undone);
  const more = changes.length - 1;

  const undoControl = (change: CtoLearnedChange) => (change.undone ? (
    <span className="ade-cto-learned-undone">Undone</span>
  ) : canUndo ? (
    <button
      type="button"
      className="ade-cto-learned-undo"
      disabled={pending != null}
      onClick={() => { void runUndo(change.id); }}
      aria-label={`Undo: ${change.text}`}
    >
      {pending === change.id ? "Undoing…" : "Undo"}
    </button>
  ) : null);

  return (
    <div className="ade-cto-learned" data-testid="cto-learned-row" data-open={open ? "true" : undefined}>
      <div className="ade-cto-learned-line" data-undone={allUndone ? "true" : undefined}>
        <button
          type="button"
          className="ade-cto-learned-toggle"
          aria-expanded={open}
          aria-controls={detailId}
          title={changes.map(changeTitle).join("\n\n")}
          onClick={() => setOpen((value) => !value)}
        >
          <Lightbulb size={12} weight="regular" className="ade-cto-learned-icon" aria-hidden />
          <span className="ade-cto-learned-verb">{VERB[first.area][first.op]}</span>
          <span className="ade-cto-learned-text" data-op={first.op}>{first.text}</span>
          {more > 0 ? <span className="ade-cto-learned-more">+{more} more</span> : null}
        </button>
        {single ? undoControl(first) : null}
      </div>
      {open ? (
        <ul id={detailId} className="ade-cto-learned-list">
          {changes.map((change) => (
            <li
              key={change.id}
              className="ade-cto-learned-item"
              data-undone={change.undone ? "true" : undefined}
              data-op={change.op}
            >
              <span className="ade-cto-learned-body">
                <span className="ade-cto-learned-area">{single ? CTO_LEARNED_AREA_LABEL[change.area] : VERB[change.area][change.op]}</span>
                <span className="ade-cto-learned-full">{change.text}</span>
                {change.detail ? <span className="ade-cto-learned-aside">{change.detail}</span> : null}
                {change.previous ? <span className="ade-cto-learned-aside">Was: {change.previous}</span> : null}
              </span>
              {single ? null : undoControl(change)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
