/**
 * What is open over the app, for the layers that float over it (the tour, the
 * contextual hints, suggestion cards, "What's new") to step aside for the same
 * things.
 */

const DIALOG_ROLE_SELECTORS = ['[role="dialog"]', '[role="alertdialog"]'] as const;

/** Any dialog or alert dialog, modal or not. */
export const DIALOG_SELECTOR = DIALOG_ROLE_SELECTORS.join(", ");

/** A dialog or alert dialog marked `aria-modal="true"`. */
export const MODAL_DIALOG_SELECTOR = DIALOG_ROLE_SELECTORS.map((role) => `${role}[aria-modal="true"]`).join(", ");

/**
 * A modal dialog, any alert dialog (a confirmation is never something to
 * cover, marked modal or not), or a contextual hint on screen.
 */
const FLOATING_LAYER_SELECTOR = [
  '[role="dialog"][aria-modal="true"]',
  '[role="alertdialog"]',
  "[data-onboarding-hint-layer]",
].join(", ");

/** A modal dialog or alert dialog is up: the tour and the hints wait for it. */
export function modalOpen(): boolean {
  return document.querySelector(MODAL_DIALOG_SELECTOR) != null;
}

/** Something a suggestion or notice card must not sit on: a modal, any alert dialog, or a contextual hint. */
export function floatingLayerBusy(): boolean {
  return document.querySelector(FLOATING_LAYER_SELECTOR) != null;
}

const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "email", "tel", "password", "number"]);

/**
 * The person may be in the middle of writing: a focused text field that holds
 * text, or a focused terminal (its draft lives on the screen, not in the
 * helper textarea). Opening a modal now would take the keyboard mid-sentence.
 */
export function editingTextNow(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (active.closest(".xterm")) return true;
  if (active instanceof HTMLTextAreaElement) return active.value.trim().length > 0;
  if (active instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(active.type) && active.value.trim().length > 0;
  return active.isContentEditable && (active.textContent ?? "").trim().length > 0;
}

/** The launch gate (first-run setup) is up; it is not always marked as a dialog. */
export function launchGateOpen(): boolean {
  return document.querySelector(".ade-gate") != null;
}

/**
 * Marks a notice that floats over the page (a toast, the Tip card, a floating
 * banner). The built-in browser's page is a native view drawn above the whole
 * window, so it hides itself while one of these overlaps it; without the mark
 * the page covered the notice and its buttons.
 */
export const FLOATS_OVER_BROWSER_ATTR = "data-ade-floats-over-browser";
/** Spread onto the notice's pointer-enabled root. */
export const FLOATS_OVER_BROWSER_PROPS = { [FLOATS_OVER_BROWSER_ATTR]: "" } as const;
