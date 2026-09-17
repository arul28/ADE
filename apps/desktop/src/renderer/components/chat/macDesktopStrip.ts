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

export type MacDesktopFooter = { kind: "windows"; text: string };

/**
 * The line under the screen, or nothing at all.
 *
 * The empty case used to be a sentence with a CLI command and a "Claim…" link
 * in it, sitting under a live video of an empty screen — plain, repetitive and
 * in the wrong place. An empty screen now says what it is on the picture
 * itself ({@link MacDesktopEmptyOverlay}), so there is nothing left for this
 * line to say and it returns null instead of inventing filler.
 */
export function macDesktopFooter(parked: readonly MacDesktopWindow[]): MacDesktopFooter | null {
  if (!parked.length) return null;
  return { kind: "windows", text: parked.map(macDesktopWindowLabel).join(" \u00b7 ") };
}
