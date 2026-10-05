/**
 * Fired in this window when Settings sees the Linear connection change (an API
 * key saved or cleared, an OAuth flow finished). The top-bar Linear button
 * re-checks on it instead of polling every few seconds while disconnected.
 */
export const LINEAR_CONNECTION_CHANGED_EVENT = "ade:linear-connection-changed";

export function announceLinearConnectionChanged(): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new Event(LINEAR_CONNECTION_CHANGED_EVENT));
}
