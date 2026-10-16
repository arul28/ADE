import React, { useEffect, useRef, useState } from "react";
import { CircleNotch, PencilSimple } from "@phosphor-icons/react";
import { isMacRuntimeTarget } from "../../lib/platform";
import { showToast } from "../app/toast/toastStore";
import { cn } from "../ui/cn";
import { IssueMarkdown } from "./issueMarkdown";

/**
 * Inline editing shared by every issue provider: the title, the description,
 * and the comment box. Each one saves through a promise the host supplies, so
 * the host owns the optimistic copy and the rollback; these only own the
 * draft, the busy state and the keys.
 *
 * Read-only when `onSave` / `onSubmit` is absent; `readOnlyReason` says why in
 * a tooltip instead of hiding the control.
 */

const MOD_LABEL = () => (isMacRuntimeTarget() ? "⌘" : "Ctrl");

function isSubmitKey(event: React.KeyboardEvent): boolean {
  return event.key === "Enter" && (isMacRuntimeTarget() ? event.metaKey : event.ctrlKey);
}

async function run(save: () => Promise<void>, what: string): Promise<boolean> {
  try {
    await save();
    return true;
  } catch (error) {
    showToast({
      tone: "error",
      title: `Couldn't save the ${what}`,
      message: error instanceof Error ? error.message : "The change was rejected.",
    });
    return false;
  }
}

export function EditableIssueTitle({
  value,
  suffix,
  onSave,
  readOnlyReason,
}: {
  value: string;
  /** Shown after the title, never edited (GitHub's `#123`). */
  suffix?: React.ReactNode;
  onSave?: (title: string) => Promise<void>;
  readOnlyReason?: string | null;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (draft != null) inputRef.current?.focus();
  }, [draft != null]); // eslint-disable-line react-hooks/exhaustive-deps -- focus once when editing starts
  // Grow with the text, so a long title is never cut off while it is edited.
  useEffect(() => {
    const input = inputRef.current;
    if (!input || draft == null) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, [draft]);

  const save = async () => {
    const next = draft?.trim() ?? "";
    if (!onSave || !next || next === value) {
      setDraft(null);
      return;
    }
    setBusy(true);
    if (await run(() => onSave(next), "title")) setDraft(null);
    setBusy(false);
  };

  if (draft != null) {
    return (
      <textarea
        ref={inputRef}
        className="w-full resize-none overflow-hidden rounded-md border border-[color:var(--color-accent)] bg-transparent px-1.5 py-1 text-[19px] font-semibold leading-tight tracking-[-0.01em] text-fg outline-none"
        rows={1}
        value={draft}
        disabled={busy}
        aria-label="Issue title"
        onChange={(event) => setDraft(event.target.value.replace(/\n/g, " "))}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void save();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setDraft(null);
          }
        }}
      />
    );
  }

  return (
    <h2
      className={cn(
        "group text-[19px] font-semibold leading-tight tracking-[-0.01em] text-fg/95",
        onSave && "-mx-1.5 cursor-text rounded-md px-1.5 hover:bg-[color:var(--kit-hover)]",
      )}
      title={onSave ? "Click to edit the title" : readOnlyReason ?? undefined}
      onClick={onSave ? () => setDraft(value) : undefined}
    >
      {value}
      {suffix}
    </h2>
  );
}

export function EditableIssueBody({
  value,
  onSave,
}: {
  value: string;
  onSave?: (body: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const body = value.trim();

  const save = async () => {
    if (!onSave || draft == null) return;
    if (draft === value) {
      setDraft(null);
      return;
    }
    setBusy(true);
    if (await run(() => onSave(draft), "description")) setDraft(null);
    setBusy(false);
  };

  if (draft != null) {
    return (
      <div className="flex flex-col gap-2">
        <textarea
          autoFocus
          className="min-h-[180px] w-full resize-y rounded-md border border-[color:var(--kit-rule)] bg-transparent p-2 font-mono text-[12px] leading-relaxed text-fg outline-none focus:border-[color:var(--color-accent)]"
          value={draft}
          disabled={busy}
          aria-label="Issue description"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (isSubmitKey(event)) {
              event.preventDefault();
              void save();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setDraft(null);
            }
          }}
        />
        <div className="flex items-center justify-end gap-1.5">
          <span className="mr-auto text-[11px] text-[color:var(--kit-text-3)]">Markdown · {MOD_LABEL()}↵ saves</span>
          <button type="button" className="kit-btn kit-btn-ghost" disabled={busy} onClick={() => setDraft(null)}>Cancel</button>
          <button type="button" className="kit-btn kit-btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? <CircleNotch size={12} className="animate-spin" /> : null}
            Save
          </button>
        </div>
      </div>
    );
  }

  // The edit control sits under the text, not at its right edge: the
  // properties box floats over that edge in the wide layout.
  return (
    <div>
      {body ? (
        <IssueMarkdown>{body}</IssueMarkdown>
      ) : (
        <p className="text-[12.5px] italic text-[color:var(--kit-text-3)]">No description.</p>
      )}
      {onSave ? (
        <button
          type="button"
          className="mt-1.5 inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-[color:var(--kit-text-3)] hover:bg-[color:var(--kit-hover)] hover:text-fg"
          onClick={() => setDraft(value)}
        >
          <PencilSimple size={11} />
          {body ? "Edit description" : "Add a description"}
        </button>
      ) : null}
    </div>
  );
}

export function IssueCommentComposer({
  onSubmit,
  readOnlyReason,
}: {
  onSubmit?: (body: string) => Promise<void>;
  readOnlyReason?: string | null;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const body = draft.trim();
    if (!onSubmit || !body || busy) return;
    setBusy(true);
    if (await run(() => onSubmit(body), "comment")) setDraft("");
    setBusy(false);
  };
  if (!onSubmit) {
    return readOnlyReason
      ? <p className="mt-3 text-[11px] text-[color:var(--kit-text-3)]">{readOnlyReason}</p>
      : null;
  }
  return (
    <div className="mt-3 flex flex-col gap-1.5 rounded-md border border-[color:var(--kit-rule)] p-2 focus-within:border-[color:var(--color-accent)]">
      <textarea
        className="min-h-[56px] w-full resize-y bg-transparent text-[12px] leading-relaxed text-fg outline-none placeholder:text-[color:var(--kit-text-3)]"
        placeholder="Leave a comment…"
        value={draft}
        disabled={busy}
        aria-label="Comment"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (isSubmitKey(event)) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-[11px] text-[color:var(--kit-text-3)]">{MOD_LABEL()}↵ sends</span>
        <button type="button" className="kit-btn kit-btn-primary" disabled={busy || !draft.trim()} onClick={() => void submit()}>
          {busy ? <CircleNotch size={12} className="animate-spin" /> : null}
          Comment
        </button>
      </div>
    </div>
  );
}
