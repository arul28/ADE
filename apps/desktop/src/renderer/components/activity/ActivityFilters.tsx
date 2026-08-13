import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaretDown, Check } from "@phosphor-icons/react";

import type { AttentionItem } from "../../../shared/types";
import { cn } from "../ui/cn";
import { ActivityStateGlyphMark } from "./ActivityStateGlyphMark";
import {
  ACTIVITY_STATE_GLYPHS,
  ACTIVITY_STATE_GROUPS,
  activityStateGroup,
  type ActivityStateGroup,
} from "./activityPresentation";
import {
  ACTIVITY_SECTION_TONE,
  activityCountPhrase,
  activityCountPhrases,
  activitySectionCounts,
  activitySections,
  type ActivitySectionCounts,
} from "./activityPriority";

/**
 * Activity's filters — machine, project, chat type, model, and the state group.
 * Every option is derived from the snapshot on screen rather than a fixed list,
 * so a filter can never offer a machine the account no longer has or hide one
 * it just gained.
 *
 * Selection is a set per axis; an empty set means "everything", which is why
 * clearing a filter and selecting all of its options read the same on screen
 * and produce the same list. `stateGroup` is the exception and is deliberately
 * a single value — see `ActivityStateStrip` for why a set would be wrong there.
 */
export type ActivityFilterState = {
  machineKeys: string[];
  projects: string[];
  kinds: AttentionItem["kind"][];
  models: string[];
  stateGroup: ActivityStateGroup | null;
};

export const EMPTY_ACTIVITY_FILTERS: ActivityFilterState = {
  machineKeys: [],
  projects: [],
  kinds: [],
  models: [],
  stateGroup: null,
};

export function activityFiltersAreEmpty(filters: ActivityFilterState): boolean {
  return filters.machineKeys.length === 0
    && filters.projects.length === 0
    && filters.kinds.length === 0
    && filters.models.length === 0
    && filters.stateGroup === null;
}

/**
 * How a project is identified for filtering, in the order that survives a trip
 * across machines: the canonical `project_<hash>` first, then the root path,
 * then the per-machine uuid as a last resort. Two machines working the same
 * repo must land on ONE option — filtering by "ADE" and getting only half of
 * ADE would be worse than not filtering at all.
 */
export function activityProjectFilterValue(item: AttentionItem): string {
  return item.project.canonicalId?.trim()
    || item.project.rootPath?.trim()
    || item.project.projectId;
}

export function applyActivityFilters(
  items: readonly AttentionItem[],
  filters: ActivityFilterState,
): AttentionItem[] {
  if (activityFiltersAreEmpty(filters)) return [...items];
  const machines = new Set(filters.machineKeys);
  const projects = new Set(filters.projects);
  const kinds = new Set<AttentionItem["kind"]>(filters.kinds);
  const models = new Set(filters.models);
  return items.filter((item) => {
    if (machines.size > 0 && !machines.has(item.machine.machineKey)) return false;
    if (projects.size > 0 && !projects.has(activityProjectFilterValue(item))) return false;
    if (kinds.size > 0 && !kinds.has(item.kind)) return false;
    // An item with no model can only ever match "everything": a model filter is
    // a claim about which model is running, and "unknown" is not one.
    if (models.size > 0 && !(item.model && models.has(item.model))) return false;
    // The state axis is AND-ed with the rest, like every other one, and it is
    // applied to notifications too rather than only to the agent feed the strip
    // counts. An axis that silently skipped one column would leave the two
    // lists disagreeing about what "filtered" even means, and the columns
    // already say "nothing here matches" for exactly this case.
    if (filters.stateGroup && activityStateGroup(item) !== filters.stateGroup) return false;
    return true;
  });
}

type FilterOption = { value: string; label: string };

const KIND_LABEL: Record<AttentionItem["kind"], string> = {
  agent: "Agents",
  pull_request: "Pull requests",
};

function optionsFrom(
  items: readonly AttentionItem[],
  pick: (item: AttentionItem) => { value: string; label: string } | null,
): FilterOption[] {
  const byValue = new Map<string, string>();
  for (const item of items) {
    const option = pick(item);
    if (!option || !option.value) continue;
    if (!byValue.has(option.value)) byValue.set(option.value, option.label);
  }
  return [...byValue.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function FilterChip({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: FilterOption[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const toggle = (value: string) => {
    onChange(
      selected.includes(value)
        ? selected.filter((entry) => entry !== value)
        : [...selected, value],
    );
  };

  const selectedLabels = options
    .filter((option) => selected.includes(option.value))
    .map((option) => option.label);
  const summary = selectedLabels.length === 0
    ? label
    : selectedLabels.length === 1
      ? selectedLabels[0]
      : `${label} · ${selectedLabels.length}`;

  if (options.length === 0) return null;

  return (
    <div ref={rootRef} className="activity-filter">
      <button
        ref={triggerRef}
        type="button"
        className="activity-filter-trigger"
        data-activity-filter={label}
        data-active={selectedLabels.length > 0 ? "true" : "false"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Filter by ${label.toLocaleLowerCase()}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="truncate">{summary}</span>
        <CaretDown size={10} weight="bold" className={cn(open && "rotate-180")} />
      </button>
      {open ? (
        <div className="activity-filter-menu" role="menu" aria-label={label}>
          {options.map((option) => {
            const checked = selected.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemcheckbox"
                aria-checked={checked}
                className="activity-filter-option"
                onClick={() => toggle(option.value)}
              >
                <span>{option.label}</span>
                {checked ? <Check size={12} weight="bold" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The state strip: one glyph and one count per populated group, and the pane's
 * status filter.
 *
 * It is a glyph strip rather than a fifth chip row because the pane already
 * spends a whole row on chips, and a sixth word chip would have cost height to
 * say something the sections were already saying. Glyph plus count says it in
 * the space that row already had.
 *
 * SINGLE-select, unlike every other axis. The strip is a status display first
 * and a filter second: several lit glyphs read as "these four states are
 * happening", which is a broken status display, not a wider filter. Pressing
 * the lit one clears it, so there is no separate gesture to learn and no state
 * the strip can be left in that it cannot leave.
 *
 * The counts come from the UNFILTERED item set. A facet that recounts itself
 * after narrowing shows the chosen group's number beside six zeroes, and the
 * zeroes are the escape routes — a filter that hides its own counts cannot be
 * turned off from the control that turned it on.
 */
function ActivityStateStrip({
  counts,
  selected,
  onSelect,
}: {
  counts: ActivitySectionCounts;
  selected: ActivityStateGroup | null;
  onSelect: (next: ActivityStateGroup | null) => void;
}) {
  // Empty groups are not rendered — six glyphs where five mean zero is noise
  // pretending to be a status line. The selected group is the one exception: if
  // the last row of the group you are filtered to finishes, dropping its button
  // would strand the filter with no way back through the strip.
  const populated = ACTIVITY_STATE_GROUPS.filter(
    (group) => counts[group] > 0 || group === selected,
  );
  if (populated.length === 0) return null;

  return (
    <div
      className="activity-state-strip"
      role="group"
      // One name for the whole strip, so a screen reader hears the state of the
      // account as a sentence instead of walking six unlabelled counters.
      aria-label={activityCountPhrases(counts).join(", ") || "All agents idle"}
      data-testid="activity-state-strip"
    >
      {populated.map((group) => {
        const active = selected === group;
        return (
          <button
            key={group}
            type="button"
            className={cn(
              "activity-state-pip",
              `activity-tone-${ACTIVITY_SECTION_TONE[group]}`,
            )}
            data-activity-state-pip={group}
            data-active={active ? "true" : "false"}
            aria-pressed={active}
            aria-label={activityCountPhrase(group, counts[group])}
            title={`${ACTIVITY_STATE_GLYPHS[group].label} · ${counts[group]}`}
            onClick={() => onSelect(active ? null : group)}
          >
            <ActivityStateGlyphMark group={group} size={11} />
            <span>{counts[group]}</span>
          </button>
        );
      })}
    </div>
  );
}

export function ActivityFilters({
  items,
  filters,
  onChange,
}: {
  /** Every unfiltered item in the pane — the option lists come from these. */
  items: readonly AttentionItem[];
  filters: ActivityFilterState;
  onChange: (next: ActivityFilterState) => void;
}) {
  const machineOptions = useMemo(
    () => optionsFrom(items, (item) => ({
      value: item.machine.machineKey,
      label: item.machine.name,
    })),
    [items],
  );
  /**
   * The facet that closes the "why are there more rows here than chats?" gap.
   * Activity is account-wide across every recently-opened project — that is the
   * feature, and narrowing what the publisher sends would throw away the other
   * machines' work — so the answer is a filter, not a smaller feed. It defaults
   * to everything, deliberately: silently scoping to the open project would
   * hide exactly what the user opened Activity to see.
   */
  const projectOptions = useMemo(
    () => optionsFrom(items, (item) => ({
      value: activityProjectFilterValue(item),
      label: item.project.name,
    })),
    [items],
  );
  const kindOptions = useMemo(
    () => optionsFrom(items, (item) => ({
      value: item.kind,
      label: KIND_LABEL[item.kind],
    })),
    [items],
  );
  const modelOptions = useMemo(
    () => optionsFrom(items, (item) => (
      item.model ? { value: item.model, label: item.model } : null
    )),
    [items],
  );

  /**
   * Derived from `items`, which the pane hands over unfiltered — the same set
   * the option lists come from, and the reason the strip keeps reporting the
   * groups you are not currently looking at.
   */
  const stateCounts = useMemo(
    () => activitySectionCounts(activitySections(items)),
    [items],
  );

  const clear = useCallback(() => onChange(EMPTY_ACTIVITY_FILTERS), [onChange]);
  const selectStateGroup = useCallback(
    (stateGroup: ActivityStateGroup | null) => onChange({ ...filters, stateGroup }),
    [filters, onChange],
  );

  return (
    <div className="activity-filters" data-testid="activity-filters">
      <FilterChip
        label="Machine"
        options={machineOptions}
        selected={filters.machineKeys}
        onChange={(machineKeys) => onChange({ ...filters, machineKeys })}
      />
      <FilterChip
        label="Project"
        options={projectOptions}
        selected={filters.projects}
        onChange={(projects) => onChange({ ...filters, projects })}
      />
      <FilterChip
        label="Type"
        options={kindOptions}
        selected={filters.kinds}
        onChange={(kinds) => onChange({
          ...filters,
          kinds: kinds as AttentionItem["kind"][],
        })}
      />
      <FilterChip
        label="Model"
        options={modelOptions}
        selected={filters.models}
        onChange={(models) => onChange({ ...filters, models })}
      />
      {activityFiltersAreEmpty(filters) ? null : (
        <button type="button" className="activity-filter-clear" onClick={clear}>
          Clear filters
        </button>
      )}
      <ActivityStateStrip
        counts={stateCounts}
        selected={filters.stateGroup}
        onSelect={selectStateGroup}
      />
    </div>
  );
}
