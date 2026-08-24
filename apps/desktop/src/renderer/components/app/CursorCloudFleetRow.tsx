import { useEffect, useRef, useState } from "react";
import {
  ArrowSquareOut,
  CaretDown,
  GitPullRequest,
  Stop,
  Trash,
} from "@phosphor-icons/react";

import type { CursorAgentUsage, CursorCloudFleetEntry } from "../../../shared/types";
import {
  cursorCloudFleetDisplayStatus,
  isCursorCloudFleetEntryActive,
} from "../../../shared/cursorCloudFleetStatus";
import { openExternalUrl } from "../../lib/openExternal";
import {
  cursorCloudRepoLabel,
  cursorCloudStatusToneClass,
  formatCursorCloudAge,
} from "../../lib/cursorCloudUtils";
import { cn } from "../ui/cn";

const CURSOR_VIOLET = "#A78BFA";

export function StatusPill({ status }: { status: string }) {
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

function formatCost(usage: CursorAgentUsage | null | undefined): string | null {
  const cents = usage?.cost?.chargedCents ?? usage?.cost?.rawCostCents ?? null;
  if (cents == null || Number.isNaN(cents)) return null;
  if (cents === 0) return "$0";
  return `$${(cents / 100).toFixed(2)}`;
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
}) {
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

function OwnershipChip({ entry }: { entry: CursorCloudFleetEntry }) {
  const { ownership } = entry;
  if (!ownership.laneName && !ownership.linearIssueId) return null;
  return (
    <span className="inline-flex max-w-[170px] items-center gap-1 truncate rounded-full border border-white/[0.08] bg-white/[0.03] px-1.5 py-px text-[10px] text-fg/55">
      {ownership.linearIssueId ? (
        <span className="font-medium text-fg/65">{ownership.linearIssueId}</span>
      ) : null}
      {ownership.laneName ? (
        <span className="truncate">{ownership.linearIssueId ? `· ${ownership.laneName}` : ownership.laneName}</span>
      ) : null}
    </span>
  );
}

export function FleetRow({
  entry,
  expanded,
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
  entry: CursorCloudFleetEntry;
  expanded: boolean;
  busy: boolean;
  confirmingDelete: boolean;
  usage: CursorAgentUsage | undefined;
  rowError: string | null;
  onToggle: () => void;
  onOpen: () => void;
  onStop: () => void;
  onPull: () => void;
  onArchive: () => void;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
}) {
  const { agent } = entry;
  const status = cursorCloudFleetDisplayStatus(entry);
  const active = isCursorCloudFleetEntryActive(entry);
  const age = formatCursorCloudAge(agent.lastModified ?? agent.createdAt);
  const cost = formatCost(usage);
  const finished = status === "finished";
  const branchOrRepo = entry.branch ?? (agent.repos?.[0] ? cursorCloudRepoLabel(agent.repos[0]) : null);

  return (
    <div
      className={cn(
        "group rounded-lg border transition-colors",
        active
          ? "border-violet-300/22 bg-white/[0.02] hover:bg-white/[0.035]"
          : "border-white/[0.06] bg-white/[0.015] hover:border-white/[0.12] hover:bg-white/[0.03]",
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
                style={{ background: status === "creating" ? "#7DD3FC" : CURSOR_VIOLET }}
              />
              <span
                className="relative inline-flex h-2 w-2 rounded-full"
                style={{ background: status === "creating" ? "#7DD3FC" : CURSOR_VIOLET }}
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
                  openExternalUrl(entry.prUrl!);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.stopPropagation();
                    openExternalUrl(entry.prUrl!);
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
          {!agent.archived ? (
            <button
              type="button"
              onClick={onOpen}
              disabled={busy}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-violet-300/25 bg-violet-500/[0.10] px-2 font-sans text-[11px] font-semibold text-violet-100/90 transition-colors hover:border-violet-300/40 hover:bg-violet-500/[0.18] disabled:opacity-40"
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
              className="inline-flex h-7 items-center gap-1 rounded-md border border-red-400/20 bg-red-500/[0.06] px-2 font-sans text-[10.5px] font-medium text-red-200/85 transition-colors hover:bg-red-500/[0.12] disabled:opacity-40"
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
            onPull={onPull}
            onArchive={onArchive}
            onRequestDelete={onRequestDelete}
            onConfirmDelete={onConfirmDelete}
          />
        </span>
      </div>

      {rowError ? (
        <div className="mx-3 mb-2 rounded-md border border-red-400/20 bg-red-500/[0.06] px-2.5 py-1.5 text-[11px] text-red-200/85">
          {rowError}
        </div>
      ) : null}

      {expanded ? (
        <div className="space-y-1.5 border-t border-white/[0.05] px-3.5 py-2.5">
          {agent.summary && agent.summary !== agent.name ? (
            <div className="line-clamp-3 text-[11.5px] leading-relaxed text-fg/60">{agent.summary}</div>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] text-fg/40">
            <span>agent {agent.agentId.slice(0, 14)}…</span>
            {entry.latestRunId ? <span>run {entry.latestRunId.slice(0, 14)}…</span> : null}
            {agent.webUrl ? (
              <button
                type="button"
                onClick={() => openExternalUrl(agent.webUrl!)}
                className="inline-flex items-center gap-1 text-fg/50 hover:text-fg/85"
              >
                <ArrowSquareOut size={9} weight="bold" /> cursor.com
              </button>
            ) : null}
          </div>
          {usage?.totalTokens != null ? (
            <div className="font-mono text-[10px] text-fg/40">
              tokens {usage.totalTokens.toLocaleString()}
              {usage.inputTokens != null ? ` · in ${usage.inputTokens.toLocaleString()} out ${usage.outputTokens?.toLocaleString() ?? "0"}` : ""}
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
  onPull,
  onArchive,
  onRequestDelete,
  onConfirmDelete,
}: {
  entry: CursorCloudFleetEntry;
  busy: boolean;
  confirmingDelete: boolean;
  finished: boolean;
  onPull: () => void;
  onArchive: () => void;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [flipUp, setFlipUp] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      setFlipUp(false);
      return;
    }
    const onDocClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false);
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
  }, [open]);

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
          {finished && !entry.agent.archived ? (
            <button type="button" role="menuitem" className={itemClass} onClick={() => { setOpen(false); onPull(); }}>
              <GitPullRequest size={12} weight="bold" className="rotate-90" />
              Pull into lane…
            </button>
          ) : null}
          <button type="button" role="menuitem" className={itemClass} onClick={() => { setOpen(false); onArchive(); }} disabled={busy}>
            {entry.agent.archived ? "Unarchive agent" : "Archive agent"}
          </button>
          {entry.prUrl ? (
            <button
              type="button"
              role="menuitem"
              className={itemClass}
              onClick={() => { setOpen(false); openExternalUrl(entry.prUrl!); }}
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
