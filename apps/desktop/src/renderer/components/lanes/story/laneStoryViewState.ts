/**
 * Per-project persistence for the Lane story view switch.
 *
 * Deliberately one localStorage key per project holding one short string —
 * never a single key holding a map of every project's state. The Quiet lanes
 * regression came from surface stores rewriting a whole map, so a stale reader
 * could clobber another surface's entry on every write.
 */

export type LaneStoryView = "list" | "timeline";

const KEY_PREFIX = "ade.laneStory.view.v1";

export function laneStoryViewStorageKey(projectKey: string | null | undefined): string {
  const key = String(projectKey ?? "").trim();
  return key ? `${KEY_PREFIX}:${key}` : KEY_PREFIX;
}

export function readLaneStoryView(projectKey: string | null | undefined): LaneStoryView {
  try {
    const raw = window.localStorage.getItem(laneStoryViewStorageKey(projectKey));
    return raw === "timeline" ? "timeline" : "list";
  } catch {
    return "list";
  }
}

export function writeLaneStoryView(projectKey: string | null | undefined, view: LaneStoryView): void {
  try {
    window.localStorage.setItem(laneStoryViewStorageKey(projectKey), view);
  } catch {
    /* storage unavailable (private mode / quota) — the view just won't persist */
  }
}
