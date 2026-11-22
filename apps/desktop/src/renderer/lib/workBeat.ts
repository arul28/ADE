/**
 * The shared beat for everything that changes on screen while an agent works.
 *
 * On macOS every frame ADE draws, even a 2 x 43 px caret, becomes a
 * whole-window composite. So what a working chat costs is the number of frames
 * a second, and signals that change out of step cost one frame each: the
 * thinking glyph and sheen, the "working for 12s" timers, the context dial
 * pulse, and the streamed text would each take frames of their own.
 *
 * The beat is every 50 ms (20 a second) of the document timeline, counted
 * from its time 0.
 * The thinking indicator's sheen and glyph (CSS loops that
 * `animationPhaseAlignment` starts at time 0) step on it, and so do the
 * stepped loops the step clock runs (`steppedLoopClock.ts`). A
 * signal that the main thread changes joins it by changing just after a beat
 * instant: the compositor shows a step in the first frame at or after its
 * instant, and a change made a moment after that instant lands in the same
 * frame. The chat pane flushes a running stream on it (AgentChatPane,
 * `scheduleQueuedEventFlush`).
 */

/** One beat, in ms. */
export const WORK_BEAT_MS = 1000 / 20;

/**
 * Milliseconds from `nowMs` (document timeline) to just past the next whole
 * multiple of `periodMs`. Rounded up, so a timer never fires before the
 * instant and a change never lands in the frame before the step it meets.
 */
export function msToNextBeat(periodMs: number = WORK_BEAT_MS, nowMs: number = performance.now()): number {
  const into = ((nowMs % periodMs) + periodMs) % periodMs;
  return Math.max(1, Math.ceil(periodMs - into));
}

/**
 * Puts every running loop under `root` on the beat: each infinite CSS
 * animation starts at time 0 of the document timeline, a whole number of
 * beats. Loops whose steps are 50 ms long then change on the same frames, so
 * the compositor draws one frame for all of them instead of one for each.
 *
 * `animationPhaseAlignment.ts` does the same for every loop when its
 * `animationstart` event arrives, a frame after the loop starts. Call this in
 * a layout effect when a surface mounts its loops or takes them back from a
 * rest (`animation: none`), so the first frame is on the beat too. It reads
 * the animations once (one style update) and sets no timer.
 *
 * A loop the step clock runs (`steppedLoopClock.ts`, playback rate 0) is left
 * to it, and so is any loop that is not infinite (Settings, Reduce motion).
 */
export function alignLoopsToBeat(root: Element | null): void {
  if (!root || typeof root.getAnimations !== "function") return;
  for (const animation of root.getAnimations({ subtree: true })) {
    if (animation.playbackRate !== 1 || animation.playState !== "running") continue;
    if (animation.effect?.getTiming().iterations !== Infinity) continue;
    if (animation.startTime !== 0) animation.startTime = 0;
  }
}
