/**
 * What the Mac Desktop pane's one chrome row says, as data.
 *
 * The strip is the only place the panel states its situation, and every label in
 * it is a judgement about two or three facts at once — the picture's state and
 * the lease's, whether anything is parked, whether the display is on this Mac.
 * Those judgements are here rather than inline in JSX so they can be asserted
 * without mounting a pane, and so the row itself stays a layout.
 *
 * Layout rule the callers keep: everything in the row is either a short text
 * chip (the status pill, the window count) or a 28px icon button with a
 * tooltip. Nothing carries a sentence, which is what kept the row on one line
 * at 600px — the version that wrote "Bring to my screen" and "Take over" as
 * labels wrapped onto two lines in a 700px pane.
 */

import type { MacDesktopLeaseState, MacDesktopWindow } from "../../../shared/types/macDesktop";

export type MacDesktopLiveStatus = "idle" | "starting" | "playing" | "error";

export type MacDesktopStatusPill = {
  /** "Live", "Starting", "Reconnecting". */
  label: string;
  /** Who is driving, after the separator. */
  detail: string;
  tone: "live" | "pending" | "error";
};

export function macDesktopStatusPill(args: {
  live: MacDesktopLiveStatus;
  lease: MacDesktopLeaseState | null;
  iHaveControl: boolean;
}): MacDesktopStatusPill {
  const label = args.live === "playing" ? "Live" : args.live === "error" ? "Reconnecting" : "Starting";
  const tone = args.live === "playing" ? "live" : args.live === "error" ? "error" : "pending";
  const detail = args.iHaveControl
    ? "You are driving"
    : args.lease?.holder === "agent"
      ? "Agent driving"
      : "Idle";
  return { label, detail, tone };
}

/**
 * The present button, or nothing.
 *
 * Three rules, and the first version broke two of them. `present` moves every
 * window the lane OWNS, wherever it currently sits, so a lane that owns nothing
 * gets no button at all — "Send back" on an empty screen reported "0 moved" and
 * was the first thing the pane offered a person who had never used it. Which
 * direction is offered follows where those windows are right now: still on the
 * lane's screen means the useful move is towards the user, already on the
 * user's screen means it is back. And both directions move windows between THIS
 * Mac's screens, so neither exists for a display hosted on another machine.
 */
export function macDesktopPresentAction(args: {
  hostIsLocal: boolean;
  /** Windows the lane owns, wherever they are. */
  ownedCount: number;
  /** How many of those are on the lane's own display. */
  parkedCount: number;
}): { destination: "main" | "display"; label: string } | null {
  if (!args.hostIsLocal) return null;
  if (args.ownedCount <= 0) return null;
  return args.parkedCount > 0
    ? { destination: "main", label: "Bring to my screen" }
    : { destination: "display", label: "Send back to the lane's screen" };
}

/**
 * Whether the lane has anything on its own screen right now.
 *
 * A window row still carries the lane id after it has been released, so the
 * question is which display it is actually sitting on.
 */
export function macDesktopParkedWindows(
  windows: readonly MacDesktopWindow[],
  displayId: number | null | undefined,
): MacDesktopWindow[] {
  if (displayId == null) return [];
  return windows.filter((entry) => entry.onDisplayId === displayId);
}

/** The label one window gets in the strip's dropdown. */
export function macDesktopWindowLabel(window: MacDesktopWindow): string {
  return [window.appName, window.title].filter(Boolean).join(" \u2014 ");
}

/**
 * Side-by-side, or stacked.
 *
 * The pane is a tall narrow column most of the time, and a 16:9 picture in it
 * leaves everything below the picture for the windows rail. Once the pane is
 * appreciably wider than it is tall the same stacking wastes the width instead,
 * so the rail moves to the right of the picture. The width floor is the second
 * half of the rule: a 300x150 pane is "wide" by ratio alone and has no room for
 * a 280px rail beside a picture.
 */
export const MAC_DESKTOP_WIDE_RATIO = 1.6;
export const MAC_DESKTOP_WIDE_MIN_WIDTH = 560;

export function macDesktopIsWidePane(width: number, height: number): boolean {
  if (width < MAC_DESKTOP_WIDE_MIN_WIDTH || height <= 0) return false;
  return width > height * MAC_DESKTOP_WIDE_RATIO;
}

/**
 * The two letters on a window card, when there is no app icon to draw.
 *
 * Words first ("Visual Studio Code" -> "VS"), because an app's initials are how
 * its name is abbreviated everywhere else; a one-word name falls back to its
 * first two characters ("Xcode" -> "XC") rather than a single lonely letter.
 */
export function macDesktopAppGlyph(appName: string | null | undefined): string {
  const words = (appName ?? "").trim().split(/[\s.\-_]+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length > 1) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return words[0]!.slice(0, 2).toUpperCase();
}

/** The title a window card shows, which is never empty. */
export function macDesktopWindowTitle(window: MacDesktopWindow): string {
  const title = window.title?.trim();
  return title?.length ? title : "Untitled window";
}

/**
 * "just now" / "2m ago" for the last-observation line.
 *
 * Coarse on purpose: the line exists to say whether what is on the picture is
 * what the agent last looked at, and a seconds-accurate clock there would be a
 * timer running for a sentence nobody reads twice.
 */
export function macDesktopRelativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
