import React, { useRef, useState } from "react";
import { CheckCircle, Circle, Plus, X } from "@phosphor-icons/react";
import {
  CTO_OPEN_WORK_MAX_OPEN,
  type CtoOpenWorkItem,
  type CtoUpdateOpenWorkArgs,
} from "../../../shared/types";
import { cn } from "../ui/cn";
import { CtoEmptyLine } from "./ctoSettingsUi";

/** The panel's compact-row grid: 8px inset, a 16px glyph column, 10px gap. */
const ROW = "flex min-w-0 items-center gap-2.5 rounded-md px-2";

/**
 * The CTO's open work as a checklist: the CTO page's side panel and
 * Settings › Memory both draw this one.
 *
 * Open items first, then finished ones, muted. Ticking an item completes it,
 * unticking reopens it; the × removes it. "Add" opens an inline field that
 * stays open for the next item until Escape or an empty blur.
 */
export type CtoOpenWorkListProps = {
  items: CtoOpenWorkItem[];
  onChange: (args: CtoUpdateOpenWorkArgs) => Promise<void>;
  /** The side panel's denser rows; shows at most three finished items. */
  compact?: boolean;
};

const COMPACT_DONE_LIMIT = 3;

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "Couldn't update open work.";
}

export function CtoOpenWorkList({ items, onChange, compact = false }: CtoOpenWorkListProps) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const open = items.filter((item) => !item.doneAt);
  const doneAll = items.filter((item) => item.doneAt);
  const done = compact ? doneAll.slice(0, COMPACT_DONE_LIMIT) : doneAll;
  const full = open.length >= CTO_OPEN_WORK_MAX_OPEN;

  const run = async (key: string, args: CtoUpdateOpenWorkArgs) => {
    setBusyId(key);
    setError(null);
    try {
      await onChange(args);
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const submit = async () => {
    const text = draft.trim();
    if (!text) {
      setAdding(false);
      return;
    }
    if (await run("__add__", { op: "add", text })) {
      setDraft("");
      inputRef.current?.focus();
    }
  };

  const textSize = compact ? "text-[12px]" : "text-[12.5px]";

  const row = (item: CtoOpenWorkItem) => {
    const isDone = Boolean(item.doneAt);
    const busy = busyId === item.id;
    return (
      <li
        key={item.id}
        className={cn(
          ROW,
          "group transition-colors hover:bg-[var(--kit-hover)]",
          compact ? "py-1" : "py-1.5",
          busy && "opacity-60",
        )}
      >
        <button
          type="button"
          role="checkbox"
          aria-checked={isDone}
          aria-label={isDone ? `Reopen "${item.text}"` : `Mark "${item.text}" done`}
          disabled={busy}
          onClick={() => void run(item.id, { op: isDone ? "reopen" : "complete", id: item.id })}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[var(--kit-text-3)] transition-colors hover:text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-[var(--cto-accent-line,currentColor)]"
        >
          {isDone
            ? <CheckCircle size={16} weight="fill" style={{ color: "var(--cto-accent, var(--color-accent))" }} />
            : <Circle size={16} />}
        </button>
        <span
          className={cn(
            "min-w-0 flex-1 truncate leading-[18px]",
            textSize,
            isDone ? "text-[var(--kit-text-3)] line-through decoration-fg/25" : "text-fg",
          )}
          title={item.text}
        >
          {item.text}
        </span>
        <button
          type="button"
          aria-label={`Remove "${item.text}"`}
          disabled={busy}
          onClick={() => void run(item.id, { op: "remove", id: item.id })}
          className="kit-icon-btn shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          style={{ width: 18, height: 18 }}
        >
          <X size={11} weight="bold" />
        </button>
      </li>
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {items.length === 0 && !adding ? (
        <CtoEmptyLine icon={<CheckCircle size={14} />}>All clear</CtoEmptyLine>
      ) : null}
      {open.length > 0 || done.length > 0 ? (
        <ul className="m-0 flex list-none flex-col p-0">
          {open.map(row)}
          {done.map(row)}
        </ul>
      ) : null}
      {adding ? (
        <div className={cn(ROW, "py-0.5")}>
          <Circle size={16} className="shrink-0 text-[var(--kit-text-3)]" aria-hidden />
          <input
            ref={inputRef}
            autoFocus
            className="kit-input min-w-0 flex-1"
            data-size="sm"
            value={draft}
            placeholder="What needs doing?"
            aria-label="New open work item"
            disabled={busyId === "__add__"}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              } else if (event.key === "Escape") {
                setDraft("");
                setAdding(false);
              }
            }}
            onBlur={() => { if (!draft.trim()) setAdding(false); }}
          />
        </div>
      ) : (
        <button
          type="button"
          disabled={full}
          title={full ? `Full: ${CTO_OPEN_WORK_MAX_OPEN} open items` : undefined}
          onClick={() => { setError(null); setAdding(true); }}
          className={cn(
            ROW,
            "h-7 self-start pr-2.5 text-[12px] text-[var(--kit-text-2)] outline-none transition-colors hover:bg-[var(--kit-hover)] hover:text-fg focus-visible:ring-1 focus-visible:ring-[var(--cto-accent-line,currentColor)] disabled:opacity-50",
          )}
        >
          <span className="flex w-4 shrink-0 justify-center" aria-hidden><Plus size={12} weight="bold" /></span>
          Add
        </button>
      )}
      {error ? <CtoEmptyLine tone="crit" hint={error}>{error}</CtoEmptyLine> : null}
    </div>
  );
}
