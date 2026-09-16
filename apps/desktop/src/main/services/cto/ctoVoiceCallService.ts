import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

import {
  buildCtoVoiceInstructions,
  buildCtoVoiceSpeakInstructions,
  CTO_VOICE_REALTIME_TOOLS,
  CTO_VOICE_TOOL_APPROVE,
  CTO_VOICE_TOOL_ASK_CTO,
  CTO_VOICE_TOOL_CANCEL_WORK,
  CTO_VOICE_TOOL_DENY,
  CTO_VOICE_TOOL_END_CALL,
  CTO_VOICE_END_CALL_AUDIO_TAIL_MS,
  CTO_VOICE_ASK_QUEUE_LIMIT,
  normalizeCtoVoiceAskMode,
  ctoVoiceEndpointUrl,
  CTO_VOICE_DEFAULT,
  CTO_VOICE_INITIAL_STATE,
  CTO_VOICE_CAPTURE_DEFAULT_NOTE,
  CTO_VOICE_MIC_WINDOW_MS,
  CTO_VOICE_MIN_SPEECH_MS,
  CTO_VOICE_MIN_SPEECH_PEAK_LEVEL,
  CTO_VOICE_PREOPEN_AUDIO_LIMIT,
  CTO_VOICE_SAMPLE_RATE,
  CTO_VOICE_TRANSCRIBE_LANGUAGE,
  CTO_VOICE_TRANSCRIBE_MODEL,
  CTO_VOICE_TRANSCRIBE_PROMPT,
  CTO_VOICE_TURN_BURST_COOLDOWN_MS,
  CTO_VOICE_TURN_BURST_LIMIT,
  CTO_VOICE_TURN_BURST_WINDOW_MS,
  ctoVoiceTranscriptHasSpeech,
  voiceCostUsd,
  type CtoVoiceCaption,
  type CtoVoiceName,
  type CtoVoicePhase,
  type CtoVoiceState,
  type CtoVoiceTranscriptRejection,
} from "../../../shared/types/ctoVoice";
import { buildConfirmation, resolveSpokenConfirmation } from "./ctoVoiceConfirmation";

/**
 * The CTO voice call.
 *
 * OpenAI's Realtime API over a WebSocket, run as a hybrid. The realtime model
 * is the conversational front: server turn detection creates its responses
 * (`turn_detection.create_response: true`), it answers small talk and anything
 * in the context block from the session prompt, and it speaks in real time.
 * Anything that needs the project it asks for by calling `ask_cto`, which runs
 * a real turn on the CTO's own thread — the user's chosen model, its memory,
 * all its tools — and comes back as a function result the model then speaks in
 * context.
 *
 * The CTO's thinking still never moves off the plan it already runs on, and
 * only the voice minutes bill to the user's own key. What moved is who talks:
 * relaying every sentence from a CTO turn cost three to five seconds before the
 * first word, even for "hello", which is not a conversation.
 *
 * Six behaviours are easy to get wrong and are load bearing:
 *
 * 1. A real microphone never stops. If the client stops sending input audio the
 *    session stalls mid-sentence — measured, not theorised. `pushAudio` keeps
 *    the stream fed and `keepAlive` sends silence when the user is muted.
 * 2. One response at a time. A second `response.create` while one is still
 *    generating is an error, so every response ADE asks for — its own lines and
 *    the one that speaks a function result — goes through one queue, drained on
 *    `response.done`.
 * 3. ADE's OWN lines are out-of-band; the function result is NOT. A line ADE
 *    wrote ("Sorry — I didn't catch that") must be read word for word, and
 *    inside the conversation the user's audio outweighs the instruction and the
 *    model answers the user instead. A function result is the opposite: the
 *    model has to see the call it made in order to speak the answer to it.
 * 4. Only one `ask_cto` runs at a time — the CTO thread is a single session and
 *    two overlapping turns collide on it — so every request goes through one
 *    serial drain loop. What happens to a second request is the MODEL's call,
 *    carried on the tool's `mode`: `replace` stops the running one, `queue`
 *    waits for it. Two may wait; a third is refused out loud.
 * 5. A transcript is not proof of speech, and the gate that judges one guards
 *    the spoken yes/no parser ALONE. Captions and the exchange count are
 *    recorded for every non-empty transcript, because rejecting one never
 *    stopped the model answering — it only deleted the user's own words. See
 *    `judgeTranscript` and `handleUserTranscript`.
 * 6. Barge-in is split. The server truncates its own response
 *    (`interrupt_response: true`); ADE cancels only a response it created
 *    itself, because a bare `response.cancel` aimed at a server response would
 *    race the server's own truncation.
 */

export type CtoVoiceSocket = {
  send: (data: string) => void;
  close: () => void;
  /**
   * `unexpected-response` is the only place the HTTP status of a failed upgrade
   * is visible. Without a listener `ws` throws the response away and reports
   * `Error: Unexpected server response: 401`, so "your key was rejected" and
   * "OpenAI is down" arrive as the same sentence.
   */
  on: (
    event: "open" | "message" | "close" | "error" | "unexpected-response",
    handler: (payload?: unknown) => void,
  ) => void;
};

/**
 * Why a call stopped. Every teardown names one, and the name is in the log.
 *
 * Kept as data rather than a free string so a new teardown path cannot be added
 * without deciding what to call it — the diagnosis this exists for is "which of
 * the nine paths ran", and an unlabelled tenth is the one that hides.
 */
export type CtoVoiceCallEndReason =
  | "owner_end"
  /**
   * The CTO hung up because the user said goodbye.
   *
   * An ordinary ending, not a failure: the card and the status line read
   * exactly as they do for the End button, and the call waits for the goodbye
   * to finish playing before it tears the socket down.
   */
  | "assistant_end"
  | "start_rejected"
  | "watchdog"
  | "socket_close"
  | "socket_error"
  | "socket_rejected"
  | "confirm_mode_failed"
  | "session_error"
  | "dispose"
  | "replaced"
  | "unknown";

/** What a failed connection attempt told us, in the two forms it can arrive. */
export type CtoVoiceSocketFailure = {
  /** HTTP status of a rejected upgrade, when there was a response at all. */
  status?: number | null;
  /** Node's error code (`ENOTFOUND`, `ECONNREFUSED`, …), when there was one. */
  code?: string | null;
  /** The raw message, read only to recover a status or code nobody passed. */
  message?: string | null;
};

export type CtoVoiceSocketFailureReason = {
  /** One sentence for the HUD, naming the thing the user can act on. */
  message: string;
  status: number | null;
  code: string | null;
};

/**
 * Codes that mean "this machine could not reach OpenAI at all".
 *
 * A DNS failure, a refused connection and a dead route are one problem from the
 * user's side — the network — and a different problem from a rejected key, so
 * they must not share a sentence.
 */
const CTO_VOICE_OFFLINE_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ETIMEDOUT",
  "EPIPE",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * Turn a failed connection into something worth reading.
 *
 * "The voice connection failed." is true of every case below and useful in none
 * of them: the three that a user can actually do something about are a key
 * OpenAI refused, a key it is throttling, and a machine that is offline. Pure,
 * so the mapping is testable without a socket.
 *
 * The status is taken from the upgrade response when we have one and recovered
 * from `ws`'s own message when we do not — `Unexpected server response: 401` is
 * what arrives when nothing listened for the response itself.
 */
export function describeCtoVoiceSocketFailure(
  failure: CtoVoiceSocketFailure = {},
): CtoVoiceSocketFailureReason {
  const text = typeof failure.message === "string" ? failure.message : "";
  const parsedStatus = /unexpected server response:\s*(\d{3})/i.exec(text)?.[1];
  const status = typeof failure.status === "number" && Number.isFinite(failure.status)
    ? failure.status
    : parsedStatus
      ? Number(parsedStatus)
      : null;
  const explicitCode = typeof failure.code === "string" && failure.code.trim().length
    ? failure.code.trim().toUpperCase()
    : null;
  // A fake socket in a test, and some wrapped errors, carry the code only in
  // the text ("getaddrinfo ENOTFOUND api.openai.com").
  const code = explicitCode
    ?? [...CTO_VOICE_OFFLINE_ERROR_CODES].find((candidate) => text.toUpperCase().includes(candidate))
    ?? null;

  if (status === 401 || status === 403) {
    return { message: CTO_VOICE_REJECTED_KEY_MESSAGE, status, code };
  }
  if (status === 429) {
    return { message: "OpenAI is rate limiting this key. Try again in a minute.", status, code };
  }
  // Only when the upgrade never got a response: a 500 is OpenAI answering, not
  // a network that is down, and must not be blamed on the user's connection.
  if (status === null && code !== null && CTO_VOICE_OFFLINE_ERROR_CODES.has(code)) {
    return { message: "ADE could not reach OpenAI. Check your internet connection.", status, code };
  }
  return { message: "The voice connection failed.", status, code };
}

/**
 * The four sentences a key problem can reduce to.
 *
 * Shared between the handshake mapping and the session-error mapping, because
 * the same refusal reaches ADE either way — as an HTTP status when the upgrade
 * is rejected, and as an `error` event when the socket opened first — and the
 * user must not be told two different things about one key.
 */
const CTO_VOICE_REJECTED_KEY_MESSAGE =
  "OpenAI rejected this key. Check it under CTO settings, Voice.";
const CTO_VOICE_EXPIRED_KEY_MESSAGE =
  "Your OpenAI key has expired. Create a new key at platform.openai.com"
  + " and paste it under CTO settings, Voice.";
const CTO_VOICE_NO_CREDIT_MESSAGE =
  "Your OpenAI account has no credit for voice calls. Add billing at platform.openai.com.";

/** What an `error` event turned out to be about. */
export type CtoVoiceServerErrorKind = "expired_key" | "rejected_key" | "no_credit" | "other";

export type CtoVoiceServerErrorReason = {
  /** One line for the HUD. OpenAI's own words unless we have better ones. */
  message: string;
  kind: CtoVoiceServerErrorKind;
  /** True when the session cannot recover, so the call ends rather than limps. */
  fatal: boolean;
};

/**
 * Errors this service caused and can ignore.
 *
 * Both are races around one in-flight response: a barge-in that cancels a
 * response the server has already finished, and a `response.create` that
 * crosses a `response.done` on the wire. Neither is anything the user can act
 * on, and putting "Cancellation failed: no active response" on screen mid-call
 * would be worse than saying nothing.
 *
 * It does mean this list can hide a real defect, and once did: a `response.cancel`
 * with no `response_id` is answered with exactly that message, because it looks
 * for a response in the default conversation and every response here is
 * out-of-band. Every barge-in failed, silently, and the CTO talked on. Cancels
 * are named now (`stopSpeaking`), so the message can only be the race again.
 */
const CTO_VOICE_BENIGN_SERVER_ERRORS: readonly RegExp[] = [
  /no active response/i,
  /already has an active response/i,
];

/**
 * Turn an `error` event into the sentence the user needs.
 *
 * This is the half of the diagnosis the old code threw away. A rejected upgrade
 * never carries OpenAI's explanation — the handshake fails before there is a
 * session to explain anything — but an upgrade that SUCCEEDS and then fails
 * does: the reason arrives as an `error` event, and its message is the truth.
 * "Your API key has expired." is a different problem from "Incorrect API key",
 * which is a different problem again from an account with no credit, and each
 * has a different fix.
 *
 * Anything we do not recognise is passed through in OpenAI's own words rather
 * than replaced with a house sentence: a message we cannot classify is still a
 * message someone wrote to be read, and guessing at it is what hid this bug for
 * a whole release.
 *
 * Pure, so the mapping is testable without a socket.
 */
export function describeCtoVoiceServerError(
  error: { message?: unknown; code?: unknown; type?: unknown } = {},
): CtoVoiceServerErrorReason {
  const raw = typeof error.message === "string" ? error.message : "";
  const code = typeof error.code === "string" ? error.code : "";
  const type = typeof error.type === "string" ? error.type : "";
  const haystack = `${raw} ${code} ${type}`.toLowerCase();
  const oneLine = raw.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length) ?? "";

  if (/expired/.test(haystack)) {
    return { message: CTO_VOICE_EXPIRED_KEY_MESSAGE, kind: "expired_key", fatal: true };
  }
  // Before the key check: "You exceeded your current quota, please check your
  // plan and billing details" is about the account, not about the key, and
  // sending the user to re-paste a working key would waste their afternoon.
  if (/quota|billing|insufficient_quota|payment|no credit/.test(haystack)) {
    return { message: CTO_VOICE_NO_CREDIT_MESSAGE, kind: "no_credit", fatal: true };
  }
  // Deliberately narrow. A bare /invalid/ also matches "Invalid value: 'x' for
  // session.audio.output.voice", and telling someone their key is bad when a
  // parameter is bad sends them to the one place the problem is not.
  const rejectedKey = /incorrect api key|invalid api key|invalid_api_key|invalid authentication/
    .test(haystack)
    || /\binvalid\b[^.\n]*\bkey\b/.test(haystack)
    || /\bkey\b[^.\n]*\binvalid\b/.test(haystack);
  if (rejectedKey) {
    return { message: CTO_VOICE_REJECTED_KEY_MESSAGE, kind: "rejected_key", fatal: true };
  }
  return {
    message: oneLine.length ? oneLine : "The voice session reported an error.",
    kind: "other",
    fatal: false,
  };
}

/** True for the two errors this service's own timing can cause. */
export function isBenignCtoVoiceServerError(message: string): boolean {
  return CTO_VOICE_BENIGN_SERVER_ERRORS.some((pattern) => pattern.test(message));
}

/**
 * How long one microphone frame lasts, read off the frame itself.
 *
 * Derived from the payload rather than from a clock on purpose. The wall-clock
 * gap between `speech_started` and `speech_stopped` is the SERVER's opinion,
 * delivered a network round trip late and padded by its own VAD, so it says
 * nothing reliable about how long the user's mouth was open. The bytes do: PCM16
 * mono at the session rate is two bytes a sample, and the frames are the same
 * audio the transcriber was given.
 *
 * Exported because the arithmetic is the load-bearing part of the length half of
 * the transcript gate, and it is worth a test of its own.
 */
export function ctoVoiceFrameDurationMs(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const bytes = Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
  return (bytes / 2) * (1_000 / CTO_VOICE_SAMPLE_RATE);
}

/**
 * How a CTO turn ended, as the call has to tell the model about it.
 *
 * The turn's own verdict, never guessed from its text: a failed turn's
 * `outputText` is the provider's error sentence, and relaying that is how the
 * CTO once read "Prompt is too long" out loud in its own voice.
 */
export type CtoVoiceBackendStatus = "completed" | "interrupted" | "failed";

export type CtoVoiceBackendResult = {
  /** The answer, for a turn that completed. Empty for every other status. */
  spoken: string;
  /** Defaults to `completed` for a host that does not report one. */
  status?: CtoVoiceBackendStatus;
  /**
   * One plain sentence for a turn that did not answer.
   *
   * A house sentence, never the provider's error text: this is relayed to the
   * user through the model, and the model will happily read a stack trace.
   */
  reason?: string;
  /**
   * Milliseconds from the backend turn starting to its first token of text.
   *
   * Reported by whoever ran the turn, because only that side is watching the
   * thread's event stream. It is the difference between "the model is slow" and
   * "ADE spent a second getting to the model", and those have different fixes.
   */
  firstTextMs?: number;
  /** Tool calls the turn made. The other half of "why did that take five seconds". */
  toolCalls?: number;
  /**
   * A scene the turn drew, lifted out of the answer's one `scene` fence.
   *
   * The HUD renders it in the same sandbox the transcript uses, so a view drawn
   * during a call and a view drawn in a chat turn are the same thing.
   */
  sceneSource?: string | null;
};

/**
 * One approval on the CTO thread, as the call needs to hear about it.
 *
 * `destructive` is decided by whoever watched the event, because only they can
 * see the command text — the tool name on its own cannot tell a force-push from
 * a `git status`.
 */
export type CtoVoiceApprovalNotice = {
  itemId: string;
  toolName: string;
  prompt: string;
  destructive?: boolean;
};

export type CtoVoiceCallDeps = {
  /** Resolved once per call; absent means the feature is not configured. */
  getApiKey: () => Promise<string | null>;
  ctoName: () => string;
  projectName: () => string;
  /**
   * "Say what it's doing": whether the model acknowledges before `ask_cto`.
   *
   * It used to gate one unconditional filler ("Let me check that.") spoken at
   * the top of every turn, which meant the user heard it before "Hello" too.
   * The filler is gone; the setting now goes into the session prompt, where the
   * model that can actually see the question decides the sentence and is told
   * to vary it. A fixed phrase before every answer is worse than a beat of
   * silence.
   */
  backchannelsEnabled: () => boolean;
  voice?: () => CtoVoiceName;
  /**
   * Everything the model may answer from without asking the CTO.
   *
   * Async because it reads the lane list, and re-read after every completed
   * `ask_cto`: a call that has just created a lane must not still be told there
   * are nine. Optional — a call with no context block still works, it just asks
   * the CTO more often.
   */
  context?: () => Promise<string>;
  /**
   * Run the user's intent on the CTO thread. Injected so this service never
   * imports the chat service, and so the turn loop is testable without a model.
   */
  runBackendTurn: (args: {
    intent: string;
    callId: string;
    signal: AbortSignal;
    /**
     * A window the user captured mid-call, base64 PNG. It goes to the CTO
     * thread, never to the realtime model: the realtime model is ears and a
     * mouth, so the only place an image can actually be read is the backend
     * that does the thinking.
     */
    imageBase64?: string | null;
  }) => Promise<CtoVoiceBackendResult>;
  /** Called once when the call ends, with the full transcript. */
  persistCall: (args: {
    callId: string;
    startedAt: string;
    endedAt: string;
    captions: CtoVoiceCaption[];
    costUsd: number;
  }) => Promise<void>;
  /**
   * Put the CTO in confirm-first mode for the life of the call.
   *
   * A call shares the CTO's one session and there is no per-turn permission
   * argument, so the guarantee that a spoken word cannot reach a writing tool
   * has to be held open for the whole call and released on hang-up.
   */
  setCallConfirmMode?: (confirmFirst: boolean) => Promise<void>;
  /**
   * Answer an approval the CTO's turn is blocked on.
   *
   * The turn is still running when the user says yes — the gate is a promise
   * inside `canUseTool`, not a return value — so the decision has to go back
   * out of band and let the same turn carry on.
   */
  resolveApproval?: (args: { itemId: string; approved: boolean }) => Promise<void>;
  /**
   * Subscribe to the CTO thread's approvals for the life of the call.
   *
   * Returns its own unsubscribe. The service owns the subscription's lifetime
   * because a watcher outliving its call would raise confirmations into a HUD
   * that is no longer on screen.
   */
  watchApprovals?: (
    onApproval: (args: CtoVoiceApprovalNotice) => void,
  ) => () => void;
  onState: (state: CtoVoiceState) => void;
  /** One chunk of output audio, base64 PCM16, for the renderer to play. */
  onOutputAudio?: (base64: string) => void;
  /**
   * The call's exchange count moved, or the call ended.
   *
   * An exchange is one ACCEPTED user turn — a rejected transcript is not one,
   * because nothing was exchanged. Raised so the CTO row's status line can track
   * a live call instead of describing the first thing that was said; `live:
   * false` is the final, truthful line.
   */
  onExchange?: (args: { exchanges: number; live: boolean }) => void;
  /**
   * The clock, injected so the burst valve's window and cooldown are testable
   * without waiting eight real seconds.
   */
  now?: () => number;
  logger?: { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void };
  /** Injected for tests; defaults to a real ws client. */
  createWebSocket?: (url: string, apiKey: string) => CtoVoiceSocket;
};

/**
 * Hand the rejected upgrade's status up, and only THEN release the socket.
 *
 * The order is the whole function. Destroying the request makes `ws` emit
 * `error` synchronously — "WebSocket was closed before the connection was
 * established" — and that error knows nothing about the 401 it was caused by.
 * Releasing first therefore let the generic sentence win the race against the
 * one the user needs, which is how a rejected key came back as "The voice
 * connection failed." The status is reported, described and latched before
 * anything is torn down; the destroy afterwards only frees the socket `ws`
 * hands to a listener and will not otherwise clean up.
 */
export function forwardUnexpectedResponse(
  handler: (payload?: unknown) => void,
  request: { destroy?: () => void } | null | undefined,
  response: { statusCode?: number | null } | null | undefined,
): void {
  try {
    handler({ statusCode: response?.statusCode ?? null });
  } finally {
    try {
      request?.destroy?.();
    } catch {
      // The handshake is already over; this only releases the socket.
    }
  }
}

function defaultSocket(url: string, apiKey: string): CtoVoiceSocket {
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    on: (event, handler) => {
      if (event === "unexpected-response") {
        // `ws` hands the listener (request, response); only the status matters,
        // and taking a listener here is also what stops it collapsing the
        // response into a bare `Error: Unexpected server response: NNN`.
        socket.on("unexpected-response", (request, response) => {
          forwardUnexpectedResponse(handler, request, response);
        });
        return;
      }
      socket.on(event, handler as (...args: unknown[]) => void);
    },
  };
}

export function createCtoVoiceCallService(deps: CtoVoiceCallDeps) {
  let socket: CtoVoiceSocket | null = null;
  /**
   * True only between `open` and the end of the socket's life.
   *
   * `ws` throws synchronously on `send` while the handshake is still in flight
   * ("WebSocket is not open: readyState 0 (CONNECTING)"), and the microphone
   * starts producing frames the moment the HUD mounts — which is the whole
   * window between Talk being pressed and OpenAI answering. Every send below is
   * gated on this rather than on `socket` being non-null, because a socket that
   * exists is not a socket that will accept anything.
   */
  let socketOpen = false;
  /**
   * True while WE are closing the socket on purpose.
   *
   * `ws` reports a close of a still-CONNECTING socket as
   * "WebSocket was closed before the connection was established" — an error
   * that looks exactly like a connection that failed on its own. Describing it
   * as one blamed OpenAI for a hang-up ADE asked for, which is how a call ended
   * by the renderer 144 ms in came back as "The voice connection failed."
   */
  let deliberateClose = false;
  /**
   * Mic frames captured before the session existed.
   *
   * Dropped rather than replayed past this bound: the first second of speech is
   * worth keeping, an unbounded queue against a socket that never opens is not.
   */
  let pendingInputAudio: string[] = [];
  /**
   * True from the moment `start` commits to a call until `endCall` tears it
   * down — NOT "is the socket open".
   *
   * Tearing down on the socket alone missed the window between `connecting` and
   * the socket existing, which is exactly where a call dies most often: the
   * renderer opens the microphone on `connecting`, and a denied microphone
   * calls `end()` straight away. `endCall` returned at its socket check, the
   * read-only hold was never released, and the CTO stayed unable to write for
   * the life of the process.
   */
  let started = false;
  /** Detaches the approval watcher when the call ends. */
  let releaseApprovalWatch: (() => void) | null = null;
  let keepAlive: NodeJS.Timeout | null = null;
  let startedAtMs = 0;
  let startedAtIso = "";

  let state: CtoVoiceState = { ...CTO_VOICE_INITIAL_STATE };

  /**
   * The utterance being transcribed right now.
   *
   * One record, because it is one thing. The id turns over when a NEW utterance
   * OPENS — on `input_audio_buffer.speech_started` — and never when one
   * finishes. A confirmation raised after the transcript closed would otherwise
   * be bound to the id the user's NEXT reply carries, and the "same utterance"
   * guard would reject every spoken yes forever.
   *
   * `text` survives completion for the same reason — a turn for this utterance
   * may still be in flight — and is cleared when a turn consumes it or a new
   * utterance opens, so a reply that never reached the CTO cannot glue onto the
   * front of a later intent.
   */
  let utterance = { id: randomUUID(), text: "", open: false, consumed: false };

  /** Cleared as soon as it is handed to a turn — one capture, one turn. */
  let pendingImage: string | null = null;

  /**
   * True once OpenAI has answered with a session, so the call is live.
   *
   * Three events can be the first to say so and only the first one counts —
   * the clock the cost is billed from must not restart on `session.updated`.
   */
  let sessionReady = false;

  /** The context block for this call's first `session.update`. Refreshed later. */
  let sessionContext = "";

  /**
   * True from `response.create` until the response that answered it is over.
   *
   * The Realtime API allows exactly one response at a time: a second
   * `response.create` while one is generating is answered with an error, not
   * with speech. Set on the send rather than on `response.created`, because the
   * two sends that race are both ours and both synchronous — the filler and the
   * answer it covers for.
   */
  let responseActive = false;

  /**
   * Responses ADE has asked for and the socket has not got to yet.
   *
   * Two kinds, and the difference is the whole of note 3 at the top of this
   * file. An `ade` entry is a line ADE wrote and needs read word for word, so it
   * is created OUT-OF-BAND with the text as its instruction. A `model` entry
   * asks the model to speak for itself with the conversation in front of it,
   * which is what a function result needs — it cannot relay an answer to a call
   * it cannot see.
   */
  type QueuedResponse = { kind: "ade"; text: string } | { kind: "model" };
  let responseQueue: QueuedResponse[] = [];

  /**
   * True when the response in flight is one ADE created out-of-band.
   *
   * Barge-in is split now: the server truncates its OWN response, because the
   * session is configured with `interrupt_response: true`. Cancelling one of
   * those from here as well races the server's truncation and comes back as an
   * error. Only a response ADE created is ADE's to cancel.
   */
  let activeResponseIsOurs = false;
  /** Set on the send, read on `response.created`: the two are a round trip apart. */
  let pendingOurResponse = false;

  /**
   * The user talked over the response that is generating right now.
   *
   * Read when its transcript arrives: a truncated response still reports the
   * words it managed to say, and without this the call record claims that half
   * sentence was the whole of what the CTO said.
   */
  let activeResponseInterrupted = false;

  /**
   * When the audio handed to the renderer so far finishes playing, in wall
   * clock.
   *
   * A playback clock rather than a byte count: chunks arrive faster than
   * realtime, so the tail of a sentence is still unspoken long after its last
   * chunk was emitted. Each chunk extends the later of "now" and the previous
   * deadline by its own duration, which is exactly how the renderer's queue
   * plays it.
   */
  let outputAudioDeadlineMs = 0;

  /** The model called `end_call`; the call hangs up once its goodbye is heard. */
  let endAfterSpeech = false;
  let endAfterSpeechTimer: NodeJS.Timeout | null = null;

  /**
   * The `ask_cto` running right now, and the controller that stops it.
   *
   * One at a time, because the CTO thread is one session: a second turn on it
   * throws. What happens to a second request is the MODEL's call, carried on
   * the tool's `mode` argument — `replace` stops the running one, `queue` waits
   * for it — and the two are served by one serial drain loop below, which is
   * also what makes a replace safe: the next turn is only started after the
   * aborted one's `runBackendTurn` has actually returned.
   */
  let askCtoAbort: AbortController | null = null;
  let askCtoRunning = false;

  /** A request the model made, and the timing record it was accepted under. */
  type AskCtoJob = { callId: string; request: string; timing: CtoVoiceTurnTiming };
  /** Requests waiting behind the running one, in the order they were asked. */
  let askQueue: AskCtoJob[] = [];
  /** True while `drainAskQueue` owns the loop, so nothing starts a second one. */
  let askDraining = false;

  /**
   * Function calls already dispatched, by `call_id`.
   *
   * The same call arrives twice: once inside `response.done`'s output list and
   * once as `response.function_call_arguments.done`. Both are handled — one
   * socket's vocabulary is not a thing to guess at — so the id is what stops a
   * request running twice.
   */
  const handledFunctionCalls = new Set<string>();

  /**
   * Calls dispatched before the response that made them was finished.
   *
   * `response.function_call_arguments.done` arrives first, which is worth
   * having on a five-second turn — but the conversation has not written the
   * call yet, so its result has to wait for `response.done`.
   */
  const unsettledFunctionCalls = new Set<string>();

  /**
   * Function results that cannot be sent yet.
   *
   * See `sendFunctionOutput`: a result may only be written once the response
   * that asked for it is finished, and the fast tools answer before it is.
   */
  let pendingFunctionOutputs: Array<{
    callId: string;
    output: Record<string, unknown>;
    speakResult: boolean;
  }> = [];

  /**
   * Confirmations already answered, by id.
   *
   * A spoken "yes" reaches this service twice now: the transcript parser reads
   * it, and the model reads the same word and calls `approve_pending_action`.
   * Whichever lands first wins; the second must be a no-op rather than a second
   * `approveToolUse` on a gate that is already open.
   */
  const resolvedConfirmations = new Set<string>();

  /**
   * The id of the response that is generating right now, once the server has
   * named it.
   *
   * A bare `response.cancel` only cancels an in-progress response in the DEFAULT
   * conversation, and every response this service asks for is out-of-band — so
   * without the id, a barge-in sent the cancel into an empty conversation and
   * the CTO kept talking over the user. The id arrives on `response.created`.
   */
  let activeResponseId: string | null = null;

  /**
   * A barge-in that arrived before the server named the response.
   *
   * `response.create` and `response.created` are a round trip apart, and the
   * user can talk inside it. Dropping the cancel there would leave the very
   * interruption a call most needs to honour unheard, so it is remembered and
   * sent the moment the id lands.
   */
  let cancelWhenNamed = false;

  const now = deps.now ?? (() => Date.now());

  /**
   * What ADE's OWN microphone heard, frame by frame, in the recent past.
   *
   * A ring rather than a set of running totals, and that is the fix for a real
   * failure: totals were only ever cleared by a judgement, so the first
   * transcript of a call was judged against every frame since the microphone
   * opened. Fifteen seconds of a quiet room contains enough scattered noisy
   * frames to add up to 240 ms, and a phantom "好" walked through a gate that
   * was running. Frames older than {@link CTO_VOICE_MIC_WINDOW_MS} are dropped,
   * so the evidence is always about the recent past — bounded by the window
   * rather than by the length of the call.
   *
   * The reset window is still deliberately NOT `speech_started`..`speech_stopped`.
   * Server VAD reports a segment after the fact and with its own prefix padding,
   * so frames that belong to the user's first syllable arrive before the server
   * admits the segment opened; resetting on `speech_started` threw exactly those
   * away and would have rejected short real answers. Resetting on a JUDGEMENT —
   * one transcript, one verdict, one reset — keeps the pre-roll, and the window
   * above stops one utterance's silence vouching for the next one's words.
   */
  type CtoVoiceMicFrame = {
    /** When it arrived, on the service's own clock. */
    at: number;
    /** 0..1 peak of that frame, as the renderer measured it. */
    level: number;
    /** How long it lasts, read off its own bytes. */
    ms: number;
    /** True when ADE was not speaking, which is what tells a person from an echo. */
    idle: boolean;
  };
  let micFrames: CtoVoiceMicFrame[] = [];
  const resetMic = () => { micFrames = []; };

  /** Drop everything that fell out of the window. Called on every write and read. */
  const trimMic = (at: number) => {
    const cutoff = at - CTO_VOICE_MIC_WINDOW_MS;
    let drop = 0;
    while (drop < micFrames.length && micFrames[drop]!.at <= cutoff) drop += 1;
    if (drop > 0) micFrames = micFrames.slice(drop);
  };

  /**
   * The meter, as the gate reads it.
   *
   * `voicedMs` is the longest CONTIGUOUS run of above-threshold frames, not the
   * sum of them: a sum cannot tell a spoken word from three unrelated clicks a
   * second apart, because the frames only have to add up. A word is energy that
   * stays up, so the run is what gets measured.
   */
  const readMic = () => {
    trimMic(now());
    let peak = 0;
    let framesWhileIdle = 0;
    let run = 0;
    let voicedMs = 0;
    for (const frame of micFrames) {
      peak = Math.max(peak, frame.level);
      if (frame.idle) framesWhileIdle += 1;
      if (frame.level >= CTO_VOICE_MIN_SPEECH_PEAK_LEVEL) {
        run += frame.ms;
        voicedMs = Math.max(voicedMs, run);
      } else {
        run = 0;
      }
    }
    return { peak, voicedMs, frames: micFrames.length, framesWhileIdle };
  };

  /**
   * When each accepted turn was accepted, inside the burst window.
   *
   * Trimmed to the window on every read, so this is bounded by the rate a
   * transcript source can physically produce transcripts rather than by the
   * length of the call.
   */
  let acceptedTurnsAtMs: number[] = [];
  /** When the last transcript of any kind arrived — the cooldown is measured off it. */
  let lastTranscriptAtMs = 0;
  /** Set while the burst valve is shut. Nothing is accepted until quiet clears it. */
  let burstValveTripped = false;
  /** Accepted user turns this call has had. The number the status line reports. */
  let exchanges = 0;

  /**
   * When the server last said the user stopped talking.
   *
   * The first leg of the latency the user actually feels, and the only one
   * nothing else records: the transcriber's own round trip. Reset per segment,
   * so a transcript with no `speech_stopped` behind it reports no leg rather
   * than one measured against a minute-old event.
   */
  let speechStoppedAtMs = 0;

  /**
   * One turn's latency, filled in as the turn passes each post.
   *
   * Held rather than logged at the end, because the last leg — the first audio
   * the user hears — arrives after the turn is over. `writeTurnTiming` writes
   * the line at whichever comes first: that audio, the turn's own verdict, or
   * the call ending, so a turn that never made a sound is still measured.
   */
  type CtoVoiceTurnTiming = {
    speechStoppedToTranscriptMs: number | null;
    acceptedAtMs: number;
    turnStartedAtMs: number | null;
    backendDoneAtMs: number | null;
    firstTextMs: number | null;
    firstSpeakAtMs: number | null;
    toolCalls: number;
  };
  /**
   * The accepted transcript that has not reached a turn yet.
   *
   * One slot, because one transcript is accepted at a time. A turn TAKES this
   * record when the model's request is dispatched and then owns it for the rest
   * of its life — which is what stops the next transcript closing a record that
   * belongs to work still running. The live call of 2026-09-16 wrote
   * `outcome: "abandoned"` for a request the CTO was still working on twenty-five
   * seconds later, purely because the user said something else in the meantime.
   */
  let pendingTiming: CtoVoiceTurnTiming | null = null;

  /**
   * The record whose answer has been handed over and is waiting to be heard.
   *
   * Separate from `pendingTiming` because the last leg — the first audio the
   * user hears — arrives after the turn is over, and by then the next utterance
   * may already have opened a record of its own.
   */
  let speakingTiming: CtoVoiceTurnTiming | null = null;

  const newTurnTiming = (
    acceptedAtMs: number,
    speechStoppedToTranscriptMs: number | null = null,
  ): CtoVoiceTurnTiming => ({
    speechStoppedToTranscriptMs,
    acceptedAtMs,
    turnStartedAtMs: null,
    backendDoneAtMs: null,
    firstTextMs: null,
    firstSpeakAtMs: null,
    toolCalls: 0,
  });

  /**
   * Write one turn's timing line.
   *
   * Every leg is optional on purpose: an interrupted turn has no answer, a
   * failed one has no audio, and a line that only appears for the happy path
   * cannot tell you which turns were slow.
   */
  const writeTurnTiming = (
    timing: CtoVoiceTurnTiming,
    outcome: string,
    firstAudioAtMs: number | null,
  ): void => {
    const since = (from: number | null, to: number | null): number | null =>
      from === null || to === null ? null : Math.round(to - from);
    deps.logger?.info("cto_voice.turn_timing", {
      callId: state.callId,
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

  /**
   * Close whichever record the audio now playing belongs to.
   *
   * The answer being spoken first, then the transcript the model answered for
   * itself — that second case is the whole point of the hybrid and its
   * `totalMs` is the number it exists to move.
   */
  const flushSpokenTiming = (firstAudioAtMs: number): void => {
    if (speakingTiming) {
      const timing = speakingTiming;
      speakingTiming = null;
      writeTurnTiming(timing, "spoken", firstAudioAtMs);
      return;
    }
    if (!pendingTiming) return;
    const timing = pendingTiming;
    pendingTiming = null;
    writeTurnTiming(timing, "spoken", firstAudioAtMs);
  };

  /** The post the audio leg is measured from, on whichever record is next up. */
  const markFirstSpeak = (): void => {
    const timing = speakingTiming ?? pendingTiming;
    if (timing && timing.firstSpeakAtMs === null) timing.firstSpeakAtMs = now();
  };

  const emit = (patch: Partial<CtoVoiceState>) => {
    state = { ...state, ...patch };
    deps.onState(state);
  };

  const setPhase = (phase: CtoVoicePhase) => emit({ phase });

  /**
   * The connection died. Say which way, once.
   *
   * A rejected upgrade can reach us twice — through `unexpected-response` and
   * again through `error` — and the second arrival knows less than the first,
   * so it must not overwrite "OpenAI rejected this key" with the generic line.
   */
  /**
   * Why the connection died, in two words rather than a sentence.
   *
   * The sentence the user reads names a provider and a settings pane; the
   * product question is only "was the key refused, or could we not reach
   * OpenAI at all". Recorded here because this is the one place the HTTP status
   * exists.
   */
  let connectionFailureKind: "rejected_key" | "connection_failed" | null = null;
  let connectionFailed = false;
  const failConnection = (failure: CtoVoiceSocketFailure, event: string): void => {
    const reason = describeCtoVoiceSocketFailure(failure);
    deps.logger?.warn(event, {
      status: reason.status,
      code: reason.code,
      ...(connectionFailed ? { suppressed: true } : {}),
      ...(deliberateClose ? { deliberate: true } : {}),
      ...(failure.message ? { error: failure.message } : {}),
    });
    // Whatever explained the failure first knew the most. Tearing the socket
    // down is itself reported as an error ("closed before the connection was
    // established"), so the follow-on is logged for the trace and then does
    // nothing at all — and a close WE asked for is never a failure to begin
    // with, whether or not anything had failed before it.
    if (deliberateClose || connectionFailed) return;
    connectionFailed = true;
    connectionFailureKind = reason.status === 401 || reason.status === 403
      ? "rejected_key"
      : "connection_failed";
    emit({ phase: "failed", error: reason.message });
  };

  const send = (payload: Record<string, unknown>) => {
    // Not "is there a socket" — "will it take this". A pre-open send throws,
    // and it used to throw once per microphone frame.
    if (!socket || !socketOpen) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch (error) {
      deps.logger?.warn("cto_voice.send_failed", { error: String(error) });
    }
  };

  const addCaption = (role: "user" | "assistant", text: string, interrupted = false) => {
    if (!text.trim().length) return;
    const caption: CtoVoiceCaption = {
      role,
      text: text.trim(),
      atMs: now() - startedAtMs,
      // Only when it is true: an absent flag is what every ordinary caption
      // carries, and a `false` on every one of them would be two hundred extra
      // fields in the persisted transcript to say nothing happened.
      ...(interrupted ? { interrupted: true } : {}),
    };
    emit({ captions: [...state.captions, caption].slice(-200) });
  };

  /**
   * Say this, out loud, exactly. ADE's own words, not the CTO's answer.
   *
   * There is no "say this" event in the Realtime API. What there is is
   * `response.create` with per-response `instructions`, which is the documented
   * way to steer one response — so the sentence is handed over as that
   * response's instruction, fenced, with `output_modalities: ["audio"]`.
   *
   * It goes out OUT-OF-BAND (`conversation: "none"` with an empty `input`), and
   * that is the load-bearing part. A response created inside the default
   * conversation is generated with the user's audio items in front of it, and
   * the model treats "read this text" as one more note next to a real question
   * it can see — so it answers the question instead. Measured against the live
   * API on 2026-09-16: in-conversation, the first exchange of a call read the
   * text back correctly and every exchange after it was hijacked (6 of 8
   * requested sentences per run, identically in three runs — "I'm ChatGPT",
   * an offer to review a pull request it knows nothing about). Out-of-band the
   * same script read the text word for word 24 times out of 24.
   *
   * Reserved for the lines that are ADE speaking rather than the CTO answering:
   * the confirmation question a blocked tool raised, the echo before an
   * approval runs, and "Sorry — I didn't catch that". A CTO answer takes the
   * other path — see `speakFunctionResult`.
   *
   * Queued rather than sent when a response is already in flight, because a
   * second one is an error rather than a second sentence.
   */
  const speak = (content: string) => {
    const text = content.trim();
    if (!text.length) return;
    // The post the audio leg is measured from: the queue may hold this behind
    // another response, and that wait is part of what the user is waiting for.
    markFirstSpeak();
    responseQueue.push({ kind: "ade", text });
    drainResponses();
  };

  /**
   * Ask the model to speak for itself, with the conversation in front of it.
   *
   * The opposite of `speak`, and deliberately so. This is what follows a
   * `function_call_output`: the model has to SEE the call it made and the
   * result that came back in order to relay the answer in context, so an
   * out-of-band response — which is generated with no conversation at all —
   * would produce a sentence about nothing.
   */
  const requestModelResponse = () => {
    // The post the audio leg is measured from. The queue may hold this behind
    // a response already in flight, and that wait is part of what the user is
    // waiting for.
    markFirstSpeak();
    // A second one buys nothing: the model reads everything in the conversation
    // when it generates, so two queued responses would say the same thing twice.
    if (responseQueue.some((entry) => entry.kind === "model")) return;
    responseQueue.push({ kind: "model" });
    drainResponses();
  };

  const drainResponses = () => {
    if (responseActive || !socketOpen) return;
    const next = responseQueue.shift();
    if (next === undefined) return;
    responseActive = true;
    if (next.kind === "ade") {
      pendingOurResponse = true;
      send({
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
    pendingOurResponse = false;
    // No `response` object at all: the default is the conversation itself, and
    // the session's own instructions and modalities already apply.
    send({ type: "response.create", event_id: randomUUID() });
  };

  /** A response ended, however it ended. Let the next one through. */
  const releaseResponse = () => {
    responseActive = false;
    // The id belongs to the response that just ended, and a cancel waiting for
    // an id that will never arrive would fire at whatever is generated next.
    activeResponseId = null;
    activeResponseIsOurs = false;
    pendingOurResponse = false;
    cancelWhenNamed = false;
    drainResponses();
  };

  /**
   * Silent context: recorded in the conversation, never read out.
   *
   * A `system` item is added to the history and nothing more — no response is
   * created for it, so nothing is spoken. It is what a mid-call capture leaves
   * behind, so the conversation on OpenAI's side says a window was shared even
   * though the image itself only ever goes to the CTO thread.
   */
  const think = (content: string) => {
    const text = content.trim();
    if (!text.length) return;
    send({
      type: "conversation.item.create",
      event_id: randomUUID(),
      item: { type: "message", role: "system", content: [{ type: "input_text", text }] },
    });
  };

  /**
   * Stop the audio the user is talking over.
   *
   * Only the audio, and only OUR audio. The session runs with
   * `interrupt_response: true`, so a response the SERVER created is truncated by
   * the server the moment it hears speech — sending our own cancel at it as
   * well races that truncation and comes back as "no active response". A
   * response ADE created out-of-band is invisible to that mechanism (it is not
   * in the conversation), so it is the one thing left for us to cancel.
   */
  const stopSpeaking = () => {
    // Anything ADE queued and has not sent is about a moment that has passed.
    responseQueue = responseQueue.filter((entry) => entry.kind !== "ade");
    if (!responseActive) return;
    // `pendingOurResponse` covers the round trip between asking for a response
    // and the server naming it — the window the user can talk inside, and the
    // one a barge-in most often lands in.
    if (!activeResponseIsOurs && !pendingOurResponse) return;
    // Named explicitly: our responses are out-of-band, and a cancel with no
    // `response_id` is only understood as "cancel the default conversation's
    // response" — which is never one of ours.
    if (activeResponseId) {
      send({ type: "response.cancel", event_id: randomUUID(), response_id: activeResponseId });
      return;
    }
    cancelWhenNamed = true;
  };

  /**
   * Hand a function's result back and, when it is worth hearing, let the model
   * speak about it.
   *
   * `speakResult: false` is for the results nobody is waiting on: an `ask_cto`
   * that was superseded or cancelled still has to answer its call — an
   * unanswered `function_call` sits in the conversation forever and the model
   * keeps referring to it — but asking for a response about it would have the
   * model narrate a question the user has already moved past.
   */
  const sendFunctionOutput = (
    callId: string,
    output: Record<string, unknown>,
    speakResult = true,
  ) => {
    // Never while the response that MADE this call is still generating. An
    // output naming a `call_id` the conversation has not finished writing is
    // refused, and that is exactly the case for a call dispatched off
    // `response.function_call_arguments.done` — a beat before its own
    // `response.done`. Any other response being in flight is irrelevant: a
    // conversation item is appended, not generated.
    if (unsettledFunctionCalls.has(callId)) {
      pendingFunctionOutputs.push({ callId, output, speakResult });
      return;
    }
    send({
      type: "conversation.item.create",
      event_id: randomUUID(),
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) },
    });
    if (speakResult) requestModelResponse();
  };

  /** Hand over everything that was waiting for the response to finish. */
  const flushFunctionOutputs = () => {
    const waiting = pendingFunctionOutputs;
    pendingFunctionOutputs = [];
    for (const entry of waiting) {
      send({
        type: "conversation.item.create",
        event_id: randomUUID(),
        item: {
          type: "function_call_output",
          call_id: entry.callId,
          output: JSON.stringify(entry.output),
        },
      });
      if (entry.speakResult) requestModelResponse();
    }
  };

  /**
   * Re-send the context block.
   *
   * Cheap (one `session.update`, no audio, no response) and worth it after
   * every completed `ask_cto`: the facts in that block are exactly the ones a
   * turn is most likely to have just changed, and a model answering "nine
   * lanes" straight after creating the tenth is worse than one that asks.
   */
  const refreshSessionContext = async () => {
    if (!deps.context || !socketOpen) return;
    try {
      const context = await deps.context();
      if (!socketOpen) return;
      send({
        type: "session.update",
        event_id: randomUUID(),
        session: {
          type: "realtime",
          instructions: buildCtoVoiceInstructions({
            ctoName: deps.ctoName(),
            projectName: deps.projectName(),
            context,
            acknowledgeAloud: deps.backchannelsEnabled(),
          }),
        },
      });
    } catch (error) {
      // A stale context block is a worse answer, not a broken call.
      deps.logger?.warn("cto_voice.context_refresh_failed", { error: String(error) });
    }
  };

  /**
   * Take the next request off the queue and run it, until the queue is empty.
   *
   * Serial by construction, and that is the fix for the bug that lost two
   * requests on the live call of 2026-09-16: the next turn cannot start until
   * the previous `runBackendTurn` has RETURNED, so a replace can never reach
   * `runSessionTurn` while the turn it aborted is still unwinding on the one
   * CTO session ("Session already has an active background turn"). Awaiting the
   * interrupt promise was not enough — that resolves when the interrupt is
   * asked for, not when the turn it interrupts is over.
   */
  async function drainAskQueue(): Promise<void> {
    if (askDraining || askCtoRunning) return;
    askDraining = true;
    try {
      for (;;) {
        const next = askQueue.shift();
        if (!next) return;
        await runAskCto(next);
      }
    } finally {
      askDraining = false;
    }
  }

  /**
   * One request from the model, placed according to the mode it chose.
   *
   * The mode is the model's judgement and nothing here second-guesses it: only
   * whoever heard both sentences can tell "no wait, I meant the merged ones"
   * from "also, run the tests".
   */
  function scheduleAskCto(job: AskCtoJob, mode: "replace" | "queue"): void {
    // A question ADE asked out loud is waiting for an answer, and the turn that
    // raised it is parked inside `canUseTool` on the one CTO session. Starting a
    // second turn there would collide with it.
    if (state.pendingConfirmation) {
      writeTurnTiming(job.timing, "refused", null);
      sendFunctionOutput(job.callId, {
        status: "busy",
        answer: "",
        reason: "ADE is still waiting for the user to approve or decline the pending action.",
      });
      return;
    }

    if (!askCtoRunning) {
      askQueue.push(job);
      void drainAskQueue();
      return;
    }

    // The cap is the conversation's, not the queue's: a third request stacked
    // behind two is one the user has stopped waiting for. Replace is capped the
    // same way — it is still a request that has to be answered in order.
    if (askQueue.length >= CTO_VOICE_ASK_QUEUE_LIMIT) {
      writeTurnTiming(job.timing, "refused", null);
      sendFunctionOutput(job.callId, {
        status: "busy",
        answer: "",
        reason: "Two requests are already waiting. Tell the user you will come back to this one.",
      });
      return;
    }

    if (mode === "replace") {
      // At the FRONT, then stop what is running: the drain loop owns the order,
      // so the correction is the very next thing to run and anything queued
      // behind it keeps its place.
      askQueue.unshift(job);
      abortRunningAsk();
      return;
    }
    askQueue.push(job);
  }

  /**
   * Run one request on the CTO thread and hand the answer back to the model.
   *
   * This is the seam. Everything the call can actually DO happens on the other
   * side of it, on the CTO's own session with its own model, memory and tools —
   * the realtime model only ever asks.
   */
  async function runAskCto(job: AskCtoJob): Promise<void> {
    const { callId, request, timing } = job;
    // A confirmation can open between being queued and being run.
    if (state.pendingConfirmation) {
      writeTurnTiming(timing, "refused", null);
      sendFunctionOutput(callId, {
        status: "busy",
        answer: "",
        reason: "ADE is still waiting for the user to approve or decline the pending action.",
      });
      return;
    }

    // Held locally, not read back off the module binding. By the time this
    // turn's await settles, `askCtoAbort` names the controller of whatever
    // replaced it, so checking the binding asks the wrong question: the
    // replaced turn sees "not aborted" and answers over the live one.
    const controller = new AbortController();
    askCtoAbort = controller;
    askCtoRunning = true;
    // Only when nothing is coming out of the speaker: the model's own
    // acknowledgement is usually still playing, and `thinking` would take the
    // HUD off `speaking` while the user can still hear it.
    if (state.phase !== "speaking") setPhase("thinking");

    try {
      const image = pendingImage;
      pendingImage = null;
      timing.turnStartedAtMs = now();
      const result = await deps.runBackendTurn({
        intent: request,
        callId: state.callId ?? "",
        signal: controller.signal,
        imageBase64: image,
      });

      timing.backendDoneAtMs = now();
      timing.firstTextMs = result.firstTextMs ?? null;
      timing.toolCalls = result.toolCalls ?? 0;

      if (controller.signal.aborted) {
        writeTurnTiming(timing, "superseded", null);
        sendFunctionOutput(callId, { status: "superseded", answer: "" }, false);
        return;
      }

      if (result.sceneSource) emit({ sceneSource: result.sceneSource });

      const status = result.status ?? "completed";
      if (status === "completed") {
        const answer = result.spoken.trim();
        // An answer that will be spoken leaves its timing line open on purpose:
        // the last leg is the first audio the user hears, which has not happened
        // yet. An answer with nothing in it never will, so it is written here.
        if (!answer.length) writeTurnTiming(timing, "silent", null);
        else handOverToSpeak(timing);
        sendFunctionOutput(callId, { status: "ok", answer });
      } else {
        writeTurnTiming(timing, status === "interrupted" ? "superseded" : "backend_failed", null);
        sendFunctionOutput(callId, {
          status,
          answer: "",
          ...(result.reason ? { reason: result.reason } : {}),
        });
      }
    } catch (error) {
      if (controller.signal.aborted) {
        writeTurnTiming(timing, "superseded", null);
        sendFunctionOutput(callId, { status: "superseded", answer: "" }, false);
        return;
      }
      deps.logger?.warn("cto_voice.backend_failed", { error: String(error) });
      writeTurnTiming(timing, "backend_failed", null);
      // The error itself never travels: the model would read it out.
      sendFunctionOutput(callId, {
        status: "failed",
        answer: "",
        reason: "The CTO could not be reached just now. Nothing was changed.",
      });
    } finally {
      if (askCtoAbort === controller) {
        askCtoAbort = null;
        askCtoRunning = false;
        if (state.phase === "thinking" && !askQueue.length) setPhase("listening");
      }
      // Last, and only for a turn nothing is waiting behind: a replaced turn's
      // facts are older than the one that replaced it, and a refresh between
      // two queued turns is a session update the second one pays for twice.
      if (!askQueue.length && !controller.signal.aborted) void refreshSessionContext();
    }
  }

  /**
   * The answer is written and the model is about to speak it.
   *
   * A record still waiting to be heard when the next one arrives never will be —
   * its response was cancelled or talked over — so it is written out here
   * rather than left open until the call ends.
   */
  function handOverToSpeak(timing: CtoVoiceTurnTiming): void {
    if (speakingTiming) writeTurnTiming(speakingTiming, "unheard", null);
    speakingTiming = timing;
  }

  /** Abort the running `ask_cto`, if there is one. Returns whether there was. */
  function abortRunningAsk(): boolean {
    if (!askCtoRunning || !askCtoAbort) return false;
    askCtoAbort.abort();
    // The HUD moves now; the turn itself keeps unwinding on the CTO session and
    // clears `askCtoRunning` in its own `finally`, which is what the drain loop
    // waits for.
    if (state.phase === "thinking" && !askQueue.length) setPhase("listening");
    return true;
  }

  /**
   * Stop everything: the running request and anything waiting behind it.
   *
   * Every dropped request still answers its own `function_call` — an unanswered
   * one sits in the conversation forever and the model keeps referring to it —
   * but none of them asks for a response, because narrating a queue the user
   * has just cancelled is noise.
   */
  function cancelRunningWork(): boolean {
    const waiting = askQueue;
    askQueue = [];
    for (const job of waiting) {
      writeTurnTiming(job.timing, "cancelled", null);
      sendFunctionOutput(job.callId, { status: "cancelled", answer: "" }, false);
    }
    const stopped = abortRunningAsk();
    if (!stopped && state.phase === "thinking") setPhase("listening");
    return stopped || waiting.length > 0;
  }

  /**
   * Hang up once the goodbye has been heard.
   *
   * Not on `response.done`: that is the moment the model finished GENERATING,
   * and the audio it generated is still sitting in the runtime's queue and the
   * renderer's playback graph. Ending there cuts the goodbye off mid-word,
   * which is the one sentence of a call the user is guaranteed to be listening
   * to. So the wait is what is left on the playback clock plus
   * {@link CTO_VOICE_END_CALL_AUDIO_TAIL_MS} for the drain and the graph.
   *
   * Idempotent: two calls to `end_call`, or a `response.done` after one that
   * already scheduled, must not arm two timers.
   */
  function scheduleEndAfterSpeech(): void {
    if (!endAfterSpeech || endAfterSpeechTimer || !started) return;
    const waitMs = Math.max(0, outputAudioDeadlineMs - now()) + CTO_VOICE_END_CALL_AUDIO_TAIL_MS;
    deps.logger?.info("cto_voice.end_call_scheduled", { callId: state.callId, waitMs });
    endAfterSpeechTimer = setTimeout(() => {
      endAfterSpeechTimer = null;
      void endCall("assistant_end");
    }, waitMs);
    endAfterSpeechTimer.unref?.();
  }

  /**
   * One function call from the model.
   *
   * Dispatched by name through an explicit switch rather than a lookup table,
   * so a name the model invented cannot reach anything: the default answers the
   * call and says so, which keeps the conversation consistent instead of
   * leaving a dangling `function_call` the model talks around.
   */
  function handleFunctionCall(name: string, callId: string, argumentsJson: string) {
    if (!callId || handledFunctionCalls.has(callId)) return;
    handledFunctionCalls.add(callId);
    deps.logger?.info("cto_voice.function_call", { callId: state.callId, tool: name });

    if (name === CTO_VOICE_TOOL_ASK_CTO) {
      let request = "";
      let mode = normalizeCtoVoiceAskMode(undefined);
      try {
        const parsed = JSON.parse(argumentsJson || "{}") as { request?: unknown; mode?: unknown };
        request = typeof parsed.request === "string" ? parsed.request.trim() : "";
        mode = normalizeCtoVoiceAskMode(parsed.mode);
      } catch {
        request = "";
      }
      if (!request.length) {
        sendFunctionOutput(callId, {
          status: "failed",
          answer: "",
          reason: "The request was empty. Ask the user what they want.",
        });
        return;
      }
      // Taken HERE, not when the turn starts: a queued request's wait is part of
      // what the user waited, and by the time it runs the pending slot belongs
      // to whatever they said next. A request the transcript gate rejected — it
      // judges ADE's own microphone, not the model's ears — still gets a record,
      // because a timing line that only appears for the happy path cannot say
      // which turns were slow.
      const timing = pendingTiming ?? newTurnTiming(now());
      pendingTiming = null;
      scheduleAskCto({ callId, request, timing }, mode);
      return;
    }

    if (name === CTO_VOICE_TOOL_CANCEL_WORK) {
      const stopped = cancelRunningWork();
      // Nothing to stop asks for no response, and that is measured rather than
      // tidy: on the live call of 2026-09-16 the model said "Okay, stopping
      // that now" in the same breath as the call, and the response this output
      // would have asked for added a second, unwanted sentence — "There's
      // nothing running to stop right now" — about a race the user cannot see.
      // A cancel that DID stop something is worth confirming.
      sendFunctionOutput(
        callId,
        stopped ? { status: "cancelled" } : { status: "nothing_running" },
        stopped,
      );
      return;
    }

    if (name === CTO_VOICE_TOOL_END_CALL) {
      endAfterSpeech = true;
      // Answered so the conversation is not left holding an open call, and
      // deliberately without asking for a response: the goodbye is in the same
      // response this call arrived in, and a second one would talk over it.
      sendFunctionOutput(callId, { status: "ok" }, false);
      // The call arrives either a beat before its response finishes
      // (`response.function_call_arguments.done`) or from the finished response
      // itself. In the first case the goodbye is still being generated, so the
      // hang-up is scheduled by `response.done`; in the second there is nothing
      // left to wait for but the audio.
      if (!responseActive) scheduleEndAfterSpeech();
      return;
    }

    if (name === CTO_VOICE_TOOL_APPROVE || name === CTO_VOICE_TOOL_DENY) {
      const pending = state.pendingConfirmation;
      if (!pending) {
        sendFunctionOutput(callId, { status: "nothing_pending" });
        return;
      }
      // A spoken yes cannot release a destructive action, whoever heard it. The
      // model is not a second opinion on that rule — it is the same rule.
      if (pending.destructive) {
        sendFunctionOutput(callId, {
          status: "needs_tap",
          reason: "That one needs the user to tap the card on screen.",
        });
        return;
      }
      if (name === CTO_VOICE_TOOL_APPROVE) approvePending("voice");
      else denyPending();
      sendFunctionOutput(callId, { status: "ok" });
      return;
    }

    sendFunctionOutput(callId, { status: "unknown_tool" });
  }

  /** Every `function_call` item in a finished response. */
  function handleResponseFunctionCalls(response: Record<string, unknown>) {
    const output = Array.isArray(response.output) ? response.output : [];
    for (const entry of output) {
      const item = (entry ?? {}) as Record<string, unknown>;
      if (item.type !== "function_call") continue;
      handleFunctionCall(
        typeof item.name === "string" ? item.name : "",
        typeof item.call_id === "string" ? item.call_id : "",
        typeof item.arguments === "string" ? item.arguments : "",
      );
    }
  }

  /**
   * One user turn's transcript, final.
   *
   * Both the answer to a pending question and the next thing to ask the CTO
   * arrive here, and they are mutually exclusive: a spoken "yes" releases a
   * turn that is already parked inside `canUseTool`, and must not also start a
   * second one.
   */
  /**
   * Could this transcript answer a question ADE asked out loud?
   *
   * A transcription event on its own is not evidence of speech — see the gate's
   * constants in `shared/types/ctoVoice` — and a phantom "yes" is the one thing
   * on this wire that can release a tool. Returns the reason to refuse the
   * transcript a DECISION, or null to let it decide. It says nothing about
   * whether the user spoke for the purposes of the call record: that question
   * has an unconditional answer now, because rejecting a caption never stopped
   * the realtime model answering and only deleted the user's own words.
   *
   * Reads state; writes nothing but the valve's own release, so the caller
   * decides what a verdict costs.
   */
  function judgeTranscript(final: string): CtoVoiceTranscriptRejection | null {
    // The valve is released by quiet, not by an accepted transcript: while it is
    // shut there are none, so "until the next accepted one" would latch forever.
    if (burstValveTripped) {
      if (now() - lastTranscriptAtMs < CTO_VOICE_TURN_BURST_COOLDOWN_MS) return "runaway";
      burstValveTripped = false;
      acceptedTurnsAtMs = [];
      deps.logger?.info("cto_voice.transcript_valve_cleared", { callId: state.callId });
    }
    if (!ctoVoiceTranscriptHasSpeech(final)) return "empty";
    const mic = readMic();
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

  function handleUserTranscript(text: string) {
    const final = text.trim();
    // Read once, before anything resets it, so every log line below describes
    // the same evidence, and before `resetMic` — the confirmation verdict is
    // made on these frames.
    const mic = readMic();
    const pending = state.pendingConfirmation;
    // Judged ONLY when there is a question open. Everywhere else the meter has
    // no vote: the model already answered whatever it heard, and a caption the
    // meter vetoed is a sentence the user watched disappear.
    const confirmationRejection = pending ? judgeTranscript(final) : null;
    lastTranscriptAtMs = now();
    // Whatever was part-heard is now either final or gone.
    if (state.pendingUserText !== null) emit({ pendingUserText: null });
    if (!ctoVoiceTranscriptHasSpeech(final)) {
      deps.logger?.info("cto_voice.transcript_rejected", {
        callId: state.callId,
        scope: "caption",
        reason: "empty" satisfies CtoVoiceTranscriptRejection,
        text: final,
        peak: Number(mic.peak.toFixed(3)),
        voicedMs: Math.round(mic.voicedMs),
        frames: mic.frames,
        framesWhileIdle: mic.framesWhileIdle,
      });
      // A transcript with no letters and no digits is silence the transcriber
      // could not resist writing something about, and there is nothing to
      // caption. The utterance is burned so a redelivered transcription cannot
      // try the same words again, and the meter starts clean so this segment's
      // silence cannot be counted towards the next one.
      utterance = { id: utterance.id, text: "", open: false, consumed: true };
      resetMic();
      return;
    }

    // The other half of the ledger. Only rejections were ever logged, so an
    // accepted phantom was invisible: the gate looked silent whether it was
    // working or waved a hallucination through. The text's LENGTH goes in the
    // log, never the text — an accepted transcript is something the user said.
    deps.logger?.info("cto_voice.transcript_accepted", {
      callId: state.callId,
      peak: Number(mic.peak.toFixed(3)),
      voicedMs: Math.round(mic.voicedMs),
      frames: mic.frames,
      framesWhileIdle: mic.framesWhileIdle,
      textLength: final.length,
    });

    // Only a record that never reached a turn is abandoned here. A turn that is
    // still running owns its own record and closes it itself — talking over
    // work that carries on is an ordinary thing to do on a hybrid call, and
    // calling that "abandoned" is how a request the CTO answered twenty-five
    // seconds later was logged as thrown away.
    if (pendingTiming) writeTurnTiming(pendingTiming, "abandoned", null);
    pendingTiming = newTurnTiming(
      lastTranscriptAtMs,
      speechStoppedAtMs ? Math.round(lastTranscriptAtMs - speechStoppedAtMs) : null,
    );
    speechStoppedAtMs = 0;

    exchanges += 1;
    acceptedTurnsAtMs = [...acceptedTurnsAtMs, lastTranscriptAtMs]
      .filter((at) => lastTranscriptAtMs - at < CTO_VOICE_TURN_BURST_WINDOW_MS);
    if (acceptedTurnsAtMs.length > CTO_VOICE_TURN_BURST_LIMIT) {
      burstValveTripped = true;
      deps.logger?.info("cto_voice.transcript_valve_tripped", {
        callId: state.callId,
        accepted: acceptedTurnsAtMs.length,
        windowMs: CTO_VOICE_TURN_BURST_WINDOW_MS,
      });
    }
    resetMic();
    try {
      deps.onExchange?.({ exchanges, live: true });
    } catch (error) {
      deps.logger?.warn("cto_voice.exchange_report_failed", { error: String(error) });
    }

    utterance.text = final;
    utterance.open = false;
    addCaption("user", final);
    emit({ interrupted: false });

    if (pending) {
      // Captioned and counted above whatever the meter thought; what the meter
      // decides is only whether these words may answer the question.
      if (confirmationRejection) {
        deps.logger?.info("cto_voice.transcript_rejected", {
          callId: state.callId,
          scope: "confirmation",
          reason: confirmationRejection,
          text: final,
          peak: Number(mic.peak.toFixed(3)),
          voicedMs: Math.round(mic.voicedMs),
          frames: mic.frames,
          framesWhileIdle: mic.framesWhileIdle,
        });
        return;
      }
      const outcome = resolveSpokenConfirmation({
        confirmation: pending,
        utteranceId: utterance.id,
        text: final,
        nowMs: now(),
      });
      if (outcome.kind === "approved") { approvePending("voice"); return; }
      if (outcome.kind === "denied") { denyPending(); return; }
      // Still waiting on an answer, so this utterance is not a new question:
      // the CTO's turn is parked inside `canUseTool` and a second turn on the
      // same session would collide with it.
      deps.logger?.info("cto_voice.reply_without_decision", { reason: outcome.reason });
      return;
    }

    // And that is the end of it. A transcript no longer starts anything: under
    // the hybrid the realtime model hears the audio itself and decides whether
    // this needs the CTO. What this path still owns is the record of the call
    // and the spoken answer to a question ADE asked.
  }

  function handleEvent(raw: unknown) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof event.type === "string" ? event.type : "";

    // The session exists and is configured. Whichever of these lands first is
    // the moment the call is live; the rest are ignored.
    if (type === "session.created" || type === "session.updated" || type === "conversation.created") {
      if (!sessionReady) {
        sessionReady = true;
        startedAtMs = now();
        startedAtIso = new Date(now()).toISOString();
        setPhase("listening");
      }
      return;
    }

    if (type === "input_audio_buffer.speech_started") {
      // A new utterance supersedes the last finished one, so a transcript
      // nobody asked the CTO about cannot be picked up minutes later.
      utterance = { id: randomUUID(), text: "", open: true, consumed: false };
      const talkingOver = responseActive
        || state.phase === "speaking"
        || state.phase === "thinking";
      if (!talkingOver) return;
      // Only cancels a response ADE created; the server truncates its own.
      stopSpeaking();
      // Whatever it manages to transcribe was cut off mid-sentence, and the
      // caption it produces has to say so.
      activeResponseInterrupted = true;
      // A question the CTO asked keeps its card on screen: the turn behind it is
      // parked inside `canUseTool` waiting for exactly this reply.
      if (state.pendingConfirmation) return;
      // The WORK is deliberately left running. Talking while the CTO works is
      // ordinary on a hybrid call — the user asks a follow-up, or thinks out
      // loud — and killing the turn for it would make the call unusable. Work
      // stops two ways and only two: `cancel_work`, and a new `ask_cto`
      // superseding it.
      emit({ interrupted: true, phase: askCtoRunning ? "thinking" : "listening" });
      return;
    }

    // Recorded, not acted on. The segment is judged from the microphone's own
    // frames, so this event decides nothing — but it is the moment the user
    // stopped talking, and the wait from here to a transcript is the one leg of
    // the latency that belongs entirely to OpenAI.
    if (type === "input_audio_buffer.speech_stopped") {
      speechStoppedAtMs = now();
      return;
    }

    if (type === "conversation.item.input_audio_transcription.delta") {
      if (!utterance.open) {
        utterance = { id: randomUUID(), text: "", open: true, consumed: false };
      }
      utterance.text += String(event.delta ?? "");
      // Shown as it arrives. A final transcript can land seconds after the
      // words, and on the call of 2026-09-16 the owner repeated themselves
      // because the HUD stayed empty until it did. Some surfaces deliver a
      // transcript as one `.completed` with no deltas at all, and then this
      // simply never fires — the captions are unchanged.
      const partial = utterance.text.trim();
      if (partial.length) emit({ pendingUserText: partial });
      return;
    }

    if (type === "conversation.item.input_audio_transcription.completed") {
      handleUserTranscript(String(event.transcript ?? utterance.text));
      return;
    }

    if (type === "conversation.item.input_audio_transcription.failed") {
      const failure = (event.error ?? {}) as Record<string, unknown>;
      deps.logger?.warn("cto_voice.transcription_failed", { error: failure.message ?? null });
      utterance = { id: randomUUID(), text: "", open: false, consumed: true };
      if (state.pendingUserText !== null) emit({ pendingUserText: null });
      // One segment's audio answers for one transcript, and this one is over.
      resetMic();
      speak("Sorry — I didn't catch that.");
      setPhase("listening");
      return;
    }

    // `response.output_audio.delta` is the GA name; `response.audio.delta` is
    // the name the same event carries on the older surface. Both are handled,
    // because one socket's vocabulary is not a thing to guess at.
    if (type === "response.output_audio.delta" || type === "response.audio.delta") {
      const delta = typeof event.delta === "string" ? event.delta : null;
      if (delta) {
        // The playback clock the hang-up waits on: chunks arrive faster than
        // realtime, so the end of the queue is later than the last chunk's
        // arrival by however much of it is still unplayed.
        outputAudioDeadlineMs = Math.max(outputAudioDeadlineMs, now())
          + ctoVoiceFrameDurationMs(delta);
        // The last post, and the only one the user can actually hear. Written
        // on the FIRST chunk of the response this turn's answer was queued as;
        // every later chunk finds no record and writes nothing.
        flushSpokenTiming(now());
        deps.onOutputAudio?.(delta);
      }
      return;
    }

    if (type === "response.created") {
      responseActive = true;
      // Which side created it, recorded here because this is the only moment
      // both facts are in hand: the send that asked for it is ours or it is
      // not, and barge-in has to cancel only the former.
      activeResponseIsOurs = pendingOurResponse;
      pendingOurResponse = false;
      activeResponseInterrupted = false;
      const created = (event.response ?? {}) as Record<string, unknown>;
      activeResponseId = typeof created.id === "string" && created.id.length ? created.id : null;
      // The user talked over a response the server had not named yet. Now it
      // has a name, so the interruption they already made can be honoured.
      if (cancelWhenNamed && activeResponseId) {
        cancelWhenNamed = false;
        send({ type: "response.cancel", event_id: randomUUID(), response_id: activeResponseId });
      }
      return;
    }

    if (
      type === "response.output_audio_transcript.delta"
      || type === "response.audio_transcript.delta"
    ) {
      setPhase("speaking");
      return;
    }

    if (
      type === "response.output_audio_transcript.done"
      || type === "response.audio_transcript.done"
    ) {
      addCaption("assistant", String(event.transcript ?? ""), activeResponseInterrupted);
      return;
    }

    if (type === "response.done" || type === "response.failed" || type === "response.cancelled") {
      const response = (event.response ?? {}) as Record<string, unknown>;
      // The conversation has caught up: every call it was still writing is now
      // written, so anything that was waiting on one can go. Queued while the
      // lock is still held, so the release below drains it in one go.
      unsettledFunctionCalls.clear();
      flushFunctionOutputs();
      // A `cancelled` response releases the lock exactly like a completed one —
      // the whole point of a barge-in is that the next thing can be said.
      releaseResponse();
      // Only once nothing else is queued: an acknowledgement and the answer
      // behind it are one stretch of speaking, not two.
      if (!responseActive && state.phase === "speaking") {
        setPhase(askCtoRunning ? "thinking" : "listening");
      }
      // Last: the model's turn is over, and what it asked for is in its output.
      handleResponseFunctionCalls(response);
      // Including a goodbye asked for a beat earlier, whose audio is now all
      // generated and only waiting to be heard.
      scheduleEndAfterSpeech();
      return;
    }

    // The other spelling of the same fact, and it arrives BEFORE
    // `response.done`. Both are handled and both are deduped by `call_id`,
    // because which one a given surface sends is not a thing to guess at — and
    // this one is a beat earlier, which on a five-second turn is worth having.
    if (type === "response.function_call_arguments.done") {
      if (typeof event.call_id === "string") unsettledFunctionCalls.add(event.call_id);
      handleFunctionCall(
        typeof event.name === "string" ? event.name : "",
        typeof event.call_id === "string" ? event.call_id : "",
        typeof event.arguments === "string" ? event.arguments : "",
      );
      return;
    }

    if (type === "error") {
      const failure = (event.error ?? event) as Record<string, unknown>;
      const rawMessage = typeof failure.message === "string" ? failure.message : "";
      const reason = describeCtoVoiceServerError(failure);
      deps.logger?.warn("cto_voice.session_error", {
        message: rawMessage,
        code: typeof failure.code === "string" ? failure.code : null,
        type: typeof failure.type === "string" ? failure.type : null,
        kind: reason.kind,
      });
      // A response this service cancelled a beat too late is not news, and it
      // must not become a banner over a call that is working.
      if (isBenignCtoVoiceServerError(rawMessage)) {
        releaseResponse();
        return;
      }
      if (!reason.fatal) {
        emit({ error: reason.message });
        return;
      }
      // The session is over — a refused key does not recover — so this is the
      // same terminal event a rejected upgrade is, and takes the same latch so
      // the close that follows cannot overwrite it with a generic sentence.
      if (connectionFailed) return;
      connectionFailed = true;
      connectionFailureKind = "rejected_key";
      emit({ phase: "failed", error: reason.message });
      void endCall("session_error");
      return;
    }
  }

  /**
   * The CTO's turn hit a tool that writes and is waiting to be let through.
   *
   * Raised from the chat's own approval event rather than from a turn's return
   * value, because the turn has not returned — it is parked inside
   * `canUseTool`. Speaking the question here is what turns "the call went
   * quiet" into "the CTO asked you something".
   */
  function raiseApproval(args: CtoVoiceApprovalNotice) {
    if (!started) return;
    const confirmation = buildConfirmation({
      id: randomUUID(),
      toolName: args.toolName,
      prompt: args.prompt,
      utteranceId: utterance.id,
      nowMs: now(),
      approvalItemId: args.itemId,
      ...(args.destructive === undefined ? {} : { destructive: args.destructive }),
    });
    emit({ pendingConfirmation: confirmation, phase: "confirming" });
    // Asked out loud, because the user is on a call: the turn is parked inside
    // `canUseTool` and the chat card is not where they are looking. ADE's own
    // words, out-of-band — the question is a permission gate, and a model that
    // rephrased it would be rewriting what the user is agreeing to.
    speak(confirmation.destructive
      ? `${confirmation.prompt} That one needs a tap — I have put a card on screen.`
      : confirmation.prompt);
    // And the model is told, silently, that a question is open. Without this it
    // hears the user say "yes" to nothing it can see and answers "yes to what?"
    // The transcript parser still resolves the same word; the two race and
    // whichever wins, `approvePending` only fires once.
    think(confirmation.destructive
      ? `ADE has asked the user out loud to approve: ${confirmation.prompt}`
        + " That action needs a tap on screen, so do not call any approval tool for it"
        + " and do not offer to approve it yourself. Say nothing about this note."
      : `ADE has asked the user out loud to approve: ${confirmation.prompt}`
        + ` If they clearly say yes, call ${CTO_VOICE_TOOL_APPROVE}. If they clearly say no,`
        + ` call ${CTO_VOICE_TOOL_DENY}. If they say anything else, say nothing about it.`
        + " Say nothing about this note.");
  }

  function approvePending(source: "voice" | "tap") {
    const confirmation = state.pendingConfirmation;
    // Two things can answer one question now — the transcript parser and the
    // model's own `approve_pending_action` — so the id is what makes the second
    // one a no-op rather than a second decision on an open gate.
    if (!confirmation || resolvedConfirmations.has(confirmation.id)) return;
    resolvedConfirmations.add(confirmation.id);
    deps.logger?.info("cto_voice.confirmation_approved", { tool: confirmation.toolName, source });
    // Echo the commitment before acting: it gives the user a beat to say no.
    speak(`Doing that now — ${confirmation.prompt.replace(/\?$/, "")}.`);
    emit({ pendingConfirmation: null, phase: "thinking" });
    // The turn is still blocked inside `canUseTool`. Releasing it is what
    // actually runs the tool; everything above is only what the user hears.
    if (confirmation.approvalItemId) {
      void deps
        .resolveApproval?.({ itemId: confirmation.approvalItemId, approved: true })
        .catch((error) => deps.logger?.warn("cto_voice.approve_failed", { error: String(error) }));
    }
  }

  function denyPending() {
    const confirmation = state.pendingConfirmation;
    if (!confirmation || resolvedConfirmations.has(confirmation.id)) return;
    resolvedConfirmations.add(confirmation.id);
    emit({ pendingConfirmation: null, phase: "listening" });
    if (confirmation.approvalItemId) {
      void deps
        .resolveApproval?.({ itemId: confirmation.approvalItemId, approved: false })
        .catch((error) => deps.logger?.warn("cto_voice.deny_failed", { error: String(error) }));
    }
  }

  /**
   * Every way a call can stop, named.
   *
   * One line per teardown, logged BEFORE the `started` guard, because the most
   * confusing case is the one where the answer is "something called end and it
   * was already over". Without it, a call that died 144 ms in looked identical
   * whether OpenAI refused it or ADE hung up on itself.
   */
  async function endCall(reason: CtoVoiceCallEndReason = "unknown") {
    deps.logger?.info("cto_voice.call_end", {
      reason,
      callId: state.callId,
      phase: state.phase,
      started,
      socketOpen,
    });
    if (!started) return;
    started = false;
    if (endAfterSpeechTimer) { clearTimeout(endAfterSpeechTimer); endAfterSpeechTimer = null; }
    endAfterSpeech = false;
    // A turn the hang-up landed in the middle of is still a measurement, and
    // the queue below is about to throw away the answer it was waiting for.
    // Both slots: the answer nobody heard, and the utterance nothing ran for.
    if (speakingTiming) writeTurnTiming(speakingTiming, "call_ended", null);
    speakingTiming = null;
    if (pendingTiming) writeTurnTiming(pendingTiming, "call_ended", null);
    pendingTiming = null;
    for (const job of askQueue) writeTurnTiming(job.timing, "call_ended", null);
    askQueue = [];
    const closing = socket;
    socket = null;
    socketOpen = false;
    pendingInputAudio = [];
    responseQueue = [];
    pendingFunctionOutputs = [];
    responseActive = false;
    askCtoAbort?.abort();
    askCtoAbort = null;
    askCtoRunning = false;
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
    releaseApprovalWatch?.();
    releaseApprovalWatch = null;
    // Set before the close, because `ws` reports it synchronously.
    deliberateClose = true;
    try { closing?.close(); } catch { /* already gone */ }

    // Restore full-auto first: a call that ended must not leave the CTO asking
    // for confirmation in the thread.
    try {
      await deps.setCallConfirmMode?.(false);
    } catch (error) {
      deps.logger?.warn("cto_voice.confirm_mode_restore_failed", { error: String(error) });
    }

    const endedAt = new Date(now()).toISOString();
    const elapsedMs = startedAtMs ? now() - startedAtMs : 0;

    // The durable write happens whatever else failed. A call the user had is a
    // call the CTO must remember.
    try {
      await deps.persistCall({
        callId: state.callId ?? randomUUID(),
        startedAt: startedAtIso || endedAt,
        endedAt,
        captions: state.captions,
        costUsd: voiceCostUsd(elapsedMs),
      });
    } catch (error) {
      deps.logger?.warn("cto_voice.persist_failed", { error: String(error) });
    }

    // The last word on the row, and the truthful one: the call is over, and this
    // is how many exchanges it actually had. Reported after the durable write so
    // a persist that throws cannot leave the line reading "Voice call" forever.
    try {
      deps.onExchange?.({ exchanges, live: false });
    } catch (error) {
      deps.logger?.warn("cto_voice.exchange_report_failed", { error: String(error) });
    }

    emit({
      phase: "ended",
      elapsedMs,
      pendingConfirmation: null,
      interrupted: false,
      pendingUserText: null,
    });
  }

  return {
    getState: () => state,

    /** The coarse reason the connection failed, if it did. Never a sentence. */
    getConnectionFailureKind: () => connectionFailureKind,

    raiseApproval,

    async start(): Promise<{ ok: boolean; error?: string }> {
      if (started) return { ok: true };
      const apiKey = await deps.getApiKey();
      if (!apiKey) {
        emit({ phase: "failed", error: "No OpenAI API key is configured." });
        return { ok: false, error: "missing-key" };
      }

      // Set before the first await: everything after this point is torn down
      // by `endCall`, including the read-only hold taken just below.
      started = true;

      // A second call on the same service must not inherit the first one's
      // half-open utterance or its unsent transcript.
      utterance = { id: randomUUID(), text: "", open: false, consumed: false };
      pendingImage = null;
      // A second call on this service must be able to fail in its own words.
      connectionFailed = false;
      connectionFailureKind = null;
      socketOpen = false;
      deliberateClose = false;
      pendingInputAudio = [];
      sessionReady = false;
      responseActive = false;
      responseQueue = [];
      pendingFunctionOutputs = [];
      askCtoRunning = false;
      handledFunctionCalls.clear();
      unsettledFunctionCalls.clear();
      resolvedConfirmations.clear();
      // A second call on this service starts with an empty microphone record and
      // an open gate: the previous call's burst must not shut this one's.
      resetMic();
      outputAudioDeadlineMs = 0;
      endAfterSpeech = false;
      activeResponseInterrupted = false;
      acceptedTurnsAtMs = [];
      lastTranscriptAtMs = 0;
      burstValveTripped = false;
      exchanges = 0;

      const callId = randomUUID();
      emit({
        callId,
        phase: "connecting",
        captions: [],
        pendingUserText: null,
        error: null,
        pendingConfirmation: null,
        sceneSource: null,
        elapsedMs: 0,
      });

      // Before the socket, not after: no audio may be in flight while the CTO
      // can still write without asking.
      try {
        await deps.setCallConfirmMode?.(true);
      } catch (error) {
        deps.logger?.warn("cto_voice.confirm_mode_failed", { error: String(error) });
        started = false;
        emit({ phase: "failed", error: "Could not set the CTO's permissions for the call." });
        return { ok: false, error: "confirm-mode" };
      }

      // After confirm mode, not before: the watcher filters on the session id
      // that `setCallConfirmMode` resolves, so subscribing earlier would watch
      // nothing. Attached even if no tool ever asks — it costs one listener.
      releaseApprovalWatch = deps.watchApprovals?.((approval) => {
        raiseApproval(approval);
      }) ?? null;

      // Built before the socket, because the session prompt has to be complete
      // in the FIRST `session.update`: anything the model says before its
      // instructions land is said by a stranger. A context that cannot be built
      // is a call that asks the CTO more often, not a call that fails.
      try {
        sessionContext = deps.context ? await deps.context() : "";
      } catch (error) {
        sessionContext = "";
        deps.logger?.warn("cto_voice.context_failed", { error: String(error) });
      }

      // The user can hang up while the awaits above are still running — the HUD
      // is on screen from `connecting`. Without this the socket below would be
      // opened for a call that is already over, and nothing would close it.
      if (!started) return { ok: false, error: "ended" };

      socket = (deps.createWebSocket ?? defaultSocket)(ctoVoiceEndpointUrl(), apiKey);
      socket.on("open", () => {
        // The call can be ended, or fail, before the socket finishes opening.
        // Without this the late handler arms a 10 Hz interval that nothing will
        // ever clear, once per abandoned call.
        if (!socket) return;
        socketOpen = true;
        // The one event that decides what kind of call this is. Server turn
        // detection now DOES create the model's responses: it is the
        // conversational front, and it answers from the context block in the
        // instructions. What it may not do is invent a project fact — that is
        // what `ask_cto` is for, and the instructions say so.
        send({
          type: "session.update",
          event_id: randomUUID(),
          session: {
            type: "realtime",
            instructions: buildCtoVoiceInstructions({
              ctoName: deps.ctoName(),
              projectName: deps.projectName(),
              context: sessionContext,
              acknowledgeAloud: deps.backchannelsEnabled(),
            }),
            // The seam, as five functions. `auto` because the whole design is
            // the model deciding which side of the line a sentence falls on.
            tools: CTO_VOICE_REALTIME_TOOLS,
            tool_choice: "auto",
            output_modalities: ["audio"],
            audio: {
              input: {
                format: { type: "audio/pcm", rate: CTO_VOICE_SAMPLE_RATE },
                turn_detection: {
                  type: "server_vad",
                  create_response: true,
                  // The server truncates its own response the moment it hears
                  // speech, which is a round trip sooner than ADE could. ADE
                  // still cancels the responses IT created out-of-band, which
                  // this does not cover: they are not in the conversation.
                  interrupt_response: true,
                },
                // Not on by default. No longer what drives a turn — the model
                // hears the audio itself — but still what the captions, the
                // saved transcript and the spoken yes/no parser are made of.
                // The language is named rather than guessed: an unnamed short
                // utterance is how a call ended up with a phantom "好" in it.
                transcription: {
                  model: CTO_VOICE_TRANSCRIBE_MODEL,
                  language: CTO_VOICE_TRANSCRIBE_LANGUAGE,
                  // Both, because measured against the live API neither one is
                  // sufficient on its own — see `CTO_VOICE_TRANSCRIBE_PROMPT`.
                  prompt: CTO_VOICE_TRANSCRIBE_PROMPT,
                },
              },
              output: {
                format: { type: "audio/pcm", rate: CTO_VOICE_SAMPLE_RATE },
                voice: deps.voice?.() ?? CTO_VOICE_DEFAULT,
              },
            },
          },
        });

        // A real microphone never stops. Without a continuous stream the session
        // stalls mid-sentence, so silence goes out whenever the user is muted.
        // Whatever the microphone produced while the handshake was in flight,
        // in order and after the session config it belongs to.
        const buffered = pendingInputAudio;
        pendingInputAudio = [];
        for (const chunk of buffered) {
          send({ type: "input_audio_buffer.append", audio: chunk });
        }

        keepAlive = setInterval(() => {
          if (!socket || !socketOpen || !state.muted) return;
          const silence = Buffer.alloc(Math.floor(CTO_VOICE_SAMPLE_RATE * 0.1) * 2);
          send({ type: "input_audio_buffer.append", audio: silence.toString("base64") });
        }, 100);

        // Anything queued before the socket opened. `watchApprovals` is attached
        // before the connection is made, so a tool that asks during the
        // handshake has a question waiting here and nothing else would send it.
        drainResponses();
      });
      socket.on("message", (payload) => handleEvent(payload));
      socket.on("unexpected-response", (payload) => {
        const response = (payload ?? {}) as { statusCode?: unknown };
        const status = typeof response.statusCode === "number" ? response.statusCode : null;
        failConnection({ status }, "cto_voice.socket_rejected");
        // Nothing else will: taking the `unexpected-response` listener makes
        // this handler responsible for ending the attempt.
        void endCall("socket_rejected");
      });
      socket.on("error", (payload) => {
        const error = (payload ?? {}) as { code?: unknown; message?: unknown };
        failConnection(
          {
            code: typeof error.code === "string" ? error.code : null,
            message: typeof error.message === "string" ? error.message : String(payload),
          },
          "cto_voice.socket_error",
        );
      });
      socket.on("close", () => { void endCall("socket_close"); });

      return { ok: true };
    },

    /** Mic frames from the renderer: base64 PCM16 at the session sample rate. */
    pushAudio(base64: string, level?: number) {
      // Wrapped whole: this runs ~12 times a second off an action call, and a
      // throw here does not stay here — it rejects the action, which the
      // desktop pump reads as "the runtime is gone" and tears the call down,
      // taking the state subscription with it before the runtime's own failure
      // can be forwarded. That is how a rejected key left the HUD counting
      // against a call that had already ended.
      try {
        if (!socket || state.muted) return;
        if (!socketOpen) {
          // The session does not exist yet. Hold the audio for the open
          // handler to flush, bounded so a socket that never opens cannot grow
          // the process.
          pendingInputAudio.push(base64);
          if (pendingInputAudio.length > CTO_VOICE_PREOPEN_AUDIO_LIMIT) {
            pendingInputAudio.splice(0, pendingInputAudio.length - CTO_VOICE_PREOPEN_AUDIO_LIMIT);
          }
        } else {
          send({ type: "input_audio_buffer.append", audio: base64 });
        }
        // The level meter is the one thing that is still true before the socket
        // opens: the user IS talking, and the HUD should show it.
        if (typeof level === "number") {
          const clamped = Math.max(0, Math.min(1, level));
          // Recorded before the emit, because this is the evidence the
          // transcript gate rules on and a throw in `emit` must not lose it.
          const at = now();
          micFrames.push({
            at,
            level: clamped,
            ms: ctoVoiceFrameDurationMs(base64),
            idle: !responseActive,
          });
          trimMic(at);
          // One emit per distinct level, so a quiet stretch of a batch is one
          // state update rather than one per frame.
          if (clamped !== state.inputLevel) emit({ inputLevel: clamped });
        }
      } catch (error) {
        deps.logger?.warn("cto_voice.push_audio_failed", { error: String(error) });
      }
    },

    /**
     * Hand the call something the user is looking at. The image waits for the
     * next CTO turn; the realtime model is only told that it happened, in the
     * silent channel, because it cannot read one.
     */
    attachImage(args: { pngBase64: string; note: string }) {
      // The capture can wait for the socket; `think` cannot be sent before it.
      if (!socket) return;
      pendingImage = args.pngBase64;
      think(args.note || CTO_VOICE_CAPTURE_DEFAULT_NOTE);
    },

    setMuted(muted: boolean) {
      emit({ muted, inputLevel: muted ? 0 : state.inputLevel });
    },

    approve(id: string) {
      if (state.pendingConfirmation?.id !== id) return;
      approvePending("tap");
    },

    deny(id: string) {
      if (state.pendingConfirmation?.id !== id) return;
      denyPending();
    },

    end: (reason?: CtoVoiceCallEndReason) => endCall(reason ?? "unknown"),
  };
}

export type CtoVoiceCallService = ReturnType<typeof createCtoVoiceCallService>;
