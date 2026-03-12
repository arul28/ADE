import React, { useCallback } from "react";
import {
  Graph,
  ListBullets,
  Table,
  MagnifyingGlass,
  GearSix,
  X,
  Circle,
  Funnel,
} from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import type { ViewMode, TimeRange } from "./timelineTypes";
import type { EventCategory } from "./eventTaxonomy";
import { CATEGORY_META } from "./eventTaxonomy";
import { useTimelineStore } from "./useTimelineStore";
import type { ScopeLevel } from "./useTimelineStore";

/* ── Constants ──────────────────────────────────────────────── */

const VIEW_MODES: { mode: ViewMode; Icon: React.ElementType; tip: string }[] = [
  { mode: "graph", Icon: Graph, tip: "Graph" },
  { mode: "list", Icon: ListBullets, tip: "List" },
  { mode: "compact", Icon: Table, tip: "Compact" },
];

const TIME_RANGES: { value: TimeRange; label: string }[] = [
  { value: "1h", label: "1 h" },
  { value: "today", label: "Today" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "all", label: "All" },
];

const STATUS_OPTIONS: {
  value: "running" | "succeeded" | "failed" | "canceled";
  label: string;
  color: string;
}[] = [
  { value: "running", label: "Running", color: "#F59E0B" },
  { value: "succeeded", label: "Passed", color: "#10B981" },
  { value: "failed", label: "Failed", color: "#EF4444" },
  { value: "canceled", label: "Canceled", color: "#6B7280" },
];

const SCOPE_OPTIONS: { value: ScopeLevel; label: string; tip: string }[] = [
  { value: "important", label: "Key",      tip: "Only high-impact events" },
  { value: "standard",  label: "Standard", tip: "High + medium events (default)" },
  { value: "detailed",  label: "Detailed", tip: "All except internal noise" },
  { value: "all",       label: "All",      tip: "Everything including tool calls" },
];

/* ── Component ──────────────────────────────────────────────── */

export function TimelineToolbar() {
  /* ── Store ─────────────────────────────────────────────────── */
  const viewMode = useTimelineStore((s) => s.viewMode);
  const setViewMode = useTimelineStore((s) => s.setViewMode);
  const filters = useTimelineStore((s) => s.filters);
  const uniqueLanes = useTimelineStore((s) => s.uniqueLanes);
  const uniqueCategories = useTimelineStore((s) => s.uniqueCategories);
  const visibility = useTimelineStore((s) => s.visibility);
  const scope = useTimelineStore((s) => s.scope);
  const setScope = useTimelineStore((s) => s.setScope);
  const setSearchQuery = useTimelineStore((s) => s.setSearchQuery);
  const setCategoryFilter = useTimelineStore((s) => s.setCategoryFilter);
  const setStatusFilter = useTimelineStore((s) => s.setStatusFilter);
  const setTimeRange = useTimelineStore((s) => s.setTimeRange);
  const toggleLaneHidden = useTimelineStore((s) => s.toggleLaneHidden);
  const toggleLaneSolo = useTimelineStore((s) => s.toggleLaneSolo);
  const clearSolo = useTimelineStore((s) => s.clearSolo);
  const clearFilters = useTimelineStore((s) => s.clearFilters);
  const toggleColumn = useTimelineStore((s) => s.toggleColumn);

  /* ── Handlers ──────────────────────────────────────────────── */
  const handleSearch = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value),
    [setSearchQuery],
  );

  const toggleCategory = useCallback(
    (cat: EventCategory) => {
      const active = filters.categories;
      const next = active.includes(cat)
        ? active.filter((c) => c !== cat)
        : [...active, cat];
      setCategoryFilter(next);
    },
    [filters.categories, setCategoryFilter],
  );

  const toggleStatus = useCallback(
    (status: "running" | "succeeded" | "failed" | "canceled") => {
      const active = filters.statuses;
      const next = active.includes(status)
        ? active.filter((s) => s !== status)
        : [...active, status];
      setStatusFilter(next);
    },
    [filters.statuses, setStatusFilter],
  );

  const hasActiveFilters =
    filters.categories.length > 0 ||
    filters.statuses.length > 0 ||
    filters.laneIds.length > 0 ||
    filters.searchQuery.length > 0 ||
    filters.timeRange !== "all" ||
    scope !== "standard";

  const hasSolo = visibility.soloedLaneIds.size > 0;

  /* ── Render ────────────────────────────────────────────────── */
  return (
    <div className="flex flex-col gap-2 border-b border-border/20 bg-[var(--color-surface-recessed)] px-3 py-2">
      {/* ── Row 1: View mode · Scope · Search · Gear ─────────── */}
      <div className="flex items-center gap-3">
        {/* View mode toggle */}
        <div className="flex items-center gap-0.5">
          {VIEW_MODES.map(({ mode, Icon, tip }) => (
            <button
              key={mode}
              title={tip}
              onClick={() => setViewMode(mode)}
              className={cn(
                "flex h-7 w-7 items-center justify-center border transition-colors",
                "rounded-none font-mono text-[10px]",
                viewMode === mode
                  ? "border-[var(--color-accent)]/20 bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
                  : "border-transparent text-[var(--color-muted-fg)] hover:bg-[var(--color-surface)]/60 hover:text-[var(--color-fg)]",
              )}
            >
              <Icon size={14} weight={viewMode === mode ? "fill" : "regular"} />
            </button>
          ))}
        </div>

        {/* Separator */}
        <div className="h-4 w-px bg-border/15" />

        {/* Scope selector */}
        <div className="flex items-center gap-0.5">
          <Funnel size={12} weight="bold" className="mr-1 text-[var(--color-muted-fg)]/50" />
          {SCOPE_OPTIONS.map(({ value, label, tip }) => (
            <button
              key={value}
              title={tip}
              onClick={() => setScope(value)}
              className={cn(
                "flex h-6 items-center px-2 border transition-colors",
                "rounded-none font-mono text-[10px] font-bold uppercase tracking-[0.5px]",
                scope === value
                  ? "border-[var(--color-accent)]/20 bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
                  : "border-transparent text-[var(--color-muted-fg)]/50 hover:text-[var(--color-muted-fg)]",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Separator */}
        <div className="h-4 w-px bg-border/15" />

        {/* Search */}
        <div className="relative flex-1">
          <MagnifyingGlass
            size={12}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-muted-fg)]/50"
          />
          <input
            type="text"
            placeholder="Search events…"
            value={filters.searchQuery}
            onChange={handleSearch}
            className={cn(
              "h-8 w-full rounded-none border border-[var(--color-border)]/15 bg-[var(--color-surface-recessed)]",
              "pl-7 pr-3 font-mono text-xs text-[var(--color-fg)]",
              "placeholder:text-[var(--color-muted-fg)]/50 focus:border-[var(--color-accent)]/40 focus:outline-none",
            )}
          />
        </div>

        {/* Column config */}
        <button
          title="Column settings"
          onClick={() => toggleColumn("")}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-none border border-transparent",
            "text-[var(--color-muted-fg)] transition-colors hover:bg-[var(--color-surface)]/60 hover:text-[var(--color-fg)]",
          )}
        >
          <GearSix size={14} />
        </button>
      </div>

      {/* ── Row 2: Category · Status · Time · Lanes ────────── */}
      <div className="flex flex-wrap items-center gap-1.5">
        {/* Section label */}
        <span className="mr-1 font-mono text-[10px] font-bold uppercase tracking-[1px] text-muted-fg/60">
          Filter
        </span>

        {/* Category chips */}
        {uniqueCategories.map((cat) => {
          const meta = CATEGORY_META[cat];
          const active = filters.categories.includes(cat);
          return (
            <Chip
              key={cat}
              role="button"
              tabIndex={0}
              onClick={() => toggleCategory(cat)}
              className={cn(
                "cursor-pointer select-none transition-colors",
                active
                  ? "border-transparent text-current"
                  : "text-muted-fg/60 hover:text-muted-fg",
              )}
              style={
                active
                  ? { backgroundColor: `${meta.color}26`, color: meta.color }
                  : undefined
              }
            >
              <span
                className="mr-1 inline-block h-1.5 w-1.5"
                style={{ backgroundColor: meta.color }}
              />
              {meta.label}
            </Chip>
          );
        })}

        {/* Divider dot */}
        {uniqueCategories.length > 0 && (
          <Circle size={3} weight="fill" className="mx-0.5 text-border/30" />
        )}

        {/* Status chips */}
        {STATUS_OPTIONS.map(({ value, label, color }) => {
          const active = filters.statuses.includes(value);
          return (
            <Chip
              key={value}
              role="button"
              tabIndex={0}
              onClick={() => toggleStatus(value)}
              className={cn(
                "cursor-pointer select-none transition-colors",
                active
                  ? "border-transparent text-current"
                  : "text-muted-fg/60 hover:text-muted-fg",
              )}
              style={
                active
                  ? { backgroundColor: `${color}26`, color }
                  : undefined
              }
            >
              <span
                className="mr-1 inline-block h-1.5 w-1.5"
                style={{ backgroundColor: color }}
              />
              {label}
            </Chip>
          );
        })}

        {/* Divider dot */}
        <Circle size={3} weight="fill" className="mx-0.5 text-border/30" />

        {/* Time range chips */}
        {TIME_RANGES.map(({ value, label }) => (
          <Chip
            key={value}
            role="button"
            tabIndex={0}
            onClick={() => setTimeRange(value)}
            className={cn(
              "cursor-pointer select-none transition-colors",
              filters.timeRange === value
                ? "border-accent/20 bg-accent/15 text-accent"
                : "text-muted-fg/60 hover:text-muted-fg",
            )}
          >
            {label}
          </Chip>
        ))}

        {/* Divider dot */}
        {uniqueLanes.length > 0 && (
          <Circle size={3} weight="fill" className="mx-0.5 text-border/30" />
        )}

        {/* Lane chips */}
        {uniqueLanes.map((lane) => {
          const hidden = visibility.hiddenLaneIds.has(lane.id);
          const soloed = visibility.soloedLaneIds.has(lane.id);
          return (
            <Chip
              key={lane.id}
              role="button"
              tabIndex={0}
              onClick={() => toggleLaneHidden(lane.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                toggleLaneSolo(lane.id);
              }}
              title="Click to toggle · Right-click to solo"
              className={cn(
                "cursor-pointer select-none transition-colors",
                hidden
                  ? "text-muted-fg/30 line-through"
                  : soloed
                    ? "border-accent/20 bg-accent/15 text-accent"
                    : "text-muted-fg/60 hover:text-muted-fg",
              )}
            >
              {lane.name}
            </Chip>
          );
        })}

        {/* Solo clear */}
        {hasSolo && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearSolo}
            className="ml-0.5 h-5 px-1.5 font-mono text-[9px] font-bold uppercase tracking-[1px] text-accent"
          >
            Clear Solo
          </Button>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Clear all filters */}
        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            className="h-5 gap-1 px-1.5 font-mono text-[9px] font-bold uppercase tracking-[1px] text-muted-fg hover:text-fg"
          >
            <X size={10} />
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}
