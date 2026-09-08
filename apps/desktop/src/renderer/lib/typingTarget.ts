/**
 * "Is this keystroke someone typing?"
 *
 * The one question every single-key shortcut in the app has to ask before it
 * acts. A layer that skips it turns the letters of a search query into
 * commands — typing "domain" into the browser's find bar switched the Work
 * pane to App Control — so the test lives in one place rather than being
 * re-derived, slightly differently, next to each binding.
 *
 * A declared escape scope counts as typing too: a surface that has claimed the
 * keyboard for itself (`data-ade-escape-scope`, e.g. the find bar) is not a
 * place a global chord may reach into, even when focus sits on one of its
 * buttons rather than in its input.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (
    target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target.isContentEditable
  ) {
    return true;
  }
  return target.closest("[data-ade-escape-scope]") != null;
}
