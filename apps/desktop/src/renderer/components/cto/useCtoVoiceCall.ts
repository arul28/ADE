import { useCallback, useEffect, useSyncExternalStore } from "react";

import { bytesToBase64 } from "../../lib/base64";
import {
  CTO_VOICE_CAPTURE_DEFAULT_NOTE,
  CTO_VOICE_CAPTURE_EVENT,
  CTO_VOICE_INITIAL_STATE,
  CTO_VOICE_SAMPLE_RATE,
  ctoVoiceMicrophoneUnavailableMessage,
  isVoiceCallLive,
  type CtoVoiceBridge,
  type CtoVoiceStatePayload,
} from "../../../shared/types/ctoVoice";
import { rendererRuntimeTarget } from "../../lib/platform";

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

function bridge(): CtoVoiceBridge | null {
  return window.ade?.ctoVoice ?? null;
}

export function voiceAvailable(): boolean {
  return bridge() !== null;
}

/* ── store ── */

let state: CtoVoiceStatePayload = { ...CTO_VOICE_INITIAL_STATE, isCallOwner: false };
const listeners = new Set<() => void>();

function setState(next: CtoVoiceStatePayload) {
  state = next;
  listeners.forEach((listener) => listener());
}

/**
 * The bridge is subscribed once for the module, not once per mounted hook.
 *
 * Two components read this store — the shell-level HUD host and the Talk button
 * on the CTO page — so a per-hook subscription registered the same IPC listener
 * twice and delivered every state push twice.
 */
let releaseBridge: (() => void) | null = null;

function subscribe(listener: () => void) {
  // Attached on SUCCESS, not on the attempt. Latching a boolean before the
  // call meant a first subscriber mounting ahead of the preload bridge turned
  // the store off for the life of the process.
  //
  // The unsubscribe is kept rather than dropped: while any component is
  // listening there is exactly one IPC listener, and when the last one goes
  // the bridge listener goes with it. Dropping it leaked a listener per
  // process and left tests no way back to a clean store.
  if (!releaseBridge) {
    releaseBridge = bridge()?.onState(setState) ?? null;
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      releaseBridge?.();
      releaseBridge = null;
    }
  };
}

/**
 * Watch the call state without rendering on it.
 *
 * The capture host needs to know whether a call is live at the moment a shot
 * lands, not on every phase change — re-rendering it mid-capture restarts the
 * fly-in animation. It reads through the store rather than opening its own
 * `bridge().onState`, because a second subscription delivers every push twice.
 */
export function subscribeVoiceState(handler: (state: CtoVoiceStatePayload) => void): () => void {
  const listener = () => handler(state);
  const unsubscribe = subscribe(listener);
  listener();
  return unsubscribe;
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

/**
 * Ask the OS for the microphone before asking Chromium for it.
 *
 * On macOS Electron hands back a live, unmuted, all-zero track instead of
 * throwing when the OS has not granted access, so `getUserMedia` succeeding
 * proves nothing. Dictation already learned this and owns the gate
 * (`ade.transcription.requestMicAccess` → `askForMediaAccess`); this reuses it
 * rather than growing a second one. Absent bridge — the browser preview — is
 * not a denial, and falls through to `getUserMedia` as before.
 */
async function microphoneAccessDenied(): Promise<boolean> {
  const ensureAccess = window.ade?.transcription?.requestMicAccess;
  if (!ensureAccess) return false;
  try {
    const access = await ensureAccess();
    return access.status !== "granted";
  } catch {
    // An unreachable gate is not a denial; let `getUserMedia` decide.
    return false;
  }
}

async function startCapture() {
  if (mediaStream) return;
  if (await microphoneAccessDenied()) {
    throw new Error("Microphone access was not granted.");
  }
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  // A stream with no audio track, or one that is already over, is a failure
  // that arrived as a success. `muted` is deliberately NOT checked: a track can
  // legitimately start muted for a frame, and hanging up on that would refuse
  // calls on working microphones.
  const track = mediaStream.getAudioTracks()[0];
  if (!track || track.readyState === "ended") {
    stopCapture();
    throw new Error("The microphone produced no audio track.");
  }
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
    bridge()?.pushAudio(bytesToBase64(floatToPcm16(input)), peak);
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

  // Starting is a plain request; the microphone is started by the HUD host in
  // response to the phase change, so it has exactly one owner no matter which
  // surface pressed the button.
  // Typed as the bridge's own result, so the no-bridge arm cannot quietly
  // return a narrower object and make callers cast to read `detail`.
  const start = useCallback(async (): ReturnType<CtoVoiceBridge["start"]> => {
    const api = bridge();
    if (!api) return { ok: false, error: "unavailable" };
    return api.start();
  }, []);

  const end = useCallback(async () => {
    await bridge()?.end();
  }, []);

  // The one place this store writes something the main process did not send.
  //
  // Mute is a physical expectation — the button must look pressed the instant
  // it is pressed — so the flag is echoed locally rather than waited for. It is
  // an echo, not a fact: the next pushed state replaces the whole object, so if
  // the main process disagrees (a call that ended mid-press, a refused mute)
  // its answer wins on the very next push. Nothing else here may do this.
  const toggleMute = useCallback(() => {
    const next = !state.muted;
    bridge()?.setMuted(next);
    setState({ ...state, muted: next });
  }, []);

  const approve = useCallback((id: string) => { void bridge()?.approve(id); }, []);
  const deny = useCallback((id: string) => { void bridge()?.deny(id); }, []);

  return { state: current, start, end, toggleMute, approve, deny, available: voiceAvailable() };
}

/**
 * Owns the microphone, the speaker, and the capture-event bridge.
 *
 * Mounted exactly once, by `CtoVoiceHudHost` at the shell level. The audio
 * objects are module-scoped, so a per-component cleanup would tear down a live
 * call when an unrelated route unmounted — which is precisely what happened
 * when the Talk button on `/cto` also ran this lifecycle.
 */
export function useCtoVoiceAudioOwner(state: CtoVoiceStatePayload): void {
  // Every window mounts this host, so a call is visible wherever the user is
  // working. Only the window that started the call may open the microphone:
  // two capturing windows put two interleaved PCM streams into one socket and
  // play the CTO's voice twice. The main process decides which window that is.
  const live = isVoiceCallLive(state.phase) && state.isCallOwner;

  useEffect(() => {
    if (!live) return;
    return bridge()?.onAudio(playVoiceChunk);
  }, [live]);

  useEffect(() => {
    if (!live) {
      stopCapture();
      flushVoicePlayback();
      return;
    }
    let cancelled = false;
    // The hang-up carries a reason because it comes from this side; see
    // `CtoVoiceBridge.end` for why a silent one is not enough.
    void startCapture().catch(() => {
      if (cancelled) return;
      void bridge()?.end(ctoVoiceMicrophoneUnavailableMessage(rendererRuntimeTarget().platform));
    });
    return () => { cancelled = true; };
  }, [live]);

  // A barge-in has to silence the speaker, not just re-label the pill.
  useEffect(() => {
    if (live && state.interrupted) flushVoicePlayback();
  }, [live, state.interrupted]);

  // The capture gesture dispatches this when a shot lands mid-call. Pointing at
  // something while you talk about it is why the gesture and the call were
  // designed together.
  //
  // NOT gated on call ownership, unlike the audio above. The chord fires in
  // whichever window is in front, the event is per-window, and `attachImage`
  // reaches the one service in the main process — so a shot taken from a
  // window that does not hold the microphone must still reach the call.
  useEffect(() => {
    const onCapture = (event: Event) => {
      const detail = (event as CustomEvent).detail as { shot?: { pngBase64?: string }; note?: string } | undefined;
      const pngBase64 = detail?.shot?.pngBase64;
      if (!pngBase64) return;
      void bridge()?.attachImage({
        pngBase64,
        note: detail?.note ?? CTO_VOICE_CAPTURE_DEFAULT_NOTE,
      });
    };
    window.addEventListener(CTO_VOICE_CAPTURE_EVENT, onCapture);
    return () => window.removeEventListener(CTO_VOICE_CAPTURE_EVENT, onCapture);
  }, []);

  useEffect(() => () => { stopCapture(); flushVoicePlayback(); }, []);
}
