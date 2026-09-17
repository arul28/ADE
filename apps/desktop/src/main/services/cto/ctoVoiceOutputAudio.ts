/**
 * The model's voice, waiting for the owner window to come and get it.
 *
 * A queue rather than four loose variables, because the two things that can
 * empty it mean OPPOSITE things and were being written at five places that had
 * to remember which. `clear()` is a barge-in: those chunks were generated
 * before the user started talking, so they are CANCELLED and the drop tally is
 * untouched. `reset()` is a new call or a teardown: nothing about the last
 * call's audio, lost or cancelled, belongs to the next one.
 *
 * The bound is the other reason this is a module. Output arrives faster than
 * realtime and the owner polls at 10 Hz; an owner that stops polling — a window
 * that froze, a renderer being replaced — must cost a bounded amount of memory,
 * and the count of what that bound threw away is a number the renderer shows
 * rather than a number nobody sees.
 */
export function createOutputAudioQueue(limit: number) {
  let chunks: string[] = [];
  let dropped = 0;

  return {
    /** One chunk of PCM. Oldest goes first once the queue is full. */
    push(chunk: string): void {
      chunks.push(chunk);
      while (chunks.length > limit) {
        chunks.shift();
        dropped += 1;
      }
    },

    /** Hand everything over and start again. The tally goes with it, once. */
    drain(): { chunks: string[]; dropped: number } {
      const drained = { chunks, dropped };
      chunks = [];
      dropped = 0;
      return drained;
    },

    /**
     * A barge-in: throw the queued audio away WITHOUT counting it as lost.
     * The user stopped the CTO mid-sentence; the rest of that sentence is not
     * something they missed.
     */
    clear(): void {
      chunks = [];
    },

    /** A new call, or a call ending. No memory of the last one, either kind. */
    reset(): void {
      chunks = [];
      dropped = 0;
    },

    /** For tests and logging only. */
    size(): number {
      return chunks.length;
    },
  };
}
