import { isMacDesktopNotParkedRetry } from "../../../shared/types/macDesktop";

/**
 * The Activity row for a window the driver could not move to the lane's screen.
 *
 * `macDesktopNotParkedPhrase` falls through to the raw reason for a code it
 * does not know, so the pane printed "localhost:5173 window_not_movable. It is
 * still on your main screen." A person cannot act on a code. The codes we can
 * name get their own sentence, and every other code gets the plain one: the
 * window did not move, and it is still where they can see it.
 */
export function macDesktopNotParkedSentence(windowLabel: string, reason: string): string {
  const code = reason.trim().toLowerCase();
  const label = windowLabel.trim() || "A window";
  if (isMacDesktopNotParkedRetry(code)) {
    return `${label} is still opening. It stays on your main screen until it is ready.`;
  }
  if (code === "escaped" || code === "window_escaped" || code === "gave_up") {
    return `${label} keeps leaving the lane's screen. It is on your main screen.`;
  }
  if (code.includes("permission") || code.includes("accessibility") || code.includes("not_trusted")) {
    return `Couldn't move ${label}: Accessibility is off. It stays on your main screen.`;
  }
  return `Couldn't move ${label} to the lane's screen. It stays on your main screen.`;
}
