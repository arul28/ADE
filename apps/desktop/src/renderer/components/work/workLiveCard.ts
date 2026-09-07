import type { WorkSidebarTab } from "../../state/appStore";

/**
 * The floating corner card's decisions, as pure functions.
 *
 * Two questions live here — "which tool should the card show?" and "which
 * remembered frame is the pointer over?" — because both are the kind of thing
 * that is obvious until it isn't (a dismissed card that never comes back, a
 * scrubber that shows frame 10 of 3), and neither needs a DOM to answer.
 */

/** The tools that have something to *look at*. Git and Files do not. */
export type WorkLiveScreenTool = Extract<WorkSidebarTab, "browser" | "app-control" | "ios">;

export const WORK_LIVE_SCREEN_TOOLS: readonly WorkLiveScreenTool[] = ["browser", "app-control", "ios"];

export function isWorkLiveScreenTool(tool: WorkSidebarTab | null): tool is WorkLiveScreenTool {
  return tool === "browser" || tool === "app-control" || tool === "ios";
}

export type WorkLiveActivity = {
  tool: WorkLiveScreenTool;
  /** `Date.now()` of this tool's most recent activity; 0 when it has none. */
  lastActivityAt: number;
  /** The tool can run here at all (capability gate). */
  available: boolean;
  /** Something of this tool's is running right now. */
  live: boolean;
};

/* ── Dismissal ────────────────────────────────────────────────────────────── */

/**
 * The activity stamp each tool's card was dismissed at, keyed by tool id.
 *
 * Per TOOL rather than one flag because "I don't need to watch the browser
 * right now" says nothing about the simulator that boots ten seconds later.
 * The value is the activity clock the card was showing when you closed it, so
 * the rule "come back on NEW activity" is a plain `>` and cannot be defeated by
 * the bookkeeping event that closing the card itself provokes.
 */
export type WorkLiveCardDismissals = Record<string, number>;

export function normalizeWorkLiveCardDismissals(value: unknown): WorkLiveCardDismissals | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const next: WorkLiveCardDismissals = {};
  for (const [key, stamp] of Object.entries(value as Record<string, unknown>)) {
    if (!isWorkLiveScreenTool(key as WorkSidebarTab)) continue;
    if (typeof stamp !== "number" || !Number.isFinite(stamp) || stamp <= 0) continue;
    next[key] = stamp;
  }
  return Object.keys(next).length > 0 ? next : null;
}

export function commitWorkLiveCardDismissal(
  dismissals: WorkLiveCardDismissals | null | undefined,
  tool: WorkLiveScreenTool,
  activityStamp: number,
): WorkLiveCardDismissals {
  const previous = dismissals?.[tool] ?? 0;
  return { ...(dismissals ?? {}), [tool]: Math.max(previous, activityStamp) };
}

/**
 * Which tool the card shows, or null for "show nothing".
 *
 * The card exists to keep the screen you are NOT looking at in view, so the
 * active tool is always excluded — otherwise you would get a postage-stamp copy
 * of the pane next to the pane. Ties go to the most recent activity, which is
 * what "the thing that just happened" means to the person watching.
 *
 * `dismissals` implements the "×" affordance: a dismissed tool stays hidden
 * until it does something strictly newer than the stamp it was dismissed at, so
 * closing it silences the current burst of activity rather than the feature —
 * and never silences a different tool.
 */
export function selectWorkLiveCardTool(args: {
  activeTool: WorkSidebarTab | null;
  activities: readonly WorkLiveActivity[];
  /** Per-tool dismissal stamps for the current lane, or null. */
  dismissals: WorkLiveCardDismissals | null;
}): WorkLiveScreenTool | null {
  const { activeTool, activities, dismissals } = args;
  let best: WorkLiveActivity | null = null;
  for (const activity of activities) {
    if (!activity.available || !activity.live) continue;
    if (activity.tool === activeTool) continue;
    if (activity.lastActivityAt <= 0) continue;
    const dismissedAt = dismissals?.[activity.tool];
    if (dismissedAt != null && activity.lastActivityAt <= dismissedAt) continue;
    if (!best || activity.lastActivityAt > best.lastActivityAt) best = activity;
  }
  return best?.tool ?? null;
}

/* ── Frame scrubber ───────────────────────────────────────────────────────── */

export const WORK_LIVE_SCRUB_BUFFER_SIZE = 10;

export type WorkLiveScrubFrame = {
  /** Whatever the card was painting when this entry was committed. */
  dataUrl: string | null;
  /** The action that closed this frame, e.g. `click 'Sign in'`. */
  caption: string | null;
  at: number;
  /**
   * The trace entry this frame belongs to, when the source knows it.
   *
   * App Control announces that an action happened before the caption for it can
   * be read back, so the frame is committed at the instant it was true and the
   * words arrive a round-trip later — addressed by id rather than by index,
   * which the ring buffer keeps shifting.
   */
  id?: string | null;
};

/**
 * Commits one frame to the ring buffer.
 *
 * Advanced on TRACE ENTRIES, not on frames: at 12fps a frame buffer would hold
 * 0.8 seconds of near-identical pictures, which is useless to scrub through.
 * One entry per action gives you "the ten things that just happened", which is
 * the actual question — and it means the buffer costs nothing while a page is
 * merely animating.
 */
export function commitWorkLiveScrubFrame(
  buffer: readonly WorkLiveScrubFrame[],
  frame: WorkLiveScrubFrame,
): WorkLiveScrubFrame[] {
  const next = [...buffer, frame];
  return next.length > WORK_LIVE_SCRUB_BUFFER_SIZE
    ? next.slice(next.length - WORK_LIVE_SCRUB_BUFFER_SIZE)
    : next;
}

/** Fills in the caption of an already-committed frame, by trace id. */
export function updateWorkLiveScrubCaption(
  buffer: readonly WorkLiveScrubFrame[],
  id: string,
  caption: string | null,
): WorkLiveScrubFrame[] {
  let changed = false;
  const next = buffer.map((frame) => {
    if (frame.id !== id || frame.caption === caption) return frame;
    changed = true;
    return { ...frame, caption };
  });
  return changed ? next : [...buffer];
}

/**
 * Maps a pointer position across the card to a buffer index, oldest on the
 * left. Returns null when there is nothing to scrub — one frame is the live
 * view, and scrubbing a single frame is just hovering.
 */
export function workLiveScrubIndex(args: {
  frameCount: number;
  /** Pointer x relative to the card's left edge, in px. */
  offsetX: number;
  width: number;
}): number | null {
  const { frameCount, offsetX, width } = args;
  if (frameCount < 2 || width <= 0) return null;
  const ratio = Math.max(0, Math.min(1, offsetX / width));
  const index = Math.round(ratio * (frameCount - 1));
  return Math.max(0, Math.min(frameCount - 1, index));
}

/* ── Captions ─────────────────────────────────────────────────────────────── */

/**
 * `click 'Sign in'` — the verb plus whatever the action was aimed at.
 *
 * Reads the target the same way the trace records it (selector / text / testId),
 * quotes only what came from the page, and gives up rather than printing a raw
 * CSS selector longer than the card.
 */
export function formatWorkLiveActionCaption(
  action: string,
  target: Record<string, unknown> | null | undefined,
): string {
  const verb = action.trim() || "action";
  const label = actionTargetLabel(target);
  return label ? `${verb} '${label}'` : verb;
}

function actionTargetLabel(target: Record<string, unknown> | null | undefined): string | null {
  if (!target) return null;
  for (const key of ["text", "testId", "selector", "url", "key"]) {
    const value = target[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    return trimmed.length > 32 ? `${trimmed.slice(0, 31)}…` : trimmed;
  }
  return null;
}

/** `2s` / `4m` / `1h` — how long ago, in the shortest honest unit. */
export function formatWorkLiveAge(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/* ── Placement ────────────────────────────────────────────────────────────── */

/** Fraction of the host box, so a resized column keeps the card where it was. */
export type WorkLiveCardPosition = { xPct: number; yPct: number };

export const WORK_LIVE_CARD_WIDTH = 260;
/** 16:10, matching the aspect the browser and App Control both preview at. */
export const WORK_LIVE_CARD_ASPECT = 16 / 10;
export const WORK_LIVE_CARD_INSET = 12;
/** Below either of these the card would cover the thing it sits next to. */
export const WORK_LIVE_CARD_MIN_HOST_WIDTH = 380;
export const WORK_LIVE_CARD_MIN_HOST_HEIGHT = 260;

/**
 * The frame width to ask the source for: the card's own width in DEVICE
 * pixels, so a Retina card is not fed a 260px image and upscaled into mush —
 * and a 5K panel is not fed a 1280px one for a thumbnail.
 */
export function workLivePreviewMaxWidth(devicePixelRatio: number | undefined): number {
  const ratio = Number.isFinite(devicePixelRatio) && (devicePixelRatio ?? 0) > 0
    ? (devicePixelRatio as number)
    : 1;
  return Math.max(320, Math.min(960, Math.round(WORK_LIVE_CARD_WIDTH * ratio)));
}

export function workLiveCardFits(host: { width: number; height: number }): boolean {
  return host.width >= WORK_LIVE_CARD_MIN_HOST_WIDTH && host.height >= WORK_LIVE_CARD_MIN_HOST_HEIGHT;
}

/**
 * The travel the card is allowed, in host pixels.
 *
 * One source of truth for three callers — the default corner, the clamp that
 * restores a stored position, and the drag constraint — because the bug this
 * replaces was exactly those three disagreeing: drag let the card leave the
 * column, and the column clips.
 */
export function workLiveCardTravel(args: {
  host: { width: number; height: number };
  cardHeight: number;
  bottomReserve?: number;
}): { minLeft: number; maxLeft: number; minTop: number; maxTop: number } {
  const bottomReserve = Math.max(0, args.bottomReserve ?? 0);
  const minLeft = WORK_LIVE_CARD_INSET;
  const minTop = WORK_LIVE_CARD_INSET;
  return {
    minLeft,
    minTop,
    maxLeft: Math.max(minLeft, args.host.width - WORK_LIVE_CARD_WIDTH - WORK_LIVE_CARD_INSET),
    maxTop: Math.max(minTop, args.host.height - args.cardHeight - WORK_LIVE_CARD_INSET - bottomReserve),
  };
}

/** Pins an arbitrary pixel position inside {@link workLiveCardTravel}. */
export function clampWorkLiveCardRect(args: {
  host: { width: number; height: number };
  left: number;
  top: number;
  cardHeight: number;
  bottomReserve?: number;
}): { left: number; top: number } {
  const travel = workLiveCardTravel(args);
  return {
    left: Math.max(travel.minLeft, Math.min(travel.maxLeft, args.left)),
    top: Math.max(travel.minTop, Math.min(travel.maxTop, args.top)),
  };
}

/**
 * Turns a stored fractional position into pixels, clamped so a card saved in a
 * wide column can never end up off-screen in a narrow one. With nothing stored
 * it is the bottom-right corner, one inset in from both edges.
 */
export function workLiveCardRect(args: {
  host: { width: number; height: number };
  position: WorkLiveCardPosition | null;
  cardHeight: number;
  /** Space to leave at the bottom, e.g. the composer's height. */
  bottomReserve?: number;
}): { left: number; top: number } {
  const { host, position, cardHeight } = args;
  const travel = workLiveCardTravel(args);
  if (!position) {
    return { left: travel.maxLeft, top: travel.maxTop };
  }
  return clampWorkLiveCardRect({
    ...args,
    left: position.xPct * (host.width - WORK_LIVE_CARD_WIDTH),
    top: position.yPct * (host.height - cardHeight),
  });
}

/**
 * Motion drag constraints, expressed as an offset budget around the card's
 * current origin. Numbers rather than the host ref: the host box is the whole
 * column and the card has to stop one inset short of it, on every edge, above
 * the composer.
 */
export function workLiveCardDragConstraints(args: {
  host: { width: number; height: number };
  origin: { left: number; top: number };
  cardHeight: number;
  bottomReserve?: number;
}): { left: number; right: number; top: number; bottom: number } {
  const travel = workLiveCardTravel(args);
  const { origin } = args;
  return {
    left: travel.minLeft - origin.left,
    right: Math.max(travel.minLeft - origin.left, travel.maxLeft - origin.left),
    top: travel.minTop - origin.top,
    bottom: Math.max(travel.minTop - origin.top, travel.maxTop - origin.top),
  };
}

export function workLiveCardPositionFromRect(args: {
  host: { width: number; height: number };
  left: number;
  top: number;
  cardHeight: number;
}): WorkLiveCardPosition {
  const spanX = Math.max(1, args.host.width - WORK_LIVE_CARD_WIDTH);
  const spanY = Math.max(1, args.host.height - args.cardHeight);
  return {
    xPct: Math.max(0, Math.min(1, args.left / spanX)),
    yPct: Math.max(0, Math.min(1, args.top / spanY)),
  };
}

export function normalizeWorkLiveCardPosition(value: unknown): WorkLiveCardPosition | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<WorkLiveCardPosition>;
  const xPct = typeof candidate.xPct === "number" && Number.isFinite(candidate.xPct) ? candidate.xPct : null;
  const yPct = typeof candidate.yPct === "number" && Number.isFinite(candidate.yPct) ? candidate.yPct : null;
  if (xPct == null || yPct == null) return null;
  return {
    xPct: Math.max(0, Math.min(1, xPct)),
    yPct: Math.max(0, Math.min(1, yPct)),
  };
}
