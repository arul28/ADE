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
 * component has to opt in.
 */

let installed = false;

function alignInfiniteLoops(event: AnimationEvent): void {
  const target = event.target;
  if (!(target instanceof Element) || typeof target.getAnimations !== "function") return;
  for (const animation of target.getAnimations()) {
    if (!(animation instanceof CSSAnimation)) continue;
    if (animation.animationName !== event.animationName) continue;
    if (animation.effect?.getTiming().iterations !== Infinity) continue;
    if (animation.playState !== "running" || animation.startTime === 0) continue;
    animation.startTime = 0;
  }
}

/** Installs the document listener once. Safe to call more than once. */
export function installAnimationPhaseAlignment(): void {
  if (installed || typeof document === "undefined" || typeof CSSAnimation === "undefined") return;
  installed = true;
  document.addEventListener("animationstart", alignInfiniteLoops, true);
}
