import type React from "react";

/**
 * Asks the Linear pane to close: the cell and PR chips navigate the app under
 * it, and the pane is a modal on top. The pane's host listens for this.
 */
export const LINEAR_PANE_CLOSE_REQUEST_EVENT = "ade:linear-pane:close-request";

/**
 * Navigate the app shell from inside the Linear pane. Hash navigation works
 * under both routers (the web client bridges the hash), and keeps this file
 * usable where no router context exists.
 */
export function navigateFromLinearPane(path: string): void {
  window.location.hash = `#${path}`;
  window.dispatchEvent(new Event(LINEAR_PANE_CLOSE_REQUEST_EVENT));
}

/**
 * Enter/Space on a chip inside a row belong to the chip: the row's own key
 * handler would select the row and cancel the chip's click.
 */
export function stopRowActivation(event: React.KeyboardEvent): void {
  if (event.key === "Enter" || event.key === " ") event.stopPropagation();
}
