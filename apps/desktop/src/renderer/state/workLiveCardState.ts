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
export type WorkLiveScreenTool = "browser" | "app-control" | "ios";

export const WORK_LIVE_SCREEN_TOOLS: readonly WorkLiveScreenTool[] = ["browser", "app-control", "ios"];

export function isWorkLiveScreenTool(tool: string | null | undefined): tool is WorkLiveScreenTool {
  return tool === "browser" || tool === "app-control" || tool === "ios";
}

/**
 * Simulator cards are keyed by device, not by the `ios` tool id: two lanes
 * with devices are two cards, and silencing one must not silence the other.
 * `ios:<udid>` is that key. The bare `ios` stamp is still accepted so a
 * dismissal written before device keying still hides the simulator.
 */
export function workLiveIosDismissalKey(udid: string): string {
  return `ios:${udid.trim()}`;
}

export function isWorkLiveDismissalKey(key: string | null | undefined): boolean {
  if (!key) return false;
  if (isWorkLiveScreenTool(key)) return true;
  return key.startsWith("ios:") && key.length > "ios:".length;
}

/**
 * Where the card sits, as fractions of the chat column. Fractions rather than
 * pixels so resizing the column keeps it in place instead of stranding it off
 * the edge.
 */
export type WorkLiveCardPosition = { xPct: number; yPct: number };

/**
 * The activity stamp each card was dismissed at, keyed by tool id or by
 * `ios:<udid>` for a simulator device.
 *
 * Per CARD rather than one flag because "I don't need to watch the browser
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

/** Drops unknown keys and non-positive stamps, so a hand-edited blob cannot hide the card forever. */
export function normalizeWorkLiveCardDismissals(value: unknown): WorkLiveCardDismissals | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const next: WorkLiveCardDismissals = {};
  for (const [key, stamp] of Object.entries(value as Record<string, unknown>)) {
    if (!isWorkLiveDismissalKey(key)) continue;
    if (typeof stamp !== "number" || !Number.isFinite(stamp) || stamp <= 0) continue;
    next[key] = stamp;
  }
  return Object.keys(next).length > 0 ? next : null;
}
