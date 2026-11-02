/**
 * State and rules for the desktop "Star ADE on GitHub" sidebar pill.
 *
 * The prefs live in the account-synced user-preferences blob, so a snooze or a
 * known star follows the user to every machine. Every field only moves one way
 * (flags turn on, counters and timestamps grow), which is what lets
 * `mergeStarPillPrefs` combine two machines' copies without losing either's
 * progress.
 */

export const ADE_GITHUB_REPO_URL = "https://github.com/arul28/ADE";

/** After the first dismissal the pill returns once this many sent messages later. */
export const STAR_PILL_SNOOZE_MESSAGES = 20;

/** The second dismissal is final. */
export const STAR_PILL_MAX_DISMISSALS = 2;

/** The GitHub star check runs at most this often. */
export const STAR_PILL_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type StarPillPrefs = {
  /**
   * Chat messages sent from desktop. Only counted while the count can still
   * change what the pill does (see `starPillCountsMessages`), so it is not a
   * usage total.
   */
  messagesSent: number;
  /** How many times the pill was dismissed; at `STAR_PILL_MAX_DISMISSALS` it never returns. */
  dismissCount: number;
  /**
   * Showings already reported as `star_prompt_shown` (0, 1 or 2), so each
   * showing is reported once per account rather than on every mount.
   */
  shownReported: number;
  /** Hidden until `messagesSent` reaches this; null when never dismissed. */
  snoozedUntilMessageCount: number | null;
  /** The user is known to have starred the repo. The pill never returns. */
  starred: boolean;
  /** Epoch ms of the last GitHub star check; null before the first. */
  lastCheckedAt: number | null;
};

export const DEFAULT_STAR_PILL_PREFS: StarPillPrefs = {
  messagesSent: 0,
  dismissCount: 0,
  shownReported: 0,
  snoozedUntilMessageCount: null,
  starred: false,
  lastCheckedAt: null,
};

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

export function normalizeStarPillPrefs(value: unknown): StarPillPrefs {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_STAR_PILL_PREFS };
  const raw = value as Record<string, unknown>;
  // Copies written before the message-based snooze carry `hasSentMessage` and
  // a chat-count snooze. Read them as one sent message and one dismissal, so an
  // older machine's copy can neither re-show a dismissed pill early nor hide it.
  const messagesSent = Math.max(nonNegativeInt(raw.messagesSent) ?? 0, raw.hasSentMessage === true ? 1 : 0);
  const legacyDismissed = nonNegativeInt(raw.snoozedUntilThreadCount) != null;
  const dismissCount = Math.min(
    STAR_PILL_MAX_DISMISSALS,
    Math.max(nonNegativeInt(raw.dismissCount) ?? 0, legacyDismissed ? 1 : 0),
  );
  const snoozedUntilMessageCount = nonNegativeInt(raw.snoozedUntilMessageCount)
    ?? (legacyDismissed ? messagesSent + STAR_PILL_SNOOZE_MESSAGES : null);
  return {
    messagesSent,
    dismissCount,
    shownReported: Math.min(STAR_PILL_MAX_DISMISSALS, nonNegativeInt(raw.shownReported) ?? 0),
    snoozedUntilMessageCount,
    starred: raw.starred === true,
    lastCheckedAt: nonNegativeInt(raw.lastCheckedAt),
  };
}

function maxNullable(left: number | null, right: number | null): number | null {
  if (left == null) return right;
  if (right == null) return left;
  return Math.max(left, right);
}

/**
 * Combine a remote copy with the local one. The account store is
 * last-writer-wins per key, so without this a machine that only bumped its
 * message counter would erase another machine's star or dismissal.
 */
export function mergeStarPillPrefs(local: StarPillPrefs, remote: unknown): StarPillPrefs {
  const incoming = normalizeStarPillPrefs(remote);
  return {
    messagesSent: Math.max(local.messagesSent, incoming.messagesSent),
    dismissCount: Math.max(local.dismissCount, incoming.dismissCount),
    shownReported: Math.max(local.shownReported, incoming.shownReported),
    snoozedUntilMessageCount: maxNullable(local.snoozedUntilMessageCount, incoming.snoozedUntilMessageCount),
    starred: local.starred || incoming.starred,
    lastCheckedAt: maxNullable(local.lastCheckedAt, incoming.lastCheckedAt),
  };
}

export function isStarPillVisible(prefs: StarPillPrefs): boolean {
  if (prefs.starred || prefs.messagesSent < 1 || prefs.dismissCount >= STAR_PILL_MAX_DISMISSALS) return false;
  return prefs.snoozedUntilMessageCount == null || prefs.messagesSent >= prefs.snoozedUntilMessageCount;
}

/**
 * Whether one more sent message can still change the pill. Past that point
 * the counter stays put, so ordinary chatting does not rewrite the
 * account-synced prefs on every send.
 */
export function starPillCountsMessages(prefs: StarPillPrefs): boolean {
  if (prefs.starred || prefs.dismissCount >= STAR_PILL_MAX_DISMISSALS) return false;
  if (prefs.snoozedUntilMessageCount == null) return prefs.messagesSent < 1;
  return prefs.messagesSent < prefs.snoozedUntilMessageCount;
}

/** Which showing of the pill this is, for analytics. */
export function starPillShowing(prefs: StarPillPrefs): "prompt_first" | "prompt_second" {
  return prefs.dismissCount === 0 ? "prompt_first" : "prompt_second";
}

export function isStarCheckDue(prefs: StarPillPrefs, now: number): boolean {
  if (prefs.lastCheckedAt == null) return true;
  const elapsed = now - prefs.lastCheckedAt;
  // A stamp from the future (another machine's skewed clock) must not park
  // the check indefinitely.
  return elapsed < 0 || elapsed >= STAR_PILL_CHECK_INTERVAL_MS;
}
