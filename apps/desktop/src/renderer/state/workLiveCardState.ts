/**
 * The persisted shape of the Work tab's floating live-preview card.
 *
 * Deliberately a `state/` module with no imports: both the store (which
 * normalizes this on load and on every write) and the card's own pure logic in
 * `components/work/workLiveCard.ts` need these two normalizers, and the store
 * must not depend on a component module. Keeping one copy here is what stops
 * the two from drifting — they already had, on which tool ids count as
 * previewable.
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

/** Drops unknown tool ids and non-positive stamps, so a hand-edited blob cannot hide the card forever. */
export function normalizeWorkLiveCardDismissals(value: unknown): WorkLiveCardDismissals | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const next: WorkLiveCardDismissals = {};
  for (const [key, stamp] of Object.entries(value as Record<string, unknown>)) {
    if (!isWorkLiveScreenTool(key)) continue;
    if (typeof stamp !== "number" || !Number.isFinite(stamp) || stamp <= 0) continue;
    next[key] = stamp;
  }
  return Object.keys(next).length > 0 ? next : null;
}
