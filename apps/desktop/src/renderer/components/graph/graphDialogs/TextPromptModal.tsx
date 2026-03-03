import React from "react";
import { Button } from "../../ui/Button";
import type { GraphTextPromptState } from "../graphTypes";

export function TextPromptModal({
  textPrompt,
  textPromptError,
  setTextPrompt,
  setTextPromptError,
  cancelTextPrompt,
  submitTextPrompt
}: {
  textPrompt: GraphTextPromptState;
  textPromptError: string | null;
  setTextPrompt: React.Dispatch<React.SetStateAction<GraphTextPromptState | null>>;
  setTextPromptError: React.Dispatch<React.SetStateAction<string | null>>;
  cancelTextPrompt: () => void;
  submitTextPrompt: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[96] flex items-center justify-center bg-black/45 p-4">
      <div className="w-[min(460px,100%)] rounded-lg border border-border/10 bg-card backdrop-blur-sm p-4 shadow-float">
        <div className="text-sm font-semibold text-fg">{textPrompt.title}</div>
        {textPrompt.message ? (
          <div className="mt-1 max-h-[200px] overflow-auto whitespace-pre-wrap rounded-lg border border-border/10 bg-card/60 px-2 py-1 text-[11px] text-muted-fg">
            {textPrompt.message}
          </div>
        ) : null}
        <input
          autoFocus
          value={textPrompt.value}
          onChange={(event) => {
            const nextValue = event.target.value;
            setTextPrompt((prev) => (prev ? { ...prev, value: nextValue } : prev));
            if (textPromptError) setTextPromptError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              cancelTextPrompt();
            } else if (event.key === "Enter") {
              event.preventDefault();
              submitTextPrompt();
            }
          }}
          placeholder={textPrompt.placeholder}
          className="mt-3 h-9 w-full rounded border border-border/15 bg-surface-recessed px-2 text-sm outline-none focus:ring-1 focus:ring-accent"
        />
        {textPromptError ? <div className="mt-2 text-xs text-red-300">{textPromptError}</div> : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={cancelTextPrompt}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={submitTextPrompt}>
            {textPrompt.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
