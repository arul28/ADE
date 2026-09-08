/**
 * The browser pane's shared chrome vocabulary.
 *
 * The tab strip, the toolbar row, the find bar and the ⋮ menu all live in
 * separate files now, and every one of them draws from the same control
 * geometry and menu surface. Keeping the strings here is what stops the four
 * from drifting into four slightly different toolbars.
 */
import type { ReactNode } from "react";
import type { BuiltInBrowserEmulationState } from "../../../../shared/types/builtInBrowser";
import type { BrowserToolbarLayout } from "../builtInBrowserToolbar";
import { cn } from "../../ui/cn";

/**
 * The chrome both toolbar pieces are handed, built once by the panel.
 *
 * Eleven props used to be passed separately to the row AND to the ⋮ menu by the
 * same parent, which is a duplication a reader has to notice rather than one the
 * types prevent. One object, spread into neither: each child takes it whole, so
 * adding a shared concern is one edit in one place.
 */
export type BrowserChromeShared = {
  toolbar: BrowserToolbarLayout;
  /** Which action is in flight, so every control can disable itself. */
  busy: string | null;
  apiAvailable: boolean;
  inspecting: boolean;
  onInspectToggle: () => void;
  emulation: BuiltInBrowserEmulationState | null;
  deviceLabel: string;
  /** The device list, rendered by whichever surface is showing it. */
  deviceMenuItems: ReactNode;
  /** The element the person picked in the page, and what may be done with it. */
  selection: {
    has: boolean;
    canAdd: boolean;
    onAttach: () => void;
  };
};


/** Shared control geometry, so the URL field and the menu buttons read as one row. */
export const TOOLBAR_CONTROL = "h-7 rounded-[7px] border text-[11px]";
export const TOOLBAR_IDLE = "border-white/[0.08] bg-white/[0.035] text-fg/72 hover:bg-white/[0.07] hover:text-fg/90";
export const TOOLBAR_ON = "border-[color-mix(in_srgb,var(--color-accent)_32%,transparent)] bg-[color-mix(in_srgb,var(--color-accent)_15%,transparent)] text-fg/92";
export const TOOLBAR_FOCUS = "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]";
export const TOOLBAR_MOTION = "transition-colors duration-[120ms] ease-out disabled:cursor-not-allowed disabled:opacity-40";

/*
  The menu vocabulary is app-wide, not the browser's.

  App Control renders its own inline-form menus from the same tokens, and the
  two had already drifted (label weight, item padding, content radius). One
  definition lives in `ui/paneMenuTokens`; this re-export is only so the files
  in this folder can keep importing their chrome from one place.
*/
export {
  MENU_CONTENT_CLASS,
  MENU_ITEM_CLASS,
  MENU_LABEL_CLASS,
  MENU_SEPARATOR_CLASS,
} from "../../ui/paneMenuTokens";

/**
 * A switch inside a menu row.
 *
 * DevTools and the network log are states you leave on, and a row that just
 * said "Off" made you guess whether clicking it turned it on or confirmed it
 * was off. Radix's checkbox item supplies the semantics; this is its face.
 */
export function MenuSwitch({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-flex h-[14px] w-[24px] shrink-0 items-center rounded-full border",
        "transition-colors duration-[120ms] ease-out",
        checked
          ? "border-[color-mix(in_srgb,var(--color-accent)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-accent)_55%,transparent)]"
          : "border-white/[0.12] bg-white/[0.06]",
      )}
    >
      <span
        className={cn(
          "absolute h-[10px] w-[10px] rounded-full bg-white/90 transition-all duration-[120ms] ease-out",
          checked ? "left-[11px]" : "left-[1.5px]",
        )}
      />
    </span>
  );
}
