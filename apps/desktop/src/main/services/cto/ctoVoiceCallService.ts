import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

import {
  buildCtoVoiceInstructions,
  buildCtoVoiceSpeakInstructions,
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
 * OpenAI's Realtime API over a WebSocket, with the realtime model reduced to
 * ears and a mouth. The session is configured so that server-side turn
 * detection does NOT create a response (`turn_detection.create_response:
 * false`), which means the model never composes anything from its own
 * knowledge: it transcribes the user, and it speaks — once per
 * `response.create` ADE sends, reading text the CTO thread already wrote.
 *
 * That is what keeps the CTO's thinking on whatever provider and plan it
 * already runs on while only the voice minutes bill to the user's own API key,
 * and it is also why permissions and confirmations are enforced here in code
 * rather than asked of the model in a prompt.
 *
 * Five behaviours are easy to get wrong and are load bearing:
 *
 * 1. A real microphone never stops. If the client stops sending input audio the
 *    session stalls mid-sentence — measured, not theorised. `pushAudio` keeps
 *    the stream fed and `keepAlive` sends silence when the user is muted.
 * 2. The intent is the TRANSCRIPT. Nothing on the wire carries "what the user
 *    asked" as a field; it arrives as
 *    `conversation.item.input_audio_transcription.completed`, which is why that
 *    event — and not any notion of the model handing work back — is what drives
 *    a CTO turn.
 * 3. One response at a time. A second `response.create` while one is still
 *    generating is an error, so speech is queued and drained on `response.done`.
 * 4. A transcript is not proof of speech. The transcriber invents words out of
 *    near-silence, and each invented sentence used to become a real CTO turn
 *    that spoke a real answer — the CTO appearing to talk to itself. Every
 *    transcript is now judged against ADE's own microphone meter before it can
 *    become an intent; see `judgeTranscript`.
 * 5. Every response ADE asks for is OUT-OF-BAND. `create_response: false` stops
 *    the model answering on its OWN initiative; it does nothing about a response
 *    ADE creates inside the conversation, where the user's audio is sitting in
 *    front of the model and gets answered instead of the instruction. See
 *    `drainSpeech`.
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

export type CtoVoiceBackendResult = {
  /** Read back to the user, word for word, by the realtime model. */
  spoken: string;
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
  backchannelsEnabled: () => boolean;
  voice?: () => CtoVoiceName;
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
  let abort: AbortController | null = null;
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

  /** Answers waiting for the current response to finish. Spoken in order. */
  let speakQueue: string[] = [];

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

  const addCaption = (role: "user" | "assistant", text: string) => {
    if (!text.trim().length) return;
    const caption: CtoVoiceCaption = { role, text: text.trim(), atMs: now() - startedAtMs };
    emit({ captions: [...state.captions, caption].slice(-200) });
  };

  /**
   * Say this, out loud, exactly.
   *
   * There is no "say this" event in the Realtime API. What there is is
   * `response.create` with per-response `instructions`, which is the documented
   * way to steer one response — so the CTO's sentence is handed over as that
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
   * Out-of-band also means nothing ADE says is added to the conversation, which
   * is what we want: the history this session accumulates is the user's audio
   * and nothing else, so it can never grow into a second voice with opinions.
   * The session-level `instructions` still apply — they are session state, not
   * conversation state.
   *
   * The alternative, `conversation.item.create` with an assistant message, puts
   * the text in the history but produces no audio.
   *
   * Queued rather than sent when a response is already in flight, because a
   * second one is an error rather than a second sentence.
   */
  const speak = (content: string) => {
    const text = content.trim();
    if (!text.length) return;
    speakQueue.push(text);
    drainSpeech();
  };

  const drainSpeech = () => {
    if (responseActive || !socketOpen) return;
    const next = speakQueue.shift();
    if (next === undefined) return;
    responseActive = true;
    send({
      type: "response.create",
      event_id: randomUUID(),
      response: {
        // Out-of-band: generated with no conversation and no input items, so
        // the only thing in front of the model is the instruction below.
        conversation: "none",
        input: [],
        instructions: buildCtoVoiceSpeakInstructions(next),
        output_modalities: ["audio"],
      },
    });
  };

  /** A response ended, however it ended. Let the next sentence through. */
  const releaseResponse = () => {
    responseActive = false;
    // The id belongs to the response that just ended, and a cancel waiting for
    // an id that will never arrive would fire at whatever is generated next.
    activeResponseId = null;
    cancelWhenNamed = false;
    drainSpeech();
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
   * Only the audio. Whether the WORK behind it should stop too is a separate
   * question with a different answer, and the caller decides it.
   */
  const stopSpeaking = () => {
    speakQueue = [];
    if (!responseActive) return;
    // Named explicitly: these responses are out-of-band, and a cancel with no
    // `response_id` is only understood as "cancel the default conversation's
    // response" — which is never one of ours.
    if (activeResponseId) {
      send({ type: "response.cancel", event_id: randomUUID(), response_id: activeResponseId });
      return;
    }
    cancelWhenNamed = true;
  };

  /**
   * Run one utterance through the CTO thread and speak what comes back.
   *
   * Driven by `conversation.item.input_audio_transcription.completed`, because
   * the transcript IS the intent: the realtime session is configured not to
   * answer on its own, so nothing else on the wire ever asks a question.
   */
  async function runCtoTurn() {
    // An utterance may be answered exactly once. Without this a retried or
    // duplicated transcription event would ask the CTO the question it just
    // answered.
    const intent = utterance.consumed ? "" : utterance.text.trim();
    utterance.text = "";
    utterance.consumed = true;
    if (!intent.length) return;

    setPhase("thinking");

    // Cover the gap immediately. The filler goes out before any backend work
    // starts, because the point of it is that the user never hears silence.
    if (deps.backchannelsEnabled()) speak("Let me check that.");

    // Held locally, not read back off `abort`. By the time this turn's await
    // settles, `abort` names the controller of whatever turn SUPERSEDED it, so
    // checking the module binding asks the wrong question: the superseded turn
    // sees "not aborted" and speaks its answer over the one the user is
    // actually waiting for.
    const controller = new AbortController();
    abort?.abort();
    abort = controller;
    try {
      const image = pendingImage;
      pendingImage = null;
      const result = await deps.runBackendTurn({
        intent,
        callId: state.callId ?? "",
        signal: controller.signal,
        imageBase64: image,
      });

      // Superseded while the backend was working: the answer is to a question
      // the user has already moved on from, so it is dropped, not spoken.
      if (controller.signal.aborted) return;

      if (result.sceneSource) emit({ sceneSource: result.sceneSource });
      // Nothing to say is a real answer here — an interrupted turn deliberately
      // returns no sentence. Speaking an empty string produces no audio, so the
      // HUD would sit in `speaking` forever waiting for a voice that never
      // comes; go straight back to listening instead.
      if (!result.spoken.trim().length) {
        setPhase("listening");
        return;
      }
      speak(result.spoken);
      setPhase("speaking");
    } catch (error) {
      if (controller.signal.aborted) return;
      deps.logger?.warn("cto_voice.backend_failed", { error: String(error) });
      speak("That didn't work. I couldn't reach the project state just now.");
      setPhase("listening");
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
   * Did the user actually say this?
   *
   * A transcription event on its own is not evidence of speech — see the gate's
   * constants in `shared/types/ctoVoice`. Returns the reason to throw the
   * transcript away, or null to let it through. Reads state; writes nothing, so
   * the caller decides what a verdict costs.
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
    const rejection = judgeTranscript(final);
    // Read once, before anything resets it, so the two log lines below describe
    // the same evidence the verdict was made on.
    const mic = readMic();
    lastTranscriptAtMs = now();
    if (rejection) {
      deps.logger?.info("cto_voice.transcript_rejected", {
        callId: state.callId,
        reason: rejection,
        text: final,
        peak: Number(mic.peak.toFixed(3)),
        voicedMs: Math.round(mic.voicedMs),
        frames: mic.frames,
        framesWhileIdle: mic.framesWhileIdle,
      });
      // Nothing else happens: no turn, no speech, no caption. The utterance is
      // burned so a redelivered transcription cannot try the same words again,
      // and the meter starts clean so this segment's silence cannot be counted
      // towards the next one.
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

    const pending = state.pendingConfirmation;
    if (pending) {
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

    // No empty check here: a transcript with no words never reaches this line —
    // `judgeTranscript` rejects it as "empty" before anything is recorded.
    void runCtoTurn();
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
      stopSpeaking();
      // A question the CTO asked is not a turn to abandon. That turn is parked
      // inside `canUseTool` waiting for exactly this reply, so aborting it here
      // would kill the work the user's "yes" is one word away from releasing —
      // and dropping `confirming` would take the card off screen with it.
      if (state.pendingConfirmation) return;
      // Everything else is a real barge-in: the answer in flight is to a
      // question the user has moved on from, so the turn behind it goes too.
      abort?.abort();
      abort = null;
      emit({ interrupted: true, phase: "listening" });
      return;
    }

    if (type === "conversation.item.input_audio_transcription.delta") {
      if (!utterance.open) {
        utterance = { id: randomUUID(), text: "", open: true, consumed: false };
      }
      utterance.text += String(event.delta ?? "");
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
      if (delta) deps.onOutputAudio?.(delta);
      return;
    }

    if (type === "response.created") {
      responseActive = true;
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
      addCaption("assistant", String(event.transcript ?? ""));
      return;
    }

    if (type === "response.done" || type === "response.failed" || type === "response.cancelled") {
      releaseResponse();
      // Only once nothing else is queued: the filler and the answer behind it
      // are one stretch of speaking, not two.
      if (!responseActive && state.phase === "speaking") setPhase("listening");
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
    // `canUseTool` and the chat card is not where they are looking.
    speak(confirmation.destructive
      ? `${confirmation.prompt} That one needs a tap — I have put a card on screen.`
      : confirmation.prompt);
  }

  function approvePending(source: "voice" | "tap") {
    const confirmation = state.pendingConfirmation;
    if (!confirmation) return;
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
    if (!confirmation) return;
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
    const closing = socket;
    socket = null;
    socketOpen = false;
    pendingInputAudio = [];
    speakQueue = [];
    responseActive = false;
    abort?.abort();
    abort = null;
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

    emit({ phase: "ended", elapsedMs, pendingConfirmation: null, interrupted: false });
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
      speakQueue = [];
      // A second call on this service starts with an empty microphone record and
      // an open gate: the previous call's burst must not shut this one's.
      resetMic();
      acceptedTurnsAtMs = [];
      lastTranscriptAtMs = 0;
      burstValveTripped = false;
      exchanges = 0;

      const callId = randomUUID();
      emit({
        callId,
        phase: "connecting",
        captions: [],
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

      // The user can hang up while the await above is still running — the HUD
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
        // The one event that decides whether this is a CTO call or a chat with
        // a stranger. `create_response: false` keeps server turn detection —
        // so speech is still segmented, committed and transcribed for us — while
        // refusing the model permission to answer any of it. Every response on
        // this socket is one ADE asked for.
        send({
          type: "session.update",
          event_id: randomUUID(),
          session: {
            type: "realtime",
            instructions: buildCtoVoiceInstructions({
              ctoName: deps.ctoName(),
              projectName: deps.projectName(),
            }),
            output_modalities: ["audio"],
            audio: {
              input: {
                format: { type: "audio/pcm", rate: CTO_VOICE_SAMPLE_RATE },
                turn_detection: {
                  type: "server_vad",
                  create_response: false,
                  // ADE cancels the in-flight response itself, on
                  // `speech_started`, so that the CTO turn behind it is aborted
                  // in the same beat. Letting the server also cancel would race
                  // that and answer our `response.cancel` with an error.
                  interrupt_response: false,
                },
                // Not on by default, and the transcript IS the intent: without
                // this the call has nothing to ask the CTO. The language is
                // named rather than guessed — an unnamed short utterance is how
                // a call ended up with a phantom "好" in its transcript.
                transcription: {
                  model: CTO_VOICE_TRANSCRIBE_MODEL,
                  language: CTO_VOICE_TRANSCRIBE_LANGUAGE,
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
        drainSpeech();
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
