import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

import {
  buildCtoVoiceInstructions,
  CTO_VOICE_DEFAULT,
  CTO_VOICE_ENDPOINT,
  CTO_VOICE_MODEL,
  CTO_VOICE_SAMPLE_RATE,
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
  }) => Promise<CtoVoiceBackendResult>;
  /** Called once when the call ends, with the full transcript. */
  persistCall: (args: {
    callId: string;
    startedAt: string;
    endedAt: string;
    captions: CtoVoiceCaption[];
    costUsd: number;
  }) => Promise<void>;
  onState: (state: CtoVoiceState) => void;
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
  let abort: AbortController | null = null;
  let keepAlive: NodeJS.Timeout | null = null;
  let startedAtMs = 0;
  let startedAtIso = "";

  let state: CtoVoiceState = {
    callId: null,
    phase: "idle",
    elapsedMs: 0,
    muted: false,
    inputLevel: 0,
    interrupted: false,
    captions: [],
    pendingConfirmation: null,
    sceneSource: null,
    error: null,
  };

  /** The utterance currently being transcribed, and the text so far. */
  let utteranceId = randomUUID();
  let inputBuffer = "";

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
    const intent = inputBuffer.trim();
    inputBuffer = "";
    setPhase("thinking");

    // Cover the gap immediately. The filler goes out before any backend work
    // starts, because the point of it is that the user never hears silence.
    speak(delegationId, "Let me check that.");
    think(delegationId, `The user asked: ${intent || "(no transcript captured)"}`);

    abort?.abort();
    abort = new AbortController();
    const raisedBy = utteranceId;

    try {
      const result = await deps.runBackendTurn({ intent, callId: state.callId ?? "", signal: abort.signal });

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
      if (abort?.signal.aborted) return;
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
      inputBuffer += String(event.delta ?? "");
      // Talking while the CTO speaks is a barge-in; show it landing.
      if (state.phase === "speaking") emit({ interrupted: true, phase: "listening" });
      return;
    }

    if (type === "session.input_transcript.done" || type === "session.input_transcript.completed") {
      const text = String(event.text ?? inputBuffer);
      addCaption("user", text);

      // A spoken reply may be answering a pending confirmation.
      const outcome = resolveSpokenConfirmation({
        confirmation: state.pendingConfirmation,
        utteranceId,
        text,
        nowMs: Date.now(),
      });
      if (outcome.kind === "approved") approvePending("voice");
      else if (outcome.kind === "denied") denyPending();

      utteranceId = randomUUID();
      emit({ interrupted: false });
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

  function approvePending(source: "voice" | "tap") {
    const confirmation = state.pendingConfirmation;
    if (!confirmation) return;
    deps.logger?.info("cto_voice.confirmation_approved", { tool: confirmation.toolName, source });
    // Echo the commitment before acting: it gives the user a beat to say no.
    speak(null, `Doing that now — ${confirmation.prompt.replace(/\?$/, "")}.`);
    emit({ pendingConfirmation: null, phase: "thinking" });
  }

  function denyPending() {
    if (!state.pendingConfirmation) return;
    emit({ pendingConfirmation: null, phase: "listening" });
  }

  async function endCall() {
    if (!socket) return;
    const closing = socket;
    socket = null;
    abort?.abort();
    abort = null;
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
    try { closing.close(); } catch { /* already gone */ }

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
        costUsd: (elapsedMs / 60_000) * 0.05,
      });
    } catch (error) {
      deps.logger?.warn("cto_voice.persist_failed", { error: String(error) });
    }

    emit({ phase: "ended", elapsedMs, pendingConfirmation: null, interrupted: false });
  }

  return {
    getState: () => state,

    async start(): Promise<{ ok: boolean; error?: string }> {
      if (socket) return { ok: true };
      const apiKey = await deps.getApiKey();
      if (!apiKey) {
        emit({ phase: "failed", error: "No OpenAI API key is configured." });
        return { ok: false, error: "missing-key" };
      }

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

      socket = (deps.createWebSocket ?? defaultSocket)(CTO_VOICE_ENDPOINT, apiKey);
      socket.on("open", () => {
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
