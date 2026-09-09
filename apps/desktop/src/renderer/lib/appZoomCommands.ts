import type { AppZoomCommand } from "../../shared/types/core";
import { createCommandClaims } from "./appCommandClaims";

/**
 * Who gets ⌘/Ctrl +=, − and 0.
 *
 * One instance of the shared claim registry (`lib/appCommandClaims`) — see that
 * file for why a menu command, and not a keydown, is what reaches the renderer.
 */
export type AppZoomCommandHandler = (command: AppZoomCommand) => boolean;

const zoomClaims = createCommandClaims<AppZoomCommand>();

export const claimAppZoomCommands = zoomClaims.claim;
export const consumeAppZoomCommand = zoomClaims.consume;
export const resetAppZoomCommandsForTests = zoomClaims.resetForTests;
