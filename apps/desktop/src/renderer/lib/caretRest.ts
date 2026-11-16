/**
 * Text carets stop blinking after a quiet spell, and start again on input.
 *
 * Chromium repaints a blinking caret every 500 ms, and each repaint keeps the
 * display link running for a while, so a focused prompt box with nobody typing
 * still wakes the app about 60 times a second. After `REST_AFTER_MS` with no
 * key, pointer, wheel or focus change, the root gets `caret-resting` and
 * index.css sets `caret-animation: manual`: the caret stays drawn, solid, and
 * stops blinking. The terminal cursor clock (`xtermCursorBlink.ts`) rests on
 * the same signal. The first input brings the blink back at once.
 */
const REST_AFTER_MS = 10_000;
const RESTING_CLASS = "caret-resting";

const listeners = new Set<(resting: boolean) => void>();
let resting = false;
let timer: number | null = null;
let installed = false;

function setResting(next: boolean): void {
  if (resting === next) return;
  resting = next;
  document.documentElement.classList.toggle(RESTING_CLASS, next);
  for (const listener of listeners) listener(next);
}

function noteActivity(): void {
  setResting(false);
  if (timer != null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    setResting(true);
  }, REST_AFTER_MS);
}

/** Starts watching input for the window. Safe to call more than once. */
export function installCaretRest(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const options = { capture: true, passive: true } as const;
  for (const type of ["keydown", "pointerdown", "wheel", "focusin", "input", "compositionstart"]) {
    window.addEventListener(type, noteActivity, options);
  }
  noteActivity();
}

export function isCaretResting(): boolean {
  return resting;
}

/** Calls `listener` when carets start or stop resting. Returns an unsubscribe. */
export function onCaretRestChange(listener: (resting: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
