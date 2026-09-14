import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

import {
  buildCtoVoiceInstructions,
  CTO_VOICE_DEFAULT,
  CTO_VOICE_ENDPOINT,
  CTO_VOICE_MODEL,
  CTO_VOICE_INITIAL_STATE,
  CTO_VOICE_SAMPLE_RATE,
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
 * GPT Live (`gpt-live-1`) with `delegation: { type: "client" }`. The voice model
 * owns the conversation; ADE owns the reasoning and routes it to the CTO thread.
 * That split is why the CTO's thinking can stay on whatever plan it already runs
 * on while only the voice minutes bill to the user's own API key — and it is
 * also why permissions and confirmations are enforced here in code rather than
 * asked of the model in a prompt.
 *
 * Two behaviours are easy to get wrong and are load bearing:
 *
 * 1. A real microphone never stops. If the client stops sending input audio the
 *    session stalls mid-sentence — measured, not theorised. `pushAudio` keeps
 *    the stream fed and `keepAlive` sends silence when the user is muted.
 * 2. `session.delegation.created` carries an id and NO task text. The intent has
 *    to be rebuilt from `session.input_transcript.delta`, which is why this
 *    service accumulates the transcript rather than waiting for a turn object.
 */

export type CtoVoiceSocket = {
  send: (data: string) => void;
  close: () => void;
  on: (event: "open" | "message" | "close" | "error", handler: (payload?: unknown) => void) => void;
};

export type CtoVoiceBackendResult = {
  /** Spoken back to the user, paraphrased by the voice model. */
  spoken: string;
  /** Optional scene the turn drew. */
  sceneSource?: string | null;
  /** Set when the backend wants to run something that changes state. */
  confirmation?: { toolName: string; prompt: string } | null;
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
   * imports the chat service, and so the delegation loop is testable without a
   * model.
   */
  runBackendTurn: (args: {
    intent: string;
    callId: string;
    signal: AbortSignal;
    /**
     * A window the user captured mid-call, base64 PNG. It goes to the CTO
     * thread, never to the voice model: GPT Live's client-delegation appends
     * carry a plain string, so the only place an image can actually be read is
     * the backend that does the thinking.
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
   * Open and close the call's read-only window. A call shares the CTO's one
   * session and there is no per-turn permission argument, so the guarantee that
   * a spoken word cannot reach a writing tool has to be held open for the
   * duration of the call and released on hang-up.
   */
  /** Put the CTO in confirm-first mode for the life of the call. */
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
    onApproval: (args: { itemId: string; toolName: string; prompt: string }) => void,
  ) => () => void;
  onState: (state: CtoVoiceState) => void;
  /** One chunk of output audio, base64 PCM16, for the renderer to play. */
  onOutputAudio?: (base64: string) => void;
  logger?: { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void };
  /** Injected for tests; defaults to a real ws client. */
  createWebSocket?: (url: string, apiKey: string) => CtoVoiceSocket;
};

function defaultSocket(url: string, apiKey: string): CtoVoiceSocket {
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    on: (event, handler) => socket.on(event, handler as (...args: unknown[]) => void),
  };
}

export function createCtoVoiceCallService(deps: CtoVoiceCallDeps) {
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
  let abort: AbortController | null = null;
  let keepAlive: NodeJS.Timeout | null = null;
  let startedAtMs = 0;
  let startedAtIso = "";

  let state: CtoVoiceState = { ...CTO_VOICE_INITIAL_STATE };

  /**
   * The utterance being transcribed right now.
   *
   * One record, because it is one thing. The id turns over when a NEW utterance
   * opens, never when one finishes: `session.delegation.created` can land
   * either side of `session.input_transcript.done`, and rotating on `done` made
   * the identity depend on which arrived first. A confirmation raised after the
   * transcript closed was then bound to the id the user's NEXT reply would
   * carry, and the "same utterance" guard rejected every spoken yes forever.
   *
   * `text` survives `done` for the same reason — a delegation for this
   * utterance may still be in flight — and is cleared when a turn consumes it
   * or a new utterance opens, so an utterance the voice model answered by
   * itself can never glue onto the front of a later intent.
   */
  let utterance = { id: randomUUID(), text: "", open: false, consumed: false };

  /** Cleared as soon as it is handed to a turn — one capture, one delegation. */
  let pendingImage: string | null = null;

  const emit = (patch: Partial<CtoVoiceState>) => {
    state = { ...state, ...patch };
    deps.onState(state);
  };

  const setPhase = (phase: CtoVoicePhase) => emit({ phase });

  const send = (payload: Record<string, unknown>) => {
    if (!socket) return;
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

  /** Spoken, paraphrased by the voice model. Requires the delegation id. */
  const speak = (delegationId: string | null, content: string) => {
    send({ type: "session.commentary.append", event_id: randomUUID(), delegation_id: delegationId, content });
  };

  /** Silent context the model may use but must not read aloud. */
  const think = (delegationId: string | null, content: string) => {
    send({ type: "session.thinking.append", event_id: randomUUID(), delegation_id: delegationId, content });
  };

  async function handleDelegation(delegationId: string) {
    // A closed utterance may be delegated exactly once. Without this, a
    // delegation that arrives before the NEXT utterance's first delta reads the
    // previous one — asking the CTO the question it just answered, and binding
    // any confirmation to an id the user's reply can no longer carry.
    const intent = utterance.consumed ? "" : utterance.text.trim();
    utterance.text = "";
    utterance.consumed = true;

    // Nothing was said — the delegation arrived before any transcript, or
    // against an utterance a previous turn already consumed. Asking the thread
    // an empty question would burn a turn and write a blank user message, but
    // the delegation still has to be answered: every other path replies, and a
    // delegation left hanging is a model waiting on a client that never speaks.
    if (!intent.length) {
      deps.logger?.warn("cto_voice.delegation_without_intent", { delegationId });
      speak(delegationId, "Sorry — I didn't catch that.");
      setPhase("listening");
      return;
    }
    setPhase("thinking");

    // Cover the gap immediately. The filler goes out before any backend work
    // starts, because the point of it is that the user never hears silence.
    speak(delegationId, "Let me check that.");
    think(delegationId, `The user asked: ${intent}`);

    // Held locally, not read back off `abort`. By the time this turn's await
    // settles, `abort` names the controller of whatever turn SUPERSEDED it, so
    // checking the module binding asks the wrong question: the superseded turn
    // sees "not aborted" and speaks its answer over the one the user is
    // actually waiting for.
    const controller = new AbortController();
    abort?.abort();
    abort = controller;
    const raisedBy = utterance.id;

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

      if (result.confirmation) {
        const confirmation = buildConfirmation({
          id: randomUUID(),
          toolName: result.confirmation.toolName,
          prompt: result.confirmation.prompt,
          utteranceId: raisedBy,
          nowMs: Date.now(),
        });
        emit({ pendingConfirmation: confirmation, phase: "confirming" });
        speak(delegationId, result.spoken || confirmation.prompt);
        return;
      }

      if (result.sceneSource) emit({ sceneSource: result.sceneSource });
      speak(delegationId, result.spoken);
      setPhase("speaking");
    } catch (error) {
      if (controller.signal.aborted) return;
      deps.logger?.warn("cto_voice.backend_failed", { error: String(error) });
      speak(delegationId, "That didn't work. I couldn't reach the project state just now.");
      setPhase("listening");
    }
  }

  function handleEvent(raw: unknown) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof event.type === "string" ? event.type : "";

    if (type === "session.started") {
      startedAtMs = Date.now();
      startedAtIso = new Date().toISOString();
      setPhase("listening");
      return;
    }

    if (type === "session.input_transcript.delta") {
      if (!utterance.open) {
        // A new utterance supersedes the last finished one, so a transcript
        // nobody delegated cannot be picked up minutes later.
        utterance = { id: randomUUID(), text: "", open: true, consumed: false };
      }
      utterance.text += String(event.delta ?? "");
      // Talking while the CTO speaks is a barge-in; show it landing.
      if (state.phase === "speaking") emit({ interrupted: true, phase: "listening" });
      return;
    }

    if (type === "session.input_transcript.done" || type === "session.input_transcript.completed") {
      // The final text replaces whatever the deltas built, and is kept rather
      // than cleared: a delegation for THIS utterance may still be in flight.
      const text = String(event.text ?? utterance.text);
      utterance.text = text;
      utterance.open = false;
      addCaption("user", text);

      // A spoken reply may be answering a pending confirmation.
      const outcome = resolveSpokenConfirmation({
        confirmation: state.pendingConfirmation,
        utteranceId: utterance.id,
        text,
        nowMs: Date.now(),
      });
      if (outcome.kind === "approved") approvePending("voice");
      else if (outcome.kind === "denied") denyPending();

      emit({ interrupted: false });
      return;
    }

    if (type === "session.output_audio.delta") {
      const delta = typeof event.delta === "string" ? event.delta : null;
      if (delta) deps.onOutputAudio?.(delta);
      return;
    }

    if (type === "session.output_transcript.delta") {
      setPhase("speaking");
      return;
    }

    if (type === "session.output_transcript.done") {
      addCaption("assistant", String(event.text ?? ""));
      if (state.phase === "speaking") setPhase("listening");
      return;
    }

    if (type === "session.delegation.created") {
      const delegation = (event.delegation ?? {}) as Record<string, unknown>;
      const id = typeof delegation.id === "string" ? delegation.id : null;
      if (id) void handleDelegation(id);
      return;
    }

    if (type === "error") {
      const error = (event.error ?? {}) as Record<string, unknown>;
      const message = typeof error.message === "string" ? error.message : "Live session error";
      deps.logger?.warn("cto_voice.session_error", { message });
      emit({ error: message });
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
  function raiseApproval(args: { itemId: string; toolName: string; prompt: string }) {
    if (!started) return;
    const confirmation = buildConfirmation({
      id: randomUUID(),
      toolName: args.toolName,
      prompt: args.prompt,
      utteranceId: utterance.id,
      nowMs: Date.now(),
      approvalItemId: args.itemId,
    });
    emit({ pendingConfirmation: confirmation, phase: "confirming" });
    // Spoken with no delegation id: this is ADE asking, not an answer to a
    // question the voice model delegated.
    speak(null, confirmation.destructive
      ? `${confirmation.prompt} That one needs a tap — I have put a card on screen.`
      : confirmation.prompt);
  }

  function approvePending(source: "voice" | "tap") {
    const confirmation = state.pendingConfirmation;
    if (!confirmation) return;
    deps.logger?.info("cto_voice.confirmation_approved", { tool: confirmation.toolName, source });
    // Echo the commitment before acting: it gives the user a beat to say no.
    speak(null, `Doing that now — ${confirmation.prompt.replace(/\?$/, "")}.`);
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

  async function endCall() {
    if (!started) return;
    started = false;
    const closing = socket;
    socket = null;
    abort?.abort();
    abort = null;
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
    releaseApprovalWatch?.();
    releaseApprovalWatch = null;
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

      socket = (deps.createWebSocket ?? defaultSocket)(CTO_VOICE_ENDPOINT, apiKey);
      socket.on("open", () => {
        // The call can be ended, or fail, before the socket finishes opening.
        // Without this the late handler arms a 10 Hz interval that nothing will
        // ever clear, once per abandoned call.
        if (!socket) return;
        send({
          type: "session.start",
          event_id: randomUUID(),
          session: {
            model: CTO_VOICE_MODEL,
            instructions: buildCtoVoiceInstructions({
              ctoName: deps.ctoName(),
              projectName: deps.projectName(),
              backchannels: deps.backchannelsEnabled(),
            }),
            audio: {
              format: { type: "audio/pcm", rate: CTO_VOICE_SAMPLE_RATE },
              output: { voice: deps.voice?.() ?? CTO_VOICE_DEFAULT },
            },
            delegation: { type: "client" },
          },
        });

        // A real microphone never stops. Without a continuous stream the session
        // stalls mid-sentence, so silence goes out whenever the user is muted.
        keepAlive = setInterval(() => {
          if (!socket || !state.muted) return;
          const silence = Buffer.alloc(Math.floor(CTO_VOICE_SAMPLE_RATE * 0.1) * 2);
          send({ type: "session.input_audio.append", audio: silence.toString("base64") });
        }, 100);
      });
      socket.on("message", (payload) => handleEvent(payload));
      socket.on("error", (payload) => {
        deps.logger?.warn("cto_voice.socket_error", { error: String(payload) });
        emit({ phase: "failed", error: "The voice connection failed." });
      });
      socket.on("close", () => { void endCall(); });

      return { ok: true };
    },

    /** Mic frames from the renderer: base64 PCM16 at the session sample rate. */
    pushAudio(base64: string, level?: number) {
      if (!socket || state.muted) return;
      send({ type: "session.input_audio.append", audio: base64 });
      if (typeof level === "number") emit({ inputLevel: Math.max(0, Math.min(1, level)) });
    },

    /**
     * Hand the call something the user is looking at. The image waits for the
     * next delegation; the voice model is only told that it happened, because
     * it cannot read one.
     */
    attachImage(args: { pngBase64: string; note: string }) {
      if (!socket) return;
      pendingImage = args.pngBase64;
      think(null, args.note || "The user shared the window they are looking at. It is attached to the next backend request.");
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

    end: endCall,
  };
}

export type CtoVoiceCallService = ReturnType<typeof createCtoVoiceCallService>;
