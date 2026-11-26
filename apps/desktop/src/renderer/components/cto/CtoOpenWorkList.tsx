import React, { useRef, useState } from "react";
import { CaretRight, ChatCircle, CheckCircle, Circle, GitPullRequest, Plus, X } from "@phosphor-icons/react";
import {
  CTO_OPEN_WORK_MAX_OPEN,
  type CtoOpenWorkItem,
  type CtoOpenWorkOwner,
  type CtoUpdateOpenWorkArgs,
} from "../../../shared/types";
import { ipcErrorMessage } from "../../lib/format";
import { cn } from "../ui/cn";
import { CtoEmptyLine } from "./ctoSettingsUi";

/** The panel's compact-row grid: 8px inset, a 16px glyph column, 10px gap. */
const ROW = "flex min-w-0 items-center gap-2.5 rounded-md px-2";

/**
 * The CTO's open work as a checklist: the CTO page's side panel and
 * Settings › Memory both draw this one.
 *
 * Three groups: what waits on the person, what the CTO is tracking, and what
 * finished (today, folded, in the side panel). Each row shows its short title
 * with the detail under it, both wrapping to two lines, and the chat or PR it
 * is linked to; a linked item closes itself when that chat or PR is done.
 * Ticking an item completes it, unticking reopens it; the × removes it. "Add"
 * opens an inline field that stays open for the next item until Escape or an
 * empty blur.
 */
export type CtoOpenWorkListProps = {
  items: CtoOpenWorkItem[];
  onChange: (args: CtoUpdateOpenWorkArgs) => Promise<void>;
  /** The side panel's denser rows; finished items are today's only, folded. */
  compact?: boolean;
};

function ownerOf(item: CtoOpenWorkItem): CtoOpenWorkOwner {
  return item.owner ?? "cto";
}

function isToday(iso: string | null): boolean {
  if (!iso) return false;
  const at = new Date(iso);
  return !Number.isNaN(at.getTime()) && at.toDateString() === new Date().toDateString();
}

function linkLabel(item: CtoOpenWorkItem): { icon: React.ReactNode; text: string } | null {
  const link = item.link;
  if (!link) return null;
  if (link.kind === "pr") return { icon: <GitPullRequest size={11} aria-hidden />, text: `#${link.number}` };
  return { icon: <ChatCircle size={11} aria-hidden />, text: link.machineId ? "Chat on another machine" : "Chat" };
}

export function CtoOpenWorkList({ items, onChange, compact = false }: CtoOpenWorkListProps) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftOwner, setDraftOwner] = useState<CtoOpenWorkOwner>("cto");
  const [doneOpen, setDoneOpen] = useState(!compact);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Not memoized: "today" moves at midnight while `items` stays the same, and
  // the list is a few dozen rows.
  const open = items.filter((item) => !item.doneAt);
  const done = items.filter((item) => item.doneAt);
  const groups = {
    waiting: open.filter((item) => ownerOf(item) === "user"),
    tracking: open.filter((item) => ownerOf(item) === "cto"),
    open,
    done: compact ? done.filter((item) => isToday(item.doneAt)) : done,
  };
  const full = groups.open.length >= CTO_OPEN_WORK_MAX_OPEN;

  const run = async (key: string, args: CtoUpdateOpenWorkArgs) => {
    setBusyId(key);
    setError(null);
    try {
      await onChange(args);
      return true;
    } catch (err) {
      setError(ipcErrorMessage(err) || "Couldn't update open work.");
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
    if (await run("__add__", { op: "add", text, owner: draftOwner })) {
      setDraft("");
      inputRef.current?.focus();
    }
  };

  const titleSize = compact ? "text-[12px]" : "text-[12.5px]";

  const row = (item: CtoOpenWorkItem) => {
    const isDone = Boolean(item.doneAt);
    const busy = busyId === item.id;
    const title = item.title?.trim() || null;
    const detail = title ? item.text : null;
    const link = linkLabel(item);
    const outcome = isDone ? item.outcome?.trim() || null : null;
    const name = title ?? item.text;
    return (
      <li
        key={item.id}
        className={cn(
          "group flex min-w-0 items-start gap-2.5 rounded-md px-2 transition-colors hover:bg-[var(--kit-hover)]",
          compact ? "py-1" : "py-1.5",
          busy && "opacity-60",
        )}
        title={[title, item.text, outcome].filter(Boolean).join("\n")}
      >
        <button
          type="button"
          role="checkbox"
          aria-checked={isDone}
          aria-label={isDone ? `Reopen "${name}"` : `Mark "${name}" done`}
          disabled={busy}
          onClick={() => void run(item.id, { op: isDone ? "reopen" : "complete", id: item.id })}
          className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[var(--kit-text-3)] transition-colors hover:text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-[var(--cto-accent-line,currentColor)]"
        >
          {isDone
            ? <CheckCircle size={16} weight="fill" style={{ color: "var(--cto-accent, var(--color-accent))" }} />
            : <Circle size={16} />}
        </button>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn(
              "line-clamp-2 break-words leading-[18px]",
              titleSize,
              isDone ? "text-[var(--kit-text-3)]" : "text-fg",
            )}
          >
            {name}
          </span>
          {detail && !isDone ? (
            <span className="line-clamp-2 break-words text-[11px] leading-[15px] text-[var(--kit-text-3)]">{detail}</span>
          ) : null}
          {link || outcome ? (
            <span className="flex min-w-0 items-center gap-1.5 text-[11px] leading-[15px] text-[var(--kit-text-3)]">
              {link ? (
                <span className="inline-flex shrink-0 items-center gap-1 text-[var(--kit-text-2)]">
                  {link.icon}
                  {link.text}
                </span>
              ) : null}
              {outcome ? <span className="min-w-0 truncate">{outcome}</span> : null}
            </span>
          ) : null}
        </span>
        <button
          type="button"
          aria-label={`Remove "${name}"`}
          disabled={busy}
          onClick={() => void run(item.id, { op: "remove", id: item.id })}
          className="kit-icon-btn mt-px shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          style={{ width: 18, height: 18 }}
        >
          <X size={11} weight="bold" />
        </button>
      </li>
    );
  };

  const group = (label: string, list: CtoOpenWorkItem[]) => (list.length ? (
    <div className="flex min-w-0 flex-col gap-0.5" role="group" aria-label={label}>
      <h4 className="m-0 px-2 pt-1 text-[11px] font-medium leading-[16px] text-[var(--kit-text-3)]">
        {label}
        <span className="ml-1.5 tabular-nums opacity-70">{list.length}</span>
      </h4>
      <ul className="m-0 flex list-none flex-col p-0">{list.map(row)}</ul>
    </div>
  ) : null);

  const doneLabel = compact ? "Done today" : "Done";

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {groups.open.length === 0 && !adding ? (
        <CtoEmptyLine icon={<CheckCircle size={14} />}>All clear</CtoEmptyLine>
      ) : null}
      {group("Waiting on you", groups.waiting)}
      {group("I'm tracking", groups.tracking)}
      {adding ? (
        <div className={cn(ROW, "py-0.5")}>
          <Circle size={16} className="shrink-0 text-[var(--kit-text-3)]" aria-hidden />
          <input
            ref={inputRef}
            autoFocus
            className="kit-input min-w-0 flex-1"
            data-size="sm"
            value={draft}
            placeholder={draftOwner === "user" ? "What do you need to do?" : "What should the CTO track?"}
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
            onBlur={(event) => {
              // Picking who it is for is part of adding, not leaving.
              if (event.relatedTarget instanceof HTMLElement && event.relatedTarget.dataset.ownerPick) return;
              if (!draft.trim()) setAdding(false);
            }}
          />
          <button
            type="button"
            data-owner-pick="true"
            className="shrink-0 rounded px-1.5 text-[11px] leading-[18px] text-[var(--kit-text-2)] outline-none transition-colors hover:bg-[var(--kit-hover)] hover:text-fg focus-visible:ring-1 focus-visible:ring-[var(--cto-accent-line,currentColor)]"
            title="Who this waits on"
            onClick={() => {
              setDraftOwner((owner) => (owner === "cto" ? "user" : "cto"));
              inputRef.current?.focus();
            }}
          >
            {draftOwner === "user" ? "For you" : "For the CTO"}
          </button>
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
      {groups.done.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-0.5">
          <button
            type="button"
            aria-expanded={doneOpen}
            onClick={() => setDoneOpen((value) => !value)}
            className="flex items-center gap-1 self-start rounded px-2 text-[11px] font-medium leading-[20px] text-[var(--kit-text-3)] outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-[var(--cto-accent-line,currentColor)]"
          >
            <CaretRight size={9} weight="bold" aria-hidden className={cn("transition-transform", doneOpen && "rotate-90")} />
            {doneLabel}
            <span className="ml-0.5 tabular-nums opacity-70">{groups.done.length}</span>
          </button>
          {doneOpen ? <ul className="m-0 flex list-none flex-col p-0">{groups.done.map(row)}</ul> : null}
        </div>
      ) : null}
      {error ? <CtoEmptyLine tone="crit" hint={error}>{error}</CtoEmptyLine> : null}
    </div>
  );
}
