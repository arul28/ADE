import type { WorkSidebarTab } from "../../state/appStore";
import {
  WORK_LIVE_SCREEN_TOOLS,
  isWorkLiveScreenTool,
  normalizeWorkLiveCardDismissals,
  normalizeWorkLiveCardPosition,
  type WorkLiveCardDismissals,
  type WorkLiveCardPosition,
  type WorkLiveScreenTool,
} from "../../state/workLiveCardState";

/**
 * The floating corner card's decisions, as pure functions.
 *
 * Two questions live here — "which tool should the card show?" and "which
 * remembered frame is the pointer over?" — because both are the kind of thing
 * that is obvious until it isn't (a dismissed card that never comes back, a
 * scrubber that shows frame 10 of 3), and neither needs a DOM to answer.
 */

/**
 * The tool ids, the two persisted shapes and their normalizers live in
 * `state/workLiveCardState` so the app store can share them without importing a
 * component module — they used to exist twice and had already drifted on which
 * ids count as previewable. Re-exported here because this is the module the
 * card and its tests read.
 */
export {
  WORK_LIVE_SCREEN_TOOLS,
  isWorkLiveScreenTool,
  normalizeWorkLiveCardDismissals,
  normalizeWorkLiveCardPosition,
};
export type { WorkLiveCardDismissals, WorkLiveCardPosition, WorkLiveScreenTool };

/**
 * Compile-time proof that every previewable tool id is a real sidebar tab id.
 * `workLiveCardState` cannot import `WorkSidebarTab` (the store imports IT), so
 * the two lists are tied together here instead.
 */
const _screenToolsAreSidebarTabs: readonly WorkSidebarTab[] = WORK_LIVE_SCREEN_TOOLS;
void _screenToolsAreSidebarTabs;

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

/* ── Per-tool source adapters ─────────────────────────────────────────────── */

/**
 * Everything the card needs to know about the tool it is picturing, folded into
 * one shape.
 *
 * The component used to answer these five questions with five consecutive
 * `if (tool === "browser") … if (tool === "app-control") … if (tool === "ios")`
 * ladders over the same three states, each with its own field-picking rule —
 * so a fourth previewable tool meant finding seven edit sites in one file.
 * One adapter per tool, in a map beside {@link WORK_LIVE_SCREEN_TOOLS}, keeps
 * the answers together and makes them testable without mounting the card.
 */
export type WorkLiveSource = {
  /** Something of this tool's is running right now. */
  live: boolean;
  /** `"agent"` when an agent session owns it, else null. */
  ownerLabel: string | null;
  /** The tool's own idea of what it is showing, before any action caption. */
  caption: string | null;
  /** A login handoff or equivalent "needs you" state, or null. */
  handoff: WorkLiveHandoff;
  /** Truthy while the tool is recording; only the browser can be. */
  recording: unknown;
};

export type WorkLiveHandoff = { label: string; detail: string | null } | null;

/**
 * Feature detection, not a type assertion: the handoff field may not exist in
 * every build of every source. An absent field renders nothing rather than an
 * "unknown" chip.
 */
export function detectWorkLiveHandoff(value: unknown): WorkLiveHandoff {
  if (!value || typeof value !== "object") return null;
  const handoff = (value as { handoff?: unknown }).handoff;
  if (!handoff || typeof handoff !== "object") return null;
  const record = handoff as { reason?: unknown; label?: unknown; state?: unknown; status?: unknown };
  for (const candidate of [record.reason, record.label, record.state, record.status]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return { label: "Needs you", detail: candidate.trim() };
    }
  }
  return { label: "Needs you", detail: null };
}

/** The three states the adapters read, in the shapes the feeds deliver them. */
export type WorkLiveSourceState = {
  /** The browser's active tab, or null. */
  browserTab: {
    ownerChatSessionId?: string | null;
    title?: string | null;
    url?: string | null;
    recording?: unknown;
    handoff?: unknown;
  } | null;
  appControlSession: {
    chatSessionId?: string | null;
    label?: string | null;
    status?: string | null;
    handoff?: unknown;
  } | null;
  iosSession: {
    chatSessionId?: string | null;
    appName?: string | null;
    deviceName?: string | null;
    handoff?: unknown;
  } | null;
};

const AGENT_OWNER_LABEL = "agent";

export const WORK_LIVE_SOURCES: Record<
  WorkLiveScreenTool,
  (state: WorkLiveSourceState) => WorkLiveSource
> = {
  browser: ({ browserTab }) => ({
    live: Boolean(browserTab),
    ownerLabel: browserTab?.ownerChatSessionId ? AGENT_OWNER_LABEL : null,
    caption: browserTab?.title ?? browserTab?.url ?? null,
    handoff: detectWorkLiveHandoff(browserTab),
    recording: browserTab?.recording ?? null,
  }),
  "app-control": ({ appControlSession }) => ({
    // `stopped` and `exited` are terminal; `failed` is not — the session is
    // still attached, which is what makes the dot red rather than absent.
    live: Boolean(appControlSession)
      && appControlSession?.status !== "stopped"
      && appControlSession?.status !== "exited",
    ownerLabel: appControlSession?.chatSessionId ? AGENT_OWNER_LABEL : null,
    caption: appControlSession?.label ?? null,
    handoff: detectWorkLiveHandoff(appControlSession),
    recording: null,
  }),
  ios: ({ iosSession }) => ({
    live: Boolean(iosSession),
    ownerLabel: iosSession?.chatSessionId ? AGENT_OWNER_LABEL : null,
    caption: iosSession?.appName ?? iosSession?.deviceName ?? null,
    handoff: detectWorkLiveHandoff(iosSession),
    recording: null,
  }),
};

export function workLiveSource(
  tool: WorkLiveScreenTool,
  state: WorkLiveSourceState,
): WorkLiveSource {
  return WORK_LIVE_SOURCES[tool](state);
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
 * A stable identity for one scrub frame.
 *
 * The ring buffer shifts left when it is full, so an INDEX is not an identity:
 * a frame the pointer is parked on moves under it and the caption starts
 * describing a different action than the picture. Trace ids are present for
 * both sources today; `at` is the fallback for a frame committed without one.
 */
export function workLiveScrubFrameKey(frame: WorkLiveScrubFrame): string {
  return `${frame.id ?? ""}:${frame.at}`;
}

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
): readonly WorkLiveScrubFrame[] {
  let changed = false;
  const next = buffer.map((frame) => {
    if (frame.id !== id || frame.caption === caption) return frame;
    changed = true;
    return { ...frame, caption };
  });
  // Identity-preserving on no change: returning a fresh array unconditionally
  // meant the `changed` bookkeeping bought nothing and React could never bail
  // out of the re-render.
  return changed ? next : buffer;
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
 * What the agent just did, in words a person reads rather than the API name.
 *
 * The trace stores the method that ran — `stopFindInPage`, `dispatchKey`,
 * `setNetworkLogging` — and the card was printing it raw, so the footer of a
 * live preview said "stopFindInPage · 1s". These are the names ADE's own trace
 * emits today (browser and App Control both); anything not listed falls through
 * to the camelCase split below, so a new capability reads as "Set network log"
 * rather than as nothing at all.
 */
const WORK_LIVE_ACTION_CAPTIONS: Readonly<Record<string, string>> = {
  navigate: "Opened",
  click: "Clicked",
  fill: "Typed",
  type: "Typed",
  typeText: "Typed",
  clear: "Cleared",
  press: "Pressed",
  dispatchKey: "Pressed",
  hover: "Hovered",
  scroll: "Scrolled",
  drag: "Dragged",
  selectOption: "Selected",
  uploadFile: "Uploaded",
  wait: "Waited",
  screenshot: "Captured",
  findInPage: "Searched",
  stopFindInPage: "Closed find",
  setEmulation: "Changed device",
  setZoom: "Zoomed",
  setDevTools: "Toggled DevTools",
  setNetworkLogging: "Toggled network log",
  exportHar: "Exported HAR",
  startRecording: "Started recording",
  stopRecording: "Stopped recording",
  "handoff-start": "Handed over",
  "handoff-end": "Handed back",
};

/** `setGeolocation` → `Set geolocation`; `handoff-pause` → `Handoff pause`. */
function sentenceCaseAction(action: string): string {
  const words = action
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!words) return "Action";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The human caption for one trace action name. */
export function workLiveActionVerb(action: string): string {
  const key = action.trim();
  if (!key) return "Action";
  return WORK_LIVE_ACTION_CAPTIONS[key] ?? sentenceCaseAction(key);
}

/**
 * `Clicked 'Sign in'` — the verb plus whatever the action was aimed at.
 *
 * Reads the target the same way the trace records it (selector / text / testId),
 * quotes only what came from the page, and gives up rather than printing a raw
 * CSS selector longer than the card.
 */
export function formatWorkLiveActionCaption(
  action: string,
  target: Record<string, unknown> | null | undefined,
): string {
  const verb = workLiveActionVerb(action);
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

/**
 * The card's box, following t3's mini-player: a 320×320 envelope, never smaller
 * than 240×150, with a 12px gap to every edge of the column.
 *
 * The envelope is square; the card is not. Each tool gets the aspect its pixels
 * actually have, scaled to fill the envelope, so the `object-contain` inside
 * letterboxes as little as possible — a 16:10 page in a square box would be
 * 37% black bars, and a phone in a 16:10 box is worse.
 */
export const WORK_LIVE_CARD_MAX_SIZE = 320;
export const WORK_LIVE_CARD_MIN_WIDTH = 240;
export const WORK_LIVE_CARD_MIN_HEIGHT = 150;
/** The widest the card ever gets; what the preview stream is sized against. */
export const WORK_LIVE_CARD_WIDTH = WORK_LIVE_CARD_MAX_SIZE;
/** 16:10, matching the aspect the browser and App Control both preview at. */
export const WORK_LIVE_CARD_ASPECT = 16 / 10;
/** The simulator is a phone; 3:4 is the closest honest frame that still fits. */
export const WORK_LIVE_CARD_PORTRAIT_ASPECT = 3 / 4;
export const WORK_LIVE_CARD_INSET = 12;
/** Below either of these the card would cover the thing it sits next to. */
export const WORK_LIVE_CARD_MIN_HOST_WIDTH = 380;
export const WORK_LIVE_CARD_MIN_HOST_HEIGHT = 260;

export type WorkLiveCardSize = { width: number; height: number };

/** The largest box of `aspect` that fits the envelope, floored at the minimum. */
function fitCardEnvelope(aspect: number): WorkLiveCardSize {
  const landscape = aspect >= 1;
  return {
    width: Math.max(
      WORK_LIVE_CARD_MIN_WIDTH,
      landscape ? WORK_LIVE_CARD_MAX_SIZE : Math.round(WORK_LIVE_CARD_MAX_SIZE * aspect),
    ),
    height: Math.max(
      WORK_LIVE_CARD_MIN_HEIGHT,
      landscape ? Math.round(WORK_LIVE_CARD_MAX_SIZE / aspect) : WORK_LIVE_CARD_MAX_SIZE,
    ),
  };
}

/** 320×200. */
export const WORK_LIVE_CARD_LANDSCAPE_SIZE = fitCardEnvelope(WORK_LIVE_CARD_ASPECT);
/** 240×320. */
export const WORK_LIVE_CARD_PORTRAIT_SIZE = fitCardEnvelope(WORK_LIVE_CARD_PORTRAIT_ASPECT);

/** The box this tool's card occupies. Only the simulator is portrait. */
export function workLiveCardSize(tool: WorkLiveScreenTool | null): WorkLiveCardSize {
  return tool === "ios" ? WORK_LIVE_CARD_PORTRAIT_SIZE : WORK_LIVE_CARD_LANDSCAPE_SIZE;
}

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

/**
 * Is there room for the card at all?
 *
 * `bottomReserve` is the composer's measured height: the card sits ABOVE it, so
 * a column that clears the minimum only by borrowing the composer's rows has no
 * room. Without this term `workLiveCardTravel`'s `Math.max` silently gave up
 * and parked the card ON the composer it was measured to avoid.
 */
export function workLiveCardFits(
  host: { width: number; height: number },
  bottomReserve = 0,
  /** The box actually being placed; defaults to the largest one any tool takes. */
  card: WorkLiveCardSize = { width: WORK_LIVE_CARD_MAX_SIZE, height: WORK_LIVE_CARD_MAX_SIZE },
): boolean {
  const minWidth = Math.max(WORK_LIVE_CARD_MIN_HOST_WIDTH, card.width + WORK_LIVE_CARD_INSET * 2);
  const minHeight = Math.max(WORK_LIVE_CARD_MIN_HOST_HEIGHT, card.height + WORK_LIVE_CARD_INSET * 2);
  return host.width >= minWidth && host.height >= minHeight + Math.max(0, bottomReserve);
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
  /** Defaults to the widest card, so a caller that omits it under-reaches. */
  cardWidth?: number;
  bottomReserve?: number;
}): { minLeft: number; maxLeft: number; minTop: number; maxTop: number } {
  const bottomReserve = Math.max(0, args.bottomReserve ?? 0);
  const cardWidth = args.cardWidth ?? WORK_LIVE_CARD_WIDTH;
  const minLeft = WORK_LIVE_CARD_INSET;
  const minTop = WORK_LIVE_CARD_INSET;
  return {
    minLeft,
    minTop,
    maxLeft: Math.max(minLeft, args.host.width - cardWidth - WORK_LIVE_CARD_INSET),
    maxTop: Math.max(minTop, args.host.height - args.cardHeight - WORK_LIVE_CARD_INSET - bottomReserve),
  };
}

/** Pins an arbitrary pixel position inside {@link workLiveCardTravel}. */
export function clampWorkLiveCardRect(args: {
  host: { width: number; height: number };
  left: number;
  top: number;
  cardHeight: number;
  cardWidth?: number;
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
  cardWidth?: number;
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
    left: position.xPct * (host.width - (args.cardWidth ?? WORK_LIVE_CARD_WIDTH)),
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
  cardWidth?: number;
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
  cardWidth?: number;
}): WorkLiveCardPosition {
  const spanX = Math.max(1, args.host.width - (args.cardWidth ?? WORK_LIVE_CARD_WIDTH));
  const spanY = Math.max(1, args.host.height - args.cardHeight);
  return {
    xPct: Math.max(0, Math.min(1, args.left / spanX)),
    yPct: Math.max(0, Math.min(1, args.top / spanY)),
  };
}

