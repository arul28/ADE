/**
 * The canvas header: view modes, search, filters, and the two toggles.
 *
 * Lifted verbatim out of `WorkspaceGraphPage`'s JSX. It is a separate component
 * only because the page it came from was one 4,900-line function — nothing here
 * decides anything, every control is a callback the canvas owns.
 */

import React from "react";
import { Funnel, MagnifyingGlass } from "@phosphor-icons/react";
import { Button, Chip, cn } from "@ade-dev/ui";

import type { GraphFilterState, GraphStatusFilter, GraphViewMode, LaneSummary } from "../lib/types";
import { VIEW_MODES, VIEW_MODE_META, activeGraphFilterCount } from "../lib/graphHelpers";

export function GraphToolbar({
  viewMode,
  onViewMode,
  filters,
  onFilters,
  matchingCount,
  onFocusResults,
  onResetView,
  showOverviewRiskEdges,
  onToggleOverviewRiskEdges,
  showRiskMatrix,
  onToggleRiskMatrix,
  rootLaneOptions,
  availableTags,
  overflowNote,
  filtersPanelRef,
  showFiltersPanel,
  onToggleFiltersPanel,
}: {
  viewMode: GraphViewMode;
  onViewMode: (mode: GraphViewMode) => void;
  filters: GraphFilterState;
  onFilters: (updater: (filters: GraphFilterState) => GraphFilterState) => void;
  matchingCount: number;
  onFocusResults: () => void;
  onResetView: () => void;
  showOverviewRiskEdges: boolean;
  onToggleOverviewRiskEdges: () => void;
  showRiskMatrix: boolean;
  onToggleRiskMatrix: () => void;
  rootLaneOptions: LaneSummary[];
  availableTags: string[];
  overflowNote: string;
  filtersPanelRef: React.RefObject<HTMLDivElement | null>;
  showFiltersPanel: boolean;
  onToggleFiltersPanel: () => void;
}): React.ReactElement {
  const filtersActiveCount = activeGraphFilterCount(filters);
  const activeViewMeta = VIEW_MODE_META[viewMode];

  return (
    <div className="absolute left-0 right-0 top-0 z-20 border-b border-white/[0.06] bg-white/[0.03] backdrop-blur-xl px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-xl bg-white/[0.02] p-0.5">
          {VIEW_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-semibold transition-colors",
                viewMode === mode ? "bg-accent text-accent-fg" : "text-muted-fg hover:text-fg",
              )}
              onClick={() => onViewMode(mode)}
            >
              {VIEW_MODE_META[mode].label}
            </button>
          ))}
        </div>

        <div className="relative ml-2">
          <MagnifyingGlass
            size={14}
            weight="regular"
            className="pointer-events-none absolute left-2 top-1.5 text-muted-fg"
          />
          <input
            aria-label="Filter lanes or tags"
            value={filters.search}
            onChange={(event) => {
              const value = event.target.value;
              onFilters((current) => ({ ...current, search: value }));
            }}
            placeholder="Filter lanes or tags"
            className="h-7 w-[220px] rounded-xl border border-white/[0.08] bg-white/[0.02] pl-7 pr-2 text-xs text-fg outline-none placeholder:text-muted-fg/50"
          />
        </div>

        {filters.search.trim().length > 0 ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            disabled={matchingCount === 0}
            onClick={onFocusResults}
          >
            Focus Results
          </Button>
        ) : null}

        <div className="relative ml-auto" ref={filtersPanelRef}>
          <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={onToggleFiltersPanel}>
            <Funnel size={14} weight="regular" />
            Filters
            {filtersActiveCount > 0 ? (
              <span className="rounded-full bg-accent px-1.5 py-0 text-[10px] text-accent-fg">
                {filtersActiveCount}
              </span>
            ) : null}
          </Button>
          {showFiltersPanel ? (
            <div className="absolute right-0 top-8 z-40 w-[360px] rounded-xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl p-2 text-xs shadow-float">
              <div className="mb-2">
                <div className="mb-1 text-[11px] uppercase tracking-wider text-muted-fg">Status</div>
                <div className="flex flex-wrap gap-1">
                  {(["conflict", "at-risk", "clean", "unknown"] as GraphStatusFilter[]).map((status) => (
                    <Chip
                      key={status}
                      role="button"
                      onClick={() =>
                        onFilters((current) => ({
                          ...current,
                          status: current.status.includes(status)
                            ? current.status.filter((entry) => entry !== status)
                            : [...current.status, status],
                        }))}
                      className={cn(
                        "cursor-pointer",
                        filters.status.includes(status)
                          && (status === "conflict"
                            ? "bg-red-500/30 text-red-200"
                            : status === "at-risk"
                              ? "bg-amber-500/30 text-amber-200"
                              : status === "clean"
                                ? "bg-emerald-500/25 text-emerald-200"
                                : "bg-white/[0.06] text-fg"),
                      )}
                    >
                      {status}
                    </Chip>
                  ))}
                </div>
              </div>
              <div className="mb-2">
                <div className="mb-1 text-[11px] uppercase tracking-wider text-muted-fg">Lane Type</div>
                <div className="flex flex-wrap gap-1">
                  {(["worktree", "attached", "primary"] as LaneSummary["laneType"][]).map((laneType) => (
                    <Chip
                      key={laneType}
                      role="button"
                      onClick={() =>
                        onFilters((current) => ({
                          ...current,
                          laneTypes: current.laneTypes.includes(laneType)
                            ? current.laneTypes.filter((entry) => entry !== laneType)
                            : [...current.laneTypes, laneType],
                        }))}
                      className={cn("cursor-pointer", filters.laneTypes.includes(laneType) && "bg-accent/30 text-accent-fg")}
                    >
                      {laneType}
                    </Chip>
                  ))}
                </div>
              </div>
              <div className="mb-2">
                <div className="mb-1 text-[11px] uppercase tracking-wider text-muted-fg">Visibility</div>
                <div className="flex flex-wrap gap-1">
                  <Chip
                    role="button"
                    onClick={() => onFilters((current) => ({ ...current, hidePrimary: !current.hidePrimary }))}
                    className={cn("cursor-pointer", filters.hidePrimary && "bg-white/[0.06] text-fg")}
                  >
                    hide primary
                  </Chip>
                  <Chip
                    role="button"
                    onClick={() => onFilters((current) => ({ ...current, hideAttached: !current.hideAttached }))}
                    className={cn("cursor-pointer", filters.hideAttached && "bg-white/[0.06] text-fg")}
                  >
                    hide attached
                  </Chip>
                  <Chip
                    role="button"
                    onClick={() => onFilters((current) => ({ ...current, hideArchived: !current.hideArchived }))}
                    className={cn("cursor-pointer", filters.hideArchived && "bg-white/[0.06] text-fg")}
                  >
                    hide archived
                  </Chip>
                </div>
              </div>
              <div className="mt-3 flex justify-between gap-2 border-t border-white/[0.06] pt-3">
                <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={onResetView}>
                  Reset View
                </Button>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={onToggleFiltersPanel}>
                  Close
                </Button>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wider text-muted-fg">
                  Root stack
                  <select
                    value={filters.rootLaneId ?? ""}
                    onChange={(event) => {
                      const value = event.target.value;
                      onFilters((current) => ({ ...current, rootLaneId: value || null }));
                    }}
                    className="h-7 rounded-xl border border-white/[0.08] bg-white/[0.02] px-2 text-xs normal-case text-fg"
                  >
                    <option value="">all stacks</option>
                    {rootLaneOptions.map((lane) => (
                      <option key={lane.id} value={lane.id}>
                        {lane.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wider text-muted-fg">
                  Tag
                  <select
                    value={filters.tags[0] ?? ""}
                    onChange={(event) => {
                      const value = event.target.value;
                      onFilters((current) => ({ ...current, tags: value ? [value] : [] }));
                    }}
                    className="h-7 rounded-xl border border-white/[0.08] bg-white/[0.02] px-2 text-xs normal-case text-fg"
                  >
                    <option value="">all tags</option>
                    {availableTags.map((tag) => (
                      <option key={tag} value={tag}>
                        {tag}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          ) : null}
        </div>

        <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={onResetView}>
          Reset View
        </Button>

        {viewMode === "all" ? (
          <Button
            size="sm"
            variant={showOverviewRiskEdges ? "primary" : "outline"}
            className="h-7 px-2 text-[11px]"
            title="Show or hide predicted file-overlap links between lanes. Stack links stay visible."
            onClick={onToggleOverviewRiskEdges}
          >
            {showOverviewRiskEdges ? "Hide overlap web" : "Show overlap web"}
          </Button>
        ) : null}

        <Button
          size="sm"
          variant={showRiskMatrix ? "primary" : "outline"}
          className="ml-2 h-8 px-2 text-[11px]"
          onClick={onToggleRiskMatrix}
        >
          Pair Matrix
        </Button>
      </div>
      <div className="mt-1 text-[11px] text-muted-fg">{activeViewMeta.helper}</div>
      {/*
        Said on the canvas, not only in a log. A plugin node that hit the cap is
        invisible in exactly the way a broken plugin is, and the person looking at
        the tab is the one who can decide whether they want it — `ade plugin
        doctor` says the same thing to the author.
      */}
      {overflowNote ? <div className="mt-0.5 text-[11px] text-muted-fg">{overflowNote}</div> : null}
    </div>
  );
}
