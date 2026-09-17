import {
  CTO_VOICE_TURN_BURST_COOLDOWN_MS,
  CTO_VOICE_TURN_BURST_LIMIT,
  CTO_VOICE_TURN_BURST_WINDOW_MS,
} from "../../../shared/types/ctoVoice";

/**
 * The gate that shuts when the transcript source runs away.
 *
 * A transcriber that redelivers, or a stuck stream, can produce accepted turns
 * faster than a person can talk, and the one place that is dangerous is the
 * spoken yes/no parser: a runaway stream must not be able to answer a
 * permission question. So this is read on EVERY transcript rather than only
 * when a question is open — it was once cleared only inside the confirmation
 * branch, and an ordinary talkative call latched it shut for good.
 *
 * Quiet is what opens it, measured from the last transcript of ANY kind, which
 * is why `isShut` both reads the clock and moves it: the cooldown belongs to
 * this valve and nothing outside it has to remember the order.
 */
export function createTranscriptBurstValve(deps: {
  now: () => number;
  log: (event: string, meta?: Record<string, unknown>) => void;
}) {
  /**
   * When each accepted turn was accepted, inside the burst window.
   *
   * Trimmed to the window on every read, so this is bounded by the rate a
   * transcript source can physically produce transcripts rather than by the
   * length of the call.
   */
  let acceptedAtMs: number[] = [];
  /** When the last transcript of any kind arrived — the cooldown is measured off it. */
  let lastTranscriptAtMs = 0;
  let tripped = false;

  return {
    /**
     * Is the valve still shut? Call this once per transcript, before anything
     * else judges it: this is also where the quiet clock starts again.
     */
    isShut(): boolean {
      const at = deps.now();
      const quietMs = at - lastTranscriptAtMs;
      lastTranscriptAtMs = at;
      if (!tripped) return false;
      if (quietMs < CTO_VOICE_TURN_BURST_COOLDOWN_MS) return true;
      tripped = false;
      acceptedAtMs = [];
      deps.log("cto_voice.transcript_valve_cleared");
      return false;
    },

    /** One accepted user turn. Too many inside the window shuts the valve. */
    noteAccepted(atMs: number): void {
      acceptedAtMs = [...acceptedAtMs, atMs]
        .filter((accepted) => atMs - accepted < CTO_VOICE_TURN_BURST_WINDOW_MS);
      if (acceptedAtMs.length <= CTO_VOICE_TURN_BURST_LIMIT) return;
      tripped = true;
      deps.log("cto_voice.transcript_valve_tripped", {
        accepted: acceptedAtMs.length,
        windowMs: CTO_VOICE_TURN_BURST_WINDOW_MS,
      });
    },

    /** A new call: a previous call's burst must not shut this one's gate. */
    reset(): void {
      acceptedAtMs = [];
      lastTranscriptAtMs = 0;
      tripped = false;
    },
  };
}
