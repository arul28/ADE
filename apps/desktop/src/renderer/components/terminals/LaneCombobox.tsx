import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { CaretUpDown, Check, DesktopTower, MagnifyingGlass } from "@phosphor-icons/react";
import { BranchIcon, LaneIcon } from "../ui/vcsIcons";
import { LaneLogoMark, laneDisplayColor } from "./LaneChip";
import { branchNameFromRef } from "../prs/shared/laneBranchTargets";
import { COLORS } from "../lanes/laneDesignTokens";
import { cn } from "../ui/cn";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";

/**
 * Synthetic lane id for the draft-composer “auto-create lane” row.
 *
 * A lane owns its machine, so once lanes span machines there is one auto-create
 * row per machine. This bare id stays the row for the default machine (the one
 * ADE runs on) so every existing caller keeps working unchanged; other machines
 * get `__ade_auto_create_lane__:<machineId>`.
 */
export const AUTO_CREATE_LANE_OPTION_ID = "__ade_auto_create_lane__";

const AUTO_CREATE_LANE_OPTION_PREFIX = `${AUTO_CREATE_LANE_OPTION_ID}:`;
const MACHINE_LANE_OPTION_PREFIX = "__ade_machine_lane__:";

/** Label used for the per-machine auto-create rows inside grouped lists. */
const AUTO_CREATE_LANE_GROUPED_LABEL = "Auto-create lane here";

/** Auto-create row id for a machine. Omit / pass the default machine for the bare id. */
export function autoCreateLaneOptionId(machineId?: string | null): string {
  const trimmed = machineId?.trim();
  return trimmed ? `${AUTO_CREATE_LANE_OPTION_PREFIX}${trimmed}` : AUTO_CREATE_LANE_OPTION_ID;
}

export function isAutoCreateLaneOptionId(laneId: string | null | undefined): boolean {
  if (!laneId) return false;
  return laneId === AUTO_CREATE_LANE_OPTION_ID || laneId.startsWith(AUTO_CREATE_LANE_OPTION_PREFIX);
}

/** The machine an auto-create row targets; `null` for the default machine. */
export function machineIdFromAutoCreateLaneOptionId(laneId: string | null | undefined): string | null {
  if (!laneId || !laneId.startsWith(AUTO_CREATE_LANE_OPTION_PREFIX)) return null;
  return laneId.slice(AUTO_CREATE_LANE_OPTION_PREFIX.length) || null;
}

export function machineLaneOptionId(machineId: string, laneId: string): string {
  return `${MACHINE_LANE_OPTION_PREFIX}${encodeURIComponent(machineId)}:${encodeURIComponent(laneId)}`;
}

export function machineLaneFromOptionId(
  optionId: string | null | undefined,
): { machineId: string; laneId: string } | null {
  if (!optionId?.startsWith(MACHINE_LANE_OPTION_PREFIX)) return null;
  const encoded = optionId.slice(MACHINE_LANE_OPTION_PREFIX.length);
  const separatorIndex = encoded.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === encoded.length - 1) return null;
  try {
    const machineId = decodeURIComponent(encoded.slice(0, separatorIndex)).trim();
    const laneId = decodeURIComponent(encoded.slice(separatorIndex + 1)).trim();
    return machineId && laneId ? { machineId, laneId } : null;
  } catch {
    return null;
  }
}

/** `LaneSummary` is assignable; callers may also pass a minimal `{ id, name, color? }` without `branchRef`. */
export type LaneComboboxLane = {
  id: string;
  name: string;
  color?: string | null;
  branchRef?: string | null;
  /** Machine the lane lives on. Unset means the default (first) machine. */
  machineId?: string | null;
};

/** A machine group header. Names are absolute ("This computer", "MacBook Pro (97)"). */
export type LaneComboboxMachine = {
  id: string;
  name: string;
};

type LaneListItem = {
  id: string;
  name: string;
  color: string | null;
  /** Short display branch (e.g. from refs/heads/foo); `null` for the "all" row. */
  branchLabel: string | null;
};

type LaneListEntry =
  | { kind: "header"; key: string; label: string }
  /** `index` addresses the row for keyboard highlight; headers are unreachable. */
  | { kind: "item"; key: string; index: number; item: LaneListItem };

const POPOVER_GAP = 4;
const VIEWPORT_PAD = 10;
const POPOVER_PREFERRED_MAX_HEIGHT = 320;
const POPOVER_MIN_HEIGHT = 160;
const POPOVER_MIN_WIDTH = 240;
/** Matches the `.ade-lane-popover` stylesheet cap so the two can't disagree. */
const POPOVER_MAX_WIDTH = 280;

function resolveBranchLabel(ref: string | null | undefined): string | null {
  if (!ref) return null;
  return branchNameFromRef(ref) || null;
}

/**
 * Row filter for the popover search box.
 *
 * Exported because it is the one piece of the combobox worth testing without a
 * DOM: everything else about filtering is rendering. Callers may hand it either
 * a short branch label or a full ref — a substring match covers both.
 */
export function laneMatchesSearch(
  candidate: { name: string; branchLabel?: string | null },
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (candidate.name.toLowerCase().includes(needle)) return true;
  return candidate.branchLabel?.toLowerCase().includes(needle) ?? false;
}

function laneListIcon(item: LaneListItem) {
  const color = item.color ? laneDisplayColor(item.color) : "var(--color-muted-fg)";
  return item.color ? (
    <LaneLogoMark color={color} size={12} />
  ) : (
    <LaneIcon size={12} weight="regular" style={{ color, opacity: 0.45, flexShrink: 0 }} />
  );
}

function laneListItemFromLane(
  lane: LaneComboboxLane,
  optionId = lane.id,
): LaneListItem {
  return {
    id: optionId,
    name: lane.name,
    color: lane.color ?? null,
    branchLabel: resolveBranchLabel(lane.branchRef),
  };
}

/**
 * Flat list (today's shape) when there is at most one machine, grouped with a
 * header + its own auto-create row per machine when lanes span machines.
 */
function buildLaneListEntries(input: {
  lanes: LaneComboboxLane[];
  machines: LaneComboboxMachine[];
  showAllOption: boolean;
  allLabel: string;
  search: string;
}): LaneListEntry[] {
  const entries: LaneListEntry[] = [];
  let nextItemIndex = 0;
  const pushItem = (key: string, item: LaneListItem) => {
    if (!laneMatchesSearch(item, input.search)) return false;
    entries.push({ kind: "item", key, index: nextItemIndex++, item });
    return true;
  };

  if (input.showAllOption) {
    pushItem("all", { id: "all", name: input.allLabel, color: null, branchLabel: null });
  }

  if (input.machines.length < 2) {
    for (const lane of input.lanes) pushItem(lane.id, laneListItemFromLane(lane));
    return entries;
  }

  // Callers inject the auto-create row as a lane; in grouped mode it becomes one
  // row per machine instead.
  const autoCreateLane = input.lanes.find((lane) => isAutoCreateLaneOptionId(lane.id)) ?? null;
  const defaultMachineId = input.machines[0]?.id ?? null;
  for (const machine of input.machines) {
    const machineLanes = input.lanes.filter((lane) => {
      if (isAutoCreateLaneOptionId(lane.id)) return false;
      const laneMachineId = lane.machineId?.trim() || defaultMachineId;
      return laneMachineId === machine.id;
    });
    const headerIndex = entries.length;
    entries.push({ kind: "header", key: `machine:${machine.id}`, label: machine.name });
    if (autoCreateLane) {
      pushItem(`${machine.id}:auto-create`, {
        id: machine.id === defaultMachineId
          ? autoCreateLaneOptionId(null)
          : autoCreateLaneOptionId(machine.id),
        name: AUTO_CREATE_LANE_GROUPED_LABEL,
        color: null,
        branchLabel: null,
      });
    }
    for (const lane of machineLanes) {
      pushItem(
        `${machine.id}:${lane.id}`,
        laneListItemFromLane(lane, machineLaneOptionId(machine.id, lane.id)),
      );
    }
    // A header with nothing under it (everything filtered out) is noise.
    if (entries.length === headerIndex + 1) entries.pop();
  }
  return entries;
}

export type LanePopoverPlacement = {
  left: number;
  width: number;
  maxHeight: number;
  /** Exactly one of these is set; `bottom` anchors an upward-opening popover. */
  top?: number;
  bottom?: number;
  openAbove: boolean;
};

/**
 * Pure placement so the viewport-clamp invariant is testable without layout.
 *
 * The popover is `position: fixed`, so an unclamped anchor happily renders off
 * the renderer edge. Both axes are clamped here, including the case where
 * neither side of the trigger has room for the minimum useful height — there we
 * abandon the anchor rather than overflow.
 */
export function computeLanePopoverPlacement(input: {
  trigger: { top: number; bottom: number; left: number; width: number };
  viewport: { width: number; height: number };
  width?: { min: number; max: number };
}): LanePopoverPlacement {
  const { trigger, viewport } = input;
  const minWidth = input.width?.min ?? POPOVER_MIN_WIDTH;
  const maxWidth = input.width?.max ?? POPOVER_MAX_WIDTH;

  const width = Math.min(
    Math.min(maxWidth, Math.max(trigger.width, minWidth)),
    Math.max(0, viewport.width - VIEWPORT_PAD * 2),
  );
  const left = Math.max(
    VIEWPORT_PAD,
    Math.min(trigger.left, viewport.width - width - VIEWPORT_PAD),
  );

  const spaceBelow = viewport.height - trigger.bottom - VIEWPORT_PAD - POPOVER_GAP;
  const spaceAbove = trigger.top - VIEWPORT_PAD - POPOVER_GAP;
  const openAbove = spaceBelow < spaceAbove;
  const available = Math.max(0, openAbove ? spaceAbove : spaceBelow);
  const cap = Math.min(POPOVER_PREFERRED_MAX_HEIGHT, Math.max(0, viewport.height - VIEWPORT_PAD * 2));
  const fitted = Math.min(cap, available);

  if (fitted < Math.min(POPOVER_MIN_HEIGHT, cap)) {
    // Neither side can host a usable list. Detach from the trigger and clamp to
    // the viewport instead of letting the menu run off-screen.
    const maxHeight = Math.min(cap, POPOVER_MIN_HEIGHT);
    const top = Math.max(
      VIEWPORT_PAD,
      Math.min(trigger.bottom + POPOVER_GAP, viewport.height - maxHeight - VIEWPORT_PAD),
    );
    return { left, width, maxHeight, top, openAbove: false };
  }

  return openAbove
    ? { left, width, maxHeight: fitted, bottom: viewport.height - trigger.top + POPOVER_GAP, openAbove }
    : { left, width, maxHeight: fitted, top: trigger.bottom + POPOVER_GAP, openAbove };
}

type LaneComboboxProps = {
  lanes: LaneComboboxLane[];
  /**
   * Machine groups, in display order. The first entry is the default machine —
   * lanes without a `machineId` and the bare auto-create id belong to it.
   * Fewer than two machines renders exactly as before: one flat list.
   */
  machines?: LaneComboboxMachine[];
  value: string;
  onChange: (laneId: string) => void;
  showAllOption?: boolean;
  allLabel?: string;
  placeholder?: string;
  compact?: boolean;
  /**
   * Rounded-full trigger; matches chat empty-state lane control styling.
   */
  variant?: "default" | "pill";
  fullWidth?: boolean;
  "aria-label"?: string;
};

export function LaneCombobox({
  lanes,
  machines,
  value,
  onChange,
  showAllOption = false,
  allLabel = "All lanes",
  placeholder = "Select lane...",
  compact = false,
  variant = "default",
  fullWidth = false,
  "aria-label": ariaLabel = "Select lane",
}: LaneComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const reducedMotion = usePrefersReducedMotion();

  const selectedLane = useMemo(() => {
    const routed = machineLaneFromOptionId(value);
    if (!routed) return lanes.find((lane) => lane.id === value);
    const defaultMachineId = machines?.[0]?.id ?? null;
    return lanes.find((lane) => {
      if (lane.id !== routed.laneId) return false;
      return (lane.machineId?.trim() || defaultMachineId) === routed.machineId;
    });
  }, [lanes, machines, value]);

  const selectedBranchLabel = useMemo(() => {
    if (value === "all" || !selectedLane) return null;
    return resolveBranchLabel(selectedLane.branchRef);
  }, [value, selectedLane]);

  const entries = useMemo(
    () => buildLaneListEntries({
      lanes,
      machines: machines ?? [],
      showAllOption,
      allLabel,
      search,
    }),
    [lanes, machines, showAllOption, allLabel, search],
  );

  // Keyboard navigation and the highlight index address selectable rows only —
  // machine headers are skipped entirely.
  const items = useMemo(
    () => entries.flatMap((entry) => (entry.kind === "item" ? [entry.item] : [])),
    [entries],
  );

  useEffect(() => {
    setHighlightedIndex(0);
  }, [search]);

  const close = useCallback(() => {
    setOpen(false);
    setSearch("");
    setHighlightedIndex(0);
  }, []);

  const selectItem = useCallback(
    (id: string) => {
      onChange(id);
      close();
      triggerRef.current?.focus();
    },
    [onChange, close],
  );

  // Click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (popoverRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, close]);

  // Keep keyboard navigation active without auto-selecting the search field.
  // Search should only acquire its highlighted border after the user clicks or
  // tabs into it.
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => popoverRef.current?.focus({ preventScroll: true }));
    const selectedIdx = items.findIndex((item) => item.id === value);
    setHighlightedIndex(selectedIdx >= 0 ? selectedIdx : 0);
    // Only re-sync when the menu opens — search filtering keeps its own highlight reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open gate
  }, [open]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        triggerRef.current?.focus();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightedIndex((prev) => Math.min(prev + 1, items.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightedIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const item = items[highlightedIndex];
        if (item) selectItem(item.id);
      }
    },
    [close, items, highlightedIndex, selectItem],
  );

  // Scroll highlighted item into view. Addressed by data attribute, not child
  // index — machine headers share the list container with selectable rows.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-item-index="${highlightedIndex}"]`,
    );
    if (typeof el?.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [open, highlightedIndex]);

  const [placement, setPlacement] = useState<LanePopoverPlacement | null>(null);
  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPlacement(computeLanePopoverPlacement({
      trigger: { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    }));
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, updatePosition]);

  // A per-machine auto-create row isn't a real lane, so it never resolves
  // through `lanes` — label it directly.
  const autoCreateFallbackLabel = !selectedLane && isAutoCreateLaneOptionId(value)
    ? "Auto-create lane"
    : null;
  const displayLabel = value === "all"
    ? allLabel
    : (selectedLane?.name ?? autoCreateFallbackLabel ?? placeholder);
  const customLaneColor = selectedLane?.color?.trim() ? selectedLane.color : null;
  const displayColor =
    value === "all" || !selectedLane
      ? null
      : (customLaneColor ?? COLORS.accent);

  const popoverStyle: React.CSSProperties = {
    left: placement?.left ?? 0,
    width: placement?.width ?? POPOVER_MIN_WIDTH,
    maxHeight: placement?.maxHeight ?? POPOVER_PREFERRED_MAX_HEIGHT,
    ...(placement?.bottom !== undefined
      ? { bottom: placement.bottom }
      : { top: placement?.top ?? 0 }),
    // The stylesheet ships a CSS keyframe entrance for this class; framer owns
    // the entrance now, and running both double-animates the open.
    animation: "none",
    transformOrigin: placement?.openAbove ? "bottom left" : "top left",
  };

  // Sits in composer shelves next to 24-28px ghost pills, so the trigger is a
  // single line at that scale in both variants — never a two-line block.
  const triggerClass = cn(
    "ade-lane-trigger group inline-flex min-w-0 shrink items-center gap-1.5",
    "border border-white/[0.07] bg-white/[0.03] text-[11px] font-normal text-fg/80",
    "transition-colors duration-100 hover:border-white/[0.13] hover:bg-white/[0.06]",
    "data-[open=true]:border-white/[0.16] data-[open=true]:bg-white/[0.07]",
    variant === "pill" ? "rounded-full" : "rounded-md",
    compact ? "h-7 px-2" : "h-[30px] px-2.5",
    fullWidth
      ? "w-full"
      // fullWidth means "fill the container" — only the free-standing form caps.
      : variant === "pill" ? "max-w-[320px]" : "max-w-[200px]",
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClass}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-open={open ? "true" : "false"}
        onClick={() => setOpen(!open)}
      >
        {displayColor ? <LaneLogoMark color={displayColor} size={11} /> : null}
        <span className="min-w-0 shrink truncate">{displayLabel}</span>
        {selectedBranchLabel ? (
          // Shrink factor puts every pixel of squeeze on the branch first: the
          // lane name is the label, the branch is only context.
          <span className="flex min-w-0 shrink-[9999] items-center gap-1 overflow-hidden text-muted-fg/65">
            <BranchIcon size={9} weight="regular" className="shrink-0" />
            <span className="truncate">{selectedBranchLabel}</span>
          </span>
        ) : null}
        <CaretUpDown
          size={10}
          weight="bold"
          className="ml-auto shrink-0 text-muted-fg/55 transition-transform duration-150 group-data-[open=true]:rotate-180"
        />
      </button>

      {/*
        No `AnimatePresence` / exit animation here on purpose: the popover lives
        in a body portal, and a node that outlives `open` by an animation frame
        leaks into whatever renders next (including other test cases). The
        entrance spring is the part users actually see.
      */}
      {open
        ? createPortal(
            <motion.div
              ref={popoverRef}
              tabIndex={-1}
              role="listbox"
              aria-activedescendant={
                highlightedIndex >= 0 ? `ade-lane-option-${highlightedIndex}` : undefined
              }
              className="ade-lane-popover ade-liquid-glass-menu"
              style={popoverStyle}
              onKeyDown={handleKeyDown}
              // Height is content-driven under `maxHeight`, so `layout` is what
              // makes filtering read as the list collapsing rather than snapping.
              layout={reducedMotion ? false : "size"}
              initial={reducedMotion ? false : { opacity: 0, scale: 0.96, y: placement?.openAbove ? 4 : -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={
                reducedMotion
                  ? { duration: 0 }
                  : { type: "spring", stiffness: 520, damping: 34, mass: 0.7 }
              }
            >
              <div className="ade-lane-popover-search-row">
                <MagnifyingGlass
                  size={12}
                  weight="regular"
                  className="shrink-0 text-muted-fg/50"
                />
                <input
                  ref={searchInputRef}
                  className="ade-lane-popover-search"
                  // Named so a bare `getByRole("textbox")` in a host surface can
                  // still tell this apart from the surface's own input.
                  aria-label="Search lanes"
                  placeholder="Search lanes..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div ref={listRef} className="ade-lane-popover-list">
                {items.length === 0 ? (
                  <div className="px-2 py-3 text-center text-[11px] text-muted-fg">
                    No lanes found
                  </div>
                ) : (
                  entries.map((entry) => {
                    if (entry.kind === "header") {
                      return (
                        <div
                          key={entry.key}
                          role="presentation"
                          data-machine-header="true"
                          className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-muted-fg/55 first:pt-1"
                        >
                          <DesktopTower size={10} weight="duotone" className="shrink-0" />
                          <span className="truncate">{entry.label}</span>
                        </div>
                      );
                    }
                    const item = entry.item;
                    const isSelected = item.id === value;
                    const isHighlighted = entry.index === highlightedIndex;

                    if (isAutoCreateLaneOptionId(item.id)) {
                      return (
                        <button
                          key={entry.key}
                          id={`ade-lane-option-${entry.index}`}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          className="ade-lane-popover-item ade-lane-popover-item-featured"
                          data-selected={isSelected ? "true" : undefined}
                          data-highlighted={isHighlighted ? "true" : undefined}
                          data-item-index={entry.index}
                          onClick={() => selectItem(item.id)}
                        >
                          <span className="ade-orchestrator-rainbow-text">{item.name}</span>
                          {isSelected ? (
                            <Check size={12} weight="bold" className="shrink-0 text-accent" />
                          ) : null}
                        </button>
                      );
                    }

                    return (
                      <button
                        key={entry.key}
                        id={`ade-lane-option-${entry.index}`}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        className="ade-lane-popover-item"
                        data-selected={isSelected ? "true" : undefined}
                        data-highlighted={isHighlighted ? "true" : undefined}
                        data-item-index={entry.index}
                        onClick={() => selectItem(item.id)}
                      >
                        {laneListIcon(item)}
                        <span className="min-w-0 shrink truncate">{item.name}</span>
                        {item.branchLabel ? (
                          // Same priority rule as the trigger: branch gives way first.
                          <span className="flex min-w-0 shrink-[9999] items-center gap-1 overflow-hidden text-[10px] text-muted-fg/60">
                            <BranchIcon size={9} weight="regular" className="shrink-0" />
                            <span className="truncate">{item.branchLabel}</span>
                          </span>
                        ) : null}
                        {isSelected ? (
                          <Check size={12} weight="bold" className="ml-auto shrink-0 text-accent" />
                        ) : null}
                      </button>
                    );
                  })
                )}
              </div>
            </motion.div>,
            document.body,
          )
        : null}
    </>
  );
}
