import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { CaretDown, Check } from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "../ui/cn";
import {
  MENU_ITEM_CLASS,
  MENU_LABEL_CLASS,
  MENU_SCROLL_CLASS,
  MENU_MAX_HEIGHT_PX,
  MENU_SURFACE_CLASS,
  MENU_WIDTH_CLASS,
} from "../ui/paneMenuTokens";

/** The house overshoot curve — same one `ade-popover-in` uses in index.css. */
const OVERSHOOT = [0.34, 1.56, 0.64, 1] as const;

/** The gap the menu keeps between its own bottom and its clipping edge. */
const MENU_EDGE_GUTTER_PX = 8;

/** Below this a scrolling menu is worse than a clipped one, so it stops shrinking. */
const MENU_MIN_HEIGHT_PX = 160;

/** `top-[calc(100%+4px)]` — kept here so the measurement matches the class. */
const MENU_TRIGGER_OFFSET_PX = 4;

/**
 * The edge that actually cuts this menu off.
 *
 * The menu is anchored inside the pane rather than portalled (so it cannot
 * float over another tool's live frame), and the Work tools pane is
 * `overflow-hidden` — so the viewport, which is what a `vh` max-height
 * measures against, is the wrong ruler entirely. On a short pane the last item
 * was clipped with no scrollbar to say it was there. The first clipping
 * ancestor is the honest one.
 */
function clipBottomFor(node: HTMLElement | null): number {
  const view = node?.ownerDocument?.defaultView ?? (typeof window === "undefined" ? null : window);
  const viewportBottom = view?.innerHeight ?? 0;
  if (!node || !view) return viewportBottom;
  for (let current = node.parentElement; current; current = current.parentElement) {
    const style = view.getComputedStyle(current);
    if (style.overflowY !== "visible" || style.overflowX !== "visible") {
      const bottom = current.getBoundingClientRect().bottom;
      return Math.min(bottom, viewportBottom || bottom);
    }
  }
  return viewportBottom;
}

/**
 * A small dropdown for the App Control toolbar.
 *
 * Hand-rolled rather than Radix for ONE reason: these menus host inline forms —
 * a launch command, a CDP port — and a Radix menu owns typeahead, focus and
 * Escape in ways a text field inside it has to fight. (Radix without a Portal
 * renders inline, so "a portal would escape the pane's stacking context" is an
 * argument against `DropdownMenu.Portal`, not against Radix; a menu that is
 * only items should still use it.)
 *
 * The paint comes from `ui/paneMenuTokens`, shared with the browser pane's
 * Radix menu, so the two implementations at least look like one product.
 */
export function AppControlMenu({
  triggerLabel,
  triggerIcon,
  triggerTitle,
  ariaLabel,
  align = "start",
  disabled = false,
  showCaret = true,
  triggerClassName,
  menuClassName,
  open: controlledOpen,
  onOpenChange,
  children,
}: {
  triggerLabel?: ReactNode;
  triggerIcon?: ReactNode;
  triggerTitle?: string;
  ariaLabel: string;
  align?: "start" | "end";
  disabled?: boolean;
  showCaret?: boolean;
  triggerClassName?: string;
  menuClassName?: string;
  /** Optional controlled mode, so another affordance can open this menu. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: (close: () => void) => ReactNode;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  // The parent's setter is called from the EVENT HANDLER, never from inside a
  // `useState` updater. React runs updaters during the render phase (twice
  // under StrictMode), so notifying the parent from in there updated a
  // different component mid-render — "Cannot update a component while
  // rendering a different component" — and fired `onOpenChange` twice per
  // click on the one menu that is mounted controlled.
  const openRef = useRef(open);
  openRef.current = open;
  const setOpen = useCallback((next: boolean | ((value: boolean) => boolean)) => {
    const resolved = typeof next === "function" ? next(openRef.current) : next;
    setUncontrolledOpen(resolved);
    onOpenChange?.(resolved);
  }, [onOpenChange]);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const reduceMotion = useReducedMotion() ?? false;
  const [maxHeightPx, setMaxHeightPx] = useState<number | null>(null);

  // Measured, not declared: the space below the trigger inside the pane is the
  // only thing that decides whether this menu has to scroll.
  useLayoutEffect(() => {
    if (!open) {
      setMaxHeightPx(null);
      return undefined;
    }
    const measure = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const top = trigger.getBoundingClientRect().bottom + MENU_TRIGGER_OFFSET_PX;
      const available = clipBottomFor(wrapperRef.current) - top - MENU_EDGE_GUTTER_PX;
      // Clamped both ways: the measurement is a safety valve for a SHORT pane,
      // not a licence to outgrow the design ceiling on a tall one.
      const clamped = Math.min(Math.max(available, MENU_MIN_HEIGHT_PX), MENU_MAX_HEIGHT_PX);
      setMaxHeightPx(Math.round(clamped));
    };
    measure();
    const view = wrapperRef.current?.ownerDocument?.defaultView ?? window;
    view.addEventListener("resize", measure);
    return () => view.removeEventListener("resize", measure);
  }, [open]);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, [setOpen]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close(true);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [close, open, setOpen]);

  // Arrow keys walk the menu; anything focusable inside (including the inline
  // forms) participates, so a keyboard user never has to reach for the mouse.
  const onMenuKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const container = event.currentTarget;
    const focusables = Array.from(
      container.querySelectorAll<HTMLElement>('[role="menuitem"],[role="menuitemcheckbox"],input,button'),
    ).filter((node) => !node.hasAttribute("disabled"));
    if (focusables.length === 0) return;
    event.preventDefault();
    const current = focusables.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = current < 0
      ? (step > 0 ? 0 : focusables.length - 1)
      : (current + step + focusables.length) % focusables.length;
    focusables[next]?.focus();
  }, []);

  return (
    <div ref={wrapperRef} className="relative flex shrink-0 items-stretch">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={triggerTitle ?? ariaLabel}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "inline-flex min-w-0 items-center gap-1 rounded-[var(--radius-sm)] px-1.5 text-[11px] font-medium",
          "text-fg/85 transition-colors duration-[120ms] ease-out hover:bg-white/[0.06]",
          "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
          // 40, not 45: the same disabled weight `MENU_ITEM_CLASS` gives the
          // browser menu next door.
          "disabled:cursor-not-allowed disabled:opacity-40",
          open && "bg-white/[0.06]",
          triggerClassName,
        )}
      >
        {triggerIcon}
        {triggerLabel != null ? <span className="min-w-0 truncate">{triggerLabel}</span> : null}
        {showCaret ? <CaretDown size={9} weight="bold" className="shrink-0 text-muted-fg/60" /> : null}
      </button>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            id={menuId}
            role="menu"
            aria-label={ariaLabel}
            onKeyDown={onMenuKeyDown}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scaleY: 0.96, y: -2 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scaleY: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scaleY: 0.97 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.15, ease: OVERSHOOT }}
            style={{
              transformOrigin: "top",
              // Beats the token's viewport-based ceiling, which stays as the
              // fallback for the frame before the first measurement lands. The
              // measurement is clamped to `MENU_MAX_HEIGHT_PX`, so this only
              // ever makes the menu shorter than the class would.
              ...(maxHeightPx == null ? null : { maxHeight: `${maxHeightPx}px` }),
            }}
            className={cn(
              MENU_SURFACE_CLASS,
              // Positioning and sizing are this menu's own: it is anchored
              // inside the pane rather than portalled, precisely so it cannot
              // float over another tool's live frame.
              "absolute top-[calc(100%+4px)] z-30 flex flex-col",
              MENU_WIDTH_CLASS,
              MENU_SCROLL_CLASS,
              "backdrop-blur-[var(--blur-popup)]",
              align === "end" ? "right-0" : "left-0",
              menuClassName,
            )}
          >
            {children(() => close(true))}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** One row in an {@link AppControlMenu}. */
export function AppControlMenuItem({
  icon,
  label,
  hint,
  checked,
  disabled = false,
  disabledReason,
  tone = "default",
  onSelect,
}: {
  icon?: ReactNode;
  label: string;
  hint?: string | null;
  checked?: boolean;
  disabled?: boolean;
  disabledReason?: string | null;
  tone?: "default" | "danger";
  onSelect: () => void;
}) {
  const reasonId = useId();
  // The reason lives OUTSIDE the button on purpose: text inside a control is
  // part of its accessible name, and "Stop No session to stop." is a worse
  // label than "Stop" with a description.
  return (
    <>
      <button
        type="button"
        role={checked == null ? "menuitem" : "menuitemcheckbox"}
        aria-checked={checked == null ? undefined : checked}
        aria-describedby={disabled && disabledReason ? reasonId : undefined}
        disabled={disabled}
        title={disabled ? disabledReason ?? undefined : hint ?? undefined}
        onClick={onSelect}
        className={cn(
          MENU_ITEM_CLASS,
          // A `<button>` has no `data-highlighted`, so the shared item class's
          // Radix hooks are inert here and the hover state is added on top.
          "w-full text-left",
          "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
          tone === "danger"
            ? "text-rose-200/85 hover:bg-rose-500/12"
            : "text-fg/85 hover:bg-white/[0.06]",
          disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
        )}
      >
        {icon ? <span className="shrink-0 text-muted-fg/75">{icon}</span> : null}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {checked ? <Check size={11} weight="bold" className="shrink-0 text-[var(--color-accent)]" /> : null}
      </button>
      {disabled && disabledReason ? (
        <span id={reasonId} className="sr-only">{disabledReason}</span>
      ) : null}
    </>
  );
}

/** A small caps label separating groups of items. */
export function AppControlMenuLabel({ children }: { children: ReactNode }) {
  return <div className={MENU_LABEL_CLASS}>{children}</div>;
}
