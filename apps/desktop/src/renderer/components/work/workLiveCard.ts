import type { WorkSidebarTab } from "../../state/appStore";
import {
  WORK_LIVE_SCREEN_TOOLS,
  isWorkLiveCardClosed,
  isWorkLiveCardSeen,
  isWorkLivePreviewDisabled,
  isWorkLiveScreenTool,
  normalizeWorkLiveCardClosedByTool,
  normalizeWorkLiveCardPosition,
  normalizeWorkLiveCardWidth,
  WORK_LIVE_CARD_DEFAULT_WIDTH,
  WORK_LIVE_CARD_MAX_WIDTH,
  WORK_LIVE_CARD_MIN_WIDTH,
  type WorkLiveCardClosedByTool,
  type WorkLiveCardFloatingTools,
  type WorkLiveCardPosition,
  type WorkLiveCardSeenByTool,
  type WorkLiveScreenTool,
} from "../../state/workLiveCardState";

/**
 * The floating corner card's decisions, as pure functions.
 *
 * Three questions live here — "which tool should the card show?", "how big is
 * the box?", and "which remembered frame is the pointer over?" — because all
 * three are the kind of thing that is obvious until it isn't (a dismissed card
 * that never comes back, a scrubber that shows frame 10 of 3, a picture scaled
 * into a fixed box and cropped), and none needs a DOM to answer.
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
  isWorkLiveCardClosed,
  isWorkLivePreviewDisabled,
  isWorkLiveCardSeen,
  normalizeWorkLiveCardClosedByTool,
  normalizeWorkLiveCardPosition,
  normalizeWorkLiveCardWidth,
  WORK_LIVE_CARD_DEFAULT_WIDTH,
  WORK_LIVE_CARD_MAX_WIDTH,
  WORK_LIVE_CARD_MIN_WIDTH,
};
export type {
  WorkLiveCardClosedByTool,
  WorkLiveCardFloatingTools,
  WorkLiveCardPosition,
  WorkLiveCardSeenByTool,
  WorkLiveScreenTool,
};
export { isWorkLivePictureInPictureSupported, workLiveIosStreamRequestUrl } from "./workLiveIosPictureInPicture";

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
  /**
   * The chat that owns this session, or null when it is unowned (a manually
   * started browser tab, a display owned by the lane).
   *
   * The card follows the conversation you are reading: a session started by
   * another chat must not float over this one. Only the owner's chat sees it.
   */
  ownerChatSessionId: string | null;
  /**
   * Identity of the CURRENT session, used for the "×" rule: a closed card stays
   * closed while this key is unchanged, and a new key may show again.
   */
  sessionKey: string | null;
  /**
   * Whether a session with no owner may show in the chat on screen.
   *
   * The card computes this per chat: for browser, App Control and the
   * simulator it is "this chat's pane has shown exactly this session"
   * (`isWorkLiveCardSeen`), so a tab opened by hand floats where you opened it
   * and nowhere else. Always false for mac-desktop, which is a lane resource
   * gated on being a viewer or lease holder.
   */
  showWhenUnowned: boolean;
};

/* ── Selection ────────────────────────────────────────────────────────────── */

/**
 * Does this activity belong to the chat on screen?
 *
 * Owned sessions only show in their own chat. Unowned sessions show only where
 * the caller says they may (`showWhenUnowned`): the card sets it to "this
 * chat's pane has shown this session", and mac-desktop always to false.
 */
export function workLiveActivityBelongsToChat(
  activity: Pick<WorkLiveActivity, "ownerChatSessionId" | "showWhenUnowned">,
  activeChatSessionId: string | null,
): boolean {
  if (activity.ownerChatSessionId != null) {
    return activeChatSessionId != null && activity.ownerChatSessionId === activeChatSessionId;
  }
  return activity.showWhenUnowned;
}

/**
 * Which tool the card shows, or null for "show nothing".
 *
 * The card exists to keep the screen you are NOT looking at in view, so the
 * active tool is normally excluded — otherwise you would get a postage-stamp
 * copy of the pane next to the pane. Ties go to the most recent activity, which
 * is what "the thing that just happened" means to the person watching.
 *
 * A tool the user explicitly FLOATED (`floatingTools`) suspends that exclusion
 * for itself until it is closed again: the Float button is the one way to ask
 * for the preview of the pane you are already on. A floated tool also skips the
 * live and activity checks — the button was pressed, so the card is the
 * feedback; a floated tool that has not painted yet is a blank frame with its
 * name on it, not a lit button that silently does nothing — and it outranks
 * every non-floated activity, so another tool's newer trace cannot quietly
 * take the slot the user just asked for.
 *
 * `closed` implements the "×" affordance by tool, not by activity stamp:
 * frames, status refreshes and remounts can never reopen a card. It is
 * presence-based (`isWorkLivePreviewDisabled`), so the "Show preview when
 * minimized" toggle — which clears the marker — is the only way back on.
 */
export function selectWorkLiveCardTool(args: {
  activeTool: WorkSidebarTab | null;
  /** The chat on screen, or null when none is selected. */
  activeChatSessionId: string | null;
  activities: readonly WorkLiveActivity[];
  /** Tools explicitly floated on for this chat. */
  floatingTools?: readonly WorkLiveScreenTool[] | null;
  /** Per-tool closed markers for this chat, keyed by tool id. */
  closed?: WorkLiveCardClosedByTool | null;
}): WorkLiveScreenTool | null {
  const { activeTool, activeChatSessionId, activities, floatingTools, closed } = args;
  let best: WorkLiveActivity | null = null;
  let bestIsFloated = false;
  for (const activity of activities) {
    if (!activity.available) continue;
    const floated = Boolean(floatingTools?.includes(activity.tool));
    // Float is per chat and an explicit ask, so it may show an unowned session
    // this chat's pane has not (yet) shown — a pane with no tab, floated. It
    // never overrides another chat's ownership.
    if (
      !workLiveActivityBelongsToChat(activity, activeChatSessionId)
      && !(floated && activity.ownerChatSessionId == null)
    ) continue;
    if (!floated) {
      if (!activity.live) continue;
      if (activity.tool === activeTool) continue;
      if (activity.lastActivityAt <= 0) continue;
      if (isWorkLivePreviewDisabled(closed, activity.tool)) continue;
    }
    if (
      !best
      || (floated && !bestIsFloated)
      || (floated === bestIsFloated && activity.lastActivityAt > best.lastActivityAt)
    ) {
      best = activity;
      bestIsFloated = floated;
    }
  }
  return best?.tool ?? null;
}

/**
 * Whether the floating Mac Desktop is mounted, and whether it is in view.
 *
 * The Mac Desktop floats in its own player (`MacDesktopMiniPlayer`), not in the
 * corner card, so this is its whole selection rule. It WANTS to show for the
 * chat in front when that chat may see the lane's desktop (a viewer, the lease
 * holder, or granted by its agent), the chat has not turned the preview off,
 * and there is something to show: a picture, the Off state of a display the
 * agent was using, or an explicit float waiting for its first frame.
 *
 * It is never in view while the tools pane shows the Mac Desktop. A float does
 * not override that, unlike the corner card's Float: a copy of the pane next to
 * the pane is the "banner over the open pane" the owner reported. "Shows" is
 * the tab id AND the pane's own element being mounted, so a tab state that
 * reads otherwise for a moment cannot put a second picture beside the pane.
 *
 * A player that holds the lane's decoder is in view too, before its first
 * frame. It used to mount hidden until a frame arrived, and a stream that sent
 * no frame kept an encoder and a reader running behind a player nobody could
 * see (the owner's 2026-09-24 report). Now the player shows the last frame, or
 * "Connecting video", or says the display sent no picture.
 */
export function macDesktopFloatState(args: {
  active: boolean;
  laneId: string | null;
  chatSessionId: string | null;
  /** False only once the host said it cannot host a display. */
  supported: boolean;
  authorized: boolean;
  dismissed: boolean;
  hasPicture: boolean;
  off: boolean;
  floated: boolean;
  /** The player holds the lane's decoder: its stream is starting, playing or failed. */
  decoding: boolean;
  /** The tool filling the tools pane, or null when the pane is closed. */
  paneTool: WorkSidebarTab | null;
  /** The pane's Mac Desktop element for this lane is mounted. */
  paneMounted?: boolean;
}): { present: boolean; visible: boolean } {
  const wanted = Boolean(
    args.active
    && args.laneId
    && args.chatSessionId
    && args.supported
    && args.authorized
    && !args.dismissed
    && (args.hasPicture || args.off || args.floated || args.decoding),
  );
  return {
    present: wanted || args.decoding,
    visible: wanted && args.paneTool !== "mac-desktop" && !args.paneMounted,
  };
}

/* ── Per-tool source adapters ─────────────────────────────────────────────── */

/**
 * Everything the card needs to know about the tool it is picturing, folded into
 * one shape.
 *
 * The component used to answer these five questions with five consecutive
 * `if (tool === "browser") … if (tool === "app-control") …` ladders over the
 * same three states, each with its own field-picking rule — so a fourth
 * previewable tool meant finding seven edit sites in one file. One adapter per
 * tool, in a map beside {@link WORK_LIVE_SCREEN_TOOLS}, keeps the answers
 * together and makes them testable without mounting the card.
 */
export type WorkLiveSource = {
  /** Something of this tool's is running right now. */
  live: boolean;
  /**
   * `"agent"` when an agent session owns it (for Mac Desktop, holds its input
   * lease), `"you"` when a person holds the Mac Desktop lease, else null.
   */
  ownerLabel: string | null;
  /** The tool's own idea of what it is showing, before any action caption. */
  caption: string | null;
  /** A login handoff or equivalent "needs you" state, or null. */
  handoff: WorkLiveHandoff;
  /** Truthy while the tool is recording. Browser tabs, Apple devices and Mac Desktop can be. */
  recording: unknown;
  /** The current session identity, for the "×" rule. */
  sessionKey: string | null;
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
    id?: string | null;
    ownerChatSessionId?: string | null;
    title?: string | null;
    url?: string | null;
    recording?: unknown;
    handoff?: unknown;
  } | null;
  appControlSession: {
    id?: string | null;
    chatSessionId?: string | null;
    label?: string | null;
    status?: string | null;
    handoff?: unknown;
  } | null;
  iosSession: {
    id?: string | null;
    chatSessionId?: string | null;
    appName?: string | null;
    deviceName?: string | null;
    deviceUdid?: string | null;
    /** Active recording from `status({laneId})` (or the record list). */
    recording?: unknown;
    handoff?: unknown;
  } | null;
  /**
   * The lane's last desktop frame, straight from `macDesktopFrameStore`.
   *
   * The Mac Desktop source is the odd one out: the other three describe a
   * SESSION and the picture arrives separately, while this one has only the
   * picture. That is deliberate — a display is per lane and permanent-ish, so
   * "is something happening on it" is answered by whether a frame has arrived
   * recently and not by whether an object exists.
   */
  macDesktopFrame: {
    laneId?: string | null;
    at?: number | null;
    caption?: string | null;
    /**
     * The display's own identity, from {@link workLiveMacDesktopSessionKey}.
     *
     * The × marker is keyed by session, and a lane's display is destroyed and
     * recreated all the time — a stop, an idle release, a host restart. Keying
     * on the lane id made a closed card stay closed for the lane's whole life;
     * the display's id and creation time change with the display, so a new
     * display is honestly a new session.
     */
    displayKey?: string | null;
  } | null;
  /**
   * Who drives the lane's desktop and whether it is being recorded, from the
   * status read and the `lease-changed` / `recording-changed` events. Optional:
   * a caller with no Mac Desktop state leaves it out.
   */
  macDesktopControl?: {
    /** The lease holder's kind, or null when nobody holds it. */
    leaseHolder?: "agent" | "user" | null;
    recording?: boolean | null;
  } | null;
};

/**
 * The mac-desktop card's session key: the display, not the lane.
 *
 * `display:<displayId>:<createdAt>` is stable for as long as one display
 * exists — across frames, status refreshes and stream restarts — and changes
 * when the display is destroyed and recreated. An off-screen-region fallback
 * has no CoreGraphics id (`displayId: null`), so the creation time carries the
 * identity there; null when nothing identifies the display at all.
 */
export function workLiveMacDesktopSessionKey(
  display: { displayId?: number | null; createdAt?: string | null } | null | undefined,
): string | null {
  if (!display) return null;
  const createdAt = typeof display.createdAt === "string" && display.createdAt.trim()
    ? display.createdAt.trim()
    : null;
  if (display.displayId == null && !createdAt) return null;
  return `display:${display.displayId ?? "offscreen"}:${createdAt ?? ""}`;
}

const AGENT_OWNER_LABEL = "agent";
/** A person took over the lane's desktop. Lowercase to sit beside "agent". */
const USER_OWNER_LABEL = "you";

/**
 * `https://example.com/a/b?c` → `example.com`.
 *
 * The identity of a page a person recognises is its host, and for a page whose
 * `<title>` has not arrived yet the host is all there is. Anything that will
 * not parse as a URL — `about:blank`, a half-typed address — is returned as it
 * was rather than dropped, so the card never silently loses its only label.
 */
export function workLiveHostLabel(url: string | null | undefined): string | null {
  const raw = typeof url === "string" ? url.trim() : "";
  if (!raw) return null;
  try {
    const host = new URL(raw).host;
    if (!host) return raw;
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return raw;
  }
}

export const WORK_LIVE_SOURCES: Record<
  WorkLiveScreenTool,
  (state: WorkLiveSourceState) => WorkLiveSource
> = {
  browser: ({ browserTab }) => ({
    live: Boolean(browserTab),
    ownerLabel: browserTab?.ownerChatSessionId ? AGENT_OWNER_LABEL : null,
    // Title first, host second — never the raw URL. The card leads with this
    // line, and a 288px pill has room for `example.com`, not for
    // `https://example.com/search?q=…&utm_source=…`.
    caption: browserTab?.title ?? workLiveHostLabel(browserTab?.url) ?? null,
    handoff: detectWorkLiveHandoff(browserTab),
    recording: browserTab?.recording ?? null,
    sessionKey: browserTab?.id ?? null,
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
    sessionKey: appControlSession?.id ?? null,
  }),
  "mac-desktop": ({ macDesktopFrame, macDesktopControl }) => ({
    live: Boolean(macDesktopFrame),
    // The display belongs to the lane, so the owner is whoever holds its input
    // lease right now, not a chat. Nobody holding it names nobody.
    ownerLabel: macDesktopControl?.leaseHolder === "agent"
      ? AGENT_OWNER_LABEL
      : macDesktopControl?.leaseHolder === "user"
        ? USER_OWNER_LABEL
        : null,
    caption: macDesktopFrame?.caption ?? null,
    handoff: null,
    recording: macDesktopControl?.recording ? true : null,
    // A display is per lane and long-lived, so the display's own identity is
    // the session key for the "×" rule: closing the preview hides it until
    // this display is replaced (or the user floats it back).
    sessionKey: macDesktopFrame?.displayKey ?? macDesktopFrame?.laneId ?? null,
  }),
  ios: ({ iosSession }) => ({
    live: Boolean(iosSession),
    ownerLabel: iosSession?.chatSessionId ? AGENT_OWNER_LABEL : null,
    caption: iosSession?.appName ?? iosSession?.deviceName ?? null,
    handoff: detectWorkLiveHandoff(iosSession),
    recording: iosSession?.recording ?? null,
    sessionKey: iosSession?.id ?? null,
  }),
};

/** One Apple device the card can picture. */
export type WorkLiveIosDevice = {
  udid: string;
  laneId: string;
  name: string;
  appName: string | null;
  chatSessionId: string | null;
  /** Truthy while this device is recording; sourced from `status` / record list. */
  recording: unknown;
  lastActivityAt: number;
};

/** Caption for one Apple device card: foreground app, else the device name. */
export function workLiveIosCaption(device: Pick<WorkLiveIosDevice, "appName" | "name">): string | null {
  const appName = device.appName?.trim() || null;
  const deviceName = device.name.trim() || null;
  return appName ?? deviceName;
}

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
 * The card's width is the user's, and its height follows the picture.
 *
 * A fixed per-tool box is exactly what cropped tall captures: a browser tab
 * captured from a tall panel rect was scaled to a 288px-wide box and cut to its
 * top band, so a person saw a zoomed-in fragment instead of a screen. The box
 * now derives its height from the source's own aspect ratio, capped so a
 * portrait phone or a full-height window does not become a full-column card.
 */
export const WORK_LIVE_CARD_INSET = 12;
/** Below either of these the card would cover the thing it sits next to. */
export const WORK_LIVE_CARD_MIN_HOST_WIDTH = 380;
export const WORK_LIVE_CARD_MIN_HOST_HEIGHT = 260;

/**
 * The tallest the card may grow before its width is shrunk to keep the aspect.
 *
 * ~340px is comfortably under half a typical chat column at 1x, and the cap is
 * additionally bounded by the column's own height minus the composer reserve in
 * {@link workLiveCardSize}, so a short window clamps it further.
 */
export const WORK_LIVE_CARD_MAX_HEIGHT = 340;

/** The card never takes more than half the chat column's width. */
export const WORK_LIVE_CARD_MAX_HOST_WIDTH_RATIO = 0.5;

/** The aspect used before a source picture has reported its own. */
export const WORK_LIVE_CARD_DEFAULT_ASPECT = 16 / 10;
export const WORK_LIVE_CARD_IOS_ASPECT = 3 / 4;

export type WorkLiveCardSize = { width: number; height: number };

/** The aspect ratio (width / height) of each tool before its source reports one. */
export const WORK_LIVE_TOOL_ASPECT: Record<WorkLiveScreenTool, number> = {
  browser: WORK_LIVE_CARD_DEFAULT_ASPECT,
  "app-control": WORK_LIVE_CARD_DEFAULT_ASPECT,
  "mac-desktop": WORK_LIVE_CARD_DEFAULT_ASPECT,
  ios: WORK_LIVE_CARD_IOS_ASPECT,
};

/**
 * The aspect to build the box from: the source's natural ratio when it is real
 * and positive, else the tool's default. A zero/NaN/negative ratio happens
 * while a frame is still decoding and must never divide the width by zero.
 */
export function workLiveCardAspect(
  tool: WorkLiveScreenTool | null,
  sourceAspect?: number | null,
): number {
  if (typeof sourceAspect === "number" && Number.isFinite(sourceAspect) && sourceAspect > 0) {
    return sourceAspect;
  }
  return tool ? WORK_LIVE_TOOL_ASPECT[tool] : WORK_LIVE_CARD_DEFAULT_ASPECT;
}

/**
 * The width range available in a column of this width.
 *
 * The user's chosen width is clamped into it, so a card dragged wide in a big
 * column cannot cover half the conversation when the column narrows.
 */
export function workLiveCardWidthBounds(hostWidth: number): { min: number; max: number } {
  const byRatio = hostWidth > 0 ? hostWidth * WORK_LIVE_CARD_MAX_HOST_WIDTH_RATIO : WORK_LIVE_CARD_MAX_WIDTH;
  const max = Math.max(
    WORK_LIVE_CARD_MIN_WIDTH,
    Math.min(WORK_LIVE_CARD_MAX_WIDTH, Math.round(byRatio)),
  );
  return { min: WORK_LIVE_CARD_MIN_WIDTH, max };
}

/**
 * The box this card occupies, from the chosen width and the picture's aspect.
 *
 * Width-first: height = width / aspect. If that height exceeds the cap (or the
 * column's available height), the width is shrunk to keep the aspect exact
 * rather than letting the height run away.
 */
export function workLiveCardSize(args: {
  tool: WorkLiveScreenTool | null;
  /** The user's chosen width; defaults inside the bounds. */
  width?: number;
  /** Natural width / height of the source picture, when known. */
  aspect?: number | null;
  host?: { width: number; height: number };
  /** Space to leave at the bottom, e.g. the composer's height. */
  bottomReserve?: number;
}): WorkLiveCardSize {
  const aspect = workLiveCardAspect(args.tool, args.aspect);
  const host = args.host ?? { width: 0, height: 0 };
  const reserve = Math.max(0, args.bottomReserve ?? 0);
  const bounds = workLiveCardWidthBounds(host.width);
  const requested = typeof args.width === "number" && Number.isFinite(args.width)
    ? args.width
    : WORK_LIVE_CARD_DEFAULT_WIDTH;
  let width = Math.max(bounds.min, Math.min(bounds.max, Math.round(requested)));
  let height = width / aspect;

  const availableHeight = host.height > 0
    ? host.height - reserve - WORK_LIVE_CARD_INSET * 2
    : Number.POSITIVE_INFINITY;
  const maxHeight = Math.max(
    WORK_LIVE_CARD_MIN_WIDTH * WORK_LIVE_CARD_IOS_ASPECT,
    Math.min(WORK_LIVE_CARD_MAX_HEIGHT, availableHeight),
  );
  if (height > maxHeight) {
    height = maxHeight;
    width = height * aspect;
  }
  // The user's floor is a hard one: for a source taller than
  // `minWidth / maxHeight` (~0.59) the two constraints cannot both hold, and a
  // 200px card that is taller than the soft cap is better than a 136px card
  // nobody can see. The exact aspect is kept either way.
  if (width < bounds.min) {
    width = bounds.min;
    height = width / aspect;
  }
  return { width: Math.round(width), height: Math.round(height) };
}

/** Every tool contains its picture; nothing is cropped. */
export const WORK_LIVE_CARD_OBJECT_FIT = "contain" as const;

/**
 * The frame width to ask the source for: the card's own width in DEVICE
 * pixels, so a Retina card is not fed a 260px image and upscaled into mush —
 * and a 5K panel is not fed a 1280px one for a thumbnail.
 */
export function workLivePreviewMaxWidth(
  devicePixelRatio: number | undefined,
  width: number = WORK_LIVE_CARD_DEFAULT_WIDTH,
): number {
  const ratio = Number.isFinite(devicePixelRatio) && (devicePixelRatio ?? 0) > 0
    ? (devicePixelRatio as number)
    : 1;
  const base = Math.max(WORK_LIVE_CARD_MIN_WIDTH, Math.round(width));
  return Math.max(base, Math.min(960, Math.round(base * ratio)));
}

/**
 * Is there room for the card at all?
 *
 * `bottomReserve` is the composer's measured height: the card sits ABOVE it, so
 * a column that clears the minimum only by borrowing the composer's rows has no
 * room. Without this term `workLiveCardTravel`'s `Math.max` silently gave up
 * and parked the card ON the composer it was measured to avoid.
 *
 * The 380px column floor applies to a FULL-SIZE card: it is the width at which
 * a default card leaves the conversation room to breathe. A card the caller has
 * already shrunk toward `WORK_LIVE_CARD_MIN_WIDTH` is measured by its own box
 * instead — a narrow column shrinks the card rather than hiding it, and only a
 * host that cannot hold the minimum card at all has no room.
 */
export function workLiveCardFits(
  host: { width: number; height: number },
  bottomReserve = 0,
  /** The box actually being placed; defaults to the default card. */
  card: WorkLiveCardSize = { width: WORK_LIVE_CARD_DEFAULT_WIDTH, height: WORK_LIVE_CARD_DEFAULT_WIDTH / WORK_LIVE_CARD_DEFAULT_ASPECT },
): boolean {
  const minWidth = card.width >= WORK_LIVE_CARD_DEFAULT_WIDTH
    ? Math.max(WORK_LIVE_CARD_MIN_HOST_WIDTH, card.width + WORK_LIVE_CARD_INSET * 2)
    : card.width + WORK_LIVE_CARD_INSET * 2;
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
  /** Defaults to the default card width, so a caller that omits it under-reaches. */
  cardWidth?: number;
  bottomReserve?: number;
}): { minLeft: number; maxLeft: number; minTop: number; maxTop: number } {
  const bottomReserve = Math.max(0, args.bottomReserve ?? 0);
  const cardWidth = args.cardWidth ?? WORK_LIVE_CARD_DEFAULT_WIDTH;
  const minLeft = WORK_LIVE_CARD_INSET;
  const minTop = WORK_LIVE_CARD_INSET;
  return {
    minLeft,
    minTop,
    maxLeft: Math.max(minLeft, args.host.width - cardWidth - WORK_LIVE_CARD_INSET),
    maxTop: Math.max(minTop, args.host.height - args.cardHeight - WORK_LIVE_CARD_INSET - bottomReserve),
  };
}

/**
 * Everything at the bottom of the chat column the card must not sit on top of.
 *
 * The composer is the obvious one; anything else that parks itself against the
 * bottom edge (an approval card, a launch shelf) opts in with
 * `data-work-live-card-avoid`, because those live in files this card does not
 * own and a shared attribute is cheaper than a shared prop chain.
 */
export const WORK_LIVE_CARD_AVOID_SELECTOR =
  "[data-chat-composer-wrapper],[data-work-live-card-avoid]";

/**
 * The card gives up at most half the column.
 *
 * Without a ceiling a tall composer — chips, attachments, a six-line draft —
 * pushes the card off the top of its own travel, and `workLiveCardTravel`'s
 * `Math.max` then quietly parks it back at the inset. Half is the point past
 * which nudging up stops being "keep the last message visible" and starts
 * being "cover a different part of the conversation".
 */
export const WORK_LIVE_CARD_MAX_BOTTOM_RESERVE_RATIO = 0.5;

export type WorkLiveCardObstruction = { top: number; bottom: number; height: number };

/**
 * How much room to leave at the bottom of the host, in host pixels.
 *
 * Viewport coordinates in, one number out: measuring rects rather than reading
 * `offsetHeight` off a selector match is what keeps a hidden empty-state
 * composer belonging to some OTHER chat pane from reserving space in this one.
 * Only boxes that reach into the bottom half count, and the reserve is measured
 * from the host's bottom edge to the box's top — so a card floating above the
 * composer covers itself and the composer under it in one number.
 */
export function workLiveBottomReserve(args: {
  host: { top: number; bottom: number; height: number };
  obstructions: readonly WorkLiveCardObstruction[];
}): number {
  const { host } = args;
  if (!(host.height > 0)) return 0;
  const midpoint = host.top + host.height / 2;
  const limit = host.height * WORK_LIVE_CARD_MAX_BOTTOM_RESERVE_RATIO;
  let reserve = 0;
  for (const box of args.obstructions) {
    // A zero-height box is display:none or not laid out yet; a box entirely
    // above the midpoint is chrome at the top, not something to sit above.
    if (!(box.height > 0)) continue;
    if (box.bottom <= midpoint) continue;
    if (box.top >= host.bottom) continue;
    reserve = Math.max(reserve, host.bottom - Math.max(host.top, box.top));
  }
  return Math.round(Math.max(0, Math.min(limit, reserve)));
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
    left: position.xPct * (host.width - (args.cardWidth ?? WORK_LIVE_CARD_DEFAULT_WIDTH)),
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
  const spanX = Math.max(1, args.host.width - (args.cardWidth ?? WORK_LIVE_CARD_DEFAULT_WIDTH));
  const spanY = Math.max(1, args.host.height - args.cardHeight);
  return {
    xPct: Math.max(0, Math.min(1, args.left / spanX)),
    yPct: Math.max(0, Math.min(1, args.top / spanY)),
  };
}
