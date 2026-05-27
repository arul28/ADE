import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CaretUpDown, Check, MagnifyingGlass } from "@phosphor-icons/react";
import { BranchIcon, LaneIcon } from "../ui/vcsIcons";
import { LaneLogoMark, laneDisplayColor } from "./LaneChip";
import { branchNameFromRef } from "../prs/shared/laneBranchTargets";
import { COLORS, laneSurfaceTint } from "../lanes/laneDesignTokens";

/** Synthetic lane id for the draft-composer “auto-create lane” row. */
export const AUTO_CREATE_LANE_OPTION_ID = "__ade_auto_create_lane__";

/** `LaneSummary` is assignable; callers may also pass a minimal `{ id, name, color? }` without `branchRef`. */
export type LaneComboboxLane = {
  id: string;
  name: string;
  color?: string | null;
  branchRef?: string | null;
};

type LaneListItem = {
  id: string;
  name: string;
  color: string | null;
  /** Short display branch (e.g. from refs/heads/foo); `null` for the "all" row. */
  branchLabel: string | null;
};

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

type LaneComboboxProps = {
  lanes: LaneComboboxLane[];
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

  const selectedLane = useMemo(
    () => lanes.find((l) => l.id === value),
    [lanes, value],
  );

  const selectedBranchLabel = useMemo(() => {
    if (value === "all" || !selectedLane) return null;
    return resolveBranchLabel(selectedLane.branchRef);
  }, [value, selectedLane]);

  const items = useMemo(() => {
    const base: LaneListItem[] = [];
    if (showAllOption) {
      base.push({ id: "all", name: allLabel, color: null, branchLabel: null });
    }
    for (const lane of lanes) {
      base.push({
        id: lane.id,
        name: lane.name,
        color: lane.color ?? null,
        branchLabel: resolveBranchLabel(lane.branchRef),
      });
    }
    const q = search.trim().toLowerCase();
    if (!q) return base;
    return base.filter((item) =>
      item.name.toLowerCase().includes(q)
      || (item.branchLabel?.toLowerCase().includes(q) ?? false),
    );
  }, [lanes, showAllOption, allLabel, search]);

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

  // Scroll highlighted item into view
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.children[highlightedIndex] as HTMLElement | undefined;
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

  const displayLabel = value === "all" ? allLabel : (selectedLane?.name ?? placeholder);
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
          maxWidth: 320,
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
          maxWidth: 200,
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
                  items.map((item) => {
                    const isSelected = item.id === value;
                    const isAutoCreate = item.id === AUTO_CREATE_LANE_OPTION_ID;

                    if (isAutoCreate) {
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className="ade-lane-popover-item ade-lane-popover-item-featured"
                          data-selected={isSelected ? "true" : undefined}
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
                        key={item.id}
                        type="button"
                        className="ade-lane-popover-item"
                        data-selected={isSelected ? "true" : undefined}
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
