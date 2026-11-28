import React, { useRef, useState } from "react";
import {
  CaretRight,
  CircleNotch,
  FunnelSimple,
  MagnifyingGlass,
  SidebarSimple,
  SlidersHorizontal,
  X,
} from "@phosphor-icons/react";
import type {
  CtoUpdateLinearViewPreferencesArgs,
  LinearDisplayPreferences,
} from "../../../../shared/types";
import { cn } from "../../ui/cn";
import { isImeComposing } from "../../../lib/imeComposition";
import { LinearDisplayMenu } from "./LinearDisplayMenu";
import { LinearMenuSelect, LinearPopover } from "./LinearPopover";

const TOOL_BUTTON =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12.5px] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-fg/30";

export type LinearToolbarTab = { value: string; label: string };

export function LinearListToolbar({
  root,
  current,
  onOpenRail,
  tabs,
  activeTab,
  onTab,
  loading,
  query,
  onQuery,
  searchInputRef,
  filters,
  display,
  pane,
  width,
}: {
  root: { label: string; icon?: React.ReactNode };
  current: string;
  /** Narrow windows hide the rail; this opens it over the list. */
  onOpenRail?: () => void;
  tabs: ReadonlyArray<LinearToolbarTab> | null;
  activeTab: string;
  onTab: (value: string) => void;
  loading: boolean;
  query: string;
  onQuery: (value: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement>;
  filters: {
    assigneeId: string;
    priority: string;
    assigneeOptions: ReadonlyArray<{ value: string; label: string }>;
    priorityOptions: ReadonlyArray<{ value: string; label: string }>;
    onChange: (patch: { assigneeId?: string; priority?: string }) => void;
  };
  display: {
    prefs: LinearDisplayPreferences;
    onChange: (patch: CtoUpdateLinearViewPreferencesArgs["patch"]) => void;
    savedToLinear: boolean | null;
    reason: string | null;
  };
  pane: { visible: boolean; onToggle: () => void } | null;
  /** The list column's width in px (0 = not measured yet): narrower drops the breadcrumb root, then button labels. */
  width: number;
}) {
  const [displayOpen, setDisplayOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const displayRef = useRef<HTMLButtonElement | null>(null);
  const filterRef = useRef<HTMLButtonElement | null>(null);
  const narrow = width > 0 && width < 700;
  const iconOnly = width > 0 && width < 720;
  const activeFilterCount = (filters.assigneeId ? 1 : 0) + (filters.priority ? 1 : 0);

  return (
    <div className={cn("flex h-11 shrink-0 items-center gap-2 border-b border-fg/[0.06] pr-2", onOpenRail ? "pl-2" : "pl-4")}>
      {onOpenRail ? (
        <button
          type="button"
          className={cn(TOOL_BUTTON, "w-7 justify-center px-0 text-muted-fg hover:bg-fg/[0.05] hover:text-fg")}
          title="Show views and projects"
          aria-label="Show views and projects"
          onClick={onOpenRail}
        >
          <SidebarSimple size={15} />
        </button>
      ) : null}
      <nav aria-label="Breadcrumb" className="flex min-w-0 max-w-[45%] shrink items-center gap-1.5 text-[13px]">
        {!narrow ? (
          <>
            <span className="flex min-w-0 items-center gap-1.5 text-fg/80">
              {root.icon}
              <span className="truncate">{root.label}</span>
            </span>
            <CaretRight size={10} className="shrink-0 text-muted-fg/50" />
          </>
        ) : null}
        <span className="truncate font-medium text-fg" aria-current="page">{current}</span>
      </nav>

      {tabs ? (
        <div className="ml-2 flex shrink-0 items-center gap-1" role="tablist" aria-label="Issue tabs">
          {tabs.map((tab) => {
            const selected = tab.value === activeTab;
            return (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={selected}
                className={cn(
                  "h-[26px] rounded-md border px-2.5 text-[12.5px] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-fg/30",
                  selected
                    ? "border-fg/[0.12] bg-fg/[0.08] text-fg"
                    : "border-transparent text-muted-fg hover:bg-fg/[0.04] hover:text-fg/90",
                )}
                onClick={() => onTab(tab.value)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      ) : null}

      {loading ? <CircleNotch size={12} className="shrink-0 animate-spin text-muted-fg/60" aria-label="Loading" /> : null}

      <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1">
        <label className="relative block min-w-[120px] max-w-[220px] flex-1">
          <span className="sr-only">Search issues</span>
          <MagnifyingGlass size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-fg/60" />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (isImeComposing(event)) return;
              // Hand the keyboard back to the list (j/k, Enter, x).
              if (event.key === "ArrowDown" || event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
            placeholder="Search"
            aria-label="Search issues"
            className="h-7 w-full rounded-md border border-transparent bg-fg/[0.04] pl-7 pr-6 text-[12.5px] text-fg outline-none transition-colors placeholder:text-muted-fg/55 hover:bg-fg/[0.06] focus:border-fg/[0.14] focus:bg-transparent"
          />
          {query ? (
            <button
              type="button"
              className="absolute right-1 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-muted-fg/70 hover:text-fg"
              aria-label="Clear search"
              onClick={() => onQuery("")}
            >
              <X size={10} />
            </button>
          ) : (
            <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-sans text-[11px] text-muted-fg/45">/</kbd>
          )}
        </label>

        <button
          ref={filterRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={filterOpen}
          className={cn(TOOL_BUTTON, activeFilterCount > 0 ? "bg-fg/[0.07] text-fg" : "text-muted-fg hover:bg-fg/[0.05] hover:text-fg")}
          title="Filter"
          onClick={() => setFilterOpen((value) => !value)}
        >
          <FunnelSimple size={13} />
          {!iconOnly ? "Filter" : null}
          {activeFilterCount > 0 ? <span className="tabular-nums text-muted-fg">{activeFilterCount}</span> : null}
        </button>
        <LinearPopover open={filterOpen} anchorRef={filterRef} onClose={() => setFilterOpen(false)} label="Filter issues" width={260}>
          <div className="space-y-2 p-3">
            <FilterRow label="Assignee">
              <LinearMenuSelect
                label="Assignee"
                value={filters.assigneeId}
                options={filters.assigneeOptions}
                className="w-[150px]"
                onChange={(assigneeId) => filters.onChange({ assigneeId })}
              />
            </FilterRow>
            <FilterRow label="Priority">
              <LinearMenuSelect
                label="Priority"
                value={filters.priority}
                options={filters.priorityOptions}
                className="w-[150px]"
                onChange={(priority) => filters.onChange({ priority })}
              />
            </FilterRow>
            {activeFilterCount > 0 ? (
              <button
                type="button"
                className="mt-1 text-[12px] text-muted-fg transition-colors hover:text-fg"
                onClick={() => filters.onChange({ assigneeId: "", priority: "" })}
              >
                Clear filters
              </button>
            ) : null}
          </div>
        </LinearPopover>

        <button
          ref={displayRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={displayOpen}
          className={cn(TOOL_BUTTON, "border border-fg/[0.09]", displayOpen ? "bg-fg/[0.07] text-fg" : "text-fg/80 hover:bg-fg/[0.05] hover:text-fg")}
          title="Display"
          onClick={() => setDisplayOpen((value) => !value)}
        >
          <SlidersHorizontal size={13} />
          {!iconOnly ? "Display" : null}
        </button>
        <LinearPopover open={displayOpen} anchorRef={displayRef} onClose={() => setDisplayOpen(false)} label="Display options" width={330}>
          <LinearDisplayMenu
            prefs={display.prefs}
            onChange={display.onChange}
            savedToLinear={display.savedToLinear}
            reason={display.reason}
          />
        </LinearPopover>

        {pane ? (
          <button
            type="button"
            className={cn(TOOL_BUTTON, "w-7 justify-center px-0", pane.visible ? "text-fg/85 hover:bg-fg/[0.05]" : "text-muted-fg hover:bg-fg/[0.05] hover:text-fg")}
            title={pane.visible ? "Hide details" : "Show details"}
            aria-label={pane.visible ? "Hide details" : "Show details"}
            aria-pressed={pane.visible}
            onClick={pane.onToggle}
          >
            <SidebarSimple size={15} mirrored />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12.5px] text-fg/80">{label}</span>
      {children}
    </div>
  );
}
