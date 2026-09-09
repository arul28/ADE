import type { AppMenuCommand } from "../../shared/types/core";
import { createCommandClaims } from "./appCommandClaims";

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
