import type { AppMenuCommand } from "../../shared/types/core";
import { createCommandClaims } from "./appCommandClaims";
import { eventMatchesBinding } from "./keybindings";

/**
 * Who gets ⌘/Ctrl F and ⌘/Ctrl W.
 *
 * One instance of the shared claim registry (`lib/appCommandClaims`) — see that
 * file for why a menu command, and not a keydown, is what reaches the renderer.
 * Unclaimed, `close-tab` falls back to the ordinary window close and `find`
 * falls back to the focused element's own find (TopBar).
 */
export type AppMenuCommandHandler = (command: AppMenuCommand) => boolean;

const menuClaims = createCommandClaims<AppMenuCommand>();

export const claimAppMenuCommands = menuClaims.claim;
export const consumeAppMenuCommand = menuClaims.consume;
export const resetAppMenuCommandsForTests = menuClaims.resetForTests;

/**
 * Where there is no native menu (the hosted web client), ⌘F / Ctrl+F arrives
 * as a keydown. Offer it to the same claims; when a surface takes it, the
 * browser's own find (which sees only the rows a virtualized list has mounted)
 * stays closed. When nothing claims it, the browser's find opens as usual.
 * Returns the uninstall.
 */
export function installFindKeyBridge(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !event.isTrusted) return;
    if (!eventMatchesBinding(event, "Mod+F")) return;
    if (!menuClaims.consume("find")) return;
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener("keydown", onKeyDown, true);
  return () => window.removeEventListener("keydown", onKeyDown, true);
}
