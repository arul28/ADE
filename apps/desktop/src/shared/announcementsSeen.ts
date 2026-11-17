/**
 * Which "What's new" pages the account has seen, as one account setting.
 *
 * Shared by the renderer (desktop and ADE Web), which keeps a local copy, and
 * the brain, which serves the value to ADE Web over a remote command. The
 * value only grows: a page id, once in it, stays. Two copies combine by union,
 * so a page seen on any computer is never shown again on another, and a merge
 * can never take a "seen" away.
 */

/** Account-wide (`ACCOUNT_SCOPE_ALL`) key of the seen map. */
export const ANNOUNCEMENTS_SEEN_SETTING_KEY = "announcements.seen";

/** Page id -> epoch ms it was first seen anywhere. */
export type SeenAnnouncementsMap = Record<string, number>;

/** Far more pages than the catalogue will ever hold; bounds a hostile or corrupt value. */
const MAX_SEEN_IDS = 500;
const MAX_ID_LENGTH = 128;

/** The valid part of a stored or remote value: string ids, finite non-negative times. */
export function normalizeSeenAnnouncements(value: unknown): SeenAnnouncementsMap {
  const out: SeenAnnouncementsMap = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  let count = 0;
  for (const [id, seenAt] of Object.entries(value as Record<string, unknown>)) {
    if (count >= MAX_SEEN_IDS) break;
    if (!id || id.length > MAX_ID_LENGTH) continue;
    if (typeof seenAt !== "number" || !Number.isFinite(seenAt) || seenAt < 0) continue;
    out[id] = seenAt;
    count += 1;
  }
  return out;
}

/**
 * Every id in either copy, at the earlier of its two times. The cap holds
 * here too, and `left`'s ids come first: a merge never pushes out a page the
 * copy already holds (a later read would otherwise drop one past the cap).
 */
export function mergeSeenAnnouncements(
  left: SeenAnnouncementsMap,
  right: SeenAnnouncementsMap,
): SeenAnnouncementsMap {
  const merged: SeenAnnouncementsMap = { ...left };
  let count = Object.keys(merged).length;
  for (const [id, seenAt] of Object.entries(right)) {
    const current = merged[id];
    if (current !== undefined) {
      merged[id] = Math.min(current, seenAt);
    } else if (count < MAX_SEEN_IDS) {
      merged[id] = seenAt;
      count += 1;
    }
  }
  return merged;
}

const KSUID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** KSUID time 0 (2014-05-13T16:53:20Z), in seconds. */
const KSUID_EPOCH_S = 1_400_000_000;
/** Before ADE had accounts; an earlier time means the id is not what this reads it as. */
const EARLIEST_ACCOUNT_MS = Date.UTC(2023, 0, 1);

/**
 * When an account was created, read from its Clerk user id, or null.
 *
 * A Clerk user id is `user_` and a 27-character KSUID, whose first 4 bytes are
 * the creation time in seconds after the KSUID epoch. Every computer and ADE
 * Web reads the same time from the same id, with no request. Anything that
 * does not parse, or gives a time before 2023 or in the future, gives null,
 * and the caller then treats the account as an existing one.
 */
export function accountCreatedAtFromUserId(userId: string | null | undefined, now = Date.now()): number | null {
  const match = /^user_([0-9A-Za-z]{27})$/.exec(userId?.trim() ?? "");
  if (!match) return null;
  let value = 0n;
  for (const char of match[1]) value = value * 62n + BigInt(KSUID_ALPHABET.indexOf(char));
  // 20 bytes: 4 of time, 16 of payload. A larger value is not a KSUID.
  if (value >= 1n << 160n) return null;
  const createdAt = (Number(value >> 128n) + KSUID_EPOCH_S) * 1000;
  if (createdAt < EARLIEST_ACCOUNT_MS || createdAt > now + 24 * 60 * 60 * 1000) return null;
  return createdAt;
}

/** True when `copy` already holds every id of `merged` at the same time: nothing to write. */
export function seenAnnouncementsCover(copy: SeenAnnouncementsMap, merged: SeenAnnouncementsMap): boolean {
  return Object.entries(merged).every(([id, seenAt]) => copy[id] === seenAt);
}
