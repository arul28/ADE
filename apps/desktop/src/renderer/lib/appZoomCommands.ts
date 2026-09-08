import type { AppZoomCommand } from "../../shared/types/core";

/**
 * Who gets ⌘/Ctrl +=, − and 0.
 *
 * Those three chords are registered as native View-menu accelerators, and
 * Electron consumes an accelerator in the browser process *before* the renderer
 * ever sees the keydown — so a panel that binds them with `onKeyDown` is
 * shadowed on the packaged app while passing every jsdom test. The menu instead
 * sends one `zoom` command into the renderer, and this is the single place that
 * decides whether the app or a surface inside it should answer it.
 *
 * A claim is a *chance* to handle, not a takeover: the handler returns false
 * when it is not the right moment (the browser pane is mounted but the composer
 * has focus), and the app zoom happens as before. Claims stack, newest first,
 * so two mounted browser panes cannot fight over one keystroke.
 */
export type AppZoomCommandHandler = (command: AppZoomCommand) => boolean;

const claims: AppZoomCommandHandler[] = [];

/** Register a handler. Returns its own unclaim, safe to call twice. */
export function claimAppZoomCommands(handler: AppZoomCommandHandler): () => void {
  claims.push(handler);
  return () => {
    const index = claims.lastIndexOf(handler);
    if (index >= 0) claims.splice(index, 1);
  };
}

/** True when a claimant handled it and the app-wide zoom must not also run. */
export function consumeAppZoomCommand(command: AppZoomCommand): boolean {
  for (let index = claims.length - 1; index >= 0; index -= 1) {
    if (claims[index](command)) return true;
  }
  return false;
}

/** Test-only: drop every claim so one suite cannot leak into the next. */
export function resetAppZoomCommandsForTests(): void {
  claims.length = 0;
}
