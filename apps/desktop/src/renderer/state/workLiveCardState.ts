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

/* ── Per-chat, per-tool "off" markers ────────────────────────────────────────
 * Mirror of lane mac-desktop (b18dd67ec) minus the mac-desktop tool; on merge,
 * take theirs. Additive here: this lane's card still keys its own dismissals by
 * activity stamp (above), and the A4 preview toggle is the per-chat marker
 * below. The two coexist until the lanes meet.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Per-tool "closed" markers for one chat.
 *
 * Valued with the SESSION KEY the tool was showing when the user pressed ×
 * (browser active tab id, App Control session id, simulator session id). A tool
 * stays closed for that chat while its key is unchanged; a NEW session key may
 * show the card again. This is per CHAT rather than per lane: the card belongs
 * to the conversation you are reading, not the checkout.
 */
export type WorkLiveCardClosedByTool = Partial<Record<WorkLiveScreenTool, string>>;

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

/**
 * True when the user turned this tool's floating preview OFF for the chat.
 *
 * Deliberately presence-based, unlike {@link isWorkLiveCardClosed}: × and the
 * "Show preview when minimized" toggle are explicit, sticky choices about the
 * TOOL, not about the session it happened to be showing. Any stored marker —
 * whatever key it carries — means the preview is off until the toggle clears
 * it, so a new session no longer reopens a card the user dismissed.
 */
export function isWorkLivePreviewDisabled(
  // Both marker maps answer this question the same way — the per-chat map is
  // keyed by session string, the lane card's by activity stamp — and presence
  // is the whole test, so one reader serves both rather than two that drift.
  closed: WorkLiveCardDismissals | WorkLiveCardClosedByTool | null | undefined,
  tool: WorkLiveScreenTool,
): boolean {
  return closed?.[tool] != null;
}
