import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowDown,
  ArrowUp,
  ArrowsInLineVertical,
  CloudArrowDown,
  Columns,
  MagnifyingGlass,
  X,
} from "@phosphor-icons/react";
import type { LaneSummary } from "../../../shared/types";
import { cn } from "../ui/cn";
import { PaneTooltip } from "../ui/PaneTooltip";
import { Z_LAYERS } from "../ui/zLayers";
import { WORK_TOOL_CHROME_BUTTON, WORK_TOOL_CHROME_FOCUS, WorkToolChromeButton } from "../terminals/workToolChrome";
import { useCommitViewPrefs, type CommitColumnId } from "./commitViewPrefs";
import { normalizeBranchName } from "./commitRowModel";
import { stripIpcErrorPrefix } from "./historyClipboard";

/** "3 ahead · 12 behind" against the lane's base; opens the lane in Lanes. */
export function LaneDriftPill({ lane }: { lane: LaneSummary | null }) {
  const navigate = useNavigate();
  if (!lane || lane.laneType === "primary" || !lane.status) return null;
  const ahead = Math.max(0, lane.status.ahead ?? 0);
  const behind = Math.max(0, lane.status.behind ?? 0);
  const base = normalizeBranchName(lane.baseRef) || "base";
  const label = ahead === 0 && behind === 0
    ? `Even with ${base}`
    : `${ahead} ahead of ${base}, ${behind} behind`;
  return (
    <PaneTooltip label={`${label} · open in Lanes`}>
      <button
        type="button"
        onClick={() => navigate(`/lanes?${new URLSearchParams({ laneId: lane.id }).toString()}`)}
        className={cn(
          "inline-flex h-6 shrink-0 items-center gap-2 rounded-full bg-white/[0.05] px-2.5 text-[11.5px] font-medium tabular-nums text-fg/75",
          "transition-colors duration-100 hover:bg-white/[0.09] hover:text-fg",
          WORK_TOOL_CHROME_FOCUS,
        )}
        data-testid="history-lane-drift"
      >
        <span className="inline-flex items-center gap-0.5" style={{ color: ahead > 0 ? "var(--ade-lane-violet, #B9A6F5)" : undefined }}>
          <ArrowUp size={11} weight="bold" aria-hidden />
          {ahead}
        </span>
        <span className="inline-flex items-center gap-0.5" style={{ color: behind > 0 ? "var(--color-warning)" : undefined }}>
          <ArrowDown size={11} weight="bold" aria-hidden />
          {behind}
        </span>
        <span className="max-w-[120px] truncate font-normal text-muted-fg">{base}</span>
      </button>
    </PaneTooltip>
  );
}

/** A magnifier that opens into a field; Esc clears it and closes. */
export function CommitSearchField() {
  const search = useCommitViewPrefs((s) => s.search);
  const setSearch = useCommitViewPrefs((s) => s.setSearch);
  const [open, setOpen] = useState(search.length > 0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  if (!open) {
    return (
      <WorkToolChromeButton label="Search commits" onClick={() => setOpen(true)} testId="history-search-open">
        <MagnifyingGlass size={15} />
      </WorkToolChromeButton>
    );
  }
  return (
    <label
      className="flex h-7 w-[min(260px,32vw)] shrink items-center gap-1.5 rounded-[7px] bg-white/[0.05] px-2 focus-within:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_55%,transparent)]"
    >
      <MagnifyingGlass size={13} className="shrink-0 text-muted-fg" aria-hidden />
      <input
        ref={inputRef}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setSearch("");
            setOpen(false);
          }
        }}
        onBlur={() => {
          if (!search.trim()) setOpen(false);
        }}
        placeholder="Message, author, sha, branch:"
        aria-label="Search commits"
        className="min-w-0 flex-1 bg-transparent text-[12px] text-fg outline-none placeholder:text-muted-fg/50"
        data-testid="history-search-input"
      />
      {search ? (
        <button
          type="button"
          aria-label="Clear search"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setSearch("");
            inputRef.current?.focus();
          }}
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-fg hover:text-fg"
        >
          <X size={11} />
        </button>
      ) : null}
    </label>
  );
}

/** One lane's history, or every lane on one graph. */
export function CommitScopeToggle() {
  const scope = useCommitViewPrefs((s) => s.scope);
  const setScope = useCommitViewPrefs((s) => s.setScope);
  const options = [
    { value: "lane" as const, label: "This lane", tip: "The lane's branch and its base history" },
    { value: "lanes" as const, label: "All lanes", tip: "Every lane's branch on one graph" },
  ];
  return (
    <div role="radiogroup" aria-label="Commits shown" className="flex h-7 shrink-0 items-center rounded-[8px] bg-white/[0.04] p-0.5">
      {options.map((option) => (
        <PaneTooltip key={option.value} label={option.tip}>
          <button
            type="button"
            role="radio"
            aria-checked={scope === option.value}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setScope(option.value)}
            className={cn(
              "h-6 rounded-[6px] px-2 text-[12px] font-medium transition-colors duration-100",
              scope === option.value ? "bg-white/[0.09] text-fg" : "text-muted-fg hover:text-fg",
              WORK_TOOL_CHROME_FOCUS,
            )}
            data-testid={`history-scope-${option.value}`}
          >
            {option.label}
          </button>
        </PaneTooltip>
      ))}
    </div>
  );
}

/** Fold linear runs down to branch tips, merges and fork points. */
export function CommitFoldToggle() {
  const fold = useCommitViewPrefs((s) => s.fold);
  const setFold = useCommitViewPrefs((s) => s.setFold);
  return (
    <WorkToolChromeButton
      label={fold === "tips" ? "Show every commit" : "Fold to branch tips"}
      onClick={() => setFold(fold === "tips" ? "all" : "tips")}
      active={fold === "tips"}
      testId="history-fold"
    >
      <ArrowsInLineVertical size={15} />
    </WorkToolChromeButton>
  );
}

const COLUMN_LABELS: Array<{ id: CommitColumnId; label: string }> = [
  { id: "author", label: "Author" },
  { id: "date", label: "Date" },
  { id: "sha", label: "SHA" },
];

export function CommitColumnsMenu() {
  const columns = useCommitViewPrefs((s) => s.columns);
  const toggleColumn = useCommitViewPrefs((s) => s.toggleColumn);
  return (
    <DropdownMenu.Root modal={false}>
      <PaneTooltip label="Columns">
        <DropdownMenu.Trigger asChild>
          <button type="button" aria-label="Columns" className={WORK_TOOL_CHROME_BUTTON} data-variant="ghost">
            <Columns size={15} />
          </button>
        </DropdownMenu.Trigger>
      </PaneTooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="min-w-[160px] rounded-[9px] border border-white/[0.08] bg-[var(--color-card)] p-1 shadow-xl"
          style={{ zIndex: Z_LAYERS.popover }}
        >
          {COLUMN_LABELS.map((column) => (
            <DropdownMenu.CheckboxItem
              key={column.id}
              checked={columns[column.id]}
              onCheckedChange={() => toggleColumn(column.id)}
              onSelect={(event) => event.preventDefault()}
              className="flex cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-[12px] text-fg outline-none data-[highlighted]:bg-white/[0.07]"
            >
              <span
                aria-hidden
                className={cn(
                  "inline-flex h-3.5 w-3.5 items-center justify-center rounded-[4px] border text-[9px]",
                  columns[column.id] ? "border-transparent bg-[var(--color-accent)] text-white" : "border-white/20",
                )}
              >
                {columns[column.id] ? "✓" : null}
              </span>
              {column.label}
            </DropdownMenu.CheckboxItem>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** `git fetch` for the lane, then refresh the graph. */
export function CommitFetchButton({
  laneId,
  disabledReason,
  onFetched,
}: {
  laneId: string | null;
  disabledReason: string | null;
  onFetched: () => void;
}) {
  const [state, setState] = useState<"idle" | "running" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async () => {
    if (!laneId) return;
    setState("running");
    setError(null);
    try {
      await window.ade.git.fetch({ laneId });
      setState("idle");
      onFetched();
    } catch (err) {
      setState("failed");
      setError(stripIpcErrorPrefix(err));
    }
  }, [laneId, onFetched]);
  useEffect(() => {
    if (state !== "failed") return;
    const timer = window.setTimeout(() => setState("idle"), 5000);
    return () => window.clearTimeout(timer);
  }, [state]);
  const label = disabledReason
    ?? (state === "running" ? "Fetching…" : state === "failed" ? `Fetch failed: ${error ?? ""}` : "Fetch from remote");
  return (
    <WorkToolChromeButton
      label={label}
      onClick={() => void run()}
      disabled={!laneId || Boolean(disabledReason) || state === "running"}
      testId="history-fetch"
      className={state === "failed" ? "text-[var(--color-error)]" : undefined}
    >
      <CloudArrowDown size={15} className={state === "running" ? "animate-pulse" : undefined} />
    </WorkToolChromeButton>
  );
}
