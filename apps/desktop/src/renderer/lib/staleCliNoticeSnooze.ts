/**
 * Persistent, per-project snooze for the "stale CLI/shell sessions" notice.
 *
 * The notice should appear at most once per hour per project, and that cadence
 * must survive app restarts, project close/reopen, and leaving/returning to a
 * project — so it is backed by localStorage (durable in the Electron renderer)
 * rather than in-memory React state. Keyed by project root: each project gets
 * its own hourly window.
 */

const STORAGE_KEY = "ade.staleCliNoticeSnoozeByRoot";

/** How long the notice stays suppressed after it is shown or dismissed. */
export const STALE_CLI_NOTICE_SNOOZE_MS = 60 * 60 * 1_000;

type SnoozeMap = Record<string, number>;

function readMap(): SnoozeMap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: SnoozeMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(map: SnoozeMap): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // best effort — storage may be unavailable
  }
}

/** Epoch ms until which the notice is snoozed for this project (0 if not snoozed). */
export function getStaleCliNoticeSnoozeUntil(projectRoot: string | null | undefined): number {
  const root = projectRoot?.trim();
  if (!root) return 0;
  return readMap()[root] ?? 0;
}

/** True if the notice is currently snoozed for this project. */
export function isStaleCliNoticeSnoozed(
  projectRoot: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  return getStaleCliNoticeSnoozeUntil(projectRoot) > nowMs;
}

/**
 * Snooze the notice for this project for one hour from `nowMs`. Also prunes
 * already-expired entries for other projects so the map can't grow unbounded.
 */
export function snoozeStaleCliNotice(
  projectRoot: string | null | undefined,
  nowMs: number = Date.now(),
): void {
  const root = projectRoot?.trim();
  if (!root) return;
  const map = readMap();
  map[root] = nowMs + STALE_CLI_NOTICE_SNOOZE_MS;
  for (const key of Object.keys(map)) {
    if (key !== root && map[key] <= nowMs) delete map[key];
  }
  writeMap(map);
}
