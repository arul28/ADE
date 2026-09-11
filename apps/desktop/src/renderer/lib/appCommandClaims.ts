/**
 * One claim registry, spent by every native-menu command channel.
 *
 * Native menu accelerators (⌘+/−/0, ⌘F, ⌘W) are consumed by Electron in the
 * browser process *before* the renderer sees a keydown, so a panel that binds
 * them with `onKeyDown` is shadowed on the packaged app while passing every
 * jsdom test. The built-in browser makes that worse — once you click the page,
 * focus is in a different WebContents entirely, so this renderer gets no key
 * event at all. The menu sends one command down instead, and a registry built
 * here is the single place that decides whether a surface inside the app or the
 * app itself answers it.
 *
 * A claim is a *chance* to handle, not a takeover: the handler returns false
 * when it is not the right moment (the browser pane is mounted but the composer
 * has focus), and the app-wide default runs as before. Claims stack, newest
 * first, so two mounted panes cannot fight over one keystroke.
 */
export type CommandClaimHandler<TCommand> = (command: TCommand) => boolean;

export interface CommandClaims<TCommand> {
  /** Register a handler. Returns its own unclaim, safe to call twice. */
  claim: (handler: CommandClaimHandler<TCommand>) => () => void;
  /** True when a claimant handled it and the app-wide default must not also run. */
  consume: (command: TCommand) => boolean;
  /** Test-only: drop every claim so one suite cannot leak into the next. */
  resetForTests: () => void;
}

export function createCommandClaims<TCommand>(): CommandClaims<TCommand> {
  const claims: CommandClaimHandler<TCommand>[] = [];
  return {
    claim(handler) {
      claims.push(handler);
      return () => {
        const index = claims.lastIndexOf(handler);
        if (index >= 0) claims.splice(index, 1);
      };
    },
    consume(command) {
      for (let index = claims.length - 1; index >= 0; index -= 1) {
        if (claims[index](command)) return true;
      }
      return false;
    },
    resetForTests() {
      claims.length = 0;
    },
  };
}
