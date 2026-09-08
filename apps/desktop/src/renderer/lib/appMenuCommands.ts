import type { AppMenuCommand } from "../../shared/types/core";

/**
 * Who gets ⌘/Ctrl F and ⌘/Ctrl W.
 *
 * The twin of `lib/appZoomCommands`, and it exists for the same reason: those
 * chords are native menu accelerators, and Electron consumes an accelerator in
 * the browser process *before* the renderer sees a keydown. The built-in
 * browser makes that worse — once you click the page, focus is in a different
 * WebContents entirely, so this renderer gets no key event at all. The menu
 * sends one command down instead, and this is the single place that decides
 * whether a surface inside the app or the app itself answers it.
 *
 * A claim is a *chance* to handle, not a takeover: the handler returns false
 * when it is not the right moment (the browser pane is mounted but the composer
 * has focus), and the app-wide default — close the window, do nothing — runs as
 * before. Claims stack, newest first, so two mounted panes cannot fight over
 * one keystroke.
 */
export type AppMenuCommandHandler = (command: AppMenuCommand) => boolean;

const claims: AppMenuCommandHandler[] = [];

/** Register a handler. Returns its own unclaim, safe to call twice. */
export function claimAppMenuCommands(handler: AppMenuCommandHandler): () => void {
  claims.push(handler);
  return () => {
    const index = claims.lastIndexOf(handler);
    if (index >= 0) claims.splice(index, 1);
  };
}

/** True when a claimant handled it and the app-wide default must not also run. */
export function consumeAppMenuCommand(command: AppMenuCommand): boolean {
  for (let index = claims.length - 1; index >= 0; index -= 1) {
    if (claims[index](command)) return true;
  }
  return false;
}

/** Test-only: drop every claim so one suite cannot leak into the next. */
export function resetAppMenuCommandsForTests(): void {
  claims.length = 0;
}
