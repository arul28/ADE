/**
 * The Work sidebar's filter panel.
 *
 * Two kinds of control live here and they must not look alike. "View" settings
 * (group, sort) pick exactly one option, so they are segmented controls. The
 * filters below the rule are multi-select chips: OR within a row, AND across
 * rows (see `workSessionFilters.ts`). A chip that is on carries an accent fill
 * and border, so its state reads without hovering.
 */
import React from "react";
import { Check, Desktop, X } from "@phosphor-icons/react";
import type { SessionFilingBucket } from "../../lib/terminalAttention";
import type { WorkLaneSortMode } from "./workLaneOrder";
import type { WorkSessionListOrganization } from "../../state/appStore";
import { SESSION_TONE_DOT_CLASS, type SessionStatusTone } from "../../../shared/sessionStatusPresentation";
import { SmartTooltip } from "../ui/SmartTooltip";
import { cn } from "../ui/cn";
import { LaneCombobox, type LaneComboboxLane } from "./LaneCombobox";
import { ToolLogo } from "./ToolLogos";
import {
  WORK_STATUS_FILTERS,
  WORK_TOOL_FAMILIES,
  activeWorkSessionFilterLabels,
  workStatusFilterLabel,
  workToolFamilyLabel,
  type WorkSessionFilters,
  type WorkToolFamily,
} from "./workSessionFilters";

/** Name for a filtered machine that no longer reports this repo. */
export const UNAVAILABLE_MACHINE_NAME = "Unavailable machine";

export type WorkFilterMachineOption = {
  id: string;
  name: string;
  online: boolean;
};

const STATUS_TONE: Record<SessionFilingBucket, SessionStatusTone> = {
  "awaiting-input": "amber",
  running: "blue",
  ended: "neutral",
  settled: "emerald",
  snoozed: "violet",
};

const GROUP_OPTIONS: ReadonlyArray<{ key: WorkSessionListOrganization; label: string; description: string }> = [
  { key: "by-lane", label: "Lane", description: "Group sessions by the lane they belong to." },
  { key: "all-lanes-by-status", label: "Status", description: "Group by status: running, your move, ended, or settled." },
  { key: "by-time", label: "Time", description: "Group by when sessions were started." },
];

/**
 * A soft neutral ring instead of the browser's default blue outline. Neutral on
 * purpose: an accent ring would read as the "on" state of a chip.
 */
export const WORK_FILTER_FOCUS_CLASS =
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color-mix(in_srgb,var(--color-fg)_35%,transparent)]";
const ROW_LABEL_CLASS = "w-[46px] shrink-0 text-[10px] font-medium leading-[22px] text-muted-fg/70";
const CHIP_CLASS = cn(
  "inline-flex h-[22px] min-w-0 max-w-full items-center gap-1 rounded-full border px-[7px] text-[10.5px] font-medium",
  "border-[var(--work-pane-border)] text-muted-fg transition-colors duration-100",
  "hover:bg-[color-mix(in_srgb,var(--color-fg)_6%,transparent)] hover:text-fg",
  "data-[on=true]:border-[color-mix(in_srgb,var(--color-accent)_45%,transparent)]",
  "data-[on=true]:bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)]",
  "data-[on=true]:text-fg",
  WORK_FILTER_FOCUS_CLASS,
);

function FilterRow({
  label,
  labelClassName,
  children,
}: {
  label: string;
  /** Overrides the label's line height when the first control is taller than a chip. */
  labelClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-1.5">
      <span className={cn(ROW_LABEL_CLASS, labelClassName)}>{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap gap-[3px]">{children}</div>
    </div>
  );
}

function FilterChip({
  on,
  onClick,
  children,
  title,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={CHIP_CLASS}
      data-on={on ? "true" : undefined}
      aria-pressed={on}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ key: T; label: string; description?: string }>;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="ade-work-segmented min-w-0 flex-1" role="group" aria-label={label}>
      {options.map((opt) => {
        const button = (
          <button
            type="button"
            aria-pressed={value === opt.key}
            className={cn("ade-work-segmented-item min-w-0 flex-1 truncate", WORK_FILTER_FOCUS_CLASS)}
            data-active={value === opt.key ? "true" : undefined}
            onClick={() => onChange(opt.key)}
          >
            {opt.label}
          </button>
        );
        return opt.description ? (
          <SmartTooltip key={opt.key} content={{ label: opt.label, description: opt.description }} wrapperClassName="flex min-w-0 flex-1" wrapperStyle={{ display: "flex" }}>
            {button}
          </SmartTooltip>
        ) : (
          <React.Fragment key={opt.key}>{button}</React.Fragment>
        );
      })}
    </div>
  );
}

function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

const TOOL_LOGO_TYPE: Record<WorkToolFamily, Parameters<typeof ToolLogo>[0]["toolType"]> = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor",
  droid: "droid",
  opencode: "opencode",
  shell: "shell",
  other: null,
};

export type WorkFilterPanelProps = {
  organization: WorkSessionListOrganization;
  onOrganizationChange: (next: WorkSessionListOrganization) => void;
  sortMode?: WorkLaneSortMode;
  sortModes?: readonly WorkLaneSortMode[];
  sortLabels?: Record<WorkLaneSortMode, string>;
  onSortModeChange?: (next: WorkLaneSortMode) => void;
  /** By-lane only: whether busy lanes fold into the Working shelf. */
  foldBusyLanes?: boolean;
  onFoldBusyLanesChange?: (enabled: boolean) => void;
  filters: WorkSessionFilters;
  onFiltersChange?: (update: (prev: WorkSessionFilters) => WorkSessionFilters) => void;
  machines: readonly WorkFilterMachineOption[];
  lanes: LaneComboboxLane[];
  laneId: string;
  onLaneIdChange: (laneId: string) => void;
  onClearAll: () => void;
};

export function WorkFilterPanel({
  organization,
  onOrganizationChange,
  sortMode,
  sortModes,
  sortLabels,
  onSortModeChange,
  foldBusyLanes,
  onFoldBusyLanesChange,
  filters,
  onFiltersChange,
  machines,
  lanes,
  laneId,
  onLaneIdChange,
  onClearAll,
}: WorkFilterPanelProps) {
  const laneActive = laneId.trim().length > 0 && laneId !== "all";
  const activeCount = activeWorkSessionFilterLabels(filters).length + (laneActive ? 1 : 0);
  // A filter for a machine that has since left must stay visible, or it would
  // hide sessions with no chip left to turn it off.
  const machineOptions = React.useMemo(() => {
    const known = new Set(machines.map((machine) => machine.id));
    const stale = filters.machine
      .filter((id) => !known.has(id))
      .map((id) => ({ id, name: UNAVAILABLE_MACHINE_NAME, online: false }));
    return [...machines, ...stale];
  }, [filters.machine, machines]);

  return (
    <div
      className="ade-chat-drawer-glass ade-work-filter-panel mx-2 mt-1.5 mb-1.5 flex flex-col gap-2 p-2.5"
      data-testid="work-filter-panel"
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <span className={ROW_LABEL_CLASS}>Group</span>
          <Segmented label="Group sessions" options={GROUP_OPTIONS} value={organization} onChange={onOrganizationChange} />
        </div>
        {sortMode && sortModes && sortLabels && onSortModeChange ? (
          <div className="flex items-center gap-1.5">
            <span className={ROW_LABEL_CLASS}>Sort</span>
            <Segmented
              label="Sort lanes"
              options={sortModes.map((mode) => ({ key: mode, label: sortLabels[mode] }))}
              value={sortMode}
              onChange={onSortModeChange}
            />
          </div>
        ) : null}
        {foldBusyLanes !== undefined && onFoldBusyLanesChange ? (
          <div className="flex items-center gap-1.5">
            <span className={ROW_LABEL_CLASS}>Focus</span>
            <FilterChip
              on={foldBusyLanes}
              title="Lanes with nothing waiting on you fold into a Working section. They come back out when something needs you or finishes."
              onClick={() => onFoldBusyLanesChange(!foldBusyLanes)}
            >
              <span className="truncate">Fold busy lanes</span>
            </FilterChip>
          </div>
        ) : null}
      </div>

      <div className="-mx-2.5 h-px bg-[var(--work-pane-border)]" aria-hidden />

      <div className="flex flex-col gap-1.5">
        {onFiltersChange ? (
          <>
            <FilterRow label="Status">
              {WORK_STATUS_FILTERS.map((bucket) => (
                <FilterChip
                  key={bucket}
                  on={filters.status.includes(bucket)}
                  onClick={() => onFiltersChange((prev) => ({ ...prev, status: toggle(prev.status, bucket) }))}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      bucket === "settled"
                        ? "border border-emerald-400/80"
                        // The shared neutral dot is white/30, which vanishes on the light theme.
                        : bucket === "ended" ? "bg-muted-fg/50" : SESSION_TONE_DOT_CLASS[STATUS_TONE[bucket]],
                    )}
                  />
                  <span className="truncate">{workStatusFilterLabel(bucket)}</span>
                </FilterChip>
              ))}
            </FilterRow>
            <FilterRow label="Tool">
              {WORK_TOOL_FAMILIES.map((family) => (
                <FilterChip
                  key={family}
                  on={filters.tool.includes(family)}
                  onClick={() => onFiltersChange((prev) => ({ ...prev, tool: toggle(prev.tool, family) }))}
                >
                  <ToolLogo toolType={TOOL_LOGO_TYPE[family]} size={11} className="shrink-0" />
                  <span className="truncate">{workToolFamilyLabel(family)}</span>
                </FilterChip>
              ))}
            </FilterRow>
            {machineOptions.length > 1 ? (
              <FilterRow label="Machine">
                <FilterChip
                  on={filters.machine.length === 0}
                  onClick={() => onFiltersChange((prev) => ({ ...prev, machine: [] }))}
                >
                  All
                </FilterChip>
                {machineOptions.map((machine) => (
                  <FilterChip
                    key={machine.id}
                    on={filters.machine.includes(machine.id)}
                    title={machine.online ? machine.name : `${machine.name} (offline)`}
                    onClick={() => onFiltersChange((prev) => ({ ...prev, machine: toggle(prev.machine, machine.id) }))}
                  >
                    <span className="relative inline-flex shrink-0">
                      <Desktop size={11} weight="regular" aria-hidden />
                      <span
                        aria-hidden
                        className={cn(
                          "absolute -bottom-px -right-0.5 h-[5px] w-[5px] rounded-full ring-1 ring-[var(--color-bg)]",
                          machine.online ? "bg-emerald-400" : "bg-white/25",
                        )}
                      />
                    </span>
                    <span className={cn("truncate", !machine.online && "opacity-60")}>{machine.name}</span>
                  </FilterChip>
                ))}
              </FilterRow>
            ) : null}
          </>
        ) : null}
        <FilterRow label="Lane" labelClassName="leading-7">
          <div className="flex min-w-0 basis-full" data-on={laneActive ? "true" : undefined}>
            <LaneCombobox
              lanes={lanes}
              value={laneId}
              onChange={onLaneIdChange}
              showAllOption
              fullWidth
              compact
              variant="pill"
              aria-label="Filter by lane"
            />
          </div>
          {onFiltersChange ? (
            <>
              <FilterChip
                on={filters.hasPr}
                onClick={() => onFiltersChange((prev) => ({ ...prev, hasPr: !prev.hasPr }))}
                title="Only lanes with a pull request"
              >
                {filters.hasPr ? <Check size={10} weight="bold" aria-hidden /> : null}
                Has PR
              </FilterChip>
              <FilterChip
                on={filters.dirtyLane}
                onClick={() => onFiltersChange((prev) => ({ ...prev, dirtyLane: !prev.dirtyLane }))}
                title="Only lanes with uncommitted changes"
              >
                {filters.dirtyLane ? <Check size={10} weight="bold" aria-hidden /> : null}
                Uncommitted
              </FilterChip>
            </>
          ) : null}
          {activeCount > 0 ? (
            <button
              type="button"
              className={cn(
                "ml-auto inline-flex h-[22px] items-center gap-1 rounded-full px-[7px] text-[10px] font-medium text-muted-fg transition-colors hover:bg-[color-mix(in_srgb,var(--color-fg)_6%,transparent)] hover:text-fg",
                WORK_FILTER_FOCUS_CLASS,
              )}
              onClick={onClearAll}
            >
              <X size={9} weight="bold" aria-hidden />
              Clear {activeCount}
            </button>
          ) : null}
        </FilterRow>
      </div>
    </div>
  );
}
