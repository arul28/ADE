import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as Popover from "@radix-ui/react-popover";
import {
  Graph,
  ListBullets,
  Table,
  MagnifyingGlass,
  GearSix,
  X,
  Circle,
  Funnel,
  GitBranch,
  Clock,
  Export,
} from "@phosphor-icons/react";
import type { ExportHistoryResult, GitConflictState } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import type { HistorySurface } from "./timelineTypes";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import type { TimelineColumn, ViewMode, TimeRange } from "./timelineTypes";
import type { EventCategory } from "./eventTaxonomy";
import { CATEGORY_META } from "./eventTaxonomy";
import { useTimelineStore } from "./useTimelineStore";
import type { ScopeLevel } from "./useTimelineStore";
import {
  buildHistoryLaneActions,
  groupHistoryLaneActions,
  runHistoryLaneAction,
  type HistoryLaneActionId,
} from "./historyLaneActions";

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

const SURFACE_OPTIONS: { value: HistorySurface; label: string; Icon: React.ElementType }[] = [
  { value: "commits", label: "Commits", Icon: GitBranch },
  { value: "activity", label: "Activity", Icon: Clock },
];

function isHistoryExportResult(value: unknown): value is ExportHistoryResult {
  return (
    typeof value === "object" &&
    value !== null &&
    ("cancelled" in value || "savedPath" in value)
  );
}

export function TimelineToolbar({
  onCommitGitActionComplete,
}: {
  onCommitGitActionComplete?: () => void;
} = {}) {
  const lanes = useAppStore((s) => s.lanes ?? []);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  /* ── Store ─────────────────────────────────────────────────── */
  const surface = useTimelineStore((s) => s.surface);
  const setSurface = useTimelineStore((s) => s.setSurface);
  const focusLaneId = useTimelineStore((s) => s.focusLaneId);
  const setFocusLaneId = useTimelineStore((s) => s.setFocusLaneId);
  const viewMode = useTimelineStore((s) => s.viewMode);
  const setViewMode = useTimelineStore((s) => s.setViewMode);
  const filters = useTimelineStore((s) => s.filters);
  const uniqueLanes = useTimelineStore((s) => s.uniqueLanes);
  const uniqueCategories = useTimelineStore((s) => s.uniqueCategories);
  const visibility = useTimelineStore((s) => s.visibility);
  const scope = useTimelineStore((s) => s.scope);
  const columns = useTimelineStore((s) => s.columns);
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

  const handleExport = useCallback(async () => {
    const exportFn = window.ade?.history?.exportOperations;
    if (typeof exportFn !== "function") {
      setExportNotice("Export unavailable (headless)");
      window.setTimeout(() => setExportNotice(null), 4000);
      return;
    }
    try {
      const result = await exportFn({
        format: "json",
        limit: 500,
        ...(focusLaneId ? { laneId: focusLaneId } : {}),
        ...(filters.statuses.length === 1 ? { status: filters.statuses[0] } : {}),
      });
      if (!isHistoryExportResult(result)) {
        setExportNotice("Export unavailable (headless)");
        window.setTimeout(() => setExportNotice(null), 4000);
        return;
      }
      if (result.cancelled) return;
      setExportNotice(`Exported ${result.rowCount} rows to ${result.savedPath}`);
      window.setTimeout(() => setExportNotice(null), 5000);
    } catch (err) {
      setExportNotice(
        `Export failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      window.setTimeout(() => setExportNotice(null), 5000);
    }
  }, [focusLaneId, filters.statuses]);

  /* ── Render ────────────────────────────────────────────────── */
  const showActivityControls = surface === "activity";
  const focusLane = lanes.find((lane) => lane.id === focusLaneId) ?? null;

  return (
    <div className="flex flex-col gap-2 border-b border-white/[0.06] bg-white/[0.02] backdrop-blur-xl px-3 py-2">
      {/* ── Row 0: Surface + lane (commits) ──────────────────── */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-0.5">
          {SURFACE_OPTIONS.map(({ value, label, Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => setSurface(value)}
              className={cn(
                "flex h-7 items-center gap-1 rounded-md border px-2 font-mono text-[10px] font-bold uppercase tracking-[0.5px] transition-colors",
                surface === value
                  ? "border-[var(--color-accent)]/20 bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
                  : "border-transparent text-[var(--color-muted-fg)] hover:bg-white/[0.04]",
              )}
            >
              <Icon size={12} weight={surface === value ? "fill" : "regular"} />
              {label}
            </button>
          ))}
        </div>
        {surface === "commits" ? (
          <>
            <select
              value={focusLaneId ?? ""}
              onChange={(e) => setFocusLaneId(e.target.value || null)}
              className="h-7 max-w-[260px] flex-1 rounded-md border border-white/[0.06] bg-white/[0.03] px-2 font-mono text-[11px] text-fg outline-none focus:border-accent/40"
            >
              <option value="">Select lane…</option>
              {lanes.map((lane) => (
                <option key={lane.id} value={lane.id}>
                  {lane.name}
                </option>
              ))}
            </select>
            <LaneGitActionsMenu
              laneId={focusLaneId}
              laneName={focusLane?.name ?? null}
              onComplete={onCommitGitActionComplete}
            />
          </>
        ) : null}
      </div>

      {/* ── Row 1: View mode · Scope · Search · Gear ─────────── */}
      {showActivityControls ? (
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
                "rounded-md font-mono text-[10px]",
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
        <div className="h-4 w-px bg-white/[0.06]" />

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
                "rounded-md font-mono text-[10px] font-bold uppercase tracking-[0.5px]",
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
        <div className="h-4 w-px bg-white/[0.06]" />

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
              "h-8 w-full rounded-md border border-white/[0.06] bg-white/[0.03]",
              "pl-7 pr-3 font-mono text-xs text-[var(--color-fg)]",
              "placeholder:text-[var(--color-muted-fg)]/50 focus:border-[var(--color-accent)]/40 focus:outline-none",
            )}
          />
        </div>

        {exportNotice ? (
          <span
            className="max-w-[200px] truncate font-mono text-[10px] text-accent"
            title={exportNotice}
          >
            {exportNotice}
          </span>
        ) : null}

        <button
          type="button"
          title="Export operations (JSON via save dialog; unavailable in headless)"
          data-tour="history.export"
          onClick={() => void handleExport()}
          className={cn(
            "flex h-7 items-center gap-1 rounded-md border border-transparent px-2",
            "font-mono text-[10px] font-bold uppercase tracking-[0.5px] text-[var(--color-muted-fg)]",
            "transition-colors hover:bg-[var(--color-surface)]/60 hover:text-[var(--color-fg)]",
          )}
        >
          <Export size={14} />
          Export
        </button>

        <ColumnSettingsMenu columns={columns} onToggleColumn={toggleColumn} />
      </div>
      ) : null}

      {/* ── Row 2: Category · Status · Time · Lanes ────────── */}
      {showActivityControls ? (
      <div className="flex flex-wrap items-center gap-1.5" data-tour="history.filter">
        {/* Section label */}
        <span className="mr-1 font-sans text-[10px] font-bold uppercase tracking-[1px] text-muted-fg/60">
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
          <Circle size={3} weight="fill" className="mx-0.5 text-white/[0.08]" />
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
        <Circle size={3} weight="fill" className="mx-0.5 text-white/[0.08]" />

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
          <Circle size={3} weight="fill" className="mx-0.5 text-white/[0.08]" />
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
      ) : null}
    </div>
  );
}

function LaneGitActionsMenu({
  laneId,
  laneName,
  onComplete,
}: {
  laneId: string | null;
  laneName: string | null;
  onComplete?: () => void;
}) {
  const navigate = useNavigate();
  const [runningAction, setRunningAction] = useState<HistoryLaneActionId | null>(null);
  const [conflictState, setConflictState] = useState<GitConflictState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actions = buildHistoryLaneActions({ hasLane: Boolean(laneId), conflictState });

  const refreshConflictState = useCallback(async () => {
    if (!laneId) {
      setConflictState(null);
      return;
    }
    try {
      setConflictState(await window.ade.git.getConflictState(laneId));
    } catch {
      setConflictState(null);
    }
  }, [laneId]);

  useEffect(() => {
    void refreshConflictState();
  }, [refreshConflictState]);

  const handleComplete = useCallback(() => {
    onComplete?.();
    void refreshConflictState();
  }, [onComplete, refreshConflictState]);

  const run = useCallback(
    async (actionId: HistoryLaneActionId) => {
      if (!laneId) return;
      setRunningAction(actionId);
      setError(null);
      await runHistoryLaneAction({
        actionId,
        laneId,
        laneName,
        onNotice: (message) => {
          setNotice(message);
          window.setTimeout(() => setNotice(null), 3500);
        },
        onError: (message) => {
          setError(message);
          window.setTimeout(() => setError(null), 5000);
        },
        onComplete: handleComplete,
        navigate: (path) => navigate(path),
      });
      setRunningAction(null);
    },
    [handleComplete, laneId, laneName, navigate],
  );
  const actionGroups = groupHistoryLaneActions(actions);

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={!laneId}
          title={laneId ? "Lane git actions" : "Select a lane first"}
          className={cn(
            "flex h-7 shrink-0 items-center gap-1 rounded-md border px-2",
            "border-white/[0.06] bg-white/[0.03] font-mono text-[10px] font-bold uppercase tracking-[0.5px]",
            "text-[var(--color-muted-fg)] transition-colors hover:bg-white/[0.06] hover:text-fg disabled:cursor-not-allowed disabled:opacity-40",
          )}
        >
          <GitBranch size={12} />
          Git actions
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 outline-none"
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <div className="flex max-h-[min(70vh,620px)] min-w-[260px] flex-col overflow-y-auto rounded-md border border-white/[0.08] bg-[var(--color-card)] p-1 shadow-xl">
            {actionGroups.map((group, groupIndex) => (
              <div
                key={group.id}
                className={cn(groupIndex > 0 ? "border-t border-white/[0.06] pt-1" : undefined)}
              >
                <div className="px-2 py-1 font-sans text-[10px] font-semibold text-muted-fg">
                  {group.label}
                </div>
                {group.actions.map((action) => {
                  const busy = runningAction === action.id;
                  return (
                    <button
                      key={action.id}
                      type="button"
                      disabled={action.disabled || runningAction != null}
                      title={action.disabledReason}
                      onClick={() => void run(action.id)}
                      className={cn(
                        "flex w-full flex-col rounded px-2 py-1.5 text-left outline-none transition-colors",
                        "hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-40",
                      )}
                    >
                      <span
                        className={cn(
                          "font-sans text-[12px] text-fg",
                          action.destructive ? "text-red-200" : undefined,
                        )}
                      >
                        {busy ? "Running…" : action.label}
                      </span>
                      <span className="font-mono text-[10px] text-muted-fg">
                        {action.description}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
            {notice ? (
              <div className="truncate border-t border-white/[0.06] px-2 py-1 font-mono text-[10px] text-accent" title={notice}>
                {notice}
              </div>
            ) : null}
            {error ? (
              <div className="truncate border-t border-white/[0.06] px-2 py-1 font-mono text-[10px] text-red-300" title={error}>
                {error}
              </div>
            ) : null}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ColumnSettingsMenu({
  columns,
  onToggleColumn,
}: {
  columns: Array<{ id: TimelineColumn; label: string; visible: boolean }>;
  onToggleColumn: (columnId: TimelineColumn) => void;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          title="Column settings"
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md border border-transparent",
            "text-[var(--color-muted-fg)] transition-colors hover:bg-[var(--color-surface)]/60 hover:text-[var(--color-fg)]",
          )}
        >
          <GearSix size={14} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 outline-none"
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <div className="flex min-w-[190px] flex-col gap-1 rounded-md border border-white/[0.08] bg-[var(--color-card)] p-1 shadow-xl">
            <div className="px-2 py-1 font-sans text-[11px] font-medium text-muted-fg">
              Columns
            </div>
            {columns.map((column) => (
              <label
                key={column.id}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5",
                  "font-sans text-[12px] text-fg hover:bg-white/[0.04]",
                )}
              >
                <input
                  type="checkbox"
                  checked={column.visible}
                  onChange={() => onToggleColumn(column.id)}
                  className="h-3 w-3 accent-[var(--color-accent)]"
                />
                <span>{column.label}</span>
              </label>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
