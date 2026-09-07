import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { CaretDown, Check } from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "../ui/cn";

/** The house overshoot curve — same one `ade-popover-in` uses in index.css. */
const OVERSHOOT = [0.34, 1.56, 0.64, 1] as const;

/**
 * A small dropdown for the App Control toolbar.
 *
 * Hand-rolled rather than Radix on purpose: the toolbar lives inside a pane
 * that can be 280px wide, the menus need to host inline forms (a launch
 * command, a CDP port) as well as items, and a portal would escape the pane's
 * stacking context and float over the live frame of a *different* tool.
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
  const setOpen = useCallback((next: boolean | ((value: boolean) => boolean)) => {
    setUncontrolledOpen((value) => {
      const resolved = typeof next === "function" ? next(controlledOpen ?? value) : next;
      onOpenChange?.(resolved);
      return resolved;
    });
  }, [controlledOpen, onOpenChange]);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const reduceMotion = useReducedMotion() ?? false;

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
          "disabled:cursor-not-allowed disabled:opacity-45",
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
            style={{ transformOrigin: "top" }}
            className={cn(
              "absolute top-[calc(100%+4px)] z-30 flex max-h-[320px] w-[248px] flex-col overflow-auto",
              "rounded-[var(--radius-md)] border border-white/[0.1] bg-card/95 p-1 shadow-[var(--shadow-popup)]",
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
          "flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[11.5px]",
          "transition-colors duration-[120ms] ease-out",
          "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
          tone === "danger"
            ? "text-rose-200/85 hover:bg-rose-500/12"
            : "text-fg/85 hover:bg-white/[0.06]",
          disabled && "cursor-not-allowed opacity-45 hover:bg-transparent",
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
  return (
    <div className="px-2 pb-1 pt-1.5 text-[9px] font-medium uppercase tracking-[0.08em] text-muted-fg/55">
      {children}
    </div>
  );
}
