import React, { useCallback, useEffect, useRef, useState } from "react";
import { Microphone, MicrophoneSlash, PhoneDisconnect, Waveform } from "@phosphor-icons/react";
import type { AgentChatCodexRealtimeCaption } from "../../../shared/types";
import { formatCodexVoiceDuration, type CodexVoicePreferences } from "../../../shared/codexVoice";
import { cn } from "../ui/cn";
import { SmartTooltip } from "../ui/SmartTooltip";
import { microphonePermissionGuidance } from "./microphonePermissionGuidance";

/**
 * Voice conversations: talk with any chat, carried by Codex voice.
 *
 * The renderer owns the WebRTC connection: it captures the microphone, plays
 * the model's audio, and sends only its SDP offer to the brain, which hands it
 * to a Codex app server (`thread/realtime/start`) and returns the answer. The
 * session runs on the user's ChatGPT sign-in: on a Codex chat's own thread, or
 * on a private voice host for any other chat (see codexVoiceSession.ts).
 *
 * Live state has two sources. Audio levels come from the local and remote
 * tracks, so the meter needs no IPC. Captions and "Codex is working" come from
 * the brain, read every `STATE_POLL_MS` while the session is live; the chat
 * itself gets one summary line when the session ends.
 */

const STATE_POLL_MS = 300;
const LEVEL_TICK_MS = 80;
/** RMS above this counts as sound; below it is room noise. */
const SPEAKING_THRESHOLD = 0.035;
/** How long "Speaking" lingers after the model's audio drops, so it does not flicker between words. */
const SPEAKING_HOLD_MS = 450;

type Phase = "idle" | "connecting" | "live";

type VoiceConnection = {
  sessionId: string;
  token: string | null;
  pc: RTCPeerConnection;
  stream: MediaStream;
  audio: HTMLAudioElement;
  audioContext: AudioContext | null;
  micAnalyser: AnalyserNode | null;
  speakerAnalyser: AnalyserNode | null;
};

export type CodexVoiceController = {
  phase: Phase;
  muted: boolean;
  startedAt: number | null;
  micLevel: number;
  speaking: boolean;
  working: boolean;
  captions: AgentChatCodexRealtimeCaption[];
  start: () => void;
  stop: () => void;
  toggleMute: () => void;
};

function logVoice(message: string, detail?: unknown): void {
  if (detail === undefined) console.info(`[codex-voice] ${message}`);
  else console.info(`[codex-voice] ${message}`, detail);
}

function rms(analyser: AnalyserNode | null, buffer: Float32Array<ArrayBuffer>): number {
  if (!analyser) return 0;
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) sum += buffer[i]! * buffer[i]!;
  return Math.sqrt(sum / buffer.length);
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "").trim();
}

/**
 * One voice session for one chat. Pass `null` when voice does not apply (voice
 * is off, Codex is not signed in, or a grid tile); a live session then ends.
 */
export function useCodexVoice({
  sessionId,
  preferences,
  onError,
}: {
  sessionId: string | null;
  preferences: CodexVoicePreferences;
  onError?: (message: string) => void;
}): CodexVoiceController {
  const [phase, setPhase] = useState<Phase>("idle");
  const [muted, setMuted] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [micLevel, setMicLevel] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const [working, setWorking] = useState(false);
  const [captions, setCaptions] = useState<AgentChatCodexRealtimeCaption[]>([]);
  const connectionRef = useRef<VoiceConnection | null>(null);
  // Advanced by every start and every teardown. A start checks it after each
  // await, so End (or a chat switch) while the mic or the brain is still
  // answering cancels that start instead of letting it go live.
  const attemptRef = useRef(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  // Read at start time; a settings change applies to the next conversation.
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;

  const teardown = useCallback((notifyBrain: boolean) => {
    attemptRef.current += 1;
    const connection = connectionRef.current;
    connectionRef.current = null;
    if (connection) {
      connection.stream.getTracks().forEach((track) => track.stop());
      connection.pc.close();
      connection.audio.pause();
      connection.audio.srcObject = null;
      void connection.audioContext?.close().catch(() => {});
      // Without a token the start is still in flight; it stops its own brain
      // session when it returns. A token-less stop could end a session another
      // window just started on the same chat.
      if (notifyBrain && connection.token) {
        void window.ade.agentChat.codex
          .realtimeStop({ sessionId: connection.sessionId, token: connection.token })
          .catch((error: unknown) => logVoice("stop failed", error));
      }
    }
    setPhase("idle");
    setMuted(false);
    setStartedAt(null);
    setMicLevel(0);
    setSpeaking(false);
    setWorking(false);
    setCaptions([]);
  }, []);

  // Switching chats, leaving voice-capable chats, or unmounting ends the call:
  // audio must not outlive the chat it belongs to.
  // Teardown also cancels a start that has no connection yet.
  useEffect(() => () => teardown(true), [sessionId, teardown]);

  // A closing window cannot run React cleanup; end the call on the way out.
  useEffect(() => {
    const onPageHide = () => teardown(true);
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [teardown]);

  const start = useCallback(async () => {
    if (!sessionId || connectionRef.current) return;
    attemptRef.current += 1;
    const attempt = attemptRef.current;
    setPhase("connecting");
    setStartedAt(null);
    const startedAtMs = performance.now();
    // On macOS, Electron hands back a silent track instead of throwing when the
    // OS has not granted the microphone, so ask for system access first (the
    // same gate dictation uses) rather than opening a call that hears nothing.
    const ensureAccess = window.ade?.transcription?.requestMicAccess;
    if (ensureAccess) {
      const access = await ensureAccess().catch(() => null);
      if (attemptRef.current !== attempt) return;
      if (access && access.status !== "granted") {
        setPhase("idle");
        onErrorRef.current?.(microphonePermissionGuidance());
        return;
      }
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      logVoice("microphone unavailable", error);
      if (attemptRef.current === attempt) {
        setPhase("idle");
        onErrorRef.current?.(microphonePermissionGuidance());
      }
      return;
    }
    if (attemptRef.current !== attempt) {
      // Ended while the microphone was opening.
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const pc = new RTCPeerConnection();
    const audio = new Audio();
    audio.autoplay = true;
    let audioContext: AudioContext | null = null;
    let micAnalyser: AnalyserNode | null = null;
    try {
      audioContext = new AudioContext();
      micAnalyser = audioContext.createAnalyser();
      micAnalyser.fftSize = 512;
      audioContext.createMediaStreamSource(stream).connect(micAnalyser);
    } catch (error) {
      logVoice("level meter unavailable", error);
    }
    const connection: VoiceConnection = {
      sessionId,
      token: null,
      pc,
      stream,
      audio,
      audioContext,
      micAnalyser,
      speakerAnalyser: null,
    };
    connectionRef.current = connection;
    pc.ontrack = (event) => {
      const remote = event.streams[0] ?? new MediaStream([event.track]);
      audio.srcObject = remote;
      if (audioContext) {
        try {
          const analyser = audioContext.createAnalyser();
          analyser.fftSize = 512;
          audioContext.createMediaStreamSource(remote).connect(analyser);
          connection.speakerAnalyser = analyser;
        } catch (error) {
          logVoice("speaker meter unavailable", error);
        }
      }
    };
    pc.onconnectionstatechange = () => {
      logVoice(`connection ${pc.connectionState}`);
      if (pc.connectionState === "failed" && connectionRef.current === connection) {
        teardown(true);
        onErrorRef.current?.("Voice lost its connection to OpenAI.");
      }
    };
    for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
    // OpenAI's realtime endpoint expects this data channel in the offer.
    pc.createDataChannel("oai-events");
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const result = await window.ade.agentChat.codex.realtimeStart({
        sessionId,
        sdp: offer.sdp ?? "",
        preferences: preferencesRef.current,
      });
      if (connectionRef.current !== connection) {
        // Stopped while connecting: the brain session exists now, so end it.
        void window.ade.agentChat.codex.realtimeStop({ sessionId, token: result.token }).catch(() => {});
        return;
      }
      connection.token = result.token;
      await pc.setRemoteDescription({ type: "answer", sdp: result.sdp });
      await audioContext?.resume().catch(() => {});
      logVoice(`live on thread ${result.threadId} after ${Math.round(performance.now() - startedAtMs)}ms`);
      setStartedAt(Date.now());
      setPhase("live");
    } catch (error) {
      logVoice("start failed", error);
      if (connectionRef.current !== connection) return;
      teardown(false);
      onErrorRef.current?.(`Voice could not start: ${cleanError(error)}`);
    }
  }, [sessionId, teardown]);

  const stop = useCallback(() => teardown(true), [teardown]);
  const startVoice = useCallback(() => void start(), [start]);

  const toggleMute = useCallback(() => {
    const connection = connectionRef.current;
    if (!connection) return;
    setMuted((current) => {
      const next = !current;
      connection.stream.getAudioTracks().forEach((track) => {
        track.enabled = !next;
      });
      return next;
    });
  }, []);

  // Audio levels, sampled from the tracks themselves.
  useEffect(() => {
    if (phase !== "live") return;
    const buffer = new Float32Array(512);
    let lastSpokeAt = 0;
    const timer = window.setInterval(() => {
      const connection = connectionRef.current;
      if (!connection) return;
      const mic = connection.stream.getAudioTracks().some((track) => track.enabled)
        ? rms(connection.micAnalyser, buffer)
        : 0;
      setMicLevel(Math.min(1, mic / 0.2));
      const now = performance.now();
      if (rms(connection.speakerAnalyser, buffer) > SPEAKING_THRESHOLD) lastSpokeAt = now;
      setSpeaking(now - lastSpokeAt < SPEAKING_HOLD_MS);
    }, LEVEL_TICK_MS);
    return () => window.clearInterval(timer);
  }, [phase]);

  // Captions and work status from the brain.
  useEffect(() => {
    if (phase !== "live") return;
    let cancelled = false;
    let inFlight = false;
    const poll = async () => {
      const connection = connectionRef.current;
      if (!connection?.token || inFlight) return;
      inFlight = true;
      try {
        const state = await window.ade.agentChat.codex.realtimeState({
          sessionId: connection.sessionId,
          token: connection.token,
        });
        if (cancelled || connectionRef.current !== connection) return;
        if (state.status === "ended") {
          teardown(false);
          if (state.error) onErrorRef.current?.(`Voice ended: ${state.error}`);
          return;
        }
        setWorking(state.working);
        setCaptions((current) => (
          JSON.stringify(current) === JSON.stringify(state.captions) ? current : state.captions
        ));
      } catch (error) {
        logVoice("state read failed", error);
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), STATE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [phase, teardown]);

  return {
    phase,
    muted,
    startedAt,
    micLevel,
    speaking,
    working,
    captions,
    start: startVoice,
    stop,
    toggleMute,
  };
}

/** The toolbar control: starts voice, and ends it while a session is live. */
export function CodexVoiceButton({ voice, className }: { voice: CodexVoiceController; className?: string }) {
  const active = voice.phase !== "idle";
  return (
    <SmartTooltip
      forceEnabled
      content={{
        label: active ? "End voice" : "Talk to this chat",
        description: active
          ? "End the voice conversation."
          : "Talk with this chat by voice. Runs on your Codex (ChatGPT) plan at about $0.05 a minute of its usage.",
      }}
    >
      <button
        type="button"
        onClick={() => (active ? voice.stop() : voice.start())}
        className={cn(
          "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-all",
          active
            ? "bg-[color:color-mix(in_srgb,var(--chat-accent)_18%,transparent)] text-[var(--chat-accent)]"
            : "text-muted-fg/35 hover:bg-[color:color-mix(in_srgb,var(--chat-accent)_10%,transparent)] hover:text-[var(--chat-accent)]",
          voice.phase === "connecting" ? "animate-pulse" : "",
          className,
        )}
        aria-label={active ? "End voice" : "Talk to this chat"}
        aria-pressed={active}
        data-codex-voice-phase={voice.phase}
      >
        <Waveform size={14} weight={active ? "fill" : "regular"} />
      </button>
    </SmartTooltip>
  );
}

function useElapsed(startedAt: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt == null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return formatCodexVoiceDuration(startedAt == null ? 0 : now - startedAt);
}

const METER_WEIGHTS = [0.55, 0.85, 1, 0.8, 0.5];

/** Docked above the composer while voice is connecting or live. */
export function CodexVoiceBar({ voice }: { voice: CodexVoiceController }) {
  const elapsed = useElapsed(voice.startedAt);
  if (voice.phase === "idle") return null;

  const connecting = voice.phase === "connecting";
  const status = connecting
    ? "Connecting…"
    : voice.speaking
      ? "Speaking"
      : voice.working
        ? "Working on it…"
        : voice.muted
          ? "Muted"
          : "Listening";
  // The model's voice drives the meter while it talks; otherwise the user's.
  const level = connecting ? 0 : voice.speaking ? 0.7 : voice.muted ? 0 : voice.micLevel;
  const newest = voice.captions[voice.captions.length - 1];

  return (
    <div
      role="region"
      aria-label="Voice conversation"
      className="mx-auto mb-1.5 flex w-full max-w-[var(--chat-column,52rem)] items-center gap-3 rounded-2xl border border-[color:color-mix(in_srgb,var(--chat-accent)_22%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_6%,transparent)] px-3 py-2 font-sans"
      data-codex-voice-bar={voice.phase}
    >
      <div className="flex h-6 w-7 shrink-0 items-center justify-center gap-[3px]" aria-hidden>
        {METER_WEIGHTS.map((weight, index) => (
          <span
            key={index}
            className={cn(
              "w-[3px] rounded-full bg-[var(--chat-accent)] transition-[height,opacity] duration-100",
              connecting ? "animate-pulse" : "",
              voice.working && !voice.speaking ? "opacity-60" : "",
            )}
            style={{ height: `${Math.max(3, Math.round(4 + level * weight * 18))}px` }}
          />
        ))}
      </div>

      <div className="min-w-0 flex-1 text-[length:calc(var(--chat-font-size)*11/14)] leading-snug">
        <div className="flex items-center gap-2">
          <span
            className={cn("font-medium text-[var(--chat-accent)]", voice.working && !voice.speaking ? "animate-pulse" : "")}
            aria-live="polite"
          >
            {status}
          </span>
          <span className="font-mono text-[length:calc(var(--chat-font-size)*10/14)] tabular-nums text-muted-fg/45">{elapsed}</span>
        </div>
        {newest ? (
          <div className="mt-0.5 truncate text-fg/70" title={newest.text.trim()}>
            <span className={newest.role === "user" ? "text-muted-fg/60" : undefined}>
              {newest.role === "user" ? "You: " : ""}
              {newest.text.trim() || "…"}
            </span>
          </div>
        ) : !connecting ? (
          <div className="mt-0.5 truncate text-muted-fg/45">Say something to start.</div>
        ) : null}
      </div>

      <SmartTooltip
        forceEnabled
        content={{
          label: voice.muted ? "Unmute" : "Mute",
          description: voice.muted ? "Let Codex hear you again." : "Stop sending your microphone. Codex keeps talking.",
        }}
      >
        <button
          type="button"
          onClick={voice.toggleMute}
          disabled={connecting}
          className={cn(
            "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors",
            voice.muted
              ? "bg-amber-400/15 text-amber-300"
              : "text-muted-fg/55 hover:bg-fg/[0.06] hover:text-fg/80",
            connecting ? "cursor-not-allowed opacity-40" : "",
          )}
          aria-label={voice.muted ? "Unmute microphone" : "Mute microphone"}
          aria-pressed={voice.muted}
        >
          {voice.muted ? <MicrophoneSlash size={14} /> : <Microphone size={14} />}
        </button>
      </SmartTooltip>
      <button
        type="button"
        onClick={voice.stop}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-red-500/15 px-2.5 text-[length:calc(var(--chat-font-size)*10/14)] font-medium text-red-300 transition-colors hover:bg-red-500/25"
        aria-label="End voice"
      >
        <PhoneDisconnect size={13} weight="fill" />
        End
      </button>
    </div>
  );
}
