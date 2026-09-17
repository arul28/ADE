/**
 * How long one voice turn took, leg by leg.
 *
 * Its own module because it is a small state machine with two slots and one
 * log line, and it was tangled through the middle of the call service where the
 * only way to read it was to read everything around it. Nothing here knows
 * about sockets, models or phases: it is given instants and it writes a line.
 *
 * The shape of the problem is that a turn's LAST leg — the first audio the user
 * actually hears — arrives after the turn itself is over, and by then the next
 * utterance may already have opened a record of its own. So there are two
 * slots, and a record is written out at whichever comes first: that audio, the
 * turn's own verdict, or the call ending. A line that only appears for the
 * happy path cannot tell you which turns were slow.
 */

/** One turn's latency, filled in as the turn passes each post. */
export type CtoVoiceTurnTiming = {
  /**
   * The call this record was opened on.
   *
   * Carried rather than read at write time: a turn can unwind after hang-up,
   * and by then the next call has its own id — which labelled the slow turn
   * that ended call one as call two's.
   */
  callId: string | null;
  speechStoppedToTranscriptMs: number | null;
  acceptedAtMs: number;
  turnStartedAtMs: number | null;
  backendDoneAtMs: number | null;
  firstTextMs: number | null;
  firstSpeakAtMs: number | null;
  toolCalls: number;
};

export function createTurnTimingRecorder(deps: {
  now: () => number;
  /** The call a record opened right now belongs to. */
  callId: () => string | null;
  /** One finished record, as the fields the log line carries. */
  log: (line: Record<string, unknown>) => void;
}) {
  /**
   * The accepted transcript that has not reached a turn yet.
   *
   * One slot, because one transcript is accepted at a time. A turn TAKES this
   * record when the model's request is dispatched and then owns it for the rest
   * of its life — which is what stops the next transcript closing a record that
   * belongs to work still running. Without it a request the CTO was still
   * working on twenty-five seconds later was written down as `abandoned`,
   * purely because the user said something else in the meantime.
   */
  let pending: CtoVoiceTurnTiming | null = null;

  /**
   * The record whose answer has been handed over and is waiting to be heard.
   *
   * Separate from `pending` because the last leg arrives after the turn is
   * over, and by then the next utterance may already have a record of its own.
   */
  let speaking: CtoVoiceTurnTiming | null = null;

  /**
   * When the server last said the user stopped talking.
   *
   * The first leg of the latency the user actually feels, and the only one
   * nothing else records: the transcriber's own round trip. It lives here
   * rather than on the call because it is a leg of a record and nothing else,
   * and it is spent on the next `open` — so a transcript with no
   * `speech_stopped` behind it reports no leg rather than one measured against
   * a minute-old event.
   */
  let speechStoppedAtMs = 0;

  const blank = (
    acceptedAtMs: number,
    speechStoppedToTranscriptMs: number | null,
  ): CtoVoiceTurnTiming => ({
    callId: deps.callId(),
    speechStoppedToTranscriptMs,
    acceptedAtMs,
    turnStartedAtMs: null,
    backendDoneAtMs: null,
    firstTextMs: null,
    firstSpeakAtMs: null,
    toolCalls: 0,
  });

  /**
   * Write one record out.
   *
   * Every leg is optional on purpose: an interrupted turn has no answer and a
   * failed one has no audio.
   */
  const write = (
    timing: CtoVoiceTurnTiming,
    outcome: string,
    firstAudioAtMs: number | null,
  ): void => {
    const since = (from: number | null, to: number | null): number | null =>
      from === null || to === null ? null : Math.round(to - from);
    deps.log({
      callId: timing.callId,
      outcome,
      speechStoppedToTranscriptMs: timing.speechStoppedToTranscriptMs,
      acceptToTurnStartMs: since(timing.acceptedAtMs, timing.turnStartedAtMs),
      turnStartToFirstTextMs: timing.firstTextMs,
      turnStartToBackendDoneMs: since(timing.turnStartedAtMs, timing.backendDoneAtMs),
      firstSpeakToFirstAudioMs: since(timing.firstSpeakAtMs, firstAudioAtMs),
      totalMs: since(timing.acceptedAtMs, firstAudioAtMs ?? timing.backendDoneAtMs),
      toolCalls: timing.toolCalls,
    });
  };

  return {
    /** The server heard the user stop talking. One leg starts here. */
    noteSpeechStopped(atMs: number): void {
      speechStoppedAtMs = atMs;
    },

    /**
     * A transcript was accepted. Any record still waiting for a turn is one
     * nothing ever ran for, and is written out as abandoned.
     */
    open(acceptedAtMs: number): void {
      if (pending) write(pending, "abandoned", null);
      pending = blank(
        acceptedAtMs,
        speechStoppedAtMs ? Math.round(acceptedAtMs - speechStoppedAtMs) : null,
      );
      // Spent: one `speech_stopped` measures one transcript.
      speechStoppedAtMs = 0;
    },

    /**
     * A request is being dispatched: it takes the waiting record and owns it.
     *
     * Taken HERE rather than when the turn starts, because a queued request's
     * wait is part of what the user waited. A request with no record behind it
     * — one the transcript gate never saw — still gets one, because a timing
     * line that only appears for the happy path cannot say which turns were slow.
     */
    take(): CtoVoiceTurnTiming {
      const timing = pending ?? blank(deps.now(), null);
      pending = null;
      return timing;
    },

    /** This record is finished, however it finished. */
    close(timing: CtoVoiceTurnTiming, outcome: string): void {
      write(timing, outcome, null);
    },

    /**
     * The answer is written and the model is about to speak it.
     *
     * A record still waiting to be heard when the next one arrives never will
     * be — its response was cancelled or talked over — so it is written out
     * here rather than left open until the call ends.
     */
    handOverToSpeak(timing: CtoVoiceTurnTiming): void {
      if (speaking) write(speaking, "unheard", null);
      speaking = timing;
    },

    /** The post the audio leg is measured from, on whichever record is next up. */
    markFirstSpeak(): void {
      const timing = speaking ?? pending;
      if (timing && timing.firstSpeakAtMs === null) timing.firstSpeakAtMs = deps.now();
    },

    /**
     * The user can hear something. Close whichever record it belongs to: the
     * answer being spoken first, then the transcript the model answered for
     * itself — that second case is the whole point of the hybrid, and its
     * `totalMs` is the number it exists to move.
     */
    markFirstAudio(firstAudioAtMs: number): void {
      const timing = speaking ?? pending;
      if (!timing) return;
      if (speaking) speaking = null;
      else pending = null;
      write(timing, "spoken", firstAudioAtMs);
    },

    /** The call is over. Both slots are still measurements. */
    closeAll(outcome: string): void {
      if (speaking) write(speaking, outcome, null);
      speaking = null;
      if (pending) write(pending, outcome, null);
      pending = null;
      // The next call's first transcript must not be measured against the last
      // call's last word.
      speechStoppedAtMs = 0;
    },
  };
}
