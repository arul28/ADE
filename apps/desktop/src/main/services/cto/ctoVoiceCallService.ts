import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

import {
  buildCtoVoiceInstructions,
  buildCtoVoiceSpeakInstructions,
  ctoVoiceEndpointUrl,
  CTO_VOICE_DEFAULT,
  CTO_VOICE_INITIAL_STATE,
  CTO_VOICE_CAPTURE_DEFAULT_NOTE,
  CTO_VOICE_PREOPEN_AUDIO_LIMIT,
  CTO_VOICE_SAMPLE_RATE,
  CTO_VOICE_TRANSCRIBE_MODEL,
  voiceCostUsd,
  type CtoVoiceCaption,
  type CtoVoiceName,
  type CtoVoicePhase,
  type CtoVoiceState,
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
 * Three behaviours are easy to get wrong and are load bearing:
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
    const caption: CtoVoiceCaption = { role, text: text.trim(), atMs: Date.now() - startedAtMs };
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
   * The alternative, `conversation.item.create` with an assistant message, puts
   * the text in the history but produces no audio: the model would then answer
   * ITSELF on the next `response.create`, which is the one thing this
   * architecture must never allow. The audio response this does create is added
   * to the conversation by the server, so the history still holds what was said.
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
        instructions: buildCtoVoiceSpeakInstructions(next),
        output_modalities: ["audio"],
      },
    });
  };

  /** A response ended, however it ended. Let the next sentence through. */
  const releaseResponse = () => {
    responseActive = false;
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
    if (responseActive) send({ type: "response.cancel", event_id: randomUUID() });
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
  function handleUserTranscript(text: string) {
    const final = text.trim();
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
        nowMs: Date.now(),
      });
      if (outcome.kind === "approved") { approvePending("voice"); return; }
      if (outcome.kind === "denied") { denyPending(); return; }
      // Still waiting on an answer, so this utterance is not a new question:
      // the CTO's turn is parked inside `canUseTool` and a second turn on the
      // same session would collide with it.
      deps.logger?.info("cto_voice.reply_without_decision", { reason: outcome.reason });
      return;
    }

    if (!final.length) {
      deps.logger?.warn("cto_voice.empty_transcript", { callId: state.callId });
      return;
    }
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
        startedAtMs = Date.now();
        startedAtIso = new Date().toISOString();
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
      nowMs: Date.now(),
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

    const endedAt = new Date().toISOString();
    const elapsedMs = startedAtMs ? Date.now() - startedAtMs : 0;

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
                // this the call has nothing to ask the CTO.
                transcription: { model: CTO_VOICE_TRANSCRIBE_MODEL },
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
        if (typeof level === "number") emit({ inputLevel: Math.max(0, Math.min(1, level)) });
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
