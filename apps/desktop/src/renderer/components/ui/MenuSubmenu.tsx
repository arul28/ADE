import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

/**
 * Hover *intent*, not hover. A menu is a list you scan by dragging the pointer
 * down it, so a submenu that opens the instant the cursor touches its row would
 * flash open on every row you merely pass over.
 */
export const SUBMENU_OPEN_DELAY_MS = 180;
/**
 * The diagonal-approach grace period. Leaving the trigger row toward the panel
 * necessarily crosses rows that are neither, so the submenu has to survive a
 * short gap with the pointer over nothing. A safe-triangle would be tighter but
 * needs continuous pointer tracking; a close delay buys the same forgiveness for
 * a fraction of the machinery, and it is what the row spacing here calls for.
 */
export const SUBMENU_CLOSE_DELAY_MS = 300;

/** Viewport gutter kept clear on every side when the panel is placed. */
const VIEWPORT_MARGIN = 8;
/** Panel overlaps its trigger row slightly so the pointer never crosses a gap. */
const PANEL_OVERLAP = 3;

export type MenuSubmenuProps = {
  /** Row label. */
  label: ReactNode;
  /** Right-aligned trailing hint on the row, rendered before the chevron. */
  hint?: ReactNode;
  /** Trigger row classes — pass the host menu's own item class. */
  className?: string;
  /** Trigger row inline style, for menus (the lane menu) that style inline. */
  style?: CSSProperties;
  /**
   * Hover fill for inline-styled hosts. The lane menu paints its own hover in
   * JS rather than CSS, so the row has to be told what its hover looks like.
   */
  hoverBackground?: string;
  /** ARIA role for the row; menus with `role="menu"` should pass `menuitem`. */
  role?: string;
  panelClassName?: string;
  panelStyle?: CSSProperties;
  /** Minimum panel width; defaults to the session menu's own min width. */
  panelMinWidth?: number;
  "data-testid"?: string;
  title?: string;
  disabled?: boolean;
  /**
   * Fired every time the panel opens, before its content renders. Content that
   * is a snapshot of the wall clock (snooze presets) resolves here so it is
   * correct at open time rather than at mount time.
   */
  onOpen?: () => void;
  children: ReactNode;
};

/**
 * A menu row that expands a second panel to its right on hover-intent, flipping
 * to the left when the viewport has no room.
 *
 * The panel is `position: fixed` and rendered inline rather than portalled: a
 * portal would escape the host menu's `onPointerDown` stop-propagation guard,
 * and every menu in the app relies on that guard to keep a click inside itself
 * from reaching the document-level dismiss listener. Fixed positioning already
 * escapes the lane menu's `overflow-y: auto` clip, which was the only reason to
 * want a portal.
 */
export function MenuSubmenu({
  label,
  hint,
  className,
  style,
  hoverBackground,
  role,
  panelClassName,
  panelStyle,
  panelMinWidth = 180,
  "data-testid": testId,
  title,
  disabled = false,
  onOpen,
  children,
}: MenuSubmenuProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set only when the panel was opened from the keyboard, so pointer users do
  // not get focus yanked off the row they are still hovering.
  const focusPanelRef = useRef(false);

  const clearTimers = useCallback(() => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; }
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  // Mirrors `open` so `onOpen` can fire exactly once per open without running
  // inside a state updater, where a caller's setState would land mid-render.
  const openRef = useRef(false);

  const openNow = useCallback(() => {
    clearTimers();
    if (openRef.current) return;
    openRef.current = true;
    onOpen?.();
    setOpen(true);
  }, [clearTimers, onOpen]);

  const closeNow = useCallback(() => {
    const restoreTriggerFocus = Boolean(
      panelRef.current
      && typeof document !== "undefined"
      && panelRef.current.contains(document.activeElement),
    );
    clearTimers();
    openRef.current = false;
    setOpen(false);
    setPosition(null);
    if (hoverBackground && triggerRef.current) {
      triggerRef.current.style.background = "transparent";
    }
    if (restoreTriggerFocus) triggerRef.current?.focus();
  }, [clearTimers, hoverBackground]);

  const scheduleOpen = useCallback(() => {
    if (disabled || open) return;
    clearTimers();
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      openNow();
    }, SUBMENU_OPEN_DELAY_MS);
  }, [clearTimers, disabled, open, openNow]);

  const scheduleClose = useCallback(() => {
    clearTimers();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      closeNow();
    }, SUBMENU_CLOSE_DELAY_MS);
  }, [clearTimers, closeNow]);

  // Place after the panel has a measurable size, then reveal it. Measuring in a
  // layout effect keeps the flip decision in the same frame as the paint, so a
  // panel near the right edge never shows in the wrong place first.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const rect = trigger.getBoundingClientRect();
    const width = panel.offsetWidth || panelMinWidth;
    const height = panel.offsetHeight;
    const viewportWidth = window.innerWidth || 0;
    const viewportHeight = window.innerHeight || 0;

    let left = rect.right - PANEL_OVERLAP;
    if (left + width > viewportWidth - VIEWPORT_MARGIN) {
      left = Math.max(VIEWPORT_MARGIN, rect.left - width + PANEL_OVERLAP);
    }
    let top = rect.top - 4;
    if (top + height > viewportHeight - VIEWPORT_MARGIN) {
      top = Math.max(VIEWPORT_MARGIN, viewportHeight - VIEWPORT_MARGIN - height);
    }
    setPosition({ left, top });
  }, [open, panelMinWidth]);

  useEffect(() => {
    if (!open || !focusPanelRef.current) return;
    focusPanelRef.current = false;
    focusFirstItem(panelRef.current);
  }, [open]);

  const returnFocusAndClose = useCallback(() => {
    closeNow();
    triggerRef.current?.focus();
  }, [closeNow]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role={role}
        title={title}
        data-testid={testId}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className={className}
        style={style}
        onPointerEnter={(event) => {
          if (hoverBackground) event.currentTarget.style.background = hoverBackground;
          scheduleOpen();
        }}
        onPointerLeave={(event) => {
          // The row keeps its fill while its panel is up: the open panel is the
          // row's state, and dropping the fill would read as "nothing selected"
          // while a whole panel hangs off it.
          if (hoverBackground && !open) event.currentTarget.style.background = "transparent";
          scheduleClose();
        }}
        onFocus={() => clearTimers()}
        onClick={() => { if (!disabled) openNow(); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            focusPanelRef.current = true;
            openNow();
          } else if (event.key === "ArrowLeft" || event.key === "Escape") {
            if (!open) return;
            event.preventDefault();
            // Escape closes the submenu only; the host menu keeps its own
            // Escape handling for the level above.
            event.stopPropagation();
            closeNow();
          }
        }}
      >
        {label}
        {hint ? (
          <span className="ml-auto max-w-[10rem] shrink-0 truncate text-[10px] text-muted-fg/50">
            {hint}
          </span>
        ) : null}
        <span aria-hidden className={hint ? "shrink-0 opacity-45" : "ml-auto shrink-0 opacity-45"}>
          ›
        </span>
      </button>
      {open ? (
        <div
          ref={panelRef}
          role="menu"
          className={panelClassName ?? "ade-liquid-glass-menu py-1"}
          style={{
            position: "fixed",
            zIndex: 60,
            minWidth: panelMinWidth,
            maxHeight: `calc(100vh - ${VIEWPORT_MARGIN * 2}px)`,
            overflowY: "auto",
            left: position?.left ?? 0,
            top: position?.top ?? 0,
            visibility: position ? "visible" : "hidden",
            ...panelStyle,
          }}
          onPointerEnter={clearTimers}
          onPointerLeave={scheduleClose}
          onKeyDown={(event) => {
            if (event.key === "Escape" || event.key === "ArrowLeft") {
              event.preventDefault();
              event.stopPropagation();
              returnFocusAndClose();
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              moveFocus(panelRef.current, event.key === "ArrowDown" ? 1 : -1);
            }
          }}
        >
          {children}
        </div>
      ) : null}
    </>
  );
}

function focusableItems(panel: HTMLElement | null): HTMLElement[] {
  if (!panel) return [];
  return Array.from(panel.querySelectorAll<HTMLElement>("button:not([disabled])"));
}

function focusFirstItem(panel: HTMLElement | null): void {
  focusableItems(panel)[0]?.focus();
}

function moveFocus(panel: HTMLElement | null, delta: number): void {
  const items = focusableItems(panel);
  if (!items.length) return;
  const current = items.indexOf(document.activeElement as HTMLElement);
  const next = current < 0
    ? (delta > 0 ? 0 : items.length - 1)
    : (current + delta + items.length) % items.length;
  items[next]?.focus();
}

/**
 * Quiet section label. Deliberately the same weight as the sidebar's shelf
 * labels: a menu heading is a wayfinding aid, not a row, and must never compete
 * with the items under it.
 */
export function MenuSectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pb-0.5 pt-1.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-fg/55">
      {children}
    </div>
  );
}

export function MenuSeparator() {
  return <div className="my-0.5 h-px bg-border/10" />;
}
