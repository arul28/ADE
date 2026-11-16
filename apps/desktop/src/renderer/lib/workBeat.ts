/**
 * The shared beat for everything that changes on screen while an agent works.
 *
 * On macOS every frame ADE draws, even a 2 x 43 px caret, becomes a
 * whole-window composite. So what a working chat costs is the number of frames
 * a second, and signals that change out of step cost one frame each: the
 * thinking glyph and sheen, the "working for 12s" timers, the context dial
 * pulse, and the streamed text would each take frames of their own.
 *
 * The beat is every 1/30 s of the document timeline, counted from its time 0.
 * The thinking indicator's sheen (a CSS loop that `animationPhaseAlignment`
 * starts at time 0) and its glyph (`thinkingGlyph.worker.ts`) step on it, and
 * so do the stepped loops the step clock runs (`steppedLoopClock.ts`). A
 * signal that the main thread changes joins it by changing just after a beat
 * instant: the compositor shows a step in the first frame at or after its
 * instant, and a change made a moment after that instant lands in the same
 * frame. The chat pane flushes a running stream on it (AgentChatPane,
 * `scheduleQueuedEventFlush`).
 */

/** One beat, in ms. */
export const WORK_BEAT_MS = 1000 / 30;

/**
 * Milliseconds from `nowMs` (document timeline) to just past the next whole
 * multiple of `periodMs`. Rounded up, so a timer never fires before the
 * instant and a change never lands in the frame before the step it meets.
 */
export function msToNextBeat(periodMs: number = WORK_BEAT_MS, nowMs: number = performance.now()): number {
  const into = ((nowMs % periodMs) + periodMs) % periodMs;
  return Math.max(1, Math.ceil(periodMs - into));
}
