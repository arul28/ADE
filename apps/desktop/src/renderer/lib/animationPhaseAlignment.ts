/**
 * Every looping CSS animation runs on the document timeline's clock.
 *
 * Stepped loops (`--animate-spin` is `steps(30)`, the status pulses step too)
 * only need a new frame when they move to their next step. Each one started
 * at its own moment, so their steps landed on different frames: four spinners
 * on the PR page (one per running check) drew 120 frames a second instead of
 * 30, and every one of those frames went through layerize, draw and GPU swap.
 * Starting each infinite loop at time 0 of the timeline puts loops with the
 * same rhythm on the same frames. An `animation-delay` still offsets its loop
 * (staggered dots stay staggered); only the arbitrary start moment goes.
 *
 * One capture listener on the document sees every animation's start, so no
 * component has to opt in. The same listener hands slow stepped loops to the
 * shared step clock (`steppedLoopClock.ts`), so they stop costing a frame per
 * display refresh.
 */

import { adoptSteppedLoop } from "./steppedLoopClock";

let installed = false;

function alignInfiniteLoops(event: AnimationEvent): void {
  const target = event.target;
  if (!(target instanceof Element) || typeof target.getAnimations !== "function") return;
  // A `::before`/`::after` loop belongs to its element but is only listed with
  // `subtree: true`; keep the plain call for the common case.
  const pseudoElement = event.pseudoElement || null;
  const animations = pseudoElement ? target.getAnimations({ subtree: true }) : target.getAnimations();
  for (const animation of animations) {
    if (!(animation instanceof CSSAnimation)) continue;
    if (animation.animationName !== event.animationName) continue;
    const effect = animation.effect as KeyframeEffect | null;
    if (effect?.getTiming().iterations !== Infinity) continue;
    if (pseudoElement && (effect.target !== target || effect.pseudoElement !== pseudoElement)) continue;
    if (animation.playState !== "running") continue;
    if (animation.startTime !== 0) animation.startTime = 0;
    adoptSteppedLoop(animation);
  }
}

/** Installs the document listener once. Safe to call more than once. */
export function installAnimationPhaseAlignment(): void {
  if (installed || typeof document === "undefined" || typeof CSSAnimation === "undefined") return;
  installed = true;
  document.addEventListener("animationstart", alignInfiniteLoops, true);
}
