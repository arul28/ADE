/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import {
  CTO_VOICE_INITIAL_STATE,
  CTO_VOICE_LOCAL_BARGE_IN_LEVEL,
  ctoVoiceMicrophoneMessage,
  type CtoVoiceStatePayload,
} from "../../../shared/types/ctoVoice";
import {
  flushVoicePlayback,
  getCtoAudioDevice,
  noteLocalBargeIn,
  playVoiceChunk,
  resetLocalBargeIn,
  stopCtoCapture,
  subscribeCtoAudioDevice,
  voicePlaybackActive,
} from "./ctoVoiceAudioDevice";
import { subscribeVoiceState, useCtoVoiceAudioOwner } from "./useCtoVoiceCall";

/**
 * A microphone that will not open must END the call and SAY so.
 *
 * This is the failure that shipped silent: the renderer hung up, the main
 * process had nothing to blame — correctly, the hang-up came from here — and
 * the HUD simply vanished with no notice. In an agent-launched dev Electron
 * (unsigned, so macOS refuses it a TCC identity) that is every single call.
 */

function AudioOwner({ state }: { state: CtoVoiceStatePayload }) {
  useCtoVoiceAudioOwner(state);
  return null;
}

const liveOwner: CtoVoiceStatePayload = {
  ...CTO_VOICE_INITIAL_STATE,
  callId: "call-1",
  phase: "connecting",
  isCallOwner: true,
};

function installBridge(overrides: {
  micStatus?: string;
  micBlock?: string | null;
  getUserMedia?: () => Promise<MediaStream>;
  audioInputs?: number;
  platform?: string;
} = {}) {
  // Typed with the parameters so the reason AND the kind it carries can both
  // be asserted: the kind is what decides whether the sentence gets a button.
  const end = vi.fn(async (_reason?: string, _errorKind?: string) => {});
  const pushAudio = vi.fn();
  (globalThis.window as unknown as { ade: unknown }).ade = {
    app: { runtimeTarget: { platform: overrides.platform ?? "darwin", arch: "arm64" } },
    transcription: {
      requestMicAccess: vi.fn(async () => ({
        status: overrides.micStatus ?? "granted",
        block: overrides.micBlock ?? null,
      })),
    },
    ctoVoice: {
      end,
      onAudio: () => () => {},
      onState: () => () => {},
      pushAudio,
      start: async () => ({ ok: true }),
      setMuted: async () => {},
      approve: async () => {},
      deny: async () => {},
      attachImage: async () => {},
      hasKey: async () => true,
    },
  };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: overrides.getUserMedia
        ?? (() => Promise.reject(new DOMException("Could not start source", "NotReadableError"))),
      enumerateDevices: async () => Array.from(
        { length: overrides.audioInputs ?? 1 },
        (_unused, index) => ({ kind: "audioinput", deviceId: `mic-${index}` }),
      ),
    },
  });
  return { end, pushAudio };
}

afterEach(() => {
  stopCtoCapture();
  cleanup();
  delete (globalThis.window as unknown as { ade?: unknown }).ade;
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("useCtoVoiceAudioOwner", () => {
  it("blames another app when the OS said yes and the device still would not open", async () => {
    // `granted` plus a rejected `getUserMedia` is not a permissions problem, and
    // sending the user to a settings pane where ADE is already ticked is the
    // failure this classification exists to stop.
    const { end } = installBridge({
      getUserMedia: () => Promise.reject(new DOMException("Could not start source", "NotReadableError")),
    });

    render(<AudioOwner state={liveOwner} />);

    await waitFor(() => expect(end).toHaveBeenCalled());
    // The sentence AND the kind: the page notice puts a settings button beside
    // some of these, and it reads the kind off the state rather than matching
    // the sentence back against every wording of every kind.
    expect(end).toHaveBeenCalledWith(ctoVoiceMicrophoneMessage("in-use", "darwin"), "in-use");
    expect(end.mock.calls[0]?.[0]).toBe("Another app is holding the microphone. Close it and try again.");
  });

  it("says there is no microphone when the machine has no input at all", async () => {
    // The owner's Mac Studio: the OS grant is fine and there is simply nothing
    // to open. Sending him to a privacy pane where ADE was already ticked is
    // the answer this replaces.
    const getUserMedia = vi.fn(async () => { throw new Error("must not be asked"); });
    const { end } = installBridge({ audioInputs: 0, getUserMedia });

    render(<AudioOwner state={liveOwner} />);

    await waitFor(() => expect(end).toHaveBeenCalled());
    expect(end.mock.calls[0]?.[0]).toBe(ctoVoiceMicrophoneMessage("no-device", "darwin"));
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("sends a development build to the sentence it can act on", async () => {
    // The owner's exact case: an agent-launched Electron has no TCC identity,
    // so `askForMediaAccess` returns false without prompting and the packaged
    // app's System Settings entry — already ticked — is a different binary.
    const { end } = installBridge({ micStatus: "denied", micBlock: "dev-build" });

    render(<AudioOwner state={liveOwner} />);

    await waitFor(() => expect(end).toHaveBeenCalled());
    expect(end.mock.calls[0]?.[0]).toBe(ctoVoiceMicrophoneMessage("dev-build", "darwin"));
    expect(end.mock.calls[0]?.[0]).toContain("Terminal");
  });

  it("points a Windows user at the Windows pane, from the bridge and not navigator", async () => {
    const { end } = installBridge({ platform: "win32", micStatus: "denied", micBlock: "os-denied" });

    render(<AudioOwner state={liveOwner} />);

    await waitFor(() => expect(end).toHaveBeenCalled());
    expect(end.mock.calls[0]?.[0]).toContain("Windows Settings › Privacy & security › Microphone");
  });

  it("refuses before getUserMedia when the OS gate says the mic is not granted", async () => {
    // Electron hands back a live, all-zero track instead of throwing when macOS
    // has not granted access, so a successful getUserMedia proves nothing. The
    // gate dictation already owns is what makes that case visible.
    const getUserMedia = vi.fn(async () => ({
      getAudioTracks: () => [{ readyState: "live" }],
      getTracks: () => [{ stop: () => {} }],
    }) as unknown as MediaStream);
    const { end } = installBridge({ micStatus: "denied", micBlock: "os-denied", getUserMedia });

    render(<AudioOwner state={liveOwner} />);

    await waitFor(() => expect(end).toHaveBeenCalled());
    expect(end.mock.calls[0]?.[0]).toContain("could not open the microphone");
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("treats a stream that arrives with no usable track as a failure", async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn(async () => ({
      getAudioTracks: () => [{ readyState: "ended" }],
      getTracks: () => [{ stop }],
    }) as unknown as MediaStream);
    const { end } = installBridge({ getUserMedia });

    render(<AudioOwner state={liveOwner} />);

    await waitFor(() => expect(end).toHaveBeenCalled());
    expect(end.mock.calls[0]?.[0]).toContain("could not open the microphone");
    // The dead stream is released rather than left holding the device.
    expect(stop).toHaveBeenCalled();
  });

  it("does not touch the microphone for a window that does not own the call", async () => {
    const { end } = installBridge();

    render(<AudioOwner state={{ ...liveOwner, isCallOwner: false }} />);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(end).not.toHaveBeenCalled();
  });

  it("stops a microphone that opens after hang-up, and never pumps it", async () => {
    // Hang-up lands while `getUserMedia` is still outstanding. The old start
    // stored whatever arrived, so a live track kept pumping into a call that
    // had already ended. Greptile P1 on PR #1249.
    let releaseStream: ((stream: MediaStream) => void) | null = null;
    const getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => {
      releaseStream = resolve;
    }));
    const { end, pushAudio } = installBridge({ getUserMedia });
    class FakeCaptureAudioContext {
      destination = {};
      createMediaStreamSource() { return { connect: () => {} }; }
      createScriptProcessor() {
        return { onaudioprocess: null as unknown, connect: () => {}, disconnect: () => {} };
      }
      close() { return Promise.resolve(); }
    }
    (globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeCaptureAudioContext;

    const { rerender } = render(<AudioOwner state={liveOwner} />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());

    rerender(<AudioOwner state={{ ...liveOwner, phase: "ended", callId: null }} />);

    const stop = vi.fn();
    releaseStream?.({
      getAudioTracks: () => [{ readyState: "live" }],
      getTracks: () => [{ stop }],
    } as unknown as MediaStream);

    await waitFor(() => expect(stop).toHaveBeenCalled());
    expect(getCtoAudioDevice().captureReady).toBe(false);
    expect(pushAudio).not.toHaveBeenCalled();
    // A hang-up the user performed is not a microphone failure.
    expect(end).not.toHaveBeenCalled();
  });
});

/**
 * A playback graph the test can watch, in the shape `playVoiceChunk` uses.
 *
 * `currentTime` never advances on its own, so "is the CTO still talking" is a
 * question about scheduled audio rather than about a real clock.
 */
function installAudioContext() {
  const closed: boolean[] = [];
  class FakeAudioContext {
    currentTime = 0;
    destination = {};
    createBuffer(_channels: number, samples: number) {
      return {
        duration: samples / 24_000,
        getChannelData: () => new Float32Array(samples),
      };
    }
    createBufferSource() {
      return { buffer: null, connect: () => {}, start: () => {} };
    }
    close() { closed.push(true); return Promise.resolve(); }
  }
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  return { closed };
}

/** A tenth of a second of PCM16 silence, as base64 — one output chunk. */
const OUTPUT_CHUNK = btoa(String.fromCharCode(...new Uint8Array(2400 * 2)));

/**
 * The local fast path for a barge-in.
 *
 * The server-side route is a full round trip — `speech_started` reaches the
 * call service, becomes an `interrupted` state, crosses the runtime event bus
 * and the desktop router — and audio already pulled into the renderer talks
 * over the user for every millisecond of it. This side knows first, because it
 * is the side holding the speaker.
 */
/**
 * The verdict and "is a device open" are one fact from two ends.
 *
 * They were two stores with two subscriptions, set in lockstep at every call
 * site — which is a pair that can be set out of step, and the start sheet reads
 * both at once. One snapshot makes that impossible rather than careful.
 */
describe("the audio device snapshot", () => {
  it("moves both halves together, and notifies once", async () => {
    installBridge({
      getUserMedia: () => Promise.reject(new DOMException("denied", "NotAllowedError")),
    });
    const seen: Array<{ failure: unknown; captureReady: boolean }> = [];
    const release = subscribeCtoAudioDevice(() => {
      const snapshot = getCtoAudioDevice();
      seen.push({ failure: snapshot.failure, captureReady: snapshot.captureReady });
    });

    render(<AudioOwner state={liveOwner} />);
    await waitFor(() => expect(getCtoAudioDevice().failure).not.toBeNull());

    expect(getCtoAudioDevice()).toMatchObject({
      captureReady: false,
      failure: { kind: "os-denied" },
    });
    // One notification carried both, rather than one per store.
    expect(seen.filter((snapshot) => snapshot.failure !== null)).toHaveLength(1);
    // And the snapshot's identity is stable while nothing has changed, because
    // `useSyncExternalStore` re-renders forever on a fresh object every read.
    expect(getCtoAudioDevice()).toBe(getCtoAudioDevice());

    release();
  });
});

describe("local barge-in", () => {
  beforeEach(() => {
    installAudioContext();
    flushVoicePlayback();
    resetLocalBargeIn();
  });

  afterEach(() => {
    flushVoicePlayback();
    resetLocalBargeIn();
  });

  it("does not flush on a peak just under the threshold, however long it lasts", () => {
    playVoiceChunk(OUTPUT_CHUNK);
    expect(voicePlaybackActive()).toBe(true);

    for (let frame = 0; frame < 8; frame += 1) {
      noteLocalBargeIn(CTO_VOICE_LOCAL_BARGE_IN_LEVEL - 0.01);
    }

    expect(voicePlaybackActive()).toBe(true);
  });

  /** One loud frame is a key press or a chair. Two in a row is a person. */
  it("flushes on the second consecutive frame at the threshold, not the first", () => {
    playVoiceChunk(OUTPUT_CHUNK);

    noteLocalBargeIn(CTO_VOICE_LOCAL_BARGE_IN_LEVEL);
    expect(voicePlaybackActive()).toBe(true);

    noteLocalBargeIn(CTO_VOICE_LOCAL_BARGE_IN_LEVEL);
    expect(voicePlaybackActive()).toBe(false);
  });

  it("forgets a lone loud frame when the next one is quiet", () => {
    playVoiceChunk(OUTPUT_CHUNK);

    noteLocalBargeIn(CTO_VOICE_LOCAL_BARGE_IN_LEVEL);
    noteLocalBargeIn(0);
    noteLocalBargeIn(CTO_VOICE_LOCAL_BARGE_IN_LEVEL);

    expect(voicePlaybackActive()).toBe(true);
  });

  it("ignores loud frames when nothing is playing", () => {
    noteLocalBargeIn(1);
    noteLocalBargeIn(1);
    expect(voicePlaybackActive()).toBe(false);
  });

  /**
   * A barge-in the server never confirmed must not mute the call forever.
   *
   * Two loud non-speech frames mid-`speaking` — a door, a cough into the desk —
   * set the latch with no VAD event behind them, and nothing then changes the
   * phase. Without a deadline the rest of that answer and every answer after it
   * is silently dropped.
   */
  it("stops discarding output once a barge-in the server never saw expires", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(10_000);

    playVoiceChunk(OUTPUT_CHUNK);
    noteLocalBargeIn(1);
    noteLocalBargeIn(1);
    expect(voicePlaybackActive()).toBe(false);

    // Still inside the window: the queue built before the user spoke is exactly
    // what the flush was for.
    now.mockReturnValue(11_400);
    playVoiceChunk(OUTPUT_CHUNK);
    expect(voicePlaybackActive()).toBe(false);

    now.mockReturnValue(11_600);
    playVoiceChunk(OUTPUT_CHUNK);
    expect(voicePlaybackActive()).toBe(true);
  });

  /** A chunk that will not decode is a gap in one answer, not a mute call. */
  it("drops a malformed chunk instead of taking the audio listener down", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => playVoiceChunk("not base64 !!!")).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  /**
   * The flush alone is not enough: the audio pump keeps draining the runtime's
   * queue, and those chunks were generated before the user opened their mouth.
   * Playing them would rebuild the graph a tenth of a second later.
   */
  it("keeps discarding chunks until the main process reports a new phase", () => {
    const handlers: Array<(state: CtoVoiceStatePayload) => void> = [];
    (globalThis.window as unknown as { ade: unknown }).ade = {
      ctoVoice: {
        onState: (handler: (state: CtoVoiceStatePayload) => void) => {
          handlers.push(handler);
          return () => {};
        },
      },
    };
    const release = subscribeVoiceState(() => {});
    handlers[0]?.({ ...CTO_VOICE_INITIAL_STATE, phase: "speaking", isCallOwner: true });

    playVoiceChunk(OUTPUT_CHUNK);
    noteLocalBargeIn(1);
    noteLocalBargeIn(1);
    expect(voicePlaybackActive()).toBe(false);

    // A state that is not a phase change — the meter pushes one of these per
    // distinct input level, all through the user's sentence.
    handlers[0]?.({
      ...CTO_VOICE_INITIAL_STATE, phase: "speaking", inputLevel: 0.4, isCallOwner: true,
    });
    playVoiceChunk(OUTPUT_CHUNK);
    expect(voicePlaybackActive()).toBe(false);

    // The next answer, which must never be muted by a barge-in against the last.
    handlers[0]?.({ ...CTO_VOICE_INITIAL_STATE, phase: "thinking", isCallOwner: true });
    playVoiceChunk(OUTPUT_CHUNK);
    expect(voicePlaybackActive()).toBe(true);

    release();
  });
});
