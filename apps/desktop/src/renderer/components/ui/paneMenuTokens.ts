import { cn } from "./cn";

/**
 * One menu surface for the pane host's dropdowns.
 *
 * The Work tools pane ships two menu implementations in adjacent panes — Radix
 * `DropdownMenu` in the browser toolbar, a hand-rolled one in App Control,
 * which needs to host inline forms (a launch command, a CDP port) that a Radix
 * menu's typeahead and focus management would fight. That split is deliberate;
 * the two looking like different products was not. The label was `9.5px`
 * semibold/`60%` in one and `9px` medium/`55%` in the other, with different
 * item padding and a different radius.
 *
 * Split so both can use it: `MENU_SURFACE_CLASS` is the paint (border, fill,
 * radius, shadow, type) with no positioning or sizing, and each menu adds its
 * own — the browser's is portalled by Radix, App Control's is absolutely
 * positioned inside the pane so it cannot escape the pane's stacking context
 * and float over another tool's live frame.
 *
 * `MENU_ITEM_CLASS` carries Radix's `data-[highlighted]` / `data-[disabled]`
 * hooks, which are inert on a plain `<button>` — so the hand-rolled menu uses
 * the same string and layers its own `hover:` state on top.
 */
export const MENU_SURFACE_CLASS = cn(
  "select-none rounded-[var(--radius-lg)] border border-white/[0.08]",
  "bg-[var(--color-popup-bg,var(--color-card))] p-1 font-sans text-[11.5px] text-fg/82",
  "shadow-[var(--shadow-popup,0_24px_64px_-24px_rgba(0,0,0,0.8))]",
);

/** The portalled variant: the surface plus the browser menu's own sizing. */
export const MENU_CONTENT_CLASS = cn(
  MENU_SURFACE_CLASS,
  "z-[140] min-w-[228px] max-w-[min(280px,calc(100vw-16px))] overflow-hidden",
);

export const MENU_ITEM_CLASS = cn(
  "flex cursor-pointer select-none items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 outline-none",
  "transition-colors duration-[120ms] ease-out data-[highlighted]:bg-white/[0.07] data-[highlighted]:text-fg",
  "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40",
);

export const MENU_LABEL_CLASS =
  "px-2 pb-1 pt-1.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-muted-fg/60";

export const MENU_SEPARATOR_CLASS = "my-1 h-px bg-white/[0.06]";
