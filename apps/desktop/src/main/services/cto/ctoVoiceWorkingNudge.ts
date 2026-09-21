import {
  CTO_VOICE_WORKING_NUDGE_AFTER_MS,
  CTO_VOICE_WORKING_NUDGE_EVERY_MS,
  CTO_VOICE_WORKING_NUDGE_MAX,
} from "../../../shared/types/ctoVoice";

/**
 * Company for a user waiting on work they cannot see.
 *
 * A request on the CTO thread can run for half a minute, and a call that goes
 * quiet for that long reads as a call that dropped. So while one runs, the call
 * says one short sentence every so often — and it is the MODEL's sentence, not
 * ADE's, so it can vary and stay in its own voice.
 *
 * Its own module because it is a self-contained clock with three numbers and
 * one rule, and living inside the call service it was three fields on the call
 * session, two functions and a module-scoped timer that every other part of a
 * 2,000-line file could reach. Nothing here knows about sockets, sessions or
 * phases: it is started, stopped, and told when the speaker will next be quiet.
 */

export type CtoVoiceWorkingNudger = {
  /** A request started running. Arm the first sentence. */
  start(): void;
  /** Nothing is running any more, however it ended. */
  stop(): void;
  /**
   * Audio handed to the renderer plays until this instant.
   *
   * The wait is measured from the last moment the user had something to LISTEN
   * to rather than from when the request started, so an acknowledgement still
   * in the speaker pushes the next sentence out behind it instead of talking
   * over it.
   */
  noteAudioDeadline(atMs: number): void;
};

export function createWorkingNudger(deps: {
  now: () => number;
  log: (event: string, meta?: Record<string, unknown>) => void;
  /**
   * The "Say what it's doing" setting, read live. Off means the user asked for
   * silence while it works, and a nudge is the same promise as the
   * acknowledgement: company, not information.
   */
  enabled: () => boolean;
  /**
   * False while someone else has the floor: a question ADE asked out loud is
   * the only thing the user should be hearing about, and a sentence while they
   * are mid-utterance is the call talking over them.
   */
  canSpeakNow: () => boolean;
  /** Put a silent note in the conversation. */
  think: (note: string) => void;
  /** Ask the model to speak for itself, with the conversation in front of it. */
  requestModelResponse: () => void;
}): CtoVoiceWorkingNudger {
  let timer: NodeJS.Timeout | null = null;
  /** True between `start` and `stop`. Nothing is said outside that window. */
  let running = false;
  /** When the request running right now started. The clock a nudge is measured from. */
  let startedAtMs = 0;
  /**
   * How many sentences the running request has produced, and when the last one
   * went out.
   *
   * Per request rather than per call: a call with four slow requests in it is
   * four separate silences, and a counter that survived one of them would leave
   * the user listening to nothing for the rest of the call.
   */
  let nudges = 0;
  let lastNudgeAtMs = 0;
  /** When the audio already handed over finishes playing. */
  let audioDeadlineMs = 0;

  /**
   * How long until the next sentence is due, in milliseconds. Negative or zero
   * means now.
   *
   * One function, because the arming and the firing must not be able to
   * disagree about when it is due.
   */
  const dueInMs = (): number => {
    const threshold = nudges === 0
      ? CTO_VOICE_WORKING_NUDGE_AFTER_MS
      : CTO_VOICE_WORKING_NUDGE_EVERY_MS;
    return Math.max(startedAtMs, lastNudgeAtMs, audioDeadlineMs) + threshold - deps.now();
  };

  const clear = (): void => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };

  /**
   * Arm the next sentence.
   *
   * `delayMs` is for one that was DEFERRED rather than due — a question is
   * open, or the user is mid-sentence — where re-deriving the wait would come
   * back as zero and spin the timer.
   */
  const arm = (delayMs?: number): void => {
    clear();
    if (!running) return;
    if (!deps.enabled()) return;
    if (nudges >= CTO_VOICE_WORKING_NUDGE_MAX) return;
    timer = setTimeout(() => {
      timer = null;
      fire();
    }, Math.max(0, delayMs ?? dueInMs()));
    timer.unref?.();
  };

  /**
   * Say one short sentence, because the request is still running.
   *
   * In the conversation rather than out-of-band — the opposite of every other
   * line ADE asks for. This one is NOT ADE's words: the model is asked to find
   * its own, and being in the conversation is also what lets the user talk over
   * it.
   */
  const fire = (): void => {
    if (!running || !deps.enabled()) return;
    // Someone else has the floor. Not a reason to give up on the sentence — the
    // request is still running — so it waits out one more gap.
    if (!deps.canSpeakNow()) {
      arm(CTO_VOICE_WORKING_NUDGE_EVERY_MS);
      return;
    }
    // Something was said inside the wait after all: the acknowledgement ran
    // long, or the model answered something else. Re-arm rather than speak.
    if (dueInMs() > 0) {
      arm();
      return;
    }
    const elapsedSeconds = Math.max(1, Math.round((deps.now() - startedAtMs) / 1000));
    nudges += 1;
    lastNudgeAtMs = deps.now();
    deps.log("cto_voice.working_nudge", { nudge: nudges, elapsedSeconds });
    // Everything it must NOT do is spelled out, because each one has a cost the
    // user can hear: a repeat makes the call sound stuck, an invented result is
    // a lie about work that has not finished, and a question hands the turn
    // back to a user who is waiting rather than deciding.
    deps.think(
      `The request you are working on is still running (about ${elapsedSeconds} seconds so far).`
      + " Say one short, natural sentence to keep the user company — vary it, do not"
      + " repeat yourself, do not invent results, and do not ask a question."
      + " Say nothing about this note.",
    );
    deps.requestModelResponse();
    arm();
  };

  return {
    start(): void {
      running = true;
      // Per request, so each silence is measured on its own.
      startedAtMs = deps.now();
      nudges = 0;
      lastNudgeAtMs = 0;
      arm();
    },

    stop(): void {
      running = false;
      clear();
    },

    noteAudioDeadline(atMs: number): void {
      audioDeadlineMs = Math.max(audioDeadlineMs, atMs);
    },
  };
}
