/**
 * History's keyboard map, as a pure resolution.
 *
 * Three chords, and each one is a compiled behaviour that the move to a guest
 * took away:
 *
 * - **G H** — the palette's "Go to History" row advertised this chord, and the
 *   compiled product answered it. A plugin cannot declare it: the shared
 *   grammar in `shared/plugins/keybindings.ts` refuses multi-stroke sequences
 *   outright, because the desktop matcher has no notion of a prefix key. So the
 *   page answers it itself, and inside History it means what the row meant —
 *   go to History's home, the commit graph with nothing selected.
 * - **Escape** — closed the detail pane. A guest sees its own Escape and the
 *   host never does, so the page has to close its own detail.
 * - **Mod+[** — the host's Back accelerator (`PLUGIN_PANEL_BACK_BINDING`). It
 *   pops a panel's back stack, and a page is one screen with one thing stacked
 *   on it: the detail. It pops that.
 *
 * Pure, and separate from the component, because the interesting behaviour is
 * the chord window and the typing guard, and neither needs a rendered page to
 * be wrong in a way a reader would notice.
 */

/**
 * How long the `G` half of the chord stays armed.
 *
 * The renderer's own `g`-prefix chords (`PrDetailPane`, `PrChecksTab`) use
 * 1200ms and this matches them, so a reader's hands learn one timing.
 */
export const HISTORY_CHORD_WINDOW_MS = 1_200;

export type HistoryKeyAction =
  /** The commit graph, nothing selected — what "Go to History" always did. */
  | "history-home"
  /** Close the detail pane, leaving the timeline as it was. */
  | "close-detail";

/** What the map remembers between keystrokes: when `G` was pressed, if it was. */
export type HistoryKeyState = { chordArmedAt: number | null };

export const HISTORY_KEY_STATE: HistoryKeyState = { chordArmedAt: null };

/** One keystroke, in the terms this map needs. */
export type HistoryKeyStroke = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** True when the reader is in a field. A chord that fires mid-word is a bug. */
  isTyping: boolean;
};

export type HistoryKeyResolution = {
  action: HistoryKeyAction | null;
  state: HistoryKeyState;
  /** True when the page should stop the host or the browser also answering. */
  handled: boolean;
};

const IDLE: HistoryKeyState = { chordArmedAt: null };

function bare(stroke: HistoryKeyStroke): boolean {
  return !stroke.metaKey && !stroke.ctrlKey && !stroke.altKey;
}

/**
 * Resolve one keystroke against the armed chord.
 *
 * Returns the NEXT state rather than mutating, so a test can walk a sequence
 * and the component can hold the state in a ref without the two disagreeing on
 * what "armed" means.
 */
export function resolveHistoryKey(
  stroke: HistoryKeyStroke,
  state: HistoryKeyState,
  now: number,
): HistoryKeyResolution {
  // A field owns every key it receives, and it also disarms the chord: a reader
  // who typed `g` into the search box has not begun a chord, and treating it as
  // one would turn the next `h` into a navigation.
  if (stroke.isTyping) return { action: null, state: IDLE, handled: false };

  const key = stroke.key.toLowerCase();

  if (key === "escape" && bare(stroke) && !stroke.shiftKey) {
    return { action: "close-detail", state: IDLE, handled: true };
  }

  // `Mod` is Cmd on macOS and Ctrl everywhere else, and the page answers either
  // rather than sniffing the platform: a reader on a Mac who has learned Ctrl
  // from another editor gets the same Back, and neither spelling means anything
  // else here.
  if (key === "[" && (stroke.metaKey || stroke.ctrlKey) && !stroke.altKey) {
    return { action: "close-detail", state: IDLE, handled: true };
  }

  if (key === "g" && bare(stroke) && !stroke.shiftKey) {
    return { action: null, state: { chordArmedAt: now }, handled: false };
  }

  if (key === "h" && bare(stroke) && !stroke.shiftKey) {
    const armedAt = state.chordArmedAt;
    if (armedAt != null && now - armedAt <= HISTORY_CHORD_WINDOW_MS) {
      return { action: "history-home", state: IDLE, handled: true };
    }
    return { action: null, state: IDLE, handled: false };
  }

  // Any other key ends the chord. Half a chord left armed across an unrelated
  // keystroke fires later, which reads as History moving on its own.
  return { action: null, state: IDLE, handled: false };
}

/** Is the reader typing into this element? The guard `LanesPage` uses. */
export function strokeTargetIsTyping(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined") return false;
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  return target.isContentEditable;
}
