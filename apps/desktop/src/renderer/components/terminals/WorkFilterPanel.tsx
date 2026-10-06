/**
 * The Work sidebar's filter panel.
 *
 * One control shape for every setting: a label on the left and a menu button
 * on the right, so the panel reads as a short form instead of a cloud of
 * pills. Two sections, because they do different things. "View" settings
 * (group, sort) pick exactly one value and never hide a chat. "Show only"
 * filters hide chats: OR within a menu, AND across menus (see
 * `workSessionFilters.ts`). Colour stays out of the panel; a status colour
 * means something only beside a chat in the list.
 */
import React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CaretUpDown, Check } from "@phosphor-icons/react";
import type { SessionFilingBucket } from "../../lib/terminalAttention";
import type { WorkLaneSortMode } from "./workLaneOrder";
import type { WorkSessionListOrganization } from "../../state/appStore";
import { cn } from "../ui/cn";
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS, MENU_SEPARATOR_CLASS } from "../ui/paneMenuTokens";
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

const GROUP_OPTIONS: ReadonlyArray<{ key: WorkSessionListOrganization; label: string }> = [
  { key: "by-lane", label: "Lane" },
  { key: "all-lanes-by-status", label: "Status" },
  { key: "by-time", label: "Time" },
];

/**
 * A soft neutral ring instead of the browser's default blue outline. Neutral on
 * purpose: an accent ring would read as an "on" state.
 */
export const WORK_FILTER_FOCUS_CLASS =
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color-mix(in_srgb,var(--color-fg)_35%,transparent)]";

const ROW_LABEL_CLASS = "w-[58px] shrink-0 text-[10.5px] text-muted-fg/75";
const SECTION_LABEL_CLASS = "text-[9.5px] font-semibold uppercase tracking-[0.08em] text-muted-fg/50";
const TRIGGER_CLASS = cn(
  "group inline-flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md border px-2 text-left text-[11px]",
  "border-[var(--work-pane-border)] bg-[color-mix(in_srgb,var(--color-fg)_3%,transparent)] text-fg/85",
  "transition-colors duration-100 hover:bg-[color-mix(in_srgb,var(--color-fg)_6%,transparent)]",
  "data-[state=open]:bg-[color-mix(in_srgb,var(--color-fg)_7%,transparent)]",
  "data-[active=true]:border-[color-mix(in_srgb,var(--color-accent)_40%,transparent)]",
  WORK_FILTER_FOCUS_CLASS,
);
const CHECK_CLASS = "flex w-3 shrink-0 justify-center text-[var(--color-accent)]";

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className={ROW_LABEL_CLASS}>{label}</span>
      <div className="flex min-w-0 flex-1">{children}</div>
    </div>
  );
}

const TriggerButton = React.forwardRef<HTMLButtonElement, React.ComponentPropsWithoutRef<"button"> & {
  value: React.ReactNode;
  muted?: boolean;
  active?: boolean;
}>(function TriggerButton({ value, muted, active, ...rest }, ref) {
  return (
    <button ref={ref} type="button" className={TRIGGER_CLASS} data-active={active ? "true" : undefined} {...rest}>
      <span className={cn("min-w-0 flex-1 truncate", muted && "text-muted-fg/70")}>{value}</span>
      <CaretUpDown size={10} className="shrink-0 text-muted-fg/60" aria-hidden />
    </button>
  );
});

/** Pick exactly one value. Never hides a chat. */
function SingleSelect<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ key: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
}) {
  const current = options.find((option) => option.key === value)?.label ?? value;
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <TriggerButton value={current} aria-label={`${label}: ${current}`} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={cn(MENU_CONTENT_CLASS, "min-w-[160px]")} side="bottom" align="start" sideOffset={4}>
          <DropdownMenu.RadioGroup value={value} onValueChange={(next) => onChange(next as T)}>
            {options.map((option) => (
              <DropdownMenu.RadioItem key={option.key} value={option.key} className={MENU_ITEM_CLASS}>
                <span className={CHECK_CLASS}>
                  <DropdownMenu.ItemIndicator><Check size={10} weight="bold" /></DropdownMenu.ItemIndicator>
                </span>
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * Pick any number of values; none picked means "Any". The menu stays open while
 * the user ticks rows, because picking two statuses is one decision.
 */
function MultiSelect<T extends string>({
  label,
  options,
  selected,
  onToggle,
  onClear,
}: {
  label: string;
  options: ReadonlyArray<{ key: T; label: string; icon?: React.ReactNode; dim?: boolean }>;
  selected: readonly T[];
  onToggle: (value: T) => void;
  onClear: () => void;
}) {
  const picked = options.filter((option) => selected.includes(option.key));
  const summary = picked.length === 0
    ? "Any"
    : picked.length <= 2
      ? picked.map((option) => option.label).join(", ")
      : `${picked.length} selected`;
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <TriggerButton
          value={summary}
          muted={picked.length === 0}
          active={picked.length > 0}
          aria-label={`${label}: ${summary}`}
        />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={cn(MENU_CONTENT_CLASS, "min-w-[180px]")} side="bottom" align="start" sideOffset={4}>
          {options.map((option) => (
            <DropdownMenu.CheckboxItem
              key={option.key}
              className={MENU_ITEM_CLASS}
              checked={selected.includes(option.key)}
              onCheckedChange={() => onToggle(option.key)}
              onSelect={(event) => event.preventDefault()}
            >
              <span className={CHECK_CLASS}>
                <DropdownMenu.ItemIndicator><Check size={10} weight="bold" /></DropdownMenu.ItemIndicator>
              </span>
              {option.icon ? <span className="flex w-3.5 shrink-0 justify-center">{option.icon}</span> : null}
              <span className={cn("min-w-0 flex-1 truncate", option.dim && "opacity-60")}>{option.label}</span>
            </DropdownMenu.CheckboxItem>
          ))}
          {picked.length > 0 ? (
            <>
              <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
              <DropdownMenu.Item className={cn(MENU_ITEM_CLASS, "pl-7 text-muted-fg")} onSelect={onClear}>
                Show all
              </DropdownMenu.Item>
            </>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** A yes/no filter, drawn as a small checkbox row. */
function CheckRow({ checked, onChange, children }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "inline-flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1 text-[11px] text-fg/80 transition-colors hover:text-fg",
        WORK_FILTER_FOCUS_CLASS,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex h-3 w-3 shrink-0 items-center justify-center rounded-[3px] border transition-colors",
          checked
            ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-bg)]"
            : "border-[color-mix(in_srgb,var(--color-fg)_30%,transparent)]",
        )}
      >
        {checked ? <Check size={8} weight="bold" /> : null}
      </span>
      <span className="truncate">{children}</span>
    </button>
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
  // hide sessions with no way left to turn it off.
  const machineOptions = React.useMemo(() => {
    const known = new Set(machines.map((machine) => machine.id));
    const stale = filters.machine
      .filter((id) => !known.has(id))
      .map((id) => ({ id, name: UNAVAILABLE_MACHINE_NAME, online: false }));
    return [...machines, ...stale];
  }, [filters.machine, machines]);

  return (
    <div
      className="ade-chat-drawer-glass ade-work-filter-panel mx-2 mt-1.5 mb-1.5 flex flex-col gap-2.5 p-2.5"
      data-testid="work-filter-panel"
    >
      <div className="flex flex-col gap-1.5">
        <span className={SECTION_LABEL_CLASS}>View</span>
        <FieldRow label="Group by">
          <SingleSelect label="Group by" options={GROUP_OPTIONS} value={organization} onChange={onOrganizationChange} />
        </FieldRow>
        {sortMode && sortModes && sortLabels && onSortModeChange ? (
          <FieldRow label="Sort by">
            <SingleSelect
              label="Sort lanes by"
              options={sortModes.map((mode) => ({ key: mode, label: sortLabels[mode] }))}
              value={sortMode}
              onChange={onSortModeChange}
            />
          </FieldRow>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className={SECTION_LABEL_CLASS}>Show only</span>
          {activeCount > 0 ? (
            <button
              type="button"
              className={cn(
                "rounded px-1 text-[10px] text-muted-fg transition-colors hover:text-fg",
                WORK_FILTER_FOCUS_CLASS,
              )}
              onClick={onClearAll}
            >
              Reset
            </button>
          ) : null}
        </div>
        {onFiltersChange ? (
          <>
            <FieldRow label="Status">
              <MultiSelect
                label="Status"
                options={WORK_STATUS_FILTERS.map((bucket: SessionFilingBucket) => ({ key: bucket, label: workStatusFilterLabel(bucket) }))}
                selected={filters.status}
                onToggle={(bucket) => onFiltersChange((prev) => ({ ...prev, status: toggle(prev.status, bucket) }))}
                onClear={() => onFiltersChange((prev) => ({ ...prev, status: [] }))}
              />
            </FieldRow>
            <FieldRow label="Agent">
              <MultiSelect
                label="Agent"
                options={WORK_TOOL_FAMILIES.map((family: WorkToolFamily) => ({
                  key: family,
                  label: workToolFamilyLabel(family),
                  icon: <ToolLogo toolType={TOOL_LOGO_TYPE[family]} size={11} className="shrink-0" />,
                }))}
                selected={filters.tool}
                onToggle={(family) => onFiltersChange((prev) => ({ ...prev, tool: toggle(prev.tool, family) }))}
                onClear={() => onFiltersChange((prev) => ({ ...prev, tool: [] }))}
              />
            </FieldRow>
            {machineOptions.length > 1 ? (
              <FieldRow label="Machine">
                <MultiSelect
                  label="Machine"
                  options={machineOptions.map((machine) => ({
                    key: machine.id,
                    label: machine.online ? machine.name : `${machine.name} (offline)`,
                    dim: !machine.online,
                  }))}
                  selected={filters.machine}
                  onToggle={(id) => onFiltersChange((prev) => ({ ...prev, machine: toggle(prev.machine, id) }))}
                  onClear={() => onFiltersChange((prev) => ({ ...prev, machine: [] }))}
                />
              </FieldRow>
            ) : null}
          </>
        ) : null}
        <FieldRow label="Lane">
          <div className="flex min-w-0 flex-1" data-on={laneActive ? "true" : undefined}>
            <LaneCombobox
              lanes={lanes}
              value={laneId}
              onChange={onLaneIdChange}
              showAllOption
              fullWidth
              dense
              aria-label="Filter by lane"
            />
          </div>
        </FieldRow>
        {onFiltersChange ? (
          <div className="flex flex-wrap items-center gap-x-3 pl-[66px]">
            <CheckRow
              checked={filters.hasPr}
              onChange={(next) => onFiltersChange((prev) => ({ ...prev, hasPr: next }))}
            >
              Has a PR
            </CheckRow>
            <CheckRow
              checked={filters.dirtyLane}
              onChange={(next) => onFiltersChange((prev) => ({ ...prev, dirtyLane: next }))}
            >
              Uncommitted changes
            </CheckRow>
          </div>
        ) : null}
      </div>
    </div>
  );
}
