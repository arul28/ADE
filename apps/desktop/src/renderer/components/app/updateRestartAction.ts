import { useEffect, useSyncExternalStore } from "react";
import type { AutoUpdateSnapshot } from "../../../shared/types";
import { updateTrackLabel, updateTrackOfVersion, type UpdateTrack } from "../../../shared/updateTrack";

/**
 * The one name for "restart ADE to put the downloaded build in place". The
 * top bar, the floating prompt, Settings and the install dialog all say it the
 * same way, so a person never meets a button a note told them about under
 * another name.
 */
export type UpdateRestartAction = {
  /** The track this restart moves the computer to; null for an ordinary update. */
  switchTo: UpdateTrack | null;
  /** "Restart and update", or "Restart and switch to Stable". */
  label: string;
};

/**
 * A downloaded build on the other track than the running one is a track
 * switch, whether it started in this launch (`track.switching`) or before a
 * restart that did not install it. Builds with no track (dev, Alpha) never are.
 */
export function updateRestartAction(snapshot: Pick<AutoUpdateSnapshot, "version" | "track">): UpdateRestartAction {
  const track = snapshot.track;
  const target = track
    ? (snapshot.version ? updateTrackOfVersion(snapshot.version) : track.switching)
    : null;
  const switchTo = track && target && target !== track.running ? target : null;
  return {
    switchTo,
    label: switchTo ? `Restart and switch to ${updateTrackLabel(switchTo)}` : "Restart and update",
  };
}

// A page that shows the restart action itself (Settings › ADE service) says
// so while it is open, and the floating prompt steps aside: one action, one
// button on screen, and nothing floating over the page's own cards.
let inPageCount = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setInPageCount(next: number): void {
  inPageCount = next;
  for (const listener of listeners) listener();
}

/** Mark that this page shows the restart action while `shown` is true. */
export function useShowsUpdateRestartAction(shown: boolean): void {
  useEffect(() => {
    if (!shown) return;
    setInPageCount(inPageCount + 1);
    return () => setInPageCount(Math.max(0, inPageCount - 1));
  }, [shown]);
}

/** True while an open page already shows the restart action. */
export function useUpdateRestartActionInPage(): boolean {
  return useSyncExternalStore(subscribe, () => inPageCount > 0, () => false);
}
