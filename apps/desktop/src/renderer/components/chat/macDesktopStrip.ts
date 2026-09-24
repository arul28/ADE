/**
 * What the Mac Desktop pane's one chrome row says, as data.
 *
 * The strip is the only place the panel states its situation, and every label in
 * it is a judgement about two or three facts at once — the picture's state and
 * the lease's, whether anything is parked, whether the display is on this Mac.
 * Those judgements are here rather than inline in JSX so they can be asserted
 * without mounting a pane, and so the row itself stays a layout.
 *
 * Layout rule the callers keep: the row is a small state dot at the far left
 * and 28px icon buttons on the right. Nothing carries a sentence, which is what
 * kept the row on one line at 600px — the version that wrote "Bring to my
 * screen" and "Take over" as labels wrapped onto two lines in a 700px pane.
 * The name/status text and the Windows dropdown were removed: the desktop's
 * apps are listed in the pane's own Apps section, not in a strip chip.
 */

import {
  type MacDesktopLeaseState,
  type MacDesktopWindow,
} from "../../../shared/types/macDesktop";

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
 * The status chip's segments, split so the layout cannot orphan one.
 *
 * The status word and the detail used to be one truncatable string with a
 * `·` baked between them, so a narrow row (takeover adds "You have control /
 * Return to agent") squeezed the whole chip to a sliver that read as a bare
 * separator, and "Live · Idle" vanished. The status is the part that must
 * never disappear, the separator belongs to the detail it introduces, and a
 * detail with nothing to say draws neither.
 */
export type MacDesktopStatusSegments = {
  /** The state word, always present. */
  status: string;
  /** The separator, present exactly when the detail is. */
  separator: string | null;
  /** The sentence after the separator, or null. */
  detail: string | null;
};

export function macDesktopStatusSegments(pill: MacDesktopStatusPill): MacDesktopStatusSegments {
  const detail = pill.detail?.trim() || null;
  return {
    status: pill.label,
    separator: detail ? "·" : null,
    detail,
  };
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

/**
 * How big the picture is when it owns the whole window.
 *
 * Full screen is an overlay over the app, not a pane: there is no aspect-ratio
 * box for the picture to inherit, so the fit is computed rather than left to
 * CSS. Both a `width:100%` + `aspect-ratio` box (too tall, clipped) and a
 * `max-h-full` one (ratio dropped the moment the height was capped) drew the
 * picture off-centre with dark bands down one side, which is exactly what the
 * owner saw. The returned box is the picture's own element size, so the
 * ResizeObserver that feeds `viewRect` measures the PICTURE and every overlay
 * — takeover cursor, agent cursor, window outline — maps onto it unchanged.
 *
 * `margin` is subtracted from both axes before the fit so the picture never
 * runs into the overlay's edges or the bar above it.
 */
export function macDesktopFullscreenPicture(
  box: { width: number; height: number },
  display: { width: number; height: number },
  margin = 0,
): { width: number; height: number } | null {
  const availableWidth = box.width - margin * 2;
  const availableHeight = box.height - margin * 2;
  if (availableWidth <= 0 || availableHeight <= 0) return null;
  if (display.width <= 0 || display.height <= 0) return null;
  const scale = Math.min(availableWidth / display.width, availableHeight / display.height);
  return {
    width: Math.round(display.width * scale),
    height: Math.round(display.height * scale),
  };
}

/**
 * Which controls the chrome row carries, per place it is drawn.
 *
 * Full screen used to carry three of them and hide even those after two
 * seconds, so a person who pressed the button landed on a picture with no
 * status and no way back but an undiscoverable Escape. The answer is that full
 * screen carries the SAME row the pane does — the only differences are the ones
 * that are facts about the row's place: full screen spells its exit out in
 * words rather than an icon tooltip, because it is the one control the user is
 * looking for. The window list is gone: it lives in the pane's Apps section.
 */
export function macDesktopStripControls(args: {
  expanded: boolean;
  hostIsLocal: boolean;
  ownedCount: number;
  parkedCount: number;
}): {
  status: true;
  record: true;
  present: boolean;
  takeover: true;
  fullscreen: { label: string; labelled: boolean };
} {
  return {
    status: true,
    record: true,
    present: macDesktopPresentAction({
      hostIsLocal: args.hostIsLocal,
      ownedCount: args.ownedCount,
      parkedCount: args.parkedCount,
    }) != null,
    takeover: true,
    fullscreen: args.expanded
      ? { label: "Exit full screen", labelled: true }
      : { label: "Full screen", labelled: false },
  };
}

/**
 * The one or two pieces of text a window row prints.
 *
 * A row that always printed both lines said "Grok Bot / Grok Bot" for every
 * single-window app, which is the whole app name twice in a card twice the
 * height it needed. The window's title is the subject when it is one; the app
 * name is a secondary column only when it adds something the title does not
 * already say.
 */
export function macDesktopWindowRowText(window: MacDesktopWindow): {
  primary: string;
  secondary: string | null;
} {
  const app = window.appName?.trim() ?? "";
  const title = window.title?.trim() ?? "";
  if (!title || (app && title.toLowerCase() === app.toLowerCase())) {
    return { primary: app || macDesktopWindowTitle(window), secondary: null };
  }
  return { primary: title, secondary: app || null };
}
