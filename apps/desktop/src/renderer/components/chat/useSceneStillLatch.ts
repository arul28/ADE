import { useEffect, useRef, useState } from "react";

import {
  useSceneStillPreview,
  useSceneStillRecord,
  useSessionStillsReady,
} from "./sceneStillStore";

/**
 * How long a settled mount waits to learn whether it has a still before it
 * gives up and runs the scene instead.
 *
 * Shorter than anything the transport promises on purpose: the read behind it
 * is a broker query that may cross to another machine, where the only bound is
 * the 30 s IPC budget, and the user is looking at a blank box for every second
 * of it. Running the code is the safe end of the trade — it is what every
 * scene did before stills existed — and a late answer is not wasted, because
 * the picture replaces the frozen frame when it lands.
 *
 * It bounds the INDEX LISTING only. Once the index has named a record, the
 * question is no longer whether a picture exists; see {@link useSceneStillLatch}.
 */
export const SCENE_STILL_INDEX_WAIT_MS = 1_500;

export type SceneStillLatch = {
  /** Show the picture and never mount a frame: the code has already run. */
  rehydrated: boolean;
  /** Not yet knowable. Draw a placeholder; do not run anything. */
  undecided: boolean;
  /** The picture, when there is one to draw. */
  storedStillSrc: string | null;
};

/**
 * Whether this mount shows a picture or runs the scene's code.
 *
 * Latched on the FIRST render that can answer rather than derived, because
 * `live` going false at the end of a turn must not yank a frame the user is
 * watching: a scene that was live on this mount plays out and freezes the way
 * it always did. Only a mount that begins settled — scrollback, a remount, a
 * reopened chat — skips execution.
 *
 * Three ways to reach an answer, and the order is the whole design:
 *
 *  - A PICTURE. Nothing to decide.
 *  - A RECORD, with its bytes still in flight. A record is proof the code
 *    already ran and left a file, so this rehydrates and holds a placeholder
 *    until the bytes land. On a remote chat every still needs its own
 *    cross-machine preview read, so deciding this on a deadline meant a
 *    reopened transcript re-ran every generated view and rewrote every still.
 *    A scene is never re-run merely because its picture is slow.
 *  - NEITHER, with the index settled — or the wait below run out. Run the
 *    scene. The index is one query for the whole chat, so the deadline bounds
 *    a single round trip rather than one per row.
 *
 * A live mount never waits, and neither does a mount with no scope key: the
 * index is keyed by that key, so there is nothing it could ever be asked about
 * and waiting left reasoning and plan-approval scenes permanently blank.
 */
export function useSceneStillLatch({
  sessionId,
  scopeKey,
  live,
}: {
  sessionId: string | null;
  scopeKey: string | null;
  live: boolean;
}): SceneStillLatch {
  const storedStill = useSceneStillRecord(sessionId, scopeKey);
  const { src: storedStillSrc, pending: pictureInFlight } = useSceneStillPreview(storedStill);
  const storedStillReady = useSessionStillsReady(sessionId);

  const rehydrateRef = useRef<boolean | null>(null);
  /**
   * True once this mount has actually SHOWN a picture.
   *
   * The re-decision below exists for a promise that was broken — a record whose
   * bytes never arrived. A mount that already had the bytes is a different
   * story: if its preview were ever to go away again (a store reset, a cache
   * eviction, a re-render that lands between two store states) the rule as
   * written would read that as "no picture" and start running the scene's code
   * underneath a user who was looking at its still. Cheap insurance against a
   * class of bug rather than a fix for a known one.
   */
  const hadPictureRef = useRef(false);
  const [indexWaitExpired, setIndexWaitExpired] = useState(false);

  const hasPicture = Boolean(storedStillSrc);
  if (hasPicture) hadPictureRef.current = true;
  const pictureComing = Boolean(storedStill?.record) && pictureInFlight;
  // "The index has answered AND no picture is coming."
  const indexAnswered = storedStillReady && !hasPicture && !pictureComing;
  if (
    rehydrateRef.current === null
    && (live || !scopeKey || hasPicture || pictureComing || indexAnswered || indexWaitExpired)
  ) {
    rehydrateRef.current = !live && (hasPicture || pictureComing);
  }
  // A preview that came back EMPTY is an answer, not a wait.
  //
  // `pictureComing` is the promise that bytes are on their way, and a mount
  // that latched on it stops running the scene forever. When the read fails —
  // a rejected cross-machine call, a host with no preview route, a non-string
  // answer — that promise is broken: no picture, nothing in flight, and the
  // row stayed a blank box that never drew and never retried. One re-decision
  // is allowed, back to the local behaviour: run the scene. The read itself
  // retries on the next mount, since the effect behind it is remounted with
  // the row. Never for a mount that once displayed a real picture — see
  // {@link hadPictureRef}.
  if (rehydrateRef.current === true && !hadPictureRef.current && !hasPicture && !pictureComing) {
    rehydrateRef.current = false;
  }
  const undecided = rehydrateRef.current === null;

  /**
   * The wait on the index listing, and only on it.
   *
   * On a remote chat that read is an IPC round trip whose only bound is the
   * 30 s call budget, and a chat whose machine is slow to answer held every
   * settled scene in the transcript at a placeholder for that whole time. Past
   * this the mount decides "no still" and runs the scene; a picture that turns
   * up afterwards still swaps in, because the freeze shows the stored still
   * over the frame the moment it resolves.
   */
  useEffect(() => {
    if (!undecided) return;
    const timer = window.setTimeout(() => setIndexWaitExpired(true), SCENE_STILL_INDEX_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [undecided]);

  return { rehydrated: rehydrateRef.current === true, undecided, storedStillSrc };
}
