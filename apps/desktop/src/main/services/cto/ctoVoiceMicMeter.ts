import {
  CTO_VOICE_MIC_WINDOW_MS,
  CTO_VOICE_MIN_SPEECH_MS,
  CTO_VOICE_MIN_SPEECH_PEAK_LEVEL,
  ctoVoiceTranscriptHasSpeech,
  type CtoVoiceTranscriptRejection,
} from "../../../shared/types/ctoVoice";

/**
 * What ADE's OWN microphone heard, and what that says about a transcript.
 *
 * Two things that belong together and to nothing else: a bounded ring of recent
 * frames, and the pure judgement that reads it. The judgement guards ONE
 * decision — whether a transcript may answer a question ADE asked out loud —
 * because under the hybrid the realtime model hears the audio itself and
 * answers whatever it heard, so refusing a caption never stopped a
 * hallucination; it only deleted the user's own words from the call record.
 */

/** One microphone frame, as the renderer measured it. */
type CtoVoiceMicFrame = {
  /** When it arrived, on the caller's clock. */
  at: number;
  /** 0..1 peak of that frame. */
  level: number;
  /** How long it lasts, read off its own bytes rather than a clock. */
  ms: number;
  /** True when ADE was not speaking, which is what tells a person from an echo. */
  idle: boolean;
};

/** The meter as the gate reads it. */
export type CtoVoiceMicReading = {
  peak: number;
  voicedMs: number;
  frames: number;
  framesWhileIdle: number;
};

/**
 * The recent past of the microphone, frame by frame.
 *
 * A ring rather than a set of running totals, and that is the fix for a real
 * failure: totals were only ever cleared by a judgement, so the first
 * transcript of a call was judged against every frame since the microphone
 * opened. Fifteen seconds of a quiet room contains enough scattered noisy
 * frames to add up to 240 ms, which is enough for a phantom transcript to walk
 * through a gate that is running. Frames older than {@link CTO_VOICE_MIC_WINDOW_MS} are dropped, so
 * the evidence is always about the recent past — bounded by the window rather
 * than by the length of the call.
 *
 * The reset window is deliberately NOT `speech_started`..`speech_stopped`.
 * Server VAD reports a segment after the fact and with its own prefix padding,
 * so frames that belong to the user's first syllable arrive before the server
 * admits the segment opened; resetting on `speech_started` threw exactly those
 * away and would have rejected short real answers. Resetting on a JUDGEMENT —
 * one transcript, one verdict, one reset — keeps the pre-roll, and the window
 * stops one utterance's silence vouching for the next one's words.
 */
export function createMicMeter(deps: { now: () => number }) {
  let frames: CtoVoiceMicFrame[] = [];

  /** Drop everything that fell out of the window. Called on every write and read. */
  const trim = (at: number): void => {
    const cutoff = at - CTO_VOICE_MIC_WINDOW_MS;
    let drop = 0;
    while (drop < frames.length && frames[drop]!.at <= cutoff) drop += 1;
    if (drop > 0) frames = frames.slice(drop);
  };

  return {
    push(frame: { level: number; ms: number; idle: boolean }): void {
      const at = deps.now();
      frames.push({ at, ...frame });
      trim(at);
    },

    /**
     * `voicedMs` is the longest CONTIGUOUS run of above-threshold frames, not
     * the sum of them: a sum cannot tell a spoken word from three unrelated
     * clicks a second apart, because the frames only have to add up. A word is
     * energy that stays up, so the run is what gets measured.
     */
    read(): CtoVoiceMicReading {
      trim(deps.now());
      let peak = 0;
      let framesWhileIdle = 0;
      let run = 0;
      let voicedMs = 0;
      for (const frame of frames) {
        peak = Math.max(peak, frame.level);
        if (frame.idle) framesWhileIdle += 1;
        if (frame.level >= CTO_VOICE_MIN_SPEECH_PEAK_LEVEL) {
          run += frame.ms;
          voicedMs = Math.max(voicedMs, run);
        } else {
          run = 0;
        }
      }
      return { peak, voicedMs, frames: frames.length, framesWhileIdle };
    },

    reset(): void { frames = []; },
  };
}

/**
 * Could this transcript answer a question ADE asked out loud?
 *
 * A transcription event on its own is not evidence of speech — see the gate's
 * constants in `shared/types/ctoVoice` — and a phantom "yes" is the one thing
 * on this wire that can release a tool. Returns the reason to refuse the
 * transcript a DECISION, or null to let it decide. It says nothing about
 * whether the user spoke for the purposes of the call record: that question has
 * an unconditional answer, because rejecting a caption never stopped the
 * realtime model answering and only deleted the user's own words.
 *
 * Pure: it is given the reading rather than reading the meter, so the caller
 * decides when the evidence is taken and what a verdict costs.
 */
export function judgeVoiceTranscript(
  final: string,
  mic: CtoVoiceMicReading,
): CtoVoiceTranscriptRejection | null {
  if (!ctoVoiceTranscriptHasSpeech(final)) return "empty";
  // The CTO being heard by the microphone. Both halves matter: a segment that
  // ran entirely under ADE's own voice AND never rose above the speech floor is
  // echo, while the same segment WITH a real peak in it is a barge-in and the
  // most urgent thing on the call.
  if (mic.frames > 0 && mic.framesWhileIdle === 0 && mic.peak < CTO_VOICE_MIN_SPEECH_PEAK_LEVEL) {
    return "echo";
  }
  if (mic.peak < CTO_VOICE_MIN_SPEECH_PEAK_LEVEL) return "no_speech_energy";
  if (mic.voicedMs < CTO_VOICE_MIN_SPEECH_MS) return "too_short";
  return null;
}
