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

/** The label one window gets in the footer and in the dropdown. */
export function macDesktopWindowLabel(window: MacDesktopWindow): string {
  return [window.appName, window.title].filter(Boolean).join(" — ");
}

export type MacDesktopFooter =
  | { kind: "windows"; text: string }
  | { kind: "empty"; text: string; command: string; action: string };

/**
 * The line under the screen.
 *
 * The empty case is the one that matters: "No windows parked yet" told a person
 * opening the tab for the first time only that the thing they were looking at
 * was expected to be empty, and not one way to change that. It now names both —
 * the command that launches an app onto the screen, and the button that adopts
 * one that is already open.
 */
export function macDesktopFooter(parked: readonly MacDesktopWindow[]): MacDesktopFooter {
  if (parked.length) {
    return { kind: "windows", text: parked.map(macDesktopWindowLabel).join(" · ") };
  }
  return {
    kind: "empty",
    text: "No windows yet ·",
    command: "ade mac-desktop open <app>",
    action: "or claim a window",
  };
}

/**
 * Windows that could be moved onto this lane's screen.
 *
 * Anything already parked on a lane display is excluded — its own lane's and
 * every other lane's — because "claim" is for a window sitting on the user's
 * own desk, and re-claiming a parked one is what `present` is for.
 */
export function macDesktopClaimableWindows(
  windows: readonly MacDesktopWindow[],
): MacDesktopWindow[] {
  return windows.filter((entry) => entry.laneId == null && entry.onDisplayId == null && !entry.minimized);
}
