/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import {
  CTO_VOICE_INITIAL_STATE,
  ctoVoiceMicrophoneMessage,
  type CtoVoiceStatePayload,
} from "../../../shared/types/ctoVoice";
import { useCtoVoiceAudioOwner } from "./useCtoVoiceCall";

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
  platform?: string;
} = {}) {
  // Typed with the parameter so the reason it carries can be asserted.
  const end = vi.fn(async (_reason?: string) => {});
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
      pushAudio: () => {},
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
        ?? (() => Promise.reject(new Error("Permission denied"))),
    },
  });
  return { end };
}

afterEach(() => {
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
    const { end } = installBridge();

    render(<AudioOwner state={liveOwner} />);

    await waitFor(() => expect(end).toHaveBeenCalled());
    expect(end).toHaveBeenCalledWith(ctoVoiceMicrophoneMessage("in-use", "darwin"));
    expect(end.mock.calls[0]?.[0]).toBe("Another app may be holding the microphone. Close it and try again.");
  });

  it("sends a development build to the sentence it can act on", async () => {
    // The owner's exact case: an agent-launched Electron has no TCC identity,
    // so `askForMediaAccess` returns false without prompting and the packaged
    // app's System Settings entry — already ticked — is a different binary.
    const { end } = installBridge({ micStatus: "denied", micBlock: "dev-build" });

    render(<AudioOwner state={liveOwner} />);

    await waitFor(() => expect(end).toHaveBeenCalled());
    expect(end.mock.calls[0]?.[0]).toBe(
      "This is a development build. macOS cannot ask it for the microphone."
      + " Start ADE from Terminal, or allow 'Electron' under Microphone in System Settings.",
    );
  });

  it("points a Windows user at the Windows pane, from the bridge and not navigator", async () => {
    const { end } = installBridge({ platform: "win32", micStatus: "denied", micBlock: "os-denied" });

    render(<AudioOwner state={liveOwner} />);

    await waitFor(() => expect(end).toHaveBeenCalled());
    expect(end.mock.calls[0]?.[0]).toContain("Windows Settings, Privacy, Microphone");
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
});
