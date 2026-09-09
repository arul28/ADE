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
import type { BrowserToolbarLayout } from "./builtInBrowserToolbar";
import { cn } from "../../ui/cn";
import {
  WORK_TOOL_CHROME_FOCUS,
  WORK_TOOL_CHROME_GHOST,
  WORK_TOOL_CHROME_MOTION,
  WORK_TOOL_CHROME_ROW_HEIGHT,
} from "../../terminals/workToolChrome";

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
  /**
   * This host has somewhere to put a browser element or a screenshot — a chat,
   * a draft, or an agent CLI session. False in a shell session, where Inspect,
   * Attach and "screenshot to chat" have no destination at all, so they are not
   * rendered rather than rendered disabled.
   */
  canAttachContext: boolean;
  inspecting: boolean;
  onInspectToggle: () => void;
  emulation: BuiltInBrowserEmulationState | null;
  deviceLabel: string;
  /** The device list, rendered by whichever surface is showing it. */
  deviceMenuItems: ReactNode;
  /** The element the person picked in the page, and what may be done with it. */
  selection: {
    has: boolean;
    onAttach: () => void;
  };
};


/*
  The row geometry, the ghost control, the focus ring and the motion curve are
  ALL owned by `terminals/workToolChrome` — the browser pane settled this look
  first, but every Work tool spends it now, so the definitions live with the
  tools and these names are aliases for the files in this folder (the same thing
  this file already does for the menu tokens below).

  Every reference browser worth copying — Cursor, Arc, Zen — draws its chrome as
  one 40px row of borderless glyphs over the window's own background. The boxed,
  bordered, filled controls this pane used to ship are what made it read as a
  form rather than as a browser.
*/
export const CHROME_ROW_CLASS = WORK_TOOL_CHROME_ROW_HEIGHT;
/** 16px, the size every glyph on the row is drawn at. */
export const CHROME_ICON_SIZE = 16;

/**
 * A control on the chrome row: 28px square, no border, no fill at rest.
 *
 * The row is quiet until you point at it. Hover is the only fill, and a
 * disabled control fades rather than growing a different box. Motion and the
 * focus ring are spent alongside it (`TOOLBAR_MOTION`, `TOOLBAR_FOCUS`) rather
 * than baked in, because the find bar's 24px controls reuse those two on a
 * different square.
 */
export const CHROME_GHOST = WORK_TOOL_CHROME_GHOST;

/**
 * "On" is a colour, never a chip.
 *
 * Inspect armed, an emulation preset applied, pop-out available — all of them
 * used to grow a tinted, bordered box that shouted at the same volume as the
 * page. State belongs in the glyph.
 */
export const CHROME_GHOST_ON = "text-[var(--color-accent)] hover:text-[var(--color-accent)]";
/** Recording is the one destructive-coloured state on the row. */
export const CHROME_GHOST_REC = "text-rose-300 hover:text-rose-200";

export const TOOLBAR_FOCUS = WORK_TOOL_CHROME_FOCUS;
export const TOOLBAR_MOTION = `${WORK_TOOL_CHROME_MOTION} disabled:cursor-not-allowed disabled:opacity-40`;

/**
 * The dot that says a toggle is on, without a word.
 *
 * 6px, bottom-right of the glyph it belongs to: the device button wears one
 * when a preset is applied, the camera wears a pulsing one while recording.
 */
export const CHROME_STATE_DOT = "pointer-events-none absolute bottom-[3px] right-[3px] h-[6px] w-[6px] rounded-full";

/**
 * Turn off the app-wide `input:focus` halo.
 *
 * `index.css` paints every focused input with a 2px accent halo, which is the
 * right default for a form. Here the RING BELONGS TO THE WRAPPER — the address
 * field is borderless until its box lights up — so without this the field wears
 * two rings at once: a square inner halo inside a rounded outer one.
 */
export const CHROME_FIELD_NO_HALO = "focus:shadow-none! focus-visible:shadow-none!";

/** Every strip under the chrome row — find, handoff, approval — is this tall. */
export const CHROME_BAR_CLASS = "h-8";
/** The hairline that separates one strip from the next. */
export const CHROME_HAIRLINE = "border-white/[0.07]";

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
