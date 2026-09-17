/**
 * Voice audio waiting for the thing that will take it.
 *
 * Two queues in a call have this exact shape and neither of them is allowed to
 * grow without a bound: the model's voice waiting for the owner window to come
 * and get it, and the microphone frames captured before the session existed,
 * waiting for the socket to open. Both were four loose variables before, and
 * the two ways to empty one mean OPPOSITE things — which is the whole reason
 * this is a module. `cancelQueued()` is a barge-in, or audio a call no longer
 * wants: those chunks were CANCELLED, so the drop tally is untouched.
 * `forgetCall()` is a new call or a teardown: nothing about the last call's
 * audio, lost or cancelled, belongs to the next one.
 *
 * The bound is the other reason. Output arrives faster than realtime and the
 * owner polls at 10 Hz; an owner that stops polling — a window that froze, a
 * renderer being replaced — and a socket that never opens must each cost a
 * bounded amount of memory, and what the bound threw away is a number someone
 * is shown rather than a number nobody sees.
 */
export function createVoiceAudioQueue(limit: number) {
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
     * Throw the queued audio away WITHOUT counting it as lost. The user
     * stopped the CTO mid-sentence; the rest of that sentence is not something
     * they missed.
     */
    cancelQueued(): void {
      chunks = [];
    },

    /** A new call, or a call ending. No memory of the last one, either kind. */
    forgetCall(): void {
      chunks = [];
      dropped = 0;
    },

    /** How much is waiting. For logging and for tests. */
    size(): number {
      return chunks.length;
    },
  };
}
