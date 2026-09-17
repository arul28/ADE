import { useCallback, useEffect, useSyncExternalStore } from "react";

import { bytesToBase64 } from "../../lib/base64";
import {
  CTO_VOICE_CAPTURE_DEFAULT_NOTE,
  CTO_VOICE_CAPTURE_EVENT,
  CTO_VOICE_INITIAL_STATE,
  CTO_VOICE_LOCAL_BARGE_IN_FRAMES,
  CTO_VOICE_LOCAL_BARGE_IN_LEVEL,
  CTO_VOICE_LOCAL_BARGE_IN_RELEASE_MS,
  CTO_VOICE_SAMPLE_RATE,
  ctoVoiceMicrophoneMessage,
  isVoiceCallLive,
  type CtoVoiceBridge,
  type CtoVoiceMicrophoneBlockKind,
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
  // A PHASE change lifts the local barge-in latch — not any pushed state. The
  // meter pushes a state per distinct input level, so "the next state" arrives
  // while the user is still mid-word and would un-silence the CTO immediately.
  // A phase change is the main process saying something new happened, and it is
  // what makes the latch unable to mute the next answer: a new answer always
  // comes through `thinking` and `speaking`.
  if (bargedInAtPhase !== null && next.phase !== bargedInAtPhase) bargedInAtPhase = null;
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

/* ── microphone verdict ── */

/**
 * The last microphone refusal, and who may clear it.
 *
 * A second store rather than a field on the call state, because the call state
 * is the main process's word and this is the renderer's: the microphone lives
 * on this side, and the reason it would not open is known here and nowhere
 * else. Module-scoped for the same reason the audio objects are — the sheet
 * that asks for the key and the host that opens the device are two components,
 * and the verdict has to survive the one that fails.
 */
export type CtoVoiceMicrophoneFailure = {
  kind: CtoVoiceMicrophoneBlockKind;
  message: string;
};

let microphoneFailure: CtoVoiceMicrophoneFailure | null = null;
const microphoneListeners = new Set<() => void>();

function setMicrophoneFailure(next: CtoVoiceMicrophoneFailure | null): void {
  microphoneFailure = next;
  microphoneListeners.forEach((listener) => listener());
}

export function clearCtoMicrophoneFailure(): void {
  if (microphoneFailure) setMicrophoneFailure(null);
}

function subscribeMicrophone(listener: () => void) {
  microphoneListeners.add(listener);
  return () => { microphoneListeners.delete(listener); };
}

/** The last microphone refusal, or null. Cleared when a call goes live. */
export function useCtoMicrophoneFailure(): CtoVoiceMicrophoneFailure | null {
  return useSyncExternalStore(
    subscribeMicrophone,
    () => microphoneFailure,
    () => microphoneFailure,
  );
}

/* ── capture ── */

let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let processor: ScriptProcessorNode | null = null;
let playbackContext: AudioContext | null = null;
let playbackAt = 0;

/** Frames in a row over the level, counted against {@link CTO_VOICE_LOCAL_BARGE_IN_FRAMES}. */
let loudFramesWhileSpeaking = 0;
/**
 * True from a local barge-in until the main process pushes its next state.
 *
 * Without it the flush is undone a tenth of a second later: the audio pump is
 * still draining the runtime's queue, so the chunks generated before the server
 * heard anything would rebuild the playback graph and the CTO would carry on
 * over the user.
 */
let bargedInAtPhase: CtoVoiceStatePayload["phase"] | null = null;
/** When that latch was set, so a barge-in the server never saw expires. */
let bargedInAtMs = 0;

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
/**
 * A refusal the caller can act on, rather than an anonymous throw.
 *
 * The kind is what decides the sentence AND whether there is a settings pane
 * worth offering, so it travels rather than being re-derived from a string.
 */
export class MicrophoneBlockedError extends Error {
  constructor(readonly kind: CtoVoiceMicrophoneBlockKind) {
    super(ctoVoiceMicrophoneMessage(kind, rendererRuntimeTarget().platform));
    this.name = "MicrophoneBlockedError";
  }
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
type MicrophoneGate = {
  /** Set when the OS has already refused, before anything is opened. */
  blocked: CtoVoiceMicrophoneBlockKind | null;
  /** What a later `NotAllowedError` means on this build. */
  denied: CtoVoiceMicrophoneBlockKind;
};

async function microphoneGate(): Promise<MicrophoneGate> {
  const ensureAccess = window.ade?.transcription?.requestMicAccess;
  // An absent bridge — the browser preview — is not a denial.
  if (!ensureAccess) return { blocked: null, denied: "os-denied" };
  try {
    const access = await ensureAccess();
    // An older host answers with a status and no kind; a settled refusal it
    // cannot classify is still a refusal the OS owns.
    const denied = access.deniedBlock ?? "os-denied";
    return {
      blocked: access.status === "granted" ? null : (access.block ?? denied),
      denied,
    };
  } catch {
    // An unreachable gate is not a denial; let `getUserMedia` decide.
    return { blocked: null, denied: "os-denied" };
  }
}

/**
 * Is there a microphone on this machine at all?
 *
 * Asked BEFORE `getUserMedia`, because a Mac Studio has no built-in one and a
 * granted permission over an empty device list is that machine's ordinary
 * state — not a fault. Prompting anyway produces `NotFoundError`, which the
 * first version of this read as "another app is holding it" and sent the user
 * hunting for an app that did not exist.
 *
 * Labels are never read, only the count: `enumerateDevices` returns unlabelled
 * entries until a stream has been opened, and the label is the one part of a
 * device list that is about the user's hardware rather than its existence.
 */
async function hasAudioInput(): Promise<boolean> {
  const enumerate = navigator.mediaDevices?.enumerateDevices;
  // A browser that cannot enumerate is not a machine with no microphone.
  if (typeof enumerate !== "function") return true;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.some((device) => device.kind === "audioinput");
  } catch {
    return true;
  }
}

/**
 * What `getUserMedia` actually refused with.
 *
 * The names are the spec's, and they mean genuinely different things — a
 * missing device, a busy device and a refused permission need three different
 * sentences. Guessing one for all of them is what produced "another app may be
 * holding the microphone" on a Mac with no microphone.
 */
function classifyCaptureError(error: unknown, denied: CtoVoiceMicrophoneBlockKind): {
  kind: CtoVoiceMicrophoneBlockKind;
  name: string;
} {
  // NOT `instanceof Error`: `getUserMedia` rejects with a `DOMException`, which
  // is its own interface and does not inherit from `Error`. Testing for one
  // sent every real refusal — the whole reason this function exists — to the
  // default branch.
  const raw = (error as { name?: unknown } | null)?.name;
  const name = typeof raw === "string" && raw ? raw : "UnknownError";
  switch (name) {
    case "NotFoundError":
    case "OverconstrainedError":
      return { kind: "no-device", name };
    case "NotReadableError":
    case "AbortError":
      return { kind: "in-use", name };
    case "NotAllowedError":
    case "SecurityError":
      return { kind: denied, name };
    default:
      return { kind: "unavailable", name };
  }
}

async function startCapture() {
  if (mediaStream) return;
  const gate = await microphoneGate();
  if (gate.blocked) throw new MicrophoneBlockedError(gate.blocked);
  // No device is not a permission problem, and prompting for one produces a
  // `NotFoundError` that reads like a fault. Answer it before asking.
  if (!await hasAudioInput()) throw new MicrophoneBlockedError("no-device");
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    const classified = classifyCaptureError(error, gate.denied);
    // The name is diagnostic, not user-facing: it goes to the log so an
    // unrecognised refusal can be classified later, and never into a sentence.
    // eslint-disable-next-line no-console
    console.warn("[cto-voice] microphone refused", classified.name);
    throw new MicrophoneBlockedError(classified.kind);
  }
  // A stream with no audio track, or one that is already over, is a failure
  // that arrived as a success. `muted` is deliberately NOT checked: a track can
  // legitimately start muted for a frame, and hanging up on that would refuse
  // calls on working microphones.
  const track = mediaStream.getAudioTracks()[0];
  if (!track || track.readyState === "ended") {
    stopCapture();
    throw new MicrophoneBlockedError("unavailable");
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
    noteLocalBargeIn(peak);
    bridge()?.pushAudio(bytesToBase64(floatToPcm16(input)), peak);
  };
  source.connect(processor);
  processor.connect(audioContext.destination);
}

function stopCapture() {
  // Cleared before the node is dropped: `disconnect` does not guarantee the
  // handler will not run once more, and one more frame after teardown pushes
  // audio into a call that is over.
  if (processor) processor.onaudioprocess = null;
  processor?.disconnect();
  processor = null;
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  void audioContext?.close();
  audioContext = null;
}

/**
 * Is the CTO audibly talking right now?
 *
 * Scheduled audio, not a phase: the phase says what the main process believes,
 * and the whole point of the local fast path is that this side knows first.
 */
export function voicePlaybackActive(): boolean {
  if (!playbackContext) return false;
  return playbackAt > playbackContext.currentTime;
}

/**
 * Silence the CTO the moment the user talks over it, without waiting for the
 * server.
 *
 * The server-side barge-in is still the one that cancels the response and
 * aborts the turn behind it; this only stops the speaker, and only while audio
 * is actually playing. Two consecutive frames over the threshold rather than
 * one, because a single loud frame is a key press.
 */
export function noteLocalBargeIn(peak: number): void {
  if (!voicePlaybackActive()) {
    loudFramesWhileSpeaking = 0;
    return;
  }
  if (peak < CTO_VOICE_LOCAL_BARGE_IN_LEVEL) {
    loudFramesWhileSpeaking = 0;
    return;
  }
  loudFramesWhileSpeaking += 1;
  if (loudFramesWhileSpeaking < CTO_VOICE_LOCAL_BARGE_IN_FRAMES) return;
  loudFramesWhileSpeaking = 0;
  bargedInAtPhase = state.phase;
  bargedInAtMs = Date.now();
  flushVoicePlayback();
}

/**
 * Is output still being discarded because of a local barge-in?
 *
 * The deadline is checked here rather than on a timer: nothing needs to happen
 * when it passes except the next chunk being allowed through, and a timer would
 * have to be cancelled on every phase change, hang-up and unmount.
 */
function bargeInStillHolding(): boolean {
  if (bargedInAtPhase === null) return false;
  if (Date.now() - bargedInAtMs < CTO_VOICE_LOCAL_BARGE_IN_RELEASE_MS) return true;
  bargedInAtPhase = null;
  return false;
}

/**
 * Close a playback context, one at a time.
 *
 * Serialized because a barge-in closes a context and the very next chunk opens
 * another, and a document may only have so many: firing the close and forgetting
 * it left the old ones closing in parallel with the new ones opening, and the
 * limit is reached by a call with enough interruptions in it.
 */
let playbackClosing: Promise<void> = Promise.resolve();

function closePlayback(context: AudioContext | null): void {
  if (!context) return;
  // A context closed twice, or closed while a node is still scheduled on it,
  // rejects; neither is worth a sentence, and neither may break the flush.
  playbackClosing = playbackClosing.then(() => context.close()).catch(() => {});
}

/** Queue an output chunk so consecutive deltas play gaplessly. */
export function playVoiceChunk(base64: string) {
  // Everything already in the runtime's queue was generated before the user
  // started talking, so playing it is exactly the thing the barge-in stopped.
  if (bargeInStillHolding()) return;
  // This runs straight off an IPC push, so nothing catches what it throws:
  // `atob` throws on a malformed chunk and `new AudioContext` throws once a
  // document has opened too many. A dropped chunk is a gap in one answer; an
  // uncaught throw here takes the listener with it and the call goes mute.
  try {
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
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn("[cto-voice] output chunk dropped", error);
  }
}

/** Drop anything still queued. Barge-in has to stop the voice immediately. */
export function flushVoicePlayback() {
  closePlayback(playbackContext);
  playbackContext = null;
  playbackAt = 0;
  loudFramesWhileSpeaking = 0;
}

/** Test seam: forget a local barge-in without waiting for a pushed state. */
export function resetLocalBargeIn(): void {
  bargedInAtPhase = null;
  bargedInAtMs = 0;
  loudFramesWhileSpeaking = 0;
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
    void startCapture()
      .then(() => {
        // The device opened: whatever the last attempt said is no longer true.
        if (!cancelled) clearCtoMicrophoneFailure();
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const kind = error instanceof MicrophoneBlockedError ? error.kind : "unavailable";
        const message = ctoVoiceMicrophoneMessage(kind, rendererRuntimeTarget().platform);
        // Recorded BEFORE the hang-up: ending the call unmounts the HUD and
        // closes the sheet's connecting state, and the verdict is the only
        // thing either of them can show afterwards.
        setMicrophoneFailure({ kind, message });
        // The hang-up carries the same sentence because it comes from this
        // side; see `CtoVoiceBridge.end` for why a silent one is not enough.
        void bridge()?.end(message);
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
