import { useSyncExternalStore } from "react";
import { ANNOUNCEMENT_PAGES, type AnnouncementPageDef } from "./announcementPages";

/**
 * Which "What's new" pages this computer has seen, and at which revision.
 * Per computer, like onboarding: this renderer's localStorage, never synced.
 */

const STORAGE_KEY = "ade.announcements.seen.v1";
const CHANGE_EVENT = "ade:announcements-seen";

type SeenMap = Record<string, number>;

function readSeen(): SeenMap {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: SeenMap = {};
    for (const [id, revision] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof revision === "number" && Number.isFinite(revision)) out[id] = revision;
    }
    return out;
  } catch {
    return {};
  }
}

let snapshot: SeenMap | null = null;

function getSnapshot(): SeenMap {
  snapshot ??= readSeen();
  return snapshot;
}

/** A page is due when this computer never saw it, or saw an older revision. */
export function isAnnouncementDue(page: AnnouncementPageDef, seen: SeenMap = getSnapshot()): boolean {
  const seenRevision = seen[page.id];
  return seenRevision === undefined || seenRevision < page.revision;
}

export function dueAnnouncements(seen: SeenMap = getSnapshot()): AnnouncementPageDef[] {
  return ANNOUNCEMENT_PAGES.filter((page) => isAnnouncementDue(page, seen));
}

export function markAnnouncementSeen(page: AnnouncementPageDef): void {
  const current = getSnapshot();
  if (current[page.id] === page.revision) return;
  const next = { ...current, [page.id]: page.revision };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: the page may show again next launch.
  }
  snapshot = next;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    snapshot = null;
    listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useSeenAnnouncements(): SeenMap {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
