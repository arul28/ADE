import { useCallback, useEffect, useLayoutEffect, useSyncExternalStore } from "react";

import {
  CTO_VOICE_CAPTURE_DEFAULT_NOTE,
  CTO_VOICE_CAPTURE_EVENT,
  CTO_VOICE_INITIAL_STATE,
  isVoiceCallLive,
  type CtoVoiceBridge,
  type CtoVoiceStatePayload,
} from "../../../shared/types/ctoVoice";
import {
  clearCtoMicrophoneFailure,
  flushVoicePlayback,
  getCtoAudioDevice,
  isCtoCaptureLive,
  MicrophoneBlockedError,
  noteCaptureClosed,
  noteCaptureFailed,
  noteCaptureOpened,
  noteVoicePhase,
  playVoiceChunk,
  startCtoCapture,
  stopCtoCapture,
  subscribeCtoAudioDevice,
} from "./ctoVoiceAudioDevice";

/**
 * Renderer half of a CTO voice call.
 *
 * The renderer owns exactly one thing: the microphone and the speaker, and both
 * of those live next door in `ctoVoiceAudioDevice`. What is here is the call
 * STATE — one store, subscribed once for the module — and the two hooks the
 * surfaces read it through. The socket, the delegation loop and every
 * permission decision live in the main process, so nothing on this side can
 * approve an action or reach OpenAI directly.
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
  // The device side latches a local barge-in until the main process says
  // something new happened, and a phase is the only part of a pushed state that
  // says so.
  noteVoicePhase(next.phase);
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

/* ── device ── */

/**
 * The microphone's own state: why it would not open, and whether it is open.
 *
 * Re-exported here rather than imported from `ctoVoiceAudioDevice` by every
 * surface, because a component asking "can the user talk yet" is asking about
 * the CALL and should not have to know the device module exists.
 */
export type CtoVoiceMicrophoneFailure = NonNullable<
  ReturnType<typeof getCtoAudioDevice>["failure"]
>;

export { clearCtoMicrophoneFailure };

/** True while this window holds an open microphone for the call. */
export function useCtoCaptureReady(): boolean {
  return useSyncExternalStore(
    subscribeCtoAudioDevice,
    () => getCtoAudioDevice().captureReady,
    () => getCtoAudioDevice().captureReady,
  );
}

/** The last microphone refusal, or null. Cleared when a device opens. */
export function useCtoMicrophoneFailure(): CtoVoiceMicrophoneFailure | null {
  return useSyncExternalStore(
    subscribeCtoAudioDevice,
    () => getCtoAudioDevice().failure,
    () => getCtoAudioDevice().failure,
  );
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

  // Hang-up has to invalidate the generation in the same commit, before
  // `getUserMedia` can settle as a microtask and store a stream the call no
  // longer owns. `useEffect` is too late for that race.
  useLayoutEffect(() => {
    if (!live) stopCtoCapture();
  }, [live]);

  useEffect(() => {
    if (!live) {
      flushVoicePlayback();
      noteCaptureClosed();
      return;
    }
    void startCtoCapture((audio, level) => bridge()?.pushAudio(audio, level))
      .then((opened) => {
        if (!opened || !isCtoCaptureLive()) return;
        // The device opened: whatever the last attempt said is no longer true,
        // and this is the signal the start sheet waits for. Set HERE, after the
        // track is confirmed live, rather than beside the phase change — the
        // whole point is that it is later than the phase.
        noteCaptureOpened();
      })
      .catch((error: unknown) => {
        const kind = error instanceof MicrophoneBlockedError ? error.kind : "unavailable";
        // Recorded BEFORE the hang-up: ending the call unmounts the HUD and
        // closes the sheet's connecting state, and the verdict is the only
        // thing either of them can show afterwards.
        const message = noteCaptureFailed(kind);
        // The hang-up carries the same sentence AND the kind, because both come
        // from this side; see `CtoVoiceBridge.end` for why a silent one is not
        // enough, and `CtoVoiceState.errorKind` for why the sentence alone is
        // not either.
        void bridge()?.end(message, kind);
      });
    return () => {
      stopCtoCapture();
    };
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

  useEffect(() => () => { stopCtoCapture(); flushVoicePlayback(); noteCaptureClosed(); }, []);
}
