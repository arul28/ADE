/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import {
  CTO_VOICE_INITIAL_STATE,
  ctoVoiceMicrophoneUnavailableMessage,
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
  getUserMedia?: () => Promise<MediaStream>;
  platform?: string;
} = {}) {
  // Typed with the parameter so the reason it carries can be asserted.
  const end = vi.fn(async (_reason?: string) => {});
  (globalThis.window as unknown as { ade: unknown }).ade = {
    app: { runtimeTarget: { platform: overrides.platform ?? "darwin", arch: "arm64" } },
    transcription: {
      requestMicAccess: vi.fn(async () => ({ status: overrides.micStatus ?? "granted" })),
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
  it("ends the call with the microphone sentence when getUserMedia refuses", async () => {
    const { end } = installBridge();

    render(<AudioOwner state={liveOwner} />);

    await waitFor(() => expect(end).toHaveBeenCalled());
    expect(end).toHaveBeenCalledWith(ctoVoiceMicrophoneUnavailableMessage("darwin"));
    expect(end.mock.calls[0]?.[0]).toContain("System Settings, Privacy & Security, Microphone");
  });

  it("points a Windows user at the Windows pane, from the bridge and not navigator", async () => {
    const { end } = installBridge({ platform: "win32" });

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
    const { end } = installBridge({ micStatus: "denied", getUserMedia });

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
