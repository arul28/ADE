import { useEffect } from "react";

/**
 * How many Android surfaces show an emulator right now: the Android pane and
 * the floating player. ADE Web has no Android events from the brain, so it
 * re-reads lane status on a timer to make them; that timer only runs while
 * one of these surfaces is mounted. The cards and pills that only show
 * whether an emulator runs read once and keep that reading.
 */
let watchers = 0;

/** True while an Android pane or the floating player is mounted. */
export function isAndroidStatusWatched(): boolean {
  return watchers > 0;
}

/** Counts the calling surface as watching while it is mounted. */
export function useAndroidStatusWatch(): void {
  useEffect(() => {
    watchers += 1;
    return () => {
      watchers -= 1;
    };
  }, []);
}
