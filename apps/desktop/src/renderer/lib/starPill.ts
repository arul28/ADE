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

/** Dismissing the pill hides it for this many newly created chats. */
export const STAR_PILL_SNOOZE_THREADS = 20;

/** The GitHub star check runs at most this often. */
export const STAR_PILL_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type StarPillPrefs = {
  /** The account has sent at least one chat message from desktop. */
  hasSentMessage: boolean;
  /** Chats created from desktop; the snooze clock. */
  threadsCreated: number;
  /** Hidden until `threadsCreated` reaches this; null when never dismissed. */
  snoozedUntilThreadCount: number | null;
  /** The user is known to have starred the repo. The pill never returns. */
  starred: boolean;
  /** Epoch ms of the last GitHub star check; null before the first. */
  lastCheckedAt: number | null;
};

export const DEFAULT_STAR_PILL_PREFS: StarPillPrefs = {
  hasSentMessage: false,
  threadsCreated: 0,
  snoozedUntilThreadCount: null,
  starred: false,
  lastCheckedAt: null,
};

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

export function normalizeStarPillPrefs(value: unknown): StarPillPrefs {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_STAR_PILL_PREFS };
  const raw = value as Record<string, unknown>;
  return {
    hasSentMessage: raw.hasSentMessage === true,
    threadsCreated: nonNegativeInt(raw.threadsCreated) ?? 0,
    snoozedUntilThreadCount: nonNegativeInt(raw.snoozedUntilThreadCount),
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
 * chat counter would erase another machine's star or snooze.
 */
export function mergeStarPillPrefs(local: StarPillPrefs, remote: unknown): StarPillPrefs {
  const incoming = normalizeStarPillPrefs(remote);
  return {
    hasSentMessage: local.hasSentMessage || incoming.hasSentMessage,
    threadsCreated: Math.max(local.threadsCreated, incoming.threadsCreated),
    snoozedUntilThreadCount: maxNullable(local.snoozedUntilThreadCount, incoming.snoozedUntilThreadCount),
    starred: local.starred || incoming.starred,
    lastCheckedAt: maxNullable(local.lastCheckedAt, incoming.lastCheckedAt),
  };
}

export function isStarPillVisible(prefs: StarPillPrefs): boolean {
  if (prefs.starred || !prefs.hasSentMessage) return false;
  return prefs.snoozedUntilThreadCount == null || prefs.threadsCreated >= prefs.snoozedUntilThreadCount;
}

export function isStarCheckDue(prefs: StarPillPrefs, now: number): boolean {
  if (prefs.lastCheckedAt == null) return true;
  const elapsed = now - prefs.lastCheckedAt;
  // A stamp from the future (another machine's skewed clock) must not park
  // the check indefinitely.
  return elapsed < 0 || elapsed >= STAR_PILL_CHECK_INTERVAL_MS;
}
