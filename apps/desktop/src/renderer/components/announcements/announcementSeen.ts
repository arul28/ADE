import { useSyncExternalStore } from "react";
import { ANNOUNCEMENT_PAGES, type AnnouncementPageDef } from "./announcementPages";
import { createLocalStore, finiteNumber, storedRecord } from "../../onboarding/localStore";

/**
 * Which "What's new" pages this computer has shown, and when it last showed
 * any. Per computer, like onboarding: this renderer's localStorage, never
 * synced. It outlives updates, so a page shown once never shows again.
 */

/** Same key as before the catalogue: its values were revisions, and any value means shown. */
export const ANNOUNCEMENTS_SEEN_STORAGE_KEY = "ade.announcements.seen.v1";
const LAST_SHOWN_STORAGE_KEY = "ade.announcements.lastShownAt.v1";

/** A page shows by itself for this long after it was added. */
const FRESH_MS = 45 * 24 * 60 * 60 * 1000;
/** Pages per showing. */
export const PAGES_PER_SHOWING = 3;
/** Inside a project, one showing a day. A little under 24h, so a daily habit is not missed by minutes. */
const IN_PROJECT_GAP_MS = 20 * 60 * 60 * 1000;

type SeenMap = Record<string, number>;

function parseSeen(stored: unknown): SeenMap {
  const out: SeenMap = {};
  for (const [id, value] of Object.entries(storedRecord(stored) ?? {})) {
    const seen = finiteNumber(value);
    if (seen !== undefined) out[id] = seen;
  }
  return out;
}

const seenStore = createLocalStore({ key: ANNOUNCEMENTS_SEEN_STORAGE_KEY, event: "ade:announcements-seen", parse: parseSeen });
const lastShownStore = createLocalStore({
  key: LAST_SHOWN_STORAGE_KEY,
  event: "ade:announcements-last-shown",
  parse: (stored) => finiteNumber(stored) ?? 0,
});

function addedAt(page: AnnouncementPageDef): number {
  const time = Date.parse(`${page.added}T12:00:00Z`);
  return Number.isFinite(time) ? time : 0;
}

/** Newest first; pages added the same day keep catalogue order. */
function newestFirst(pages: readonly AnnouncementPageDef[]): AnnouncementPageDef[] {
  return pages
    .map((page, index) => ({ page, index }))
    .sort((a, b) => addedAt(b.page) - addedAt(a.page) || a.index - b.index)
    .map(({ page }) => page);
}

/** The next pages to show by themselves: unseen, still fresh, newest first, at most three. */
export function dueAnnouncements(seen: SeenMap = seenStore.get(), now = Date.now()): AnnouncementPageDef[] {
  return newestFirst(ANNOUNCEMENT_PAGES)
    .filter((page) => seen[page.id] === undefined && now - addedAt(page) <= FRESH_MS)
    .slice(0, PAGES_PER_SHOWING);
}

/** Every page, newest first, for Help › What's new. */
export function allAnnouncements(): AnnouncementPageDef[] {
  return newestFirst(ANNOUNCEMENT_PAGES);
}

/** Whether a project may show pages now: none were shown in the last day (after an update counts). */
export function inProjectShowingAllowed(now = Date.now()): boolean {
  return now - lastShownStore.get() >= IN_PROJECT_GAP_MS;
}

export function markAnnouncementSeen(page: AnnouncementPageDef, now = Date.now()): void {
  const current = seenStore.get();
  if (current[page.id] !== undefined) return;
  seenStore.set({ ...current, [page.id]: now });
}

/** Called when a showing opens by itself (not from Help), so the next one waits a day. */
export function markShowing(now = Date.now()): void {
  lastShownStore.set(now);
}

export function useSeenAnnouncements(): SeenMap {
  return useSyncExternalStore(seenStore.subscribe, seenStore.get, seenStore.get);
}
