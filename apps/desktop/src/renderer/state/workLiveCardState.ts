/**
 * The persisted shape of the Work tab's floating live-preview card.
 *
 * Deliberately a `state/` module with no imports beyond the card's pure logic:
 * both the store (which normalizes the position and width on load and on every
 * write) and the card's own pure logic in `components/work/workLiveCard.ts` need
 * these normalizers, and the store must not depend on a component module.
 * Keeping one copy here is what stops the two from drifting — they already had,
 * on which tool ids count as previewable.
 */

/** The tools that have something to *look at*. Git and Files do not. */
export type WorkLiveScreenTool = "browser" | "app-control" | "ios" | "mac-desktop";

export const WORK_LIVE_SCREEN_TOOLS: readonly WorkLiveScreenTool[] = [
  "browser",
  "app-control",
  "ios",
  // The lane's own macOS screen. It qualifies for the same reason the others do
  // — there is a picture of it — and it is the cheapest of the four to show:
  // the frame is already in `macDesktopFrameStore`, kept by whichever surface
  // last held the decoder, so the card adds no capture of its own.
  "mac-desktop",
];

export function isWorkLiveScreenTool(tool: string | null | undefined): tool is WorkLiveScreenTool {
  // Reads the list above rather than repeating it: the two had already drifted
  // once, which is the whole reason this module exists.
  return WORK_LIVE_SCREEN_TOOLS.includes(tool as WorkLiveScreenTool);
}

/**
 * Where the card sits, as fractions of the chat column. Fractions rather than
 * pixels so resizing the column keeps it in place instead of stranding it off
 * the edge.
 */
export type WorkLiveCardPosition = { xPct: number; yPct: number };

/** Reads a stored fractional position, clamping it into 0..1 and rejecting junk. */
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

/**
 * The width the user chose for the card, in CSS pixels.
 *
 * Only the width is chosen: the height follows the source picture's aspect
 * ratio (see `workLiveCardSize`), because a fixed box is what cropped tall
 * captures in the first place. `null` means "never resized" and falls back to
 * the default.
 */
export const WORK_LIVE_CARD_DEFAULT_WIDTH = 288;
export const WORK_LIVE_CARD_MIN_WIDTH = 200;
/** A card wider than this stops being a corner preview and becomes a pane. */
export const WORK_LIVE_CARD_MAX_WIDTH = 560;

export function normalizeWorkLiveCardWidth(value: unknown): number | null {
  // `null` / `undefined` / `""` must stay "never resized" — `Number(null)` is 0,
  // which would otherwise clamp to the minimum width and shrink every card.
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(WORK_LIVE_CARD_MIN_WIDTH, Math.min(WORK_LIVE_CARD_MAX_WIDTH, Math.round(n)));
}

/**
 * Per-tool "closed" markers for one chat.
 *
 * Valued with the SESSION KEY the tool was showing when the user pressed ×
 * (browser active tab id, App Control session id, simulator session id, the
 * lane's display id for mac-desktop). A tool stays closed for that chat while
 * its key is unchanged; a NEW session key may show the card again. This is per
 * CHAT rather than per lane: the card belongs to the conversation you are
 * reading, not the checkout.
 */
export type WorkLiveCardClosedByTool = Partial<Record<WorkLiveScreenTool, string>>;

/** Tools the user explicitly floated back on for one chat. */
export type WorkLiveCardFloatingTools = WorkLiveScreenTool[];

/**
 * Reads a stored closed map. Unknown tool ids and empty keys are dropped so a
 * hand-edited blob cannot hide a card forever with a value nothing can match.
 */
export function normalizeWorkLiveCardClosedByTool(value: unknown): WorkLiveCardClosedByTool {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const next: WorkLiveCardClosedByTool = {};
  for (const [key, sessionKey] of Object.entries(value as Record<string, unknown>)) {
    if (!isWorkLiveScreenTool(key)) continue;
    if (typeof sessionKey !== "string" || !sessionKey.trim()) continue;
    next[key] = sessionKey.trim();
  }
  return next;
}

/** Reads a stored floating list, keeping only screen tools and dropping dupes. */
export function normalizeWorkLiveCardFloatingTools(value: unknown): WorkLiveCardFloatingTools {
  if (!Array.isArray(value)) return [];
  const next: WorkLiveCardFloatingTools = [];
  for (const entry of value) {
    if (!isWorkLiveScreenTool(entry) || next.includes(entry)) continue;
    next.push(entry);
  }
  return next;
}

/** True when `tool` is closed for this chat at the given session key. */
export function isWorkLiveCardClosed(
  closed: WorkLiveCardClosedByTool | null | undefined,
  tool: WorkLiveScreenTool,
  sessionKey: string | null,
): boolean {
  const stored = closed?.[tool];
  if (stored == null) return false;
  // A key we cannot compute cannot distinguish a new session from the old one,
  // so an unknown key stays closed rather than flashing the card back.
  if (sessionKey == null) return true;
  return stored === sessionKey;
}
