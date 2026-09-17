import { randomUUID } from "node:crypto";

import { buildCtoVoiceSpeakInstructions } from "../../../shared/types/ctoVoicePrompt";

/**
 * One response at a time, and which side asked for it.
 *
 * The Realtime API allows exactly one response to be generating: a second
 * `response.create` while one is in flight is answered with an error, not with
 * speech. So everything ADE asks to have said goes through this one lock — and
 * the lock is the reason the flags here are worth keeping in one place rather
 * than scattered through a call's event handler, where four of them once
 * survived a hang-up and made the next call's first barge-in cancel a stranger.
 *
 * Two kinds of entry, and the difference is load bearing. An `ade` entry is a
 * line ADE WROTE and needs read word for word, so it is created OUT-OF-BAND
 * (`conversation: "none"`, empty `input`) with the text as its instruction: a
 * response created inside the conversation is generated with the user's audio
 * in front of it, and the model answers the user instead of reading the line.
 * A `model` entry is the opposite — it asks the model to speak for itself with
 * the conversation in front of it, which is what a function result needs,
 * because it cannot relay an answer to a call it cannot see.
 */
type CtoVoiceQueuedResponse =
  | { kind: "ade"; text: string }
  /**
   * `timed` is whether this response is part of a turn the call is MEASURING.
   *
   * False for the "still working" sentences, which belong to no transcript: a
   * counted one stamped the first-speak post on whichever timing record was
   * open and then closed it on its own first chunk of audio, so a request the
   * user was still waiting for was written down as answered by a sentence that
   * said nothing.
   */
  | { kind: "model"; timed: boolean };

export function createResponseQueue(deps: {
  send: (payload: Record<string, unknown>) => void;
  /** Not "is there a socket" — "will it take this". A pre-open send throws. */
  isOpen: () => boolean;
  /**
   * Something was queued for the user to hear. The post the audio leg of the
   * turn timing is measured from, because the queue may hold this behind a
   * response already in flight and that wait is part of what the user waited.
   */
  onQueued?: () => void;
}) {
  let queue: CtoVoiceQueuedResponse[] = [];

  /**
   * True from `response.create` until the response that answered it is over.
   *
   * Set on the send rather than on `response.created`, because the sends that
   * race are both ours and both synchronous.
   */
  let active = false;

  /**
   * The entry the last `response.create` was sent for.
   *
   * Kept because a create can be REFUSED — "already has an active response" —
   * and the queue has already shifted it off by then. Without it the sentence
   * that was refused is simply lost, which for a confirmation question means
   * the user is asked nothing and the turn waits forever.
   */
  let inflight: CtoVoiceQueuedResponse | null = null;

  /** True when the response in flight is one ADE created out-of-band. */
  let activeIsOurs = false;
  /** Set on the send, read on `response.created`: the two are a round trip apart. */
  let pendingOurs = false;
  /**
   * The id of the response generating right now, once the server has named it.
   *
   * A bare `response.cancel` only cancels an in-progress response in the
   * DEFAULT conversation, and every response ADE asks for is out-of-band — so
   * without the id a barge-in sent the cancel into an empty conversation and
   * the CTO kept talking over the user.
   */
  let activeId: string | null = null;
  /**
   * A barge-in that arrived before the server named the response.
   *
   * `response.create` and `response.created` are a round trip apart and the
   * user can talk inside it. Dropping the cancel there would leave the very
   * interruption a call most needs to honour unheard.
   */
  let cancelWhenNamed = false;

  /**
   * Nothing is generating any more, whatever the reason.
   *
   * One place rather than two, because every one of these flags describes the
   * SAME response and a call end that cleared five of the six is how the next
   * call's first barge-in cancelled a stranger.
   */
  const clearInflight = (): void => {
    active = false;
    inflight = null;
    // The id belongs to the response that just ended, and a cancel waiting for
    // an id that will never arrive would fire at whatever is next.
    activeId = null;
    activeIsOurs = false;
    pendingOurs = false;
    cancelWhenNamed = false;
  };

  const drain = (): void => {
    if (active || !deps.isOpen()) return;
    const next = queue.shift();
    if (next === undefined) return;
    active = true;
    inflight = next;
    if (next.kind === "ade") {
      pendingOurs = true;
      deps.send({
        type: "response.create",
        event_id: randomUUID(),
        response: {
          // Out-of-band: generated with no conversation and no input items, so
          // the only thing in front of the model is the instruction below.
          conversation: "none",
          input: [],
          instructions: buildCtoVoiceSpeakInstructions(next.text),
          output_modalities: ["audio"],
        },
      });
      return;
    }
    pendingOurs = false;
    // No `response` object at all: the default is the conversation itself, and
    // the session's own instructions and modalities already apply.
    deps.send({ type: "response.create", event_id: randomUUID() });
  };

  return {
    /** True while a response is generating, or being asked for. */
    isActive: (): boolean => active,

    /** Say this, out loud, exactly. ADE's own words, not the CTO's answer. */
    speak(content: string): void {
      const text = content.trim();
      if (!text.length) return;
      deps.onQueued?.();
      queue.push({ kind: "ade", text });
      drain();
    },

    /**
     * Ask the model to speak for itself, with the conversation in front of it.
     *
     * `timing: false` for a sentence that is not any turn's answer — see
     * `CtoVoiceQueuedResponse`.
     */
    requestModelResponse(options: { timing?: boolean } = {}): void {
      const timed = options.timing !== false;
      if (timed) deps.onQueued?.();
      // A second one buys nothing: the model reads everything in the
      // conversation when it generates, so two would say the same thing twice.
      const queued = queue.find(
        (entry): entry is Extract<CtoVoiceQueuedResponse, { kind: "model" }> =>
          entry.kind === "model",
      );
      if (queued) {
        // An untimed entry already waiting is upgraded rather than skipped: the
        // one response that goes out will carry a real answer, and a turn whose
        // answer rode out on it must still be measured.
        if (timed) queued.timed = true;
        return;
      }
      queue.push({ kind: "model", timed });
      drain();
    },

    /**
     * True when audio arriving right now belongs to a response a turn's timing
     * record may be closed by.
     *
     * True with nothing in flight: audio with no entry behind it is the
     * SERVER's own response — the model answering the user for itself — which
     * is most of a hybrid call and is exactly the case the hybrid's timing line
     * exists to measure.
     */
    // Read off the entry in flight rather than mirrored into a flag beside it:
    // the entry already carries the answer, and a second copy is one more thing
    // for a teardown to forget to clear.
    countsForTurnTiming: (): boolean => (
      inflight === null || inflight.kind === "ade" || inflight.timed
    ),

    /** The socket is open; anything queued before it was can go now. */
    drain,

    /** The server named the response that is generating. */
    noteCreated(responseId: string | null): void {
      active = true;
      // Which side created it, recorded here because this is the only moment
      // both facts are in hand: the send that asked for it was ours or it was
      // not, and barge-in has to cancel only the former.
      activeIsOurs = pendingOurs;
      pendingOurs = false;
      activeId = responseId;
      // The user talked over a response the server had not named yet. Now it
      // has a name, so the interruption they already made can be honoured.
      if (cancelWhenNamed && activeId) {
        cancelWhenNamed = false;
        deps.send({ type: "response.cancel", event_id: randomUUID(), response_id: activeId });
      }
    },

    /** A response ended, however it ended. Let the next one through. */
    release(): void {
      clearInflight();
      drain();
    },

    /**
     * The server refused the create because it is STILL generating.
     *
     * The lock is real, so nothing is released: the refused line goes back to
     * the head of the queue and waits for the `response.done` that is coming.
     * Releasing here let the queue drain itself into the same refusal, line
     * after line, until every sentence ADE had queued was gone and none of them
     * was said.
     */
    requeueRefused(): void {
      const refused = inflight;
      inflight = null;
      // The create that was refused never became a response, so the flag it set
      // on the way out belongs to nothing. Left true, the next `response.created`
      // — the server's own, the one that refused us — is recorded as ADE's, and
      // the next barge-in cancels a response the server is already truncating.
      pendingOurs = false;
      if (!refused) return;
      queue.unshift(refused);
    },

    /**
     * Stop the audio the user is talking over — only the audio, and only OURS.
     *
     * The session runs with `interrupt_response: true`, so a response the
     * SERVER created is truncated by the server the moment it hears speech;
     * sending our own cancel at it as well races that truncation and comes back
     * as "no active response". A response ADE created out-of-band is invisible
     * to that mechanism (it is not in the conversation), so it is the one thing
     * left for us to cancel.
     */
    stopSpeaking(): void {
      // Anything ADE queued and has not sent is about a moment that has passed.
      queue = queue.filter((entry) => entry.kind !== "ade");
      if (!active) return;
      // `pendingOurs` covers the round trip between asking for a response and
      // the server naming it — the window the user can talk inside, and the one
      // a barge-in most often lands in.
      if (!activeIsOurs && !pendingOurs) return;
      // Named explicitly: our responses are out-of-band, and a cancel with no
      // `response_id` is only understood as "cancel the default conversation's
      // response" — which is never one of ours.
      if (activeId) {
        deps.send({ type: "response.cancel", event_id: randomUUID(), response_id: activeId });
        return;
      }
      cancelWhenNamed = true;
    },

    /** A call is starting or ending: none of this belongs to the next one. */
    reset(): void {
      queue = [];
      clearInflight();
    },
  };
}
