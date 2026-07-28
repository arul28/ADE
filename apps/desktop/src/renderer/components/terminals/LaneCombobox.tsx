import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CaretUpDown, Check, MagnifyingGlass } from "@phosphor-icons/react";
import { BranchIcon, LaneIcon } from "../ui/vcsIcons";
import { LaneLogoMark, laneDisplayColor } from "./LaneChip";
import { branchNameFromRef } from "../prs/shared/laneBranchTargets";
import { COLORS, laneSurfaceTint } from "../lanes/laneDesignTokens";

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

/** A machine group header. Names are absolute ("This Mac", "MacBook Pro (97)"). */
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

function resolveBranchLabel(ref: string | null | undefined): string | null {
  if (!ref) return null;
  return branchNameFromRef(ref) || null;
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

function matchesLaneSearch(item: LaneListItem, query: string): boolean {
  if (!query) return true;
  return item.name.toLowerCase().includes(query)
    || (item.branchLabel?.toLowerCase().includes(query) ?? false);
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
  const query = input.search.trim().toLowerCase();
  const entries: LaneListEntry[] = [];
  let nextItemIndex = 0;
  const pushItem = (key: string, item: LaneListItem) => {
    if (!matchesLaneSearch(item, query)) return false;
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
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

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
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        close();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, close]);

  // Focus search on open and sync keyboard highlight to the current selection.
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => searchInputRef.current?.focus());
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

  // Position popover below trigger
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});
  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const spaceBelow = viewportHeight - rect.bottom - VIEWPORT_PAD;
    const spaceAbove = rect.top - VIEWPORT_PAD;
    const openAbove = spaceBelow < spaceAbove;

    const available = (openAbove ? spaceAbove : spaceBelow) - POPOVER_GAP;
    const maxHeight = Math.max(
      POPOVER_MIN_HEIGHT,
      Math.min(POPOVER_PREFERRED_MAX_HEIGHT, available),
    );

    const width = Math.min(280, Math.max(rect.width, 260));
    let left = rect.left;
    if (left + width > viewportWidth - VIEWPORT_PAD) {
      left = viewportWidth - width - VIEWPORT_PAD;
    }
    left = Math.max(VIEWPORT_PAD, left);

    setPopoverStyle({
      left,
      width,
      maxHeight,
      ...(openAbove
        ? { bottom: viewportHeight - rect.top + POPOVER_GAP }
        : { top: rect.bottom + POPOVER_GAP }),
    });
  }, []);
  useEffect(() => {
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
  const pillSurface = variant === "pill" && value !== "all" && selectedLane && customLaneColor
    ? laneSurfaceTint(customLaneColor, "default")
    : null;
  const defaultVariantSurface = variant === "default" && value !== "all" && customLaneColor
    ? laneSurfaceTint(customLaneColor, "soft")
    : null;

  const triggerStyle: React.CSSProperties =
    variant === "pill"
      ? {
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          minHeight: selectedBranchLabel ? 40 : 31,
          padding: selectedBranchLabel
            ? "5px 10px 5px 14px"
            : "6px 10px 6px 14px",
          borderRadius: 9999,
          border: pillSurface?.text ? pillSurface.border : "1px solid rgba(255,255,255,0.08)",
          background: pillSurface?.text
            ? pillSurface.background
            : "rgba(255,255,255,0.04)",
          boxShadow: pillSurface?.text
            ? `inset 0 0 0 1px color-mix(in srgb, ${pillSurface.text} 10%, transparent)`
            : undefined,
          color: pillSurface?.text ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.7)",
          fontSize: 11,
          fontWeight: 500,
          cursor: "pointer",
          minWidth: 0,
          width: fullWidth ? "100%" : undefined,
          // fullWidth means "fill the container" — don't cap it below the parent.
          maxWidth: fullWidth ? undefined : 320,
          transition: "border-color 100ms ease, background 100ms ease, box-shadow 100ms ease",
        }
      : {
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          ...(
            selectedBranchLabel
              ? {
                  height: "auto" as const,
                  minHeight: compact ? 32 : 40,
                  padding: compact ? "3px 6px" : "4px 8px",
                }
              : {
                  height: compact ? 24 : 28,
                  padding: compact ? "0 6px" : "0 8px",
                }
          ),
          borderRadius: 6,
          border: defaultVariantSurface?.text
            ? defaultVariantSurface.border
            : "1px solid var(--work-pane-border)",
          background: defaultVariantSurface?.text
            ? defaultVariantSurface.background
            : "rgba(255,255,255,0.02)",
          boxShadow: defaultVariantSurface?.text
            ? `inset 0 0 0 1px color-mix(in srgb, ${defaultVariantSurface.text} 8%, transparent)`
            : undefined,
          color: "var(--color-fg)",
          fontSize: 11,
          fontWeight: 400,
          cursor: "pointer",
          minWidth: 0,
          width: fullWidth ? "100%" : undefined,
          // fullWidth means "fill the container" — don't cap it below the parent.
          maxWidth: fullWidth ? undefined : 200,
          transition: "border-color 100ms ease, background 100ms ease, box-shadow 100ms ease",
        };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="ade-lane-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        style={triggerStyle}
      >
        {displayColor ? (
          <LaneLogoMark color={displayColor} size={11} />
        ) : null}
        {selectedBranchLabel ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: 2,
              minWidth: 0,
              flex: 1,
              lineHeight: 1.2,
            }}
          >
            <span className="truncate" style={{ width: "100%" }}>
              {displayLabel}
            </span>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                minWidth: 0,
                width: "100%",
              }}
            >
              <BranchIcon
                size={9}
                weight="regular"
                style={{
                  color: "var(--color-muted-fg)",
                  opacity: 0.55,
                  flexShrink: 0,
                }}
              />
              <span
                className="truncate"
                style={{
                  fontSize: 10,
                  color: "var(--color-muted-fg)",
                  opacity: 0.92,
                }}
              >
                {selectedBranchLabel}
              </span>
            </div>
          </div>
        ) : (
          <span className="truncate" style={{ flex: 1, minWidth: 0 }}>
            {displayLabel}
          </span>
        )}
        <CaretUpDown
          size={10}
          weight="bold"
          style={{ color: "var(--color-muted-fg)", opacity: 0.6, flexShrink: 0 }}
        />
      </button>

      {open
        ? createPortal(
            <div
              ref={popoverRef}
              className="ade-lane-popover ade-liquid-glass-menu"
              style={popoverStyle}
              onKeyDown={handleKeyDown}
            >
              <div className="ade-lane-popover-search-row">
                <MagnifyingGlass
                  size={12}
                  weight="regular"
                  style={{ color: "var(--color-muted-fg)", opacity: 0.5, flexShrink: 0 }}
                />
                <input
                  ref={searchInputRef}
                  className="ade-lane-popover-search"
                  placeholder="Search lanes..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div ref={listRef} className="ade-lane-popover-list">
                {items.length === 0 ? (
                  <div
                    style={{
                      padding: "12px 8px",
                      fontSize: 11,
                      color: "var(--color-muted-fg)",
                      textAlign: "center",
                    }}
                  >
                    No lanes found
                  </div>
                ) : (
                  entries.map((entry) => {
                    if (entry.kind === "header") {
                      return (
                        <div
                          key={entry.key}
                          role="presentation"
                          style={{
                            padding: "7px 8px 3px",
                            fontSize: 9.5,
                            fontWeight: 600,
                            letterSpacing: "0.12em",
                            textTransform: "uppercase",
                            color: "var(--color-muted-fg)",
                            opacity: 0.55,
                          }}
                        >
                          {entry.label}
                        </div>
                      );
                    }
                    const item = entry.item;
                    const currentIndex = entry.index;
                    const isSelected = item.id === value;
                    const isAutoCreate = isAutoCreateLaneOptionId(item.id);

                    if (isAutoCreate) {
                      return (
                        <button
                          key={entry.key}
                          type="button"
                          className="ade-lane-popover-item ade-lane-popover-item-featured"
                          data-selected={isSelected ? "true" : undefined}
                          data-item-index={currentIndex}
                          onClick={() => selectItem(item.id)}
                        >
                          <span className="ade-orchestrator-rainbow-text">{item.name}</span>
                          {isSelected ? (
                            <Check
                              size={12}
                              weight="bold"
                              style={{
                                color: "var(--color-accent)",
                                flexShrink: 0,
                              }}
                            />
                          ) : null}
                        </button>
                      );
                    }

                    const titleRow = (
                      <div
                        style={{
                          display: "flex",
                          width: "100%",
                          alignItems: "center",
                          gap: 6,
                          minWidth: 0,
                        }}
                      >
                        {laneListIcon(item)}
                        <span className="truncate" style={{ flex: 1, minWidth: 0 }}>
                          {item.name}
                        </span>
                        {isSelected ? (
                          <Check
                            size={12}
                            weight="bold"
                            style={{
                              color: "var(--color-accent)",
                              flexShrink: 0,
                            }}
                          />
                        ) : null}
                      </div>
                    );
                    return (
                      <button
                        key={entry.key}
                        type="button"
                        className="ade-lane-popover-item"
                        data-selected={isSelected ? "true" : undefined}
                        data-item-index={currentIndex}
                        onClick={() => selectItem(item.id)}
                        style={
                          item.branchLabel
                            ? {
                                flexDirection: "column",
                                alignItems: "stretch",
                                gap: 0,
                                paddingTop: 5,
                                paddingBottom: 5,
                              }
                            : undefined
                        }
                      >
                        {item.branchLabel ? (
                          <>
                            {titleRow}
                            <div className="ade-lane-popover-branch-row">
                              <BranchIcon
                                size={10}
                                weight="regular"
                                style={{ color: "var(--color-muted-fg)", opacity: 0.6, flexShrink: 0 }}
                              />
                              <span className="truncate ade-lane-popover-branch-label">
                                {item.branchLabel}
                              </span>
                            </div>
                          </>
                        ) : (
                          titleRow
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
