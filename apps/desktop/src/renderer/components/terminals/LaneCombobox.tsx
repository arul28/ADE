import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CaretUpDown, Check, GitBranch, MagnifyingGlass } from "@phosphor-icons/react";
import { branchNameFromRef } from "../prs/shared/laneBranchTargets";
import { COLORS, laneSurfaceTint } from "../lanes/laneDesignTokens";

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

function resolveBranchLabel(ref: string | null | undefined): string | null {
  if (!ref) return null;
  return branchNameFromRef(ref) || null;
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

  // Focus search on open
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
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
    el?.scrollIntoView({ block: "nearest" });
  }, [open, highlightedIndex]);

  // Position popover below trigger
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});
  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const openAbove = spaceBelow < 200 && rect.top > 200;
    setPopoverStyle({
      left: rect.left,
      width: Math.max(rect.width, 260),
      ...(openAbove
        ? { bottom: window.innerHeight - rect.top + 4 }
        : { top: rect.bottom + 4 }),
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
          <span
            className="ade-lane-popover-dot"
            style={{ background: displayColor, flexShrink: 0 }}
          />
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
              <GitBranch
                size={9}
                weight="regular"
                style={{
                  color: "var(--color-muted-fg)",
                  opacity: 0.55,
                  flexShrink: 0,
                }}
                aria-hidden
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
              <div style={{ display: "flex", alignItems: "center", paddingLeft: 10 }}>
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
                  style={{ borderBottom: "none", paddingLeft: 6 }}
                />
              </div>
              <div
                style={{
                  height: 1,
                  background: "var(--work-pane-border)",
                  flexShrink: 0,
                }}
              />
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
                  items.map((item, idx) => {
                    const isSelected = item.id === value;
                    const isHighlighted = idx === highlightedIndex;
                    const dot = item.color ? (
                      <span className="ade-lane-popover-dot" style={{ background: item.color }} />
                    ) : (
                      <span
                        className="ade-lane-popover-dot"
                        style={{ background: "var(--color-muted-fg)", opacity: 0.3 }}
                      />
                    );
                    const titleRow = (
                      <div
                        style={{
                          display: "flex",
                          width: "100%",
                          alignItems: "center",
                          gap: 8,
                          minWidth: 0,
                        }}
                      >
                        {dot}
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
                        data-highlighted={isHighlighted ? "true" : undefined}
                        onClick={() => selectItem(item.id)}
                        onMouseEnter={() => setHighlightedIndex(idx)}
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
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 4,
                                marginLeft: 14,
                                marginTop: 3,
                                minWidth: 0,
                              }}
                            >
                              <GitBranch
                                size={10}
                                weight="regular"
                                style={{ color: "var(--color-muted-fg)", opacity: 0.55, flexShrink: 0 }}
                                aria-hidden
                              />
                              <span
                                className="truncate"
                                style={{
                                  fontSize: 10,
                                  lineHeight: 1.2,
                                  color: "var(--color-muted-fg)",
                                  opacity: 0.92,
                                }}
                              >
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
