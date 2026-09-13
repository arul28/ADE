import { useCallback, useEffect, useSyncExternalStore } from "react";

import {
  CTO_VOICE_INITIAL_STATE,
  CTO_VOICE_SAMPLE_RATE,
  type CtoVoiceState,
} from "../../../shared/types/ctoVoice";

/**
 * Renderer half of a CTO voice call.
 *
 * The renderer owns exactly one thing: the microphone and the speaker. The
 * socket, the delegation loop and every permission decision live in the main
 * process, so nothing here can approve an action or reach OpenAI directly.
 *
 * The bridge is read optionally throughout. In the browser preview (and on any
 * build where the main-process half is not present) the hook degrades to
 * "voice unavailable" instead of throwing, which is the same shape `SceneFrame`
 * uses for its own optional bridge.
 */

/** Dispatched by the capture gesture when a shot lands during a live call. */
export const CTO_VOICE_CAPTURE_EVENT = "ade:cto-voice:attach-capture";

type VoiceBridge = {
  start: () => Promise<{ ok: boolean; error?: string }>;
  end: () => Promise<void>;
  pushAudio: (base64: string, level: number) => void;
  setMuted: (muted: boolean) => void;
  approve: (id: string) => Promise<void>;
  deny: (id: string) => Promise<void>;
  /**
   * Hand the live conversation something the user is looking at. Optional: an
   * older main process may not have it, and the capture gesture must degrade
   * rather than throw when it does not.
   */
  attachImage?: (args: { pngBase64: string; note: string }) => Promise<void>;
  onState: (handler: (state: CtoVoiceState) => void) => () => void;
  hasKey: () => Promise<boolean>;
};

function bridge(): VoiceBridge | null {
  const ade = (window as unknown as { ade?: { ctoVoice?: VoiceBridge } }).ade;
  return ade?.ctoVoice ?? null;
}

export function voiceAvailable(): boolean {
  return bridge() !== null;
}

/* ── store ── */

let state: CtoVoiceState = CTO_VOICE_INITIAL_STATE;
const listeners = new Set<() => void>();

function setState(next: CtoVoiceState) {
  state = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/* ── capture ── */

let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let processor: ScriptProcessorNode | null = null;
let playbackContext: AudioContext | null = null;
let playbackAt = 0;

/** Float32 [-1,1] → PCM16 little-endian, the format the session negotiated. */
function floatToPcm16(input: Float32Array): Uint8Array {
  const out = new Uint8Array(input.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < input.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function startCapture() {
  if (mediaStream) return;
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  audioContext = new AudioContext({ sampleRate: CTO_VOICE_SAMPLE_RATE });
  const source = audioContext.createMediaStreamSource(mediaStream);
  // ScriptProcessor is deprecated but is the only node that works without
  // shipping a separate worklet file; the buffer is small and the work per
  // frame is a clamp and a cast.
  processor = audioContext.createScriptProcessor(2048, 1, 1);
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < input.length; i += 1) peak = Math.max(peak, Math.abs(input[i]));
    bridge()?.pushAudio(toBase64(floatToPcm16(input)), peak);
  };
  source.connect(processor);
  processor.connect(audioContext.destination);
}

function stopCapture() {
  processor?.disconnect();
  processor = null;
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  void audioContext?.close();
  audioContext = null;
}

/** Queue an output chunk so consecutive deltas play gaplessly. */
export function playVoiceChunk(base64: string) {
  if (!playbackContext) {
    playbackContext = new AudioContext({ sampleRate: CTO_VOICE_SAMPLE_RATE });
    playbackAt = playbackContext.currentTime;
  }
  const binary = atob(base64);
  const samples = binary.length / 2;
  const buffer = playbackContext.createBuffer(1, samples, CTO_VOICE_SAMPLE_RATE);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < samples; i += 1) {
    const lo = binary.charCodeAt(i * 2);
    const hi = binary.charCodeAt(i * 2 + 1);
    const value = (hi << 8) | lo;
    channel[i] = (value >= 0x8000 ? value - 0x10000 : value) / 0x8000;
  }
  const node = playbackContext.createBufferSource();
  node.buffer = buffer;
  node.connect(playbackContext.destination);
  playbackAt = Math.max(playbackAt, playbackContext.currentTime);
  node.start(playbackAt);
  playbackAt += buffer.duration;
}

/** Drop anything still queued. Barge-in has to stop the voice immediately. */
export function flushVoicePlayback() {
  void playbackContext?.close();
  playbackContext = null;
  playbackAt = 0;
}

/* ── hook ── */

export function useCtoVoiceCall() {
  const current = useSyncExternalStore(subscribe, () => state, () => state);

  useEffect(() => bridge()?.onState(setState), []);

  // The capture gesture dispatches this when a shot lands mid-call. Pointing at
  // something while you talk about it is the reason the gesture and the call
  // were designed together, so the call consumes it here rather than making the
  // user drop the image into a composer they are not looking at.
  useEffect(() => {
    const onCapture = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { shot?: { pngBase64?: string }; note?: string }
        | undefined;
      const pngBase64 = detail?.shot?.pngBase64;
      if (!pngBase64) return;
      const attach = bridge()?.attachImage;
      if (typeof attach !== "function") return;
      void attach({ pngBase64, note: detail?.note ?? "The user shared what they are looking at." });
    };
    window.addEventListener(CTO_VOICE_CAPTURE_EVENT, onCapture);
    return () => window.removeEventListener(CTO_VOICE_CAPTURE_EVENT, onCapture);
  }, []);

  // A barge-in has to silence the speaker, not just re-label the pill.
  useEffect(() => {
    if (current.interrupted) flushVoicePlayback();
  }, [current.interrupted]);

  const start = useCallback(async () => {
    const api = bridge();
    if (!api) return { ok: false, error: "unavailable" as const };
    const result = await api.start();
    if (result.ok) {
      try {
        await startCapture();
      } catch {
        await api.end();
        return { ok: false, error: "microphone" as const };
      }
    }
    return result;
  }, []);

  const end = useCallback(async () => {
    stopCapture();
    flushVoicePlayback();
    await bridge()?.end();
  }, []);

  const toggleMute = useCallback(() => {
    const next = !state.muted;
    bridge()?.setMuted(next);
    setState({ ...state, muted: next });
  }, []);

  const approve = useCallback((id: string) => { void bridge()?.approve(id); }, []);
  const deny = useCallback((id: string) => { void bridge()?.deny(id); }, []);

  useEffect(() => () => { stopCapture(); flushVoicePlayback(); }, []);

  return { state: current, start, end, toggleMute, approve, deny, available: voiceAvailable() };
}
