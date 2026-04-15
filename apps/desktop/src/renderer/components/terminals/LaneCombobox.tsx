import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CaretUpDown, MagnifyingGlass, Check } from "@phosphor-icons/react";
import type { LaneSummary } from "../../../shared/types";
import { COLORS } from "../lanes/laneDesignTokens";

type LaneComboboxProps = {
  lanes: LaneSummary[];
  value: string;
  onChange: (laneId: string) => void;
  showAllOption?: boolean;
  allLabel?: string;
  placeholder?: string;
  compact?: boolean;
};

export function LaneCombobox({
  lanes,
  value,
  onChange,
  showAllOption = false,
  allLabel = "All lanes",
  placeholder = "Select lane...",
  compact = false,
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

  const items = useMemo(() => {
    const base: Array<{ id: string; name: string; color: string | null }> = [];
    if (showAllOption) {
      base.push({ id: "all", name: allLabel, color: null });
    }
    for (const lane of lanes) {
      base.push({ id: lane.id, name: lane.name, color: lane.color ?? null });
    }
    if (!search.trim()) return base;
    const q = search.trim().toLowerCase();
    return base.filter((item) => item.name.toLowerCase().includes(q));
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
      width: Math.max(rect.width, 220),
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
  const displayColor = value === "all" ? null : (selectedLane?.color ?? COLORS.accent);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="ade-lane-trigger"
        onClick={() => setOpen(!open)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          height: compact ? 24 : 28,
          padding: compact ? "0 6px" : "0 8px",
          borderRadius: 6,
          border: "1px solid var(--work-pane-border)",
          background: "rgba(255,255,255,0.02)",
          color: "var(--color-fg)",
          fontSize: 11,
          fontWeight: 400,
          cursor: "pointer",
          minWidth: 0,
          maxWidth: 200,
          transition: "border-color 100ms ease, background 100ms ease",
        }}
      >
        {displayColor ? (
          <span
            className="ade-lane-popover-dot"
            style={{ background: displayColor }}
          />
        ) : null}
        <span className="truncate" style={{ flex: 1, minWidth: 0 }}>
          {displayLabel}
        </span>
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
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className="ade-lane-popover-item"
                        data-selected={isSelected ? "true" : undefined}
                        data-highlighted={isHighlighted ? "true" : undefined}
                        onClick={() => selectItem(item.id)}
                        onMouseEnter={() => setHighlightedIndex(idx)}
                      >
                        {item.color ? (
                          <span
                            className="ade-lane-popover-dot"
                            style={{ background: item.color }}
                          />
                        ) : (
                          <span
                            className="ade-lane-popover-dot"
                            style={{
                              background: "var(--color-muted-fg)",
                              opacity: 0.3,
                            }}
                          />
                        )}
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
