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

/**
 * Turns away every `animationiteration` listener, so a running loop never
 * wakes the main thread.
 *
 * A composited loop needs no main-thread frame, but while any node of the
 * document listens for `animationiteration`, Chrome must wake the main thread
 * at the end of each pass of each loop to send that event. React listens for
 * it at every root and portal container, whether or not a component asks for
 * it, so the working sheen and breathe (three loops) cost about 45 main-thread
 * frames and React dispatches in a 32 s turn, a third of its idle main-thread
 * time. Nothing in ADE uses the event: a React `onAnimationIteration` prop or
 * a native listener for it does not fire. Use `animationend`, or count the
 * passes from the animation's `currentTime`.
 */
function turnAwayAnimationIterationListeners(): void {
  const addEventListener = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (type === "animationiteration") return;
    addEventListener.call(this, type, listener, options);
  };
}

/**
 * Installs the document listener once. Safe to call more than once. Call it
 * before React creates a root: the roots' listeners are added then.
 */
export function installAnimationPhaseAlignment(): void {
  if (installed || typeof document === "undefined" || typeof CSSAnimation === "undefined") return;
  installed = true;
  turnAwayAnimationIterationListeners();
  document.addEventListener("animationstart", alignInfiniteLoops, true);
}
