/**
 * One fleet row, the section header above it, and the row menu inside it.
 *
 * This is `CursorCloudFleetRow.tsx` moved. Every class name, every title
 * attribute and every menu label is the compiled one; what changed is where the
 * facts come from and where the presses go.
 *
 * - The status, the age and the cost were computed here from an agent object
 *   and a usage object. `status`, `active` and `age` now arrive on the entry
 *   already decided by the child, and `cost` arrives already formatted, because
 *   a row drawn on a phone in another time zone must say what the Mac says.
 * - `openExternalUrl` became `openLink`, which asks the HOST to decide between
 *   ADE's own browser and the reader's.
 * - The row's own async work — the usage fetch on expand — is gone. The fleet
 *   reads `pageAgent` once for the selected row and hands the usage down.
 */

import React, { useEffect, useRef, useState } from "react";
import {
  ArrowSquareOut,
  CaretDown,
  GitPullRequest,
  Stop,
  Trash,
} from "@phosphor-icons/react";
import { cn } from "@ade-dev/ui";

import type { CloudFleetEntry, CloudUsage } from "../types";
import { CURSOR_CREATING_SKY, CURSOR_VIOLET, cursorCloudStatusToneClass } from "../lib/cursorCloud";
import { openLink } from "../host/ui";

export function StatusPill({ status }: { status: string }): React.ReactElement {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[1px]",
        cursorCloudStatusToneClass(status),
      )}
    >
      {status}
    </span>
  );
}

export function SectionHeader({
  label,
  count,
  hint,
  accent,
}: {
  label: string;
  count?: number;
  hint?: string;
  accent?: boolean;
}): React.ReactElement {
  return (
    <div className="flex items-baseline gap-2 px-1">
      <span
        className={cn(
          "font-sans text-[10px] font-semibold uppercase tracking-[1px]",
          accent ? "text-violet-200/80" : "text-fg/45",
        )}
      >
        {label}
      </span>
      {count != null ? <span className="font-mono text-[10px] text-fg/30">{count}</span> : null}
      {hint ? <span className="text-[10px] text-fg/30">{hint}</span> : null}
    </div>
  );
}

function OwnershipChip({ entry }: { entry: CloudFleetEntry }): React.ReactElement | null {
  const { ownership } = entry;
  if (!ownership.laneName && !ownership.linearIssueId) return null;
  return (
    <span className="inline-flex max-w-[170px] items-center gap-1 truncate rounded-full border border-white/[0.08] bg-white/[0.03] px-1.5 py-px text-[10px] text-fg/55">
      {ownership.linearIssueId ? (
        <span className="font-medium text-fg/65">{ownership.linearIssueId}</span>
      ) : null}
      {ownership.laneName ? (
        <span className="truncate">
          {ownership.linearIssueId ? `· ${ownership.laneName}` : ownership.laneName}
        </span>
      ) : null}
    </span>
  );
}

export function FleetRow({
  entry,
  expanded,
  selected,
  busy,
  confirmingDelete,
  usage,
  rowError,
  onToggle,
  onOpen,
  onStop,
  onPull,
  onArchive,
  onRequestDelete,
  onConfirmDelete,
}: {
  entry: CloudFleetEntry;
  expanded: boolean;
  selected: boolean;
  busy: boolean;
  confirmingDelete: boolean;
  usage: CloudUsage | undefined;
  rowError: string | null;
  onToggle: () => void;
  onOpen: () => void;
  onStop: () => void;
  onPull: () => void;
  onArchive: () => void;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
}): React.ReactElement {
  const { agent } = entry;
  const status = entry.status;
  const active = entry.active;
  const age = entry.age;
  const cost = usage?.cost ?? null;
  const finished = status === "finished";
  // The child already chose between the branch and the repo label and sent
  // whichever it had; `branch` wins when both exist, exactly as the compiled
  // row's `entry.branch ?? cursorCloudRepoLabel(repos[0])` did.
  const branchOrRepo = entry.branch;

  return (
    <div
      className={cn(
        "group rounded-lg border transition-colors",
        active
          ? "border-violet-300/22 bg-white/[0.02] hover:bg-white/[0.035]"
          : "border-white/[0.06] bg-white/[0.015] hover:border-white/[0.12] hover:bg-white/[0.03]",
        // The selected row is the one the detail pane is showing. Marked with
        // the accent ring rather than a background, so a selected ACTIVE row
        // still reads as active.
        selected && "ring-1 ring-violet-300/35",
      )}
    >
      {/* Div, not button: the row hosts real interactive children (Stop, Open,
          menu) and nested buttons would drop out of the a11y tree. */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle();
          }
        }}
        aria-expanded={expanded}
        className="flex w-full cursor-pointer items-start gap-3 px-3 py-2.5 text-left"
      >
        <span className="relative mt-1.5 flex h-2 w-2 shrink-0">
          {active ? (
            <>
              <span
                className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-50"
                style={{ background: status === "creating" ? CURSOR_CREATING_SKY : CURSOR_VIOLET }}
              />
              <span
                className="relative inline-flex h-2 w-2 rounded-full"
                style={{ background: status === "creating" ? CURSOR_CREATING_SKY : CURSOR_VIOLET }}
              />
            </>
          ) : (
            <span
              className={cn("inline-flex h-2 w-2 rounded-full", {
                "bg-emerald-400/70": status === "finished",
                "bg-red-400/70": status === "error" || status === "expired",
                "bg-white/25": status === "cancelled" || status === "archived",
              })}
            />
          )}
        </span>
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 truncate font-sans text-[12.5px] font-semibold tracking-tight text-fg/88">
              {agent.name || agent.agentId.slice(0, 12)}
            </span>
            <StatusPill status={status} />
            {age ? <span className="shrink-0 font-mono text-[10px] text-fg/35">{age}</span> : null}
            {cost ? (
              <span className="shrink-0 font-mono text-[10px] font-medium text-emerald-200/70">{cost}</span>
            ) : null}
          </span>
          <span className="flex items-center gap-2 font-mono text-[10.5px] text-fg/42">
            {branchOrRepo ? <span className="min-w-0 truncate">{branchOrRepo}</span> : null}
            {entry.modelId ? <span className="shrink-0 text-fg/35">{entry.modelId}</span> : null}
            <OwnershipChip entry={entry} />
            {entry.prUrl ? (
              <span
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation();
                  void openLink(entry.prUrl!);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.stopPropagation();
                    void openLink(entry.prUrl!);
                  }
                }}
                className="inline-flex shrink-0 items-center gap-0.5 text-violet-200/70 hover:text-violet-100"
                title="Open pull request"
              >
                <GitPullRequest size={10} weight="bold" /> PR
              </span>
            ) : null}
          </span>
        </span>
        <span
          className="flex shrink-0 items-center gap-1.5 self-center"
          onClick={(event) => event.stopPropagation()}
        >
          {/*
           * Below 560px the two action buttons are hidden and the SAME two
           * actions appear at the top of the row menu. A phone row is two lines
           * of text plus one 28px target; three targets in that width means the
           * reader hits Stop when they meant to open the agent.
           */}
          {!agent.archived ? (
            <button
              type="button"
              onClick={onOpen}
              disabled={busy}
              className="hidden h-7 items-center gap-1 rounded-md border border-violet-300/25 bg-violet-500/[0.10] px-2 font-sans text-[11px] font-semibold text-violet-100/90 transition-colors hover:border-violet-300/40 hover:bg-violet-500/[0.18] disabled:opacity-40 min-[560px]:inline-flex"
              title="Open as an ADE cloud chat — replies keep running in cloud"
            >
              Open
            </button>
          ) : null}
          {active ? (
            <button
              type="button"
              onClick={onStop}
              disabled={busy}
              className="hidden h-7 items-center gap-1 rounded-md border border-red-400/20 bg-red-500/[0.06] px-2 font-sans text-[10.5px] font-medium text-red-200/85 transition-colors hover:bg-red-500/[0.12] disabled:opacity-40 min-[560px]:inline-flex"
              title="Stop this run — works even if it was launched elsewhere"
            >
              <Stop size={10} weight="fill" /> Stop
            </button>
          ) : null}
          <RowMenu
            entry={entry}
            busy={busy}
            confirmingDelete={confirmingDelete}
            finished={finished}
            active={active}
            onOpen={onOpen}
            onStop={onStop}
            onPull={onPull}
            onArchive={onArchive}
            onRequestDelete={onRequestDelete}
            onConfirmDelete={onConfirmDelete}
            onConfirmDismiss={onRequestDelete}
          />
        </span>
      </div>

      {rowError ? (
        <div className="mx-3 mb-2 rounded-md border border-red-400/20 bg-red-500/[0.06] px-2.5 py-1.5 text-[11px] text-red-200/85">
          {rowError}
        </div>
      ) : null}

      {/*
       * The compiled inline expansion, kept for the wide layout only.
       *
       * Below 860px the detail is a full-screen panel that already carries the
       * summary, the ids, the cursor.com link and the tokens, and drawing them
       * twice under a row nobody can see behind that panel is pure height.
       */}
      {expanded ? (
        <div className="hidden space-y-1.5 border-t border-white/[0.05] px-3.5 py-2.5 min-[860px]:block">
          {agent.summary && agent.summary !== agent.name ? (
            <div className="line-clamp-3 text-[11.5px] leading-relaxed text-fg/60">{agent.summary}</div>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] text-fg/40">
            <span>agent {agent.agentId.slice(0, 14)}…</span>
            {entry.latestRunId ? <span>run {entry.latestRunId.slice(0, 14)}…</span> : null}
            {agent.webUrl ? (
              <button
                type="button"
                onClick={() => void openLink(agent.webUrl!)}
                className="inline-flex items-center gap-1 text-fg/50 hover:text-fg/85"
              >
                <ArrowSquareOut size={9} weight="bold" /> cursor.com
              </button>
            ) : null}
          </div>
          {usage?.totalTokens != null ? (
            <div className="font-mono text-[10px] text-fg/40">
              tokens {usage.totalTokens.toLocaleString()}
              {usage.inputTokens != null
                ? ` · in ${usage.inputTokens.toLocaleString()} out ${usage.outputTokens?.toLocaleString() ?? "0"}`
                : ""}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RowMenu({
  entry,
  busy,
  confirmingDelete,
  finished,
  active,
  onOpen,
  onStop,
  onPull,
  onArchive,
  onRequestDelete,
  onConfirmDelete,
  onConfirmDismiss,
}: {
  entry: CloudFleetEntry;
  busy: boolean;
  confirmingDelete: boolean;
  finished: boolean;
  active: boolean;
  onOpen: () => void;
  onStop: () => void;
  onPull: () => void;
  onArchive: () => void;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
  onConfirmDismiss: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [flipUp, setFlipUp] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      setFlipUp(false);
      return;
    }
    const onDocClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
        // Dismissing the menu without acting must also stand down an armed
        // delete confirmation.
        if (confirmingDelete) onConfirmDismiss();
      }
    };
    // Flip the menu above the trigger when it would overflow the viewport
    // bottom; both anchor and menu live in the same offset-parent space.
    const flip = () => {
      const menu = menuRef.current?.querySelector("[data-row-menu-list]") as HTMLElement | null;
      if (!menu) return;
      const rect = menu.getBoundingClientRect();
      setFlipUp(window.innerHeight - rect.bottom < 8);
    };
    document.addEventListener("mousedown", onDocClick);
    requestAnimationFrame(flip);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open, confirmingDelete, onConfirmDismiss]);

  const itemClass =
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] text-fg/70 transition-colors hover:bg-white/[0.06] hover:text-fg/95 disabled:opacity-40";

  return (
    <div ref={menuRef} className="relative" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        className={cn(
          "inline-flex h-7 w-7 items-center justify-center rounded-md border text-fg/45 transition-colors",
          confirmingDelete
            ? "border-red-400/35 bg-red-500/[0.12] text-red-200/95"
            : "border-white/[0.07] hover:border-white/[0.18] hover:text-fg/85",
          busy && "opacity-40",
        )}
      >
        <CaretDown size={11} weight="bold" />
      </button>
      {open ? (
        <div
          data-row-menu-list
          role="menu"
          className={cn(
            "absolute right-0 z-10 w-[210px] rounded-lg border border-white/[0.10] bg-[#17151f] p-1 shadow-xl shadow-black/50",
            flipUp ? "bottom-8" : "top-8",
          )}
        >
          {/* The narrow layout's home for the two buttons the row hides. */}
          {!entry.agent.archived ? (
            <button
              type="button"
              role="menuitem"
              className={cn(itemClass, "min-[560px]:hidden")}
              onClick={() => { setOpen(false); onOpen(); }}
              disabled={busy}
            >
              Open
            </button>
          ) : null}
          {active ? (
            <button
              type="button"
              role="menuitem"
              className={cn(itemClass, "min-[560px]:hidden")}
              onClick={() => { setOpen(false); onStop(); }}
              disabled={busy}
            >
              <Stop size={12} weight="fill" /> Stop
            </button>
          ) : null}
          {finished && !entry.agent.archived ? (
            <button type="button" role="menuitem" className={itemClass} onClick={() => { setOpen(false); onPull(); }}>
              <GitPullRequest size={12} weight="bold" className="rotate-90" />
              Pull into lane…
            </button>
          ) : null}
          <button type="button" role="menuitem" className={itemClass} onClick={() => { setOpen(false); onArchive(); }} disabled={busy}>
            {entry.agent.archived ? "Unarchive agent" : "Archive agent"}
          </button>
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => { setOpen(false); void openLink(entry.agent.webUrl || "https://cursor.com/agents"); }}
          >
            <ArrowSquareOut size={12} weight="bold" /> View on cursor.com
          </button>
          {entry.prUrl ? (
            <button
              type="button"
              role="menuitem"
              className={itemClass}
              onClick={() => { setOpen(false); void openLink(entry.prUrl!); }}
            >
              <GitPullRequest size={12} weight="bold" /> Open PR
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className={cn(itemClass, confirmingDelete ? "text-red-200/95" : "text-red-300/80 hover:text-red-200")}
            onClick={() => {
              if (confirmingDelete) {
                setOpen(false);
                onConfirmDelete();
              } else {
                onRequestDelete();
              }
            }}
            disabled={busy}
          >
            <Trash size={12} weight="bold" />
            {confirmingDelete ? "Click again to delete forever" : "Delete agent…"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
