import { bytesToBase64 } from "../../lib/base64";
import {
  CTO_VOICE_LOCAL_BARGE_IN_FRAMES,
  CTO_VOICE_LOCAL_BARGE_IN_LEVEL,
  CTO_VOICE_LOCAL_BARGE_IN_RELEASE_MS,
  CTO_VOICE_SAMPLE_RATE,
  ctoVoiceMicrophoneMessage,
  type CtoVoiceMicrophoneBlockKind,
  type CtoVoiceStatePayload,
} from "../../../shared/types/ctoVoice";
import { rendererRuntimeTarget } from "../../lib/platform";

/**
 * The window's half of a call: one microphone, one speaker, one verdict.
 *
 * Everything here is module-scoped on purpose — there is exactly one microphone
 * per window, and a per-component copy would tear down a live call when an
 * unrelated route unmounted. Its own module because none of it is about the
 * CALL: the socket, the delegation loop and every permission decision live in
 * the main process, and what is left on this side is a device, a playback graph
 * and the one thing only this side can know, which is why the device would not
 * open.
 */

/* ── device verdict ── */

/**
 * The last microphone refusal, and whether a device is open right now.
 *
 * ONE snapshot rather than two stores, because the two are the same fact from
 * opposite ends — a verdict is set exactly when readiness is cleared — and the
 * surfaces that read them (the start sheet, the page notice) read both. The
 * object is rebuilt only when something changed, because `useSyncExternalStore`
 * re-renders forever on a snapshot with a fresh identity every call.
 */
export type CtoVoiceAudioDeviceState = {
  /**
   * Why the microphone would not open, or null.
   *
   * The renderer's word, not the main process's: the device lives on this side,
   * and the reason it was refused is known here and nowhere else.
   */
  failure: { kind: CtoVoiceMicrophoneBlockKind; message: string } | null;
  /**
   * True once this window has a live microphone track for the running call.
   *
   * The start sheet needs it because `start()` answering `ok` is not the same
   * thing as a call the user can talk on: the device is opened in response to
   * the phase change, which happens AFTER the sheet has already seen a live
   * phase. Closing on the phase alone dropped the sheet a beat before the
   * device failed, so a refused microphone landed on the page notice — a
   * yellow line with no buttons — instead of in the modal being looked at.
   */
  captureReady: boolean;
};

let deviceState: CtoVoiceAudioDeviceState = { failure: null, captureReady: false };
const deviceListeners = new Set<() => void>();

function setDeviceState(next: Partial<CtoVoiceAudioDeviceState>): void {
  const merged = { ...deviceState, ...next };
  if (merged.failure === deviceState.failure && merged.captureReady === deviceState.captureReady) {
    return;
  }
  deviceState = merged;
  deviceListeners.forEach((listener) => listener());
}

export function subscribeCtoAudioDevice(listener: () => void): () => void {
  deviceListeners.add(listener);
  return () => { deviceListeners.delete(listener); };
}

export function getCtoAudioDevice(): CtoVoiceAudioDeviceState {
  return deviceState;
}

export function clearCtoMicrophoneFailure(): void {
  setDeviceState({ failure: null });
}

/* ── capture ── */

let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let processor: ScriptProcessorNode | null = null;
let playbackContext: AudioContext | null = null;
let playbackAt = 0;
/**
 * Which capture attempt is current.
 *
 * `startCtoCapture` awaits the OS gate and `getUserMedia`, and hang-up can
 * land in that gap. `stopCtoCapture` used to close whatever was stored, which
 * was nothing yet, so the late stream installed a live track on a call that
 * had already ended. Each start takes a generation; stop advances it; a
 * stream that arrives for a stale generation is stopped immediately and never
 * stored. The owner hook also stops in `useLayoutEffect` so the bump happens
 * in the same commit as hang-up, before a pending `getUserMedia` can settle
 * as a microtask.
 */
let captureGeneration = 0;

/** Frames in a row over the level, counted against {@link CTO_VOICE_LOCAL_BARGE_IN_FRAMES}. */
let loudFramesWhileSpeaking = 0;
/**
 * The phase the main process last reported.
 *
 * Kept here rather than read back out of the call store because the barge-in
 * latch below is released by a phase CHANGE, and the frame callback that sets
 * it runs on this side with no view of that store.
 */
let currentPhase: CtoVoiceStatePayload["phase"] | null = null;
/**
 * True from a local barge-in until the main process pushes its next phase.
 *
 * Without it the flush is undone a tenth of a second later: the audio pump is
 * still draining the runtime's queue, so the chunks generated before the server
 * heard anything would rebuild the playback graph and the CTO would carry on
 * over the user.
 *
 * A flag AND the phase it was taken at, rather than the phase alone standing in
 * for both: a window that has never been pushed a state has no phase, and a
 * latch that reads as "not held" there would let the pump talk over the user on
 * the very first barge-in of a call.
 */
let bargedIn = false;
let bargedInAtPhase: CtoVoiceStatePayload["phase"] | null = null;
/** When that latch was set, so a barge-in the server never saw expires. */
let bargedInAtMs = 0;

/**
 * The main process said something new happened.
 *
 * A PHASE change lifts the latch — not any pushed state. The meter pushes a
 * state per distinct input level, so "the next state" arrives while the user is
 * still mid-word and would un-silence the CTO immediately. A new answer always
 * comes through `thinking` and `speaking`, which is what makes the latch unable
 * to mute it.
 */
export function noteVoicePhase(phase: CtoVoiceStatePayload["phase"]): void {
  currentPhase = phase;
  if (bargedIn && phase !== bargedInAtPhase) bargedIn = false;
}

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

type MicrophoneGate = {
  /** Set when the OS has already refused, before anything is opened. */
  blocked: CtoVoiceMicrophoneBlockKind | null;
  /** What a later `NotAllowedError` means on this build. */
  denied: CtoVoiceMicrophoneBlockKind;
};

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

function discardMediaStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}

/**
 * Open the microphone and pump frames at the call.
 *
 * `pushAudio` is passed in rather than reached for: this module owns the
 * device, and the call bridge belongs to the hook above it. Hang-up can land
 * while the OS prompt is still outstanding; the generation in `stopCtoCapture`
 * is what stops that late stream from being stored. Returns `true` when the
 * graph is live, `false` when hang-up won the race — never throws for hang-up.
 */
export async function startCtoCapture(
  pushAudio: (audio: string, level: number) => void,
): Promise<boolean> {
  if (mediaStream) return true;
  const generation = ++captureGeneration;
  const cancelled = (): boolean => generation !== captureGeneration;
  const gate = await microphoneGate();
  if (cancelled()) return false;
  if (gate.blocked) throw new MicrophoneBlockedError(gate.blocked);
  // No device is not a permission problem, and prompting for one produces a
  // `NotFoundError` that reads like a fault. Answer it before asking.
  const hasInput = await hasAudioInput();
  if (cancelled()) return false;
  if (!hasInput) throw new MicrophoneBlockedError("no-device");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    if (cancelled()) return false;
    const classified = classifyCaptureError(error, gate.denied);
    // The name is diagnostic, not user-facing: it goes to the log so an
    // unrecognised refusal can be classified later, and never into a sentence.
    console.warn("[cto-voice] microphone refused", classified.name);
    throw new MicrophoneBlockedError(classified.kind);
  }
  if (cancelled()) {
    discardMediaStream(stream);
    return false;
  }
  // A stream with no audio track, or one that is already over, is a failure
  // that arrived as a success. `muted` is deliberately NOT checked: a track can
  // legitimately start muted for a frame, and hanging up on that would refuse
  // calls on working microphones.
  const track = stream.getAudioTracks()[0];
  if (!track || track.readyState === "ended") {
    discardMediaStream(stream);
    throw new MicrophoneBlockedError("unavailable");
  }
  mediaStream = stream;
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
    pushAudio(bytesToBase64(floatToPcm16(input)), peak);
  };
  source.connect(processor);
  processor.connect(audioContext.destination);
  if (cancelled()) {
    stopCtoCapture();
    return false;
  }
  return true;
}

export function stopCtoCapture(): void {
  // Invalidate every in-flight start BEFORE tearing down what is stored, so a
  // `getUserMedia` that resolves in the same tick sees a stale generation and
  // discards its stream instead of writing over this teardown.
  captureGeneration += 1;
  // Cleared before the node is dropped: `disconnect` does not guarantee the
  // handler will not run once more, and one more frame after teardown pushes
  // audio into a call that is over.
  if (processor) processor.onaudioprocess = null;
  processor?.disconnect();
  processor = null;
  discardMediaStream(mediaStream);
  mediaStream = null;
  void audioContext?.close();
  audioContext = null;
}

/** True while a graph this window opened is still stored. */
export function isCtoCaptureLive(): boolean {
  return mediaStream !== null;
}

/** The device opened, or it did not. Both are the same fact from two ends. */
export function noteCaptureOpened(): void {
  setDeviceState({ failure: null, captureReady: true });
}

export function noteCaptureFailed(kind: CtoVoiceMicrophoneBlockKind): string {
  const message = ctoVoiceMicrophoneMessage(kind, rendererRuntimeTarget().platform);
  setDeviceState({ failure: { kind, message }, captureReady: false });
  return message;
}

export function noteCaptureClosed(): void {
  setDeviceState({ captureReady: false });
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
  bargedIn = true;
  bargedInAtPhase = currentPhase;
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
  if (!bargedIn) return false;
  if (Date.now() - bargedInAtMs < CTO_VOICE_LOCAL_BARGE_IN_RELEASE_MS) return true;
  bargedIn = false;
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
export function playVoiceChunk(base64: string): void {
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
    console.warn("[cto-voice] output chunk dropped", error);
  }
}

/** Drop anything still queued. Barge-in has to stop the voice immediately. */
export function flushVoicePlayback(): void {
  closePlayback(playbackContext);
  playbackContext = null;
  playbackAt = 0;
  loudFramesWhileSpeaking = 0;
}

/** Test seam: forget a local barge-in without waiting for a pushed state. */
export function resetLocalBargeIn(): void {
  bargedIn = false;
  bargedInAtPhase = null;
  bargedInAtMs = 0;
  loudFramesWhileSpeaking = 0;
}
