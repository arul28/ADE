import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

import {
  CTO_VOICE_CAPTURE_DEFAULT_NOTE,
  CTO_VOICE_END_CALL_AUDIO_TAIL_MS,
  CTO_VOICE_INITIAL_STATE,
  CTO_VOICE_PREOPEN_AUDIO_LIMIT,
  CTO_VOICE_SAMPLE_RATE,
  type CtoVoiceCaption,
  ctoVoiceEndpointUrl,
  type CtoVoiceName,
  type CtoVoicePhase,
  type CtoVoiceState,
  ctoVoiceTranscriptHasSpeech,
  type CtoVoiceTranscriptRejection,
  voiceCostUsd,
} from "../../../shared/types/ctoVoice";
import type {
  CtoVoiceAudioDeltaEvent,
  CtoVoiceServerEvent,
  CtoVoiceSettledEvent,
  CtoVoiceTranscriptEvent,
} from "../../../shared/types/ctoVoiceEvents";
import {
  buildCtoVoiceInstructionsUpdate,
  buildCtoVoiceSessionUpdate,
} from "../../../shared/types/ctoVoiceSession";
import {
  CTO_VOICE_ASK_QUEUE_LIMIT,
  CTO_VOICE_TOOL_APPROVE,
  CTO_VOICE_TOOL_ASK_CTO,
  CTO_VOICE_TOOL_CANCEL_WORK,
  CTO_VOICE_TOOL_DENY,
  CTO_VOICE_TOOL_END_CALL,
  normalizeCtoVoiceAskMode,
} from "../../../shared/types/ctoVoiceTools";
import { createVoiceAudioQueue } from "./ctoVoiceAudioQueue";
import { buildConfirmation, resolveSpokenConfirmation } from "./ctoVoiceConfirmation";
import {
  createResponseQueue,
} from "./ctoVoiceResponseQueue";
import { createFunctionCallLedger } from "./ctoVoiceToolCalls";
import {
  createMicMeter,
  judgeVoiceTranscript,
} from "./ctoVoiceMicMeter";
import { createTranscriptBurstValve } from "./ctoVoiceTurnBurst";
import {
  createTurnTimingRecorder,
  type CtoVoiceTurnTiming,
} from "./ctoVoiceTurnTiming";
import {
  ctoVoiceFrameDurationMs,
  describeCtoVoiceServerError,
  describeCtoVoiceSocketFailure,
  forwardUnexpectedResponse,
  isBenignCtoVoiceServerError,
  isCtoVoiceActiveResponseConflict,
  type CtoVoiceSocketFailure,
} from "./ctoVoiceFailures";

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
 *    `judgeVoiceTranscript` and `handleUserTranscript`.
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
 * without deciding what to call it — the diagnosis this exists for is "which
 * teardown path ran", and an unlabelled one is the one that hides. Every member
 * here is produced by something; a name nothing can emit is a worse lie than a
 * free string, because it reads as a case that was thought about.
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
  | "socket_rejected"
  | "session_error"
  | "dispose"
  | "replaced"
  | "unknown";

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

/** A request the model made, and the timing record it was accepted under. */
type AskCtoJob = { callId: string; request: string; timing: CtoVoiceTurnTiming };

/**
 * Everything that belongs to ONE call and must not outlive it.
 *
 * One record rather than a drawer of closure variables, because "reset for the
 * next call" was two hand-written lists — one in `start`, one in `endCall` —
 * that overlapped without agreeing. A variable missing from both is a fact
 * about a finished call that the next one reads as its own, and every bug of
 * that family has the same shape: the first barge-in of call two cancels a
 * response from call one. `start` assigns a fresh record, so a field added
 * here is reset by construction and there is no list to forget it from.
 *
 * What is deliberately NOT here is anything with a teardown of its own — the
 * socket, the timers, the abort controller, the sub-modules — because those
 * need `clearTimeout`/`abort`/`reset` called on them, not a new value.
 */
type CallSession = {
  /**
   * True only between `open` and the end of the socket's life.
   *
   * `ws` throws synchronously on `send` while the handshake is still in flight
   * ("WebSocket is not open: readyState 0 (CONNECTING)"), and the microphone
   * starts producing frames the moment the HUD mounts — which is the whole
   * window between Talk being pressed and OpenAI answering. Every send is
   * gated on this rather than on `socket` being non-null, because a socket that
   * exists is not a socket that will accept anything.
   */
  socketOpen: boolean;
  /**
   * True while WE are closing the socket on purpose.
   *
   * `ws` reports a close of a still-CONNECTING socket as
   * "WebSocket was closed before the connection was established" — an error
   * that looks exactly like a connection that failed on its own. Describing it
   * as one blames OpenAI for a hang-up ADE asked for.
   */
  deliberateClose: boolean;
  startedAtMs: number;
  startedAtIso: string;
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
  utterance: { id: string; text: string; open: boolean };
  /** Cleared as soon as it is handed to a turn — one capture, one turn. */
  pendingImage: string | null;
  /**
   * True once OpenAI has answered with a session, so the call is live.
   *
   * Three events can be the first to say so and only the first one counts —
   * the clock the cost is billed from must not restart on `session.updated`.
   */
  sessionReady: boolean;
  /**
   * The user talked over the response that is generating right now.
   *
   * Read when its transcript arrives: a truncated response still reports the
   * words it managed to say, and without this the call record claims that half
   * sentence was the whole of what the CTO said.
   */
  activeResponseInterrupted: boolean;
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
  outputAudioDeadlineMs: number;
  /** The model called `end_call`; the call hangs up once its goodbye is heard. */
  endAfterSpeech: boolean;
  /**
   * The `ask_cto` running right now.
   *
   * One at a time, because the CTO thread is one session: a second turn on it
   * throws. What happens to a second request is the MODEL's call, carried on
   * the tool's `mode` argument — `replace` stops the running one, `queue` waits
   * for it — and the two are served by one serial drain loop, which is also
   * what makes a replace safe: the next turn is only started after the aborted
   * one's `runBackendTurn` has actually returned.
   */
  askCtoRunning: boolean;
  /** Requests waiting behind the running one, in the order they were asked. */
  askQueue: AskCtoJob[];
  /** True while `drainAskQueue` owns the loop, so nothing starts a second one. */
  askDraining: boolean;
  /** Accepted user turns this call has had. The number the status line reports. */
  exchanges: number;
  /**
   * Why the connection died, in two words rather than a sentence.
   *
   * The sentence the user reads names a provider and a settings pane; the
   * product question is only "was the key refused, or could we not reach
   * OpenAI at all". Recorded here because this is the one place the HTTP status
   * exists. Survives `endCall` so the runtime can read it off a failed call,
   * and is cleared by the NEXT `start`. Non-null is also the latch: a rejected
   * upgrade reaches us twice and the second arrival knows less than the first.
   */
  connectionFailureKind: "rejected_key" | "connection_failed" | null;
};

function freshCallSession(): CallSession {
  return {
    socketOpen: false,
    deliberateClose: false,
    startedAtMs: 0,
    startedAtIso: "",
    utterance: { id: randomUUID(), text: "", open: false },
    pendingImage: null,
    sessionReady: false,
    activeResponseInterrupted: false,
    outputAudioDeadlineMs: 0,
    endAfterSpeech: false,
    askCtoRunning: false,
    askQueue: [],
    askDraining: false,
    exchanges: 0,
    connectionFailureKind: null,
  };
}

export function createCtoVoiceCallService(deps: CtoVoiceCallDeps) {
  /** Everything that belongs to this one call, replaced wholesale by `start`. */
  let call = freshCallSession();
  let socket: CtoVoiceSocket | null = null;
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

  let state: CtoVoiceState = { ...CTO_VOICE_INITIAL_STATE };

  let endAfterSpeechTimer: NodeJS.Timeout | null = null;

  /** Stops the `ask_cto` running right now. See `CallSession.askCtoRunning`. */
  let askCtoAbort: AbortController | null = null;

  /**
   * Every function call in flight: dedupe, settle-order and the results that
   * are still waiting on it. See `ctoVoiceToolCalls`.
   */
  const functionCalls = createFunctionCallLedger({
    send: (payload) => send(payload),
    requestModelResponse: () => responses.requestModelResponse(),
  });

  /**
   * Confirmations already answered, by id.
   *
   * A spoken "yes" reaches this service twice now: the transcript parser reads
   * it, and the model reads the same word and calls `approve_pending_action`.
   * Whichever lands first wins; the second must be a no-op rather than a second
   * `approveToolUse` on a gate that is already open.
   */
  const resolvedConfirmations = new Set<string>();

  const now = deps.now ?? (() => Date.now());
  /**
   * What ADE's own microphone heard in the last few seconds. The ring, and the
   * pure judgement that reads it, live in `ctoVoiceMicMeter`.
   */
  const mic = createMicMeter({ now: () => now() });

  /**
   * Mic frames captured before the session existed.
   *
   * The same bounded queue the runtime holds the model's voice in: the first
   * second of speech is worth keeping, an unbounded queue against a socket that
   * never opens is not, and what the bound threw away is worth a log line.
   */
  const preOpenAudio = createVoiceAudioQueue(CTO_VOICE_PREOPEN_AUDIO_LIMIT);

  /**
   * The gate that shuts when the transcript source runs away, so a stuck
   * stream cannot answer a permission question. See `ctoVoiceTurnBurst`.
   */
  const burstValve = createTranscriptBurstValve({
    now: () => now(),
    log: (event, meta) => deps.logger?.info(event, { callId: state.callId, ...meta }),
  });

  /**
   * How long each turn took, leg by leg. The two slots and the log line it
   * writes live in `ctoVoiceTurnTiming`; what stays here is the call id, which
   * is the only thing about a timing line that belongs to this call.
   */
  const timings = createTurnTimingRecorder({
    now: () => now(),
    log: (line) => deps.logger?.info("cto_voice.turn_timing", { callId: state.callId, ...line }),
  });

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
  const failConnection = (failure: CtoVoiceSocketFailure, event: string): void => {
    const reason = describeCtoVoiceSocketFailure(failure);
    deps.logger?.warn(event, {
      status: reason.status,
      code: reason.code,
      ...(call.connectionFailureKind ? { suppressed: true } : {}),
      ...(call.deliberateClose ? { deliberate: true } : {}),
      ...(failure.message ? { error: failure.message } : {}),
    });
    // Whatever explained the failure first knew the most. Tearing the socket
    // down is itself reported as an error ("closed before the connection was
    // established"), so the follow-on is logged for the trace and then does
    // nothing at all — and a close WE asked for is never a failure to begin
    // with, whether or not anything had failed before it.
    if (call.deliberateClose || call.connectionFailureKind !== null) return;
    call.connectionFailureKind = reason.status === 401 || reason.status === 403
      ? "rejected_key"
      : "connection_failed";
    emit({ phase: "failed", error: reason.message });
  };

  const send = (payload: Record<string, unknown>) => {
    // Not "is there a socket" — "will it take this". A pre-open send throws,
    // and it used to throw once per microphone frame.
    if (!socket || !call.socketOpen) return;
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
      atMs: now() - call.startedAtMs,
      // Only when it is true: an absent flag is what every ordinary caption
      // carries, and a `false` on every one of them would be two hundred extra
      // fields in the persisted transcript to say nothing happened.
      ...(interrupted ? { interrupted: true } : {}),
    };
    emit({ captions: [...state.captions, caption].slice(-200) });
  };

  /**
   * Everything ADE asks to have said, behind the API's one-response lock.
   *
   * `speak` is a line ADE WROTE, read word for word out-of-band;
   * `requestModelResponse` asks the model to speak for itself with the
   * conversation in front of it, which is what a function result needs. The
   * lock, the queue and the barge-in cancel live in `ctoVoiceResponseQueue`.
   */
  const responses = createResponseQueue({
    send: (payload) => send(payload),
    isOpen: () => call.socketOpen,
    // The post the audio leg is measured from: the queue may hold this behind
    // another response, and that wait is part of what the user is waiting for.
    onQueued: () => timings.markFirstSpeak(),
  });
  const speak = (content: string) => responses.speak(content);

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

  /** Hand a function's result back. See `ctoVoiceToolCalls` for the ordering. */
  const sendFunctionOutput = (
    callId: string,
    output: Record<string, unknown>,
    speakResult = true,
  ) => { functionCalls.answer(callId, output, speakResult); };

  /**
   * Re-send the context block.
   *
   * Cheap (one `session.update`, no audio, no response) and worth it after
   * every completed `ask_cto`: the facts in that block are exactly the ones a
   * turn is most likely to have just changed, and a model answering "nine
   * lanes" straight after creating the tenth is worse than one that asks.
   */
  const refreshSessionContext = async () => {
    if (!deps.context || !call.socketOpen) return;
    try {
      const context = await deps.context();
      if (!call.socketOpen) return;
      send({
        ...buildCtoVoiceInstructionsUpdate({
          ctoName: deps.ctoName(),
          projectName: deps.projectName(),
          context,
          acknowledgeAloud: deps.backchannelsEnabled(),
        }),
        event_id: randomUUID(),
      });
    } catch (error) {
      // A stale context block is a worse answer, not a broken call.
      deps.logger?.warn("cto_voice.context_refresh_failed", { error: String(error) });
    }
  };

  /**
   * Take the next request off the queue and run it, until the queue is empty.
   *
   * Serial by construction, and that is what stops two requests being lost:
   * the next turn cannot start until
   * the previous `runBackendTurn` has RETURNED, so a replace can never reach
   * `runSessionTurn` while the turn it aborted is still unwinding on the one
   * CTO session ("Session already has an active background turn"). Awaiting the
   * interrupt promise was not enough — that resolves when the interrupt is
   * asked for, not when the turn it interrupts is over.
   */
  async function drainAskQueue(): Promise<void> {
    if (call.askDraining || call.askCtoRunning) return;
    // The loop belongs to the record it started on, and says so rather than
    // reading `call` back each time. `start` replaces that record wholesale, so
    // a loop still awaiting an aborted turn when the NEXT call begins would
    // otherwise wake up on the new call's queue and run a turn beside that
    // call's own drain loop — two turns on the one CTO session.
    const session = call;
    session.askDraining = true;
    try {
      for (;;) {
        if (session !== call) return;
        const next = session.askQueue.shift();
        if (!next) return;
        await runAskCto(next);
      }
    } finally {
      session.askDraining = false;
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
      timings.close(job.timing, "refused");
      sendFunctionOutput(job.callId, {
        status: "busy",
        answer: "",
        reason: "ADE is still waiting for the user to approve or decline the pending action.",
      });
      return;
    }

    if (!call.askCtoRunning) {
      call.askQueue.push(job);
      void drainAskQueue();
      return;
    }

    // The cap is the conversation's, not the queue's: a third request stacked
    // behind two is one the user has stopped waiting for. Replace is capped the
    // same way — it is still a request that has to be answered in order.
    if (call.askQueue.length >= CTO_VOICE_ASK_QUEUE_LIMIT) {
      timings.close(job.timing, "refused");
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
      call.askQueue.unshift(job);
      abortRunningAsk();
      return;
    }
    call.askQueue.push(job);
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
      timings.close(timing, "refused");
      sendFunctionOutput(callId, {
        status: "busy",
        answer: "",
        reason: "ADE is still waiting for the user to approve or decline the pending action.",
      });
      return;
    }

    // The call is over. `endCall` aborts the running turn and empties the
    // queue, but the loop that owns them is still unwinding, and a job it had
    // already taken would otherwise run a full CTO turn after hang-up.
    if (!started) return;

    // Held locally, not read back off the module binding. By the time this
    // turn's await settles, `askCtoAbort` names the controller of whatever
    // replaced it, so checking the binding asks the wrong question: the
    // replaced turn sees "not aborted" and answers over the live one.
    const controller = new AbortController();
    askCtoAbort = controller;
    call.askCtoRunning = true;
    // Only when nothing is coming out of the speaker: the model's own
    // acknowledgement is usually still playing, and `thinking` would take the
    // HUD off `speaking` while the user can still hear it.
    if (state.phase !== "speaking") setPhase("thinking");

    try {
      const image = call.pendingImage;
      call.pendingImage = null;
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
        timings.close(timing, "superseded");
        sendFunctionOutput(callId, { status: "superseded", answer: "" }, false);
        return;
      }

      const status = result.status ?? "completed";
      if (status === "completed") {
        // Always, including the null: `sceneSource` is the CURRENT answer's
        // picture, and only ever nulling it at call start left a chart from four
        // turns ago on the HUD for the rest of the call. Only a COMPLETED
        // answer writes it, though — a turn that failed or was talked over has
        // no picture of its own, and blanking the one on screen would take away
        // the chart the user is still reading.
        emit({ sceneSource: result.sceneSource ?? null });
        const answer = result.spoken.trim();
        // An answer that will be spoken leaves its timing line open on purpose:
        // the last leg is the first audio the user hears, which has not happened
        // yet. An answer with nothing in it never will, so it is written here.
        if (!answer.length) timings.close(timing, "silent");
        else timings.handOverToSpeak(timing);
        sendFunctionOutput(callId, { status: "ok", answer });
      } else {
        timings.close(timing, status === "interrupted" ? "superseded" : "backend_failed");
        sendFunctionOutput(callId, {
          status,
          answer: "",
          ...(result.reason ? { reason: result.reason } : {}),
        });
      }
    } catch (error) {
      if (controller.signal.aborted) {
        timings.close(timing, "superseded");
        sendFunctionOutput(callId, { status: "superseded", answer: "" }, false);
        return;
      }
      deps.logger?.warn("cto_voice.backend_failed", { error: String(error) });
      timings.close(timing, "backend_failed");
      // The error itself never travels: the model would read it out.
      sendFunctionOutput(callId, {
        status: "failed",
        answer: "",
        reason: "The CTO could not be reached just now. Nothing was changed.",
      });
    } finally {
      if (askCtoAbort === controller) {
        askCtoAbort = null;
        call.askCtoRunning = false;
        if (state.phase === "thinking" && !call.askQueue.length) setPhase("listening");
      }
      // Last, and only for a turn nothing is waiting behind: a replaced turn's
      // facts are older than the one that replaced it, and a refresh between
      // two queued turns is a session update the second one pays for twice.
      if (!call.askQueue.length && !controller.signal.aborted) void refreshSessionContext();
    }
  }

  /**
   * The sub-modules a new call must not inherit anything from.
   *
   * They keep their own state and are reset rather than replaced, so unlike
   * `CallSession` this IS a list — which is why it is one list in one place:
   * a response id left behind makes the first barge-in cancel a response the
   * SERVER created, a previous call's burst shuts this one's gate, and a stale
   * mic reading votes on this call's first spoken yes.
   *
   * The timing recorder is deliberately absent. Its records are flushed by
   * `closeAll` on the way out, because a turn the hang-up landed in the middle
   * of is still a measurement; clearing it here would throw away the line that
   * says why the last call felt slow.
   */
  function resetSubModules(): void {
    responses.reset();
    functionCalls.reset();
    mic.reset();
    preOpenAudio.forgetCall();
    burstValve.reset();
    // Not a module, but the same lifetime: an id answered on the last call
    // must not make this call's first question a no-op.
    resolvedConfirmations.clear();
  }

  /** Abort the running `ask_cto`, if there is one. Returns whether there was. */
  function abortRunningAsk(): boolean {
    if (!call.askCtoRunning || !askCtoAbort) return false;
    askCtoAbort.abort();
    // The HUD moves now; the turn itself keeps unwinding on the CTO session and
    // clears `askCtoRunning` in its own `finally`, which is what the drain loop
    // waits for.
    if (state.phase === "thinking" && !call.askQueue.length) setPhase("listening");
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
    const waiting = call.askQueue;
    call.askQueue = [];
    for (const job of waiting) {
      timings.close(job.timing, "cancelled");
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
    if (!call.endAfterSpeech || endAfterSpeechTimer || !started) return;
    const waitMs = Math.max(0, call.outputAudioDeadlineMs - now()) + CTO_VOICE_END_CALL_AUDIO_TAIL_MS;
    deps.logger?.info("cto_voice.end_call_scheduled", { callId: state.callId, waitMs });
    endAfterSpeechTimer = setTimeout(() => {
      endAfterSpeechTimer = null;
      void endCall("assistant_end");
    }, waitMs);
    endAfterSpeechTimer.unref?.();
  }

  /** A tool name the model invented. Answered, so nothing is left dangling. */
  const unknownTool = (callId: string) => {
    sendFunctionOutput(callId, { status: "unknown_tool" });
  };

  /**
   * What each of the model's function calls does, by the tool's name.
   *
   * A table keyed by the tool constants rather than five `if (name === …)` in a
   * row, because the names are a closed list and this is the shape of one: a
   * tool added to `CTO_VOICE_REALTIME_TOOLS` with nothing here is a missing key
   * rather than a branch that was never written.
   */
  const toolHandlers: Record<string, (callId: string, argumentsJson: string) => void> = {
    [CTO_VOICE_TOOL_ASK_CTO]: (callId, argumentsJson) => {
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
      const timing = timings.take();
      scheduleAskCto({ callId, request, timing }, mode);
    },

    [CTO_VOICE_TOOL_CANCEL_WORK]: (callId) => {
      const stopped = cancelRunningWork();
      // Nothing to stop asks for no response, and that is measured rather than
      // tidy: the model says "Okay, stopping that now" in the same breath as
      // the call, and the response this output would have asked for adds a
      // second, unwanted sentence — "There's nothing running to stop right
      // now" — about a race the user cannot see.
      // A cancel that DID stop something is worth confirming.
      sendFunctionOutput(
        callId,
        stopped ? { status: "cancelled" } : { status: "nothing_running" },
        stopped,
      );
    },

    [CTO_VOICE_TOOL_END_CALL]: (callId) => {
      call.endAfterSpeech = true;
      // Answered so the conversation is not left holding an open call, and
      // deliberately without asking for a response: the goodbye is in the same
      // response this call arrived in, and a second one would talk over it.
      sendFunctionOutput(callId, { status: "ok" }, false);
      // The call arrives either a beat before its response finishes
      // (`response.function_call_arguments.done`) or from the finished response
      // itself. In the first case the goodbye is still being generated, so the
      // hang-up is scheduled by `response.done`; in the second there is nothing
      // left to wait for but the audio.
      if (!responses.isActive()) scheduleEndAfterSpeech();
    },

    [CTO_VOICE_TOOL_APPROVE]: (callId) => { answerPending(callId, true); },
    [CTO_VOICE_TOOL_DENY]: (callId) => { answerPending(callId, false); },
  };

  /** The model heard a yes or a no. The two differ only in the last line. */
  function answerPending(callId: string, approved: boolean) {
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
    if (approved) approvePending("voice");
    else denyPending();
    sendFunctionOutput(callId, { status: "ok" });
  }

  /** One function call from the model, dispatched by name. */
  function handleFunctionCall(name: string, callId: string, argumentsJson: string) {
    if (!functionCalls.claim(callId)) return;
    deps.logger?.info("cto_voice.function_call", { callId: state.callId, tool: name });
    // `hasOwn`, not a bare lookup: the name comes off the wire, and `toString`
    // would otherwise reach `Object.prototype`'s own member and call it.
    const handler = Object.hasOwn(toolHandlers, name) ? toolHandlers[name] : undefined;
    (handler ?? unknownTool)(callId, argumentsJson);
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
  function handleUserTranscript(text: string) {
    const final = text.trim();
    // Read once, before anything resets it, so every log line below describes
    // the same evidence, and before `mic.reset()` — the confirmation verdict is
    // made on these frames.
    const reading = mic.read();
    const pending = state.pendingConfirmation;
    // Judged ONLY when there is a question open. Everywhere else the meter has
    // no vote: the model already answered whatever it heard, and a caption the
    // meter vetoed is a sentence the user watched disappear.
    // Read whether or not anything is pending, so a call that never asked a
    // question still lets quiet reopen the valve.
    const valveShut = burstValve.isShut();
    const confirmationRejection = pending
      ? (valveShut ? ("runaway" satisfies CtoVoiceTranscriptRejection) : judgeVoiceTranscript(final, reading))
      : null;
    const acceptedAtMs = now();
    // Whatever was part-heard is now either final or gone.
    if (state.pendingUserText !== null) emit({ pendingUserText: null });
    if (!ctoVoiceTranscriptHasSpeech(final)) {
      deps.logger?.info("cto_voice.transcript_rejected", {
        callId: state.callId,
        scope: "caption",
        reason: "empty" satisfies CtoVoiceTranscriptRejection,
        text: final,
        peak: Number(reading.peak.toFixed(3)),
        voicedMs: Math.round(reading.voicedMs),
        frames: reading.frames,
        framesWhileIdle: reading.framesWhileIdle,
      });
      // A transcript with no letters and no digits is silence the transcriber
      // could not resist writing something about, and there is nothing to
      // caption. The utterance is burned so a redelivered transcription cannot
      // try the same words again, and the meter starts clean so this segment's
      // silence cannot be counted towards the next one.
      call.utterance = { id: call.utterance.id, text: "", open: false };
      mic.reset();
      // The barge-in this segment carried is over, even though its transcript
      // was nothing. Left true, the next one is not a false→true edge and the
      // runtime keeps its stale audio queued and talks over the user with it.
      if (state.interrupted) emit({ interrupted: false });
      return;
    }

    // The other half of the ledger. Only rejections were ever logged, so an
    // accepted phantom was invisible: the gate looked silent whether it was
    // working or waved a hallucination through. The text's LENGTH goes in the
    // log, never the text — an accepted transcript is something the user said.
    deps.logger?.info("cto_voice.transcript_accepted", {
      callId: state.callId,
      peak: Number(reading.peak.toFixed(3)),
      voicedMs: Math.round(reading.voicedMs),
      frames: reading.frames,
      framesWhileIdle: reading.framesWhileIdle,
      textLength: final.length,
    });

    // Only a record that never reached a turn is abandoned here. A turn that is
    // still running owns its own record and closes it itself — talking over
    // work that carries on is an ordinary thing to do on a hybrid call, and
    // calling that "abandoned" is how a request the CTO answered twenty-five
    // seconds later was logged as thrown away.
    timings.open(acceptedAtMs);

    call.exchanges += 1;
    burstValve.noteAccepted(acceptedAtMs);
    mic.reset();
    try {
      deps.onExchange?.({ exchanges: call.exchanges, live: true });
    } catch (error) {
      deps.logger?.warn("cto_voice.exchange_report_failed", { error: String(error) });
    }

    call.utterance.text = final;
    call.utterance.open = false;
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
          peak: Number(reading.peak.toFixed(3)),
          voicedMs: Math.round(reading.voicedMs),
          frames: reading.frames,
          framesWhileIdle: reading.framesWhileIdle,
        });
        return;
      }
      const outcome = resolveSpokenConfirmation({
        confirmation: pending,
        utteranceId: call.utterance.id,
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

  /**
   * The session exists and is configured. Whichever of the three lands first is
   * the moment the call is live; the rest are ignored.
   */
  const onSessionReady = () => {
    if (call.sessionReady) return;
    call.sessionReady = true;
    call.startedAtMs = now();
    call.startedAtIso = new Date(now()).toISOString();
    setPhase("listening");
  };

  /** A response ended, however it ended: completed, failed or cancelled. */
  const onResponseSettled = (event: CtoVoiceSettledEvent) => {
    const response = event.response ?? {};
    // The conversation has caught up: every call it was still writing is now
    // written, so anything that was waiting on one can go. Queued while the
    // lock is still held, so the release below drains it in one go.
    functionCalls.settle(typeof response.id === "string" ? response.id : null);
    // A `cancelled` response releases the lock exactly like a completed one —
    // the whole point of a barge-in is that the next thing can be said.
    responses.release();
    // Only once nothing else is queued: an acknowledgement and the answer
    // behind it are one stretch of speaking, not two.
    if (!responses.isActive() && state.phase === "speaking") {
      setPhase(call.askCtoRunning ? "thinking" : "listening");
    }
    // Last: the model's turn is over, and what it asked for is in its output.
    handleResponseFunctionCalls(response);
    // Including a goodbye asked for a beat earlier, whose audio is now all
    // generated and only waiting to be heard.
    scheduleEndAfterSpeech();
  };

  /** The model has started speaking, under either of the event's two names. */
  const onTranscriptDelta = () => { setPhase("speaking"); };

  /** What it said, under either of the event's two names. */
  const onTranscriptDone = (event: CtoVoiceTranscriptEvent) => {
    addCaption("assistant", String(event.transcript ?? ""), call.activeResponseInterrupted);
  };

  /**
   * What each event from the session does, by its `type`.
   *
   * A table rather than twenty `if (type === …)` comparisons in a row, because
   * several of these arrive under two names — the GA spelling and the older
   * one — and an alias is then two keys sharing one handler rather than a
   * condition that has to be read to find that out. An event with no entry here
   * is one this service has no opinion about.
   */
  const eventHandlers: { [K in keyof CtoVoiceServerEvent]?: (event: CtoVoiceServerEvent[K]) => void } = {
    "session.created": onSessionReady,
    "session.updated": onSessionReady,
    "conversation.created": onSessionReady,

    "input_audio_buffer.speech_started": () => {
      // A new utterance supersedes the last finished one, so a transcript
      // nobody asked the CTO about cannot be picked up minutes later.
      call.utterance = { id: randomUUID(), text: "", open: true };
      const talkingOver = responses.isActive()
        || state.phase === "speaking"
        || state.phase === "thinking";
      if (!talkingOver) {
        // A new utterance is a new turn, and the flag has to fall back between
        // them: the runtime drops its queued output audio on the false→true
        // EDGE, so a flag left true by an earlier barge-in makes the next
        // barge-in drop nothing at all and the CTO talks on.
        if (state.interrupted) emit({ interrupted: false });
        return;
      }
      // Only cancels a response ADE created; the server truncates its own.
      responses.stopSpeaking();
      // Whatever it manages to transcribe was cut off mid-sentence, and the
      // caption it produces has to say so.
      call.activeResponseInterrupted = true;
      // A question the CTO asked keeps its card on screen: the turn behind it is
      // parked inside `canUseTool` waiting for exactly this reply.
      if (state.pendingConfirmation) return;
      // The WORK is deliberately left running. Talking while the CTO works is
      // ordinary on a hybrid call — the user asks a follow-up, or thinks out
      // loud — and killing the turn for it would make the call unusable. Work
      // stops two ways and only two: `cancel_work`, and a new `ask_cto`
      // superseding it.
      emit({ interrupted: true, phase: call.askCtoRunning ? "thinking" : "listening" });
    },

    // Recorded, not acted on. The segment is judged from the microphone's own
    // frames, so this event decides nothing — but it is the moment the user
    // stopped talking, and the wait from here to a transcript is the one leg of
    // the latency that belongs entirely to OpenAI.
    "input_audio_buffer.speech_stopped": () => { timings.noteSpeechStopped(now()); },

    "conversation.item.input_audio_transcription.delta": (event) => {
      if (!call.utterance.open) {
        call.utterance = { id: randomUUID(), text: "", open: true };
      }
      call.utterance.text += String(event.delta ?? "");
      // Shown as it arrives. A final transcript can land seconds after the
      // words, and a HUD that stays empty until it does has the user repeating
      // themselves. Some surfaces deliver a transcript as one `.completed` with
      // no deltas at all, and then this simply never fires — the captions are
      // unchanged.
      const partial = call.utterance.text.trim();
      if (partial.length) emit({ pendingUserText: partial });
    },

    "conversation.item.input_audio_transcription.completed": (event) => {
      handleUserTranscript(String(event.transcript ?? call.utterance.text));
    },

    "conversation.item.input_audio_transcription.failed": (event) => {
      deps.logger?.warn("cto_voice.transcription_failed", {
        error: event.error?.message ?? null,
      });
      call.utterance = { id: randomUUID(), text: "", open: false };
      if (state.pendingUserText !== null) emit({ pendingUserText: null });
      // The barge-in this segment carried is over, however badly. Left true, the
      // next one is not an edge and the runtime keeps its stale audio queued.
      if (state.interrupted) emit({ interrupted: false });
      // One segment's audio answers for one transcript, and this one is over.
      mic.reset();
      speak("Sorry — I didn't catch that.");
      setPhase("listening");
    },

    // `response.output_audio.delta` is the GA name; `response.audio.delta` is
    // the name the same event carries on the older surface. Both are handled,
    // because one socket's vocabulary is not a thing to guess at.
    "response.output_audio.delta": onOutputAudioDelta,
    "response.audio.delta": onOutputAudioDelta,

    "response.created": (event) => {
      call.activeResponseInterrupted = false;
      const created = event.response ?? {};
      responses.noteCreated(
        typeof created.id === "string" && created.id.length ? created.id : null,
      );
    },

    "response.output_audio_transcript.delta": onTranscriptDelta,
    "response.audio_transcript.delta": onTranscriptDelta,

    "response.output_audio_transcript.done": onTranscriptDone,
    "response.audio_transcript.done": onTranscriptDone,

    "response.done": onResponseSettled,
    "response.failed": onResponseSettled,
    "response.cancelled": onResponseSettled,

    // The other spelling of the same fact, and it arrives BEFORE
    // `response.done`. Both are handled and both are deduped by `call_id`,
    // because which one a given surface sends is not a thing to guess at — and
    // this one is a beat earlier, which on a five-second turn is worth having.
    "response.function_call_arguments.done": (event) => {
      if (typeof event.call_id === "string") {
        functionCalls.noteUnsettled(
          event.call_id,
          typeof event.response_id === "string" ? event.response_id : null,
        );
      }
      handleFunctionCall(
        typeof event.name === "string" ? event.name : "",
        typeof event.call_id === "string" ? event.call_id : "",
        typeof event.arguments === "string" ? event.arguments : "",
      );
    },

    error: (event) => {
      const failure = event.error ?? event;
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
        // "Already has an active response" is the server still generating: the
        // lock is REAL, and releasing it would let the queue drain into the same
        // refusal until it was empty. The line we were refused goes back to the
        // head of the queue and waits for the `response.done` that is coming.
        if (isCtoVoiceActiveResponseConflict(rawMessage)) {
          responses.requeueRefused();
          return;
        }
        responses.release();
        return;
      }
      if (!reason.fatal) {
        emit({ error: reason.message });
        return;
      }
      // The session is over — a refused key does not recover — so this is the
      // same terminal event a rejected upgrade is, and takes the same latch so
      // the close that follows cannot overwrite it with a generic sentence.
      if (call.connectionFailureKind !== null) return;
      call.connectionFailureKind = "rejected_key";
      emit({ phase: "failed", error: reason.message });
      void endCall("session_error");
    },
  };

  /** One chunk of the model's voice, under either of its two event names. */
  function onOutputAudioDelta(event: CtoVoiceAudioDeltaEvent) {
    const delta = typeof event.delta === "string" ? event.delta : null;
    if (!delta) return;
    // The playback clock the hang-up waits on: chunks arrive faster than
    // realtime, so the end of the queue is later than the last chunk's arrival
    // by however much of it is still unplayed.
    call.outputAudioDeadlineMs = Math.max(call.outputAudioDeadlineMs, now())
      + ctoVoiceFrameDurationMs(delta);
    // The last post, and the only one the user can actually hear. Written on
    // the FIRST chunk of the response this turn's answer was queued as; every
    // later chunk finds no record and writes nothing.
    timings.markFirstAudio(now());
    deps.onOutputAudio?.(delta);
  }

  function handleEvent(raw: unknown) {
    // A closed socket still delivers whatever `ws` had already queued, and this
    // transport has no `off` to detach the listener with. Without this guard a
    // `function_call` that landed after hang-up started a real CTO turn on a
    // call that was over — racing the confirm-hold release and leaving
    // `askCtoRunning` true, so the NEXT call's first question collided with it.
    if (!started) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof event.type === "string" ? event.type : "";
    // `hasOwn`, not a bare lookup: the type comes off the wire, and `toString`
    // would otherwise reach `Object.prototype`'s own member and call it.
    if (!Object.hasOwn(eventHandlers, type)) return;
    // The ONE cast in the dispatch, and the only place it belongs: this is
    // where an untyped string off the wire becomes a key of the map. Every
    // handler past it is typed against the event it was registered under.
    const key = type as keyof CtoVoiceServerEvent;
    (eventHandlers[key] as ((event: unknown) => void) | undefined)?.(event);
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
      utteranceId: call.utterance.id,
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
      socketOpen: call.socketOpen,
    });
    if (!started) return;
    started = false;
    // Teardown only. Everything that is merely per-call state is replaced
    // wholesale by the next `start`, so nothing here is a list to keep in sync.
    if (endAfterSpeechTimer) { clearTimeout(endAfterSpeechTimer); endAfterSpeechTimer = null; }
    // A turn the hang-up landed in the middle of is still a measurement, and
    // the answer it was waiting for is about to be thrown away. Both slots: the
    // answer nobody heard, and the utterance nothing ran for.
    timings.closeAll("call_ended");
    for (const job of call.askQueue) timings.close(job.timing, "call_ended");
    // Emptied, not just measured: the drain loop reads this queue again after
    // the turn it is awaiting unwinds, and anything left here is a CTO turn
    // that runs on a call the user has hung up.
    call.askQueue = [];
    const closing = socket;
    socket = null;
    // Not "for the next call" — for the rest of THIS teardown: no send may go
    // out at a socket that is closing, and the close below must be read as ours.
    call.socketOpen = false;
    functionCalls.dropPendingOutputs();
    responses.reset();
    // Frames captured against a socket that is closing. Nothing will send them,
    // and they are not the next call's first sentence.
    preOpenAudio.forgetCall();
    askCtoAbort?.abort();
    askCtoAbort = null;
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
    releaseApprovalWatch?.();
    releaseApprovalWatch = null;
    // Set before the close, because `ws` reports it synchronously.
    call.deliberateClose = true;
    try { closing?.close(); } catch { /* already gone */ }

    // Restore full-auto first: a call that ended must not leave the CTO asking
    // for confirmation in the thread.
    try {
      await deps.setCallConfirmMode?.(false);
    } catch (error) {
      deps.logger?.warn("cto_voice.confirm_mode_restore_failed", { error: String(error) });
    }

    const endedAt = new Date(now()).toISOString();
    const elapsedMs = call.startedAtMs ? now() - call.startedAtMs : 0;

    // The durable write happens whatever else failed. A call the user had is a
    // call the CTO must remember.
    try {
      await deps.persistCall({
        callId: state.callId ?? randomUUID(),
        startedAt: call.startedAtIso || endedAt,
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
      deps.onExchange?.({ exchanges: call.exchanges, live: false });
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
    getConnectionFailureKind: () => call.connectionFailureKind,

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

      // A second call on this service inherits NOTHING from the first: not its
      // half-open utterance, not its opinion about a response, not the failure
      // it died of. One assignment rather than a list, so a field added to
      // `CallSession` is reset here by construction.
      call = freshCallSession();
      resetSubModules();

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
      let sessionContext = "";
      try {
        sessionContext = deps.context ? await deps.context() : "";
      } catch (error) {
        deps.logger?.warn("cto_voice.context_failed", { error: String(error) });
      }

      // The user can hang up while the awaits above are still running — the HUD
      // is on screen from `connecting`. Without this the socket below would be
      // opened for a call that is already over, and nothing would close it.
      if (!started) return { ok: false, error: "ended" };

      socket = (deps.createWebSocket ?? defaultSocket)(ctoVoiceEndpointUrl(), apiKey);
      // The socket the message pump belongs to. There is no `off` on this
      // transport, so "detached" is expressed as "the service has moved on":
      // events from a socket this service has let go are not read at all. The
      // failure listeners below deliberately stay attached — `failConnection`
      // and `endCall` are idempotent, and their lines are the trace that says
      // which way a call died.
      const attached = socket;
      socket.on("open", () => {
        // The call can be ended, or fail, before the socket finishes opening.
        // Without this the late handler arms a 10 Hz interval that nothing will
        // ever clear, once per abandoned call.
        if (socket !== attached) return;
        call.socketOpen = true;
        send({
          ...buildCtoVoiceSessionUpdate({
            ctoName: deps.ctoName(),
            projectName: deps.projectName(),
            context: sessionContext,
            acknowledgeAloud: deps.backchannelsEnabled(),
            voice: deps.voice?.(),
          }),
          event_id: randomUUID(),
        });

        // A real microphone never stops. Without a continuous stream the session
        // stalls mid-sentence, so silence goes out whenever the user is muted.
        // Whatever the microphone produced while the handshake was in flight,
        // in order and after the session config it belongs to.
        const buffered = preOpenAudio.drain();
        for (const chunk of buffered.chunks) {
          send({ type: "input_audio_buffer.append", audio: chunk });
        }
        // A slow handshake eats the front of the first sentence, and that is a
        // thing the user notices and nobody else can see.
        if (buffered.dropped) {
          deps.logger?.warn("cto_voice.preopen_audio_dropped", {
            callId: state.callId,
            dropped: buffered.dropped,
          });
        }

        keepAlive = setInterval(() => {
          if (!socket || !call.socketOpen || !state.muted) return;
          const silence = Buffer.alloc(Math.floor(CTO_VOICE_SAMPLE_RATE * 0.1) * 2);
          send({ type: "input_audio_buffer.append", audio: silence.toString("base64") });
        }, 100);

        // Anything queued before the socket opened. `watchApprovals` is attached
        // before the connection is made, so a tool that asks during the
        // handshake has a question waiting here and nothing else would send it.
        responses.drain();
      });
      socket.on("message", (payload) => {
        if (socket !== attached) return;
        handleEvent(payload);
      });
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
        if (!call.socketOpen) {
          // The session does not exist yet. Hold the audio for the open
          // handler to flush, bounded so a socket that never opens cannot grow
          // the process.
          preOpenAudio.push(base64);
        } else {
          send({ type: "input_audio_buffer.append", audio: base64 });
        }
        // The level meter is the one thing that is still true before the socket
        // opens: the user IS talking, and the HUD should show it.
        if (typeof level === "number") {
          const clamped = Math.max(0, Math.min(1, level));
          // Recorded before the emit, because this is the evidence the
          // transcript gate rules on and a throw in `emit` must not lose it.
          mic.push({
            level: clamped,
            ms: ctoVoiceFrameDurationMs(base64),
            idle: !responses.isActive(),
          });
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
      call.pendingImage = args.pngBase64;
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
