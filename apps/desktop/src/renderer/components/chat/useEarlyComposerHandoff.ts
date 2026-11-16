import { useEffect, useRef } from "react";
import {
  claimEarlyComposer,
  recordEarlyComposerLayout,
  retireEarlyComposer,
  type EarlyComposerClaim,
} from "../../lib/earlyComposer";

/*
 * The real Work draft composer's side of the early prompt box
 * (`lib/earlyComposer.ts`).
 *
 * On its first mount in a window, after its saved draft is read:
 * 1. With an empty draft, it records the new-chat screen, so the next cold
 *    start can draw it while the Work chunk loads.
 * 2. It takes what the early box holds: the text goes into the draft through
 *    the composer's own draft path (and is saved like typed text); then,
 *    once the field shows it, the caret and the keyboard follow, and an early
 *    Enter is replayed into the field so the composer's own key handling
 *    decides what it does.
 */

/** Long enough for the field to render the handed-over text. */
const HANDOFF_WAIT_FRAMES = 60;
let layoutRecordedThisWindow = false;

function fieldText(field: HTMLElement): string {
  return field instanceof HTMLTextAreaElement ? field.value : (field.textContent ?? "");
}

function placeCaret(field: HTMLElement, claim: EarlyComposerClaim, caret: { start: number; end: number }): void {
  if (!claim.focus) return;
  field.focus({ preventScroll: true });
  // The rich editor (links, mentions) keeps its own caret; the plain field
  // takes the early box's.
  if (field instanceof HTMLTextAreaElement) field.setSelectionRange(caret.start, caret.end);
}

function finishHandoff(
  dock: HTMLElement,
  claim: EarlyComposerClaim,
  expectedText: string,
  caret: { start: number; end: number },
  insertLineBreak: () => void,
): void {
  // Now, in this effect: the plain field shows the text and takes the
  // keyboard at once, so a key typed in the next frame lands after the text
  // and not in an empty field (React then renders the same value and keeps
  // the caret). The draft store already holds the text.
  const field = dock.querySelector<HTMLElement>("[data-chat-composer-text]");
  let placed = false;
  if (field instanceof HTMLTextAreaElement && !field.disabled) {
    if (field.value !== expectedText) field.value = expectedText;
    placeCaret(field, claim, caret);
    placed = true;
  }
  let frames = 0;
  const tick = () => {
    frames += 1;
    if (!dock.isConnected) return;
    const current = dock.querySelector<HTMLElement>("[data-chat-composer-text]");
    // Two frames at least, so the composer has rendered the new draft before
    // an early Enter reaches its key handler.
    // A key the person typed in the real field since then may follow the text.
    const shown = current ? fieldText(current) : "";
    if (!current || !(placed ? shown.startsWith(expectedText) : shown === expectedText) || frames < 2) {
      if (frames < HANDOFF_WAIT_FRAMES) requestAnimationFrame(tick);
      return;
    }
    if (!placed || current !== field) placeCaret(current, claim, caret);
    if (!claim.pendingKey) return;
    const taken = !current.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      metaKey: claim.pendingKey.metaKey,
      ctrlKey: claim.pendingKey.ctrlKey,
      bubbles: true,
      cancelable: true,
    }));
    // Not a send in this composer (Enter set to a new line): the line break
    // the key would have typed.
    const editable = current instanceof HTMLTextAreaElement ? !current.disabled && !current.readOnly : current.isContentEditable;
    if (!taken && editable && !claim.pendingKey.metaKey && !claim.pendingKey.ctrlKey) insertLineBreak();
  };
  requestAnimationFrame(tick);
}

export function useEarlyComposerHandoff(args: {
  /** This is the Work tab's new-chat composer. */
  enabled: boolean;
  projectRoot: string | null;
  dockRef: { readonly current: HTMLElement | null };
  /** The draft text now (the store, not a render). */
  readDraft: () => string;
  /** Set the draft through the composer's own path. */
  applyDraft: (text: string) => void;
}): void {
  const argsRef = useRef(args);
  argsRef.current = args;
  const { enabled, projectRoot } = args;
  useEffect(() => {
    if (!enabled) return;
    const { dockRef, readDraft, applyDraft } = argsRef.current;
    const dock = dockRef.current;
    const hydrated = readDraft();
    if (dock && projectRoot && hydrated === "" && !layoutRecordedThisWindow) {
      layoutRecordedThisWindow = recordEarlyComposerLayout(dock, projectRoot);
    }
    const claim = claimEarlyComposer(projectRoot);
    if (!claim) {
      retireEarlyComposer();
      return;
    }
    let expectedText = hydrated;
    let caret = { start: hydrated.length, end: hydrated.length };
    if (claim.text) {
      // The early box only takes input when the saved draft is empty. If one
      // appeared anyway (another window), nothing is dropped: the early text
      // goes after it on a new line.
      const prefix = hydrated ? `${hydrated}\n` : "";
      expectedText = `${prefix}${claim.text}`;
      caret = { start: prefix.length + claim.selectionStart, end: prefix.length + claim.selectionEnd };
      applyDraft(expectedText);
    }
    // No prompt box on screen (a panel holds it): the text is in the draft,
    // and the caret and an early Enter have nowhere to go.
    if (!dock) return;
    finishHandoff(dock, claim, expectedText, caret, () => {
      const current = argsRef.current.readDraft();
      const start = Math.min(caret.start, current.length);
      const end = Math.min(caret.end, current.length);
      argsRef.current.applyDraft(`${current.slice(0, start)}\n${current.slice(end)}`);
      // The field renders the new text on the next frame; the caret goes after the break.
      requestAnimationFrame(() => {
        const field = dock.querySelector<HTMLElement>("[data-chat-composer-text]");
        if (field instanceof HTMLTextAreaElement && document.activeElement === field) {
          field.setSelectionRange(start + 1, start + 1);
        }
      });
    });
    // Mount only: the hand-over happens once, on the first draft composer.
  }, [enabled, projectRoot]);
}
