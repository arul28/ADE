import React, { useCallback, useState } from "react";
import { Lightbulb } from "@phosphor-icons/react";
import {
  CTO_LEARNED_AREA_LABEL,
  type CtoLearnedChange,
} from "../../../../shared/types/chat";
import { showToast } from "../../app/toast/toastStore";
import { useChatRuntimeScope } from "../ChatRuntimeScope";
import "./ctoChat.css";

const OP_WORD: Record<CtoLearnedChange["op"], string | null> = {
  added: null,
  changed: "Sharpened",
  removed: "Removed",
};

function changeTitle(change: CtoLearnedChange): string {
  const parts = [change.text];
  if (change.detail) parts.push(change.detail);
  if (change.previous) parts.push(`Was: ${change.previous}`);
  return parts.join("\n");
}

/**
 * What one CTO turn changed in its rules, skills and notes, with an Undo per
 * change. Undo goes to the chat's machine (its pin); the host draws the row
 * again with the change marked undone, so this row keeps no undone state of
 * its own beyond the call in flight.
 */
export function CtoLearnedRow({ learnId, changes }: { learnId: string; changes: readonly CtoLearnedChange[] }) {
  const { pin } = useChatRuntimeScope();
  const [pending, setPending] = useState<string | null>(null);
  const undo = window.ade?.cto?.undoLearned;

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

  return (
    <div className="ade-cto-learned" data-testid="cto-learned-row">
      <div className="ade-cto-learned-head">
        <Lightbulb size={12} weight="regular" className="ade-cto-learned-icon" aria-hidden />
        <span>Learned</span>
      </div>
      <ul className="ade-cto-learned-list">
        {changes.map((change) => {
          const opWord = OP_WORD[change.op];
          return (
            <li
              key={change.id}
              className="ade-cto-learned-item"
              data-undone={change.undone ? "true" : undefined}
              data-op={change.op}
              title={changeTitle(change)}
            >
              <span className="ade-cto-learned-area">{CTO_LEARNED_AREA_LABEL[change.area]}</span>
              <span className="ade-cto-learned-text">
                {opWord ? <span className="ade-cto-learned-op">{opWord} · </span> : null}
                <span className="ade-cto-learned-line">{change.text}</span>
                {change.detail ? <span className="ade-cto-learned-detail"> · {change.detail}</span> : null}
              </span>
              {change.undone ? (
                <span className="ade-cto-learned-undone">Undone</span>
              ) : undo && pin ? (
                <button
                  type="button"
                  className="ade-cto-learned-undo"
                  disabled={pending != null}
                  onClick={() => { void runUndo(change.id); }}
                  aria-label={`Undo: ${change.text}`}
                >
                  {pending === change.id ? "Undoing…" : "Undo"}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
