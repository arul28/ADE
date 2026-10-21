import { useSyncExternalStore } from "react";
import { ANNOUNCEMENT_PAGES, type AnnouncementPageDef } from "./announcementPages";
import { createLocalStore, finiteNumber, storedRecord } from "../../onboarding/localStore";

/**
 * Which "What's new" pages this computer has seen, and at which revision.
 * Per computer, like onboarding: this renderer's localStorage, never synced.
 */

export const ANNOUNCEMENTS_SEEN_STORAGE_KEY = "ade.announcements.seen.v1";

type SeenMap = Record<string, number>;

function parseSeen(stored: unknown): SeenMap {
  const out: SeenMap = {};
  for (const [id, revision] of Object.entries(storedRecord(stored) ?? {})) {
    const seen = finiteNumber(revision);
    if (seen !== undefined) out[id] = seen;
  }
  return out;
}

const store = createLocalStore({ key: ANNOUNCEMENTS_SEEN_STORAGE_KEY, event: "ade:announcements-seen", parse: parseSeen });

/** A page is due when this computer never saw it, or saw an older revision. */
function isAnnouncementDue(page: AnnouncementPageDef, seen: SeenMap): boolean {
  const seenRevision = seen[page.id];
  return seenRevision === undefined || seenRevision < page.revision;
}

export function dueAnnouncements(seen: SeenMap = store.get()): AnnouncementPageDef[] {
  return ANNOUNCEMENT_PAGES.filter((page) => isAnnouncementDue(page, seen));
}

export function markAnnouncementSeen(page: AnnouncementPageDef): void {
  const current = store.get();
  if (current[page.id] === page.revision) return;
  store.set({ ...current, [page.id]: page.revision });
}

export function useSeenAnnouncements(): SeenMap {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
