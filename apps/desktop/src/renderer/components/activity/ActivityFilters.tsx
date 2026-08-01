import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaretDown, Check } from "@phosphor-icons/react";

import type { AttentionItem } from "../../../shared/types";
import { cn } from "../ui/cn";

/**
 * Activity's three filters — machine, chat type, model. Every option is derived
 * from the snapshot on screen rather than a fixed list, so a filter can never
 * offer a machine the account no longer has or hide one it just gained.
 *
 * Selection is a set per axis; an empty set means "everything", which is why
 * clearing a filter and selecting all of its options read the same on screen
 * and produce the same list.
 */
export type ActivityFilterState = {
  machineKeys: string[];
  kinds: AttentionItem["kind"][];
  models: string[];
};

export const EMPTY_ACTIVITY_FILTERS: ActivityFilterState = {
  machineKeys: [],
  kinds: [],
  models: [],
};

export function activityFiltersAreEmpty(filters: ActivityFilterState): boolean {
  return filters.machineKeys.length === 0
    && filters.kinds.length === 0
    && filters.models.length === 0;
}

export function applyActivityFilters(
  items: readonly AttentionItem[],
  filters: ActivityFilterState,
): AttentionItem[] {
  if (activityFiltersAreEmpty(filters)) return [...items];
  const machines = new Set(filters.machineKeys);
  const kinds = new Set<AttentionItem["kind"]>(filters.kinds);
  const models = new Set(filters.models);
  return items.filter((item) => {
    if (machines.size > 0 && !machines.has(item.machine.machineKey)) return false;
    if (kinds.size > 0 && !kinds.has(item.kind)) return false;
    // An item with no model can only ever match "everything": a model filter is
    // a claim about which model is running, and "unknown" is not one.
    if (models.size > 0 && !(item.model && models.has(item.model))) return false;
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

  const clear = useCallback(() => onChange(EMPTY_ACTIVITY_FILTERS), [onChange]);

  return (
    <div className="activity-filters" data-testid="activity-filters">
      <FilterChip
        label="Machine"
        options={machineOptions}
        selected={filters.machineKeys}
        onChange={(machineKeys) => onChange({ ...filters, machineKeys })}
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
    </div>
  );
}
