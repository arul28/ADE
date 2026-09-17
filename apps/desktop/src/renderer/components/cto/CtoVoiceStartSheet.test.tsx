/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  CTO_VOICE_CHAT_OVER_LIMIT_DETAIL,
  CTO_VOICE_INITIAL_STATE,
  ctoVoiceMicrophoneMessage,
  type CtoVoiceStatePayload,
} from "../../../shared/types/ctoVoice";
import { CtoVoiceStartSheet } from "./CtoVoiceStartSheet";

/**
 * The flow between "I have no key" and "I can hear the CTO".
 *
 * It used to end at Save — the sheet closed, the call started behind it, and a
 * microphone that would not open became a yellow line under the page header
 * with no way to act on it. These pin the sheet staying up until the call is
 * genuinely live, and turning into something actionable when it is not.
 */

const start = vi.fn(async () => ({ ok: true }) as { ok: boolean; error?: string; detail?: string });
const startFreshSession = vi.fn(async () => ({
  sessionId: "cto-2",
  previousSessionId: "cto-1",
  handoff: { written: true, thin: false, source: "model" as const },
}));
const onClose = vi.fn();

let callState: CtoVoiceStatePayload = { ...CTO_VOICE_INITIAL_STATE, isCallOwner: true };
/** The microphone verdict, which arrives AFTER the phase goes live. */
let captureReady = false;
let microphoneFailure: { kind: string; message: string } | null = null;
const clearCtoMicrophoneFailure = vi.fn(() => { microphoneFailure = null; });

vi.mock("./useCtoVoiceCall", () => ({
  useCtoVoiceCall: () => ({ state: callState, start }),
  useCtoMicrophoneFailure: () => microphoneFailure,
  useCtoCaptureReady: () => captureReady,
  clearCtoMicrophoneFailure: () => clearCtoMicrophoneFailure(),
}));

/* The key sheet is a whole settings surface; this suite is about the flow. */
vi.mock("../settings/OpenAiKeySheet", () => ({
  OpenAiKeySheet: ({ onSaved, onCancel, saveLabel }: {
    onSaved?: () => void; onCancel?: () => void; saveLabel?: string;
  }) => (
    <div data-testid="key-sheet">
      <button type="button" onClick={onSaved}>{saveLabel}</button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  ),
}));

function setLive() {
  callState = { ...CTO_VOICE_INITIAL_STATE, phase: "listening", callId: "c1", isCallOwner: true };
}

beforeEach(() => {
  start.mockClear();
  startFreshSession.mockClear();
  onClose.mockClear();
  clearCtoMicrophoneFailure.mockClear();
  microphoneFailure = null;
  captureReady = false;
  callState = { ...CTO_VOICE_INITIAL_STATE, isCallOwner: true };
  vi.useRealTimers();
  (globalThis.window as unknown as { ade: unknown }).ade = {
    app: {
      runtimeTarget: { platform: "darwin", arch: "arm64" },
      openSystemSettingsPane: vi.fn(async () => ({ opened: true })),
    },
    cto: { startFreshSession },
  };
});

afterEach(() => {
  cleanup();
  delete (globalThis.window as unknown as { ade?: unknown }).ade;
});

describe("CtoVoiceStartSheet", () => {
  it("goes straight to connecting, and closes once the microphone is open", async () => {
    const { rerender } = render(<CtoVoiceStartSheet onClose={onClose} />);

    // No key step: the sheet asks for the call first and only falls back to a
    // key when the answer says there is none.
    await waitFor(() => expect(screen.getByTestId("cto-voice-sheet-connecting")).toBeTruthy());
    expect(start).toHaveBeenCalledTimes(1);
    // Still open: the call has not connected yet, and closing here is what left
    // the user with a header notice and no way forward.
    expect(onClose).not.toHaveBeenCalled();

    // A live PHASE is not enough. The microphone is opened by the HUD host
    // after this point, so a sheet that closes here is a sheet that is gone
    // before the device can refuse.
    setLive();
    rerender(<CtoVoiceStartSheet onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId("cto-voice-sheet-connecting")).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();

    captureReady = true;
    rerender(<CtoVoiceStartSheet onClose={onClose} />);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("keeps a microphone refusal that lands after the call went live inside the sheet", async () => {
    const { rerender } = render(<CtoVoiceStartSheet onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId("cto-voice-sheet-connecting")).toBeTruthy());

    // The exact race: the phase reaches a live value first, and the device
    // answers a moment later. The sheet has to still be there to say so.
    setLive();
    rerender(<CtoVoiceStartSheet onClose={onClose} />);
    microphoneFailure = { kind: "os-denied", message: ctoVoiceMicrophoneMessage("os-denied", "darwin") };
    rerender(<CtoVoiceStartSheet onClose={onClose} />);

    await waitFor(() => expect(screen.getByTestId("cto-voice-sheet-blocked")).toBeTruthy());
    expect(screen.getByTestId("cto-voice-try-again")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stops waiting for a microphone verdict that never comes", async () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<CtoVoiceStartSheet onClose={onClose} />);
      await vi.advanceTimersByTimeAsync(0);
      setLive();
      rerender(<CtoVoiceStartSheet onClose={onClose} />);
      expect(onClose).not.toHaveBeenCalled();
      // No host to open the device, no failure either: the call is up, so the
      // sheet gives way rather than spinning over a working call.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the key step only when the call says there is no key", async () => {
    start.mockResolvedValueOnce({ ok: false, error: "missing-key", detail: "no OpenAI key on this machine" });
    render(<CtoVoiceStartSheet onClose={onClose} />);

    await waitFor(() => expect(screen.getByTestId("key-sheet")).toBeTruthy());

    fireEvent.click(screen.getByText("Save and start"));

    await waitFor(() => expect(screen.getByTestId("cto-voice-sheet-connecting")).toBeTruthy());
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("shows the microphone card instead of closing, with the sentence for the cause", async () => {
    const { rerender } = render(<CtoVoiceStartSheet onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId("cto-voice-sheet-connecting")).toBeTruthy());

    microphoneFailure = {
      kind: "dev-build",
      message: ctoVoiceMicrophoneMessage("dev-build", "darwin"),
    };
    rerender(<CtoVoiceStartSheet onClose={onClose} />);

    await waitFor(() => expect(screen.getByTestId("cto-voice-sheet-blocked")).toBeTruthy());
    expect(screen.getByText("ADE cannot use the microphone")).toBeTruthy();
    expect(screen.getByText(/development build/)).toBeTruthy();
    expect(screen.getByTestId("cto-voice-open-mic-settings")).toBeTruthy();
    expect(screen.getByTestId("cto-voice-try-again")).toBeTruthy();
    expect(screen.getByTestId("cto-voice-sheet-close")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("sends a machine with no input device to the sound pane, not the privacy one", async () => {
    microphoneFailure = {
      kind: "no-device",
      message: ctoVoiceMicrophoneMessage("no-device", "darwin"),
    };
    render(<CtoVoiceStartSheet onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId("cto-voice-sheet-blocked")).toBeTruthy());
    expect(screen.getByText("Open sound settings")).toBeTruthy();

    fireEvent.click(screen.getByTestId("cto-voice-open-mic-settings"));

    const open = (globalThis.window as unknown as {
      ade: { app: { openSystemSettingsPane: ReturnType<typeof vi.fn> } };
    }).ade.app.openSystemSettingsPane;
    await waitFor(() => expect(open).toHaveBeenCalledWith("macos-sound-input"));
  });

  it("offers the Windows sound pane to a Windows owner with no input device", async () => {
    (globalThis.window as unknown as {
      ade: { app: { runtimeTarget: { platform: string } } };
    }).ade.app.runtimeTarget.platform = "win32";
    microphoneFailure = {
      kind: "no-device",
      message: ctoVoiceMicrophoneMessage("no-device", "win32"),
    };
    render(<CtoVoiceStartSheet onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId("cto-voice-sheet-blocked")).toBeTruthy());
    expect(screen.getByText(/Windows Settings › System › Sound › Input/)).toBeTruthy();

    fireEvent.click(screen.getByTestId("cto-voice-open-mic-settings"));

    const open = (globalThis.window as unknown as {
      ade: { app: { openSystemSettingsPane: ReturnType<typeof vi.fn> } };
    }).ade.app.openSystemSettingsPane;
    await waitFor(() => expect(open).toHaveBeenCalledWith("windows-sound"));
  });

  it("keeps the sentence but drops the button on Linux, where no pane can be opened", async () => {
    (globalThis.window as unknown as {
      ade: { app: { runtimeTarget: { platform: string } } };
    }).ade.app.runtimeTarget.platform = "linux";
    microphoneFailure = {
      kind: "no-device",
      message: ctoVoiceMicrophoneMessage("no-device", "linux"),
    };
    render(<CtoVoiceStartSheet onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId("cto-voice-sheet-blocked")).toBeTruthy());
    expect(screen.getByText(/your desktop's sound settings/)).toBeTruthy();
    expect(screen.queryByTestId("cto-voice-open-mic-settings")).toBeNull();
  });

  it("opens the microphone pane by id, never by URL", async () => {
    microphoneFailure = { kind: "os-denied", message: "no mic" };
    render(<CtoVoiceStartSheet onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId("cto-voice-open-mic-settings")).toBeTruthy());

    fireEvent.click(screen.getByTestId("cto-voice-open-mic-settings"));

    const open = (globalThis.window as unknown as {
      ade: { app: { openSystemSettingsPane: ReturnType<typeof vi.fn> } };
    }).ade.app.openSystemSettingsPane;
    await waitFor(() => expect(open).toHaveBeenCalledWith("macos-microphone"));
  });

  it("re-runs the call from Try again, and forgets the last verdict first", async () => {
    microphoneFailure = { kind: "os-denied", message: "no mic" };
    render(<CtoVoiceStartSheet onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId("cto-voice-sheet-blocked")).toBeTruthy());
    const beforeRetry = start.mock.calls.length;

    fireEvent.click(screen.getByTestId("cto-voice-try-again"));

    await waitFor(() => expect(start.mock.calls.length).toBe(beforeRetry + 1));
    // Without this the sheet snaps straight back to the card it just left.
    expect(clearCtoMicrophoneFailure).toHaveBeenCalled();
    expect(screen.getByTestId("cto-voice-sheet-connecting")).toBeTruthy();
  });

  it("renders a refused start inside the sheet rather than behind it", async () => {
    start.mockResolvedValueOnce({ ok: false, error: "unavailable", detail: "no project is open" });
    render(<CtoVoiceStartSheet onClose={onClose} />);

    await waitFor(() => expect(screen.getByTestId("cto-voice-sheet-blocked")).toBeTruthy());
    expect(screen.getByText("ADE cannot start the call")).toBeTruthy();
    expect(screen.getByText(/no project is open\./)).toBeTruthy();
    // Not a microphone problem, so no pane to offer.
    expect(screen.queryByTestId("cto-voice-open-mic-settings")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows a call that died before it connected, with the runtime's own sentence", async () => {
    const { rerender } = render(<CtoVoiceStartSheet onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId("cto-voice-sheet-connecting")).toBeTruthy());

    callState = {
      ...CTO_VOICE_INITIAL_STATE,
      phase: "failed",
      error: "OpenAI rejected this key. Check it under CTO settings, Voice.",
      isCallOwner: true,
    };
    rerender(<CtoVoiceStartSheet onClose={onClose} />);

    await waitFor(() => expect(screen.getByTestId("cto-voice-sheet-blocked")).toBeTruthy());
    expect(screen.getByText(/OpenAI rejected this key/)).toBeTruthy();
  });

  /**
   * The call store is module-scoped: the last call's error outlives the HUD that
   * showed it, and a sheet opened afterwards would read it as its own.
   */
  it("ignores the error the last call left behind", async () => {
    callState = {
      ...CTO_VOICE_INITIAL_STATE,
      phase: "failed",
      callId: "c0",
      error: "OpenAI rejected this key. Check it under CTO settings, Voice.",
      isCallOwner: true,
    };
    render(<CtoVoiceStartSheet onClose={onClose} />);

    await waitFor(() => expect(start).toHaveBeenCalled());
    expect(screen.getByTestId("cto-voice-sheet-connecting")).toBeTruthy();
    expect(screen.queryByTestId("cto-voice-sheet-blocked")).toBeNull();
  });

  it("still blocks on a failure that belongs to this call", async () => {
    callState = {
      ...CTO_VOICE_INITIAL_STATE,
      phase: "failed",
      callId: "c0",
      error: "That call failed.",
      isCallOwner: true,
    };
    const { rerender } = render(<CtoVoiceStartSheet onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId("cto-voice-sheet-connecting")).toBeTruthy());

    callState = {
      ...CTO_VOICE_INITIAL_STATE,
      phase: "failed",
      callId: "c1",
      error: "The voice connection failed.",
      isCallOwner: true,
    };
    rerender(<CtoVoiceStartSheet onClose={onClose} />);

    await waitFor(() => expect(screen.getByTestId("cto-voice-sheet-blocked")).toBeTruthy());
    expect(screen.getByText(/The voice connection failed/)).toBeTruthy();
  });

  it("offers a fresh session only when the chat itself is what refused the call", async () => {
    start.mockResolvedValueOnce({
      ok: false,
      error: "chat-unavailable",
      detail: CTO_VOICE_CHAT_OVER_LIMIT_DETAIL,
    });
    render(<CtoVoiceStartSheet onClose={onClose} />);

    await waitFor(() => expect(screen.getByTestId("cto-voice-sheet-blocked")).toBeTruthy());
    // The headline must not argue with the detail sentence printed after it.
    expect(screen.getByText(/ADE can't start a call on this conversation\./)).toBeTruthy();
    expect(screen.getByText(/over its context limit/)).toBeTruthy();
    expect(screen.getByTestId("cto-voice-start-fresh-session")).toBeTruthy();
    // The existing way out stays where it was.
    expect(screen.getByTestId("cto-voice-try-again")).toBeTruthy();
    expect(screen.getByTestId("cto-voice-sheet-close")).toBeTruthy();
  });

  it("keeps the fresh-session button off every other refusal", async () => {
    start.mockResolvedValueOnce({ ok: false, error: "unavailable", detail: "no project is open" });
    render(<CtoVoiceStartSheet onClose={onClose} />);

    await waitFor(() => expect(screen.getByTestId("cto-voice-sheet-blocked")).toBeTruthy());
    expect(screen.queryByTestId("cto-voice-start-fresh-session")).toBeNull();
  });

  it("starts a fresh session and retries the call from the refusal card", async () => {
    start.mockResolvedValueOnce({
      ok: false,
      error: "chat-unavailable",
      detail: CTO_VOICE_CHAT_OVER_LIMIT_DETAIL,
    });
    render(<CtoVoiceStartSheet onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId("cto-voice-start-fresh-session")).toBeTruthy());
    expect(start).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("cto-voice-start-fresh-session"));

    await waitFor(() => expect(startFreshSession).toHaveBeenCalledTimes(1));
    // Recovery means the call is tried again, not that the owner is sent back
    // to the button they already pressed.
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  });

  it("cancelling the key step closes without asking for the call again", async () => {
    start.mockResolvedValueOnce({ ok: false, error: "missing-key", detail: "no OpenAI key on this machine" });
    render(<CtoVoiceStartSheet onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId("key-sheet")).toBeTruthy());

    fireEvent.click(screen.getByText("Cancel"));

    expect(onClose).toHaveBeenCalledTimes(1);
    // The mount attempt is the only one: cancelling asks for nothing further.
    expect(start).toHaveBeenCalledTimes(1);
  });
});
