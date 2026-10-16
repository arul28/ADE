/**
 * Who owns a keystroke right now.
 *
 * Every page-level shortcut has to ask the same two questions before it acts,
 * and surfaces that answer them differently steal keys from each other. One
 * module answers both:
 *
 * - `keyChordIsClaimed` — a modal layer is in front and answers its own keys.
 * - `caretChordIsClaimed` — the caret is in a field or a terminal's input,
 *   where unmodified keys are typing and the caret chords belong to the
 *   platform.
 */

/**
 * Anything that owns keys more strongly than the page behind it.
 *
 * A superset of `WorkSidebar`'s pane-level `MODAL_LAYER_SELECTOR` (that one
 * additionally treats a non-empty field and its `data-ade-escape-scope`
 * opt-out as claims, which is pane-Escape policy rather than page policy), so a
 * page chord that lands inside a popover, a sheet or a listbox stays with it.
 *
 * A Radix popper counts because it portals to `document.body`, outside the
 * subtree that opened it.
 */
export const MODAL_LAYER_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  "[data-radix-popper-content-wrapper]",
].join(", ");

/** What counts as "the person is typing". */
const CARET_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
  "[contenteditable='']",
  "[role='textbox']",
].join(", ");

function asElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

export function keyChordIsClaimed(target: EventTarget | null): boolean {
  return asElement(target)?.closest(MODAL_LAYER_SELECTOR) != null;
}

export function caretChordIsClaimed(target: EventTarget | null): boolean {
  const element = asElement(target);
  if (!element) return false;
  if (element.closest(".xterm")) return true;
  return element.closest(CARET_SELECTOR) != null;
}
