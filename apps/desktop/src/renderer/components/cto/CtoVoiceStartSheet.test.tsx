/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  CTO_VOICE_CHAT_OVER_LIMIT_DETAIL,
  CTO_VOICE_INITIAL_STATE,
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
let microphoneFailure: { kind: string; message: string } | null = null;
const clearCtoMicrophoneFailure = vi.fn(() => { microphoneFailure = null; });

vi.mock("./useCtoVoiceCall", () => ({
  useCtoVoiceCall: () => ({ state: callState, start }),
  useCtoMicrophoneFailure: () => microphoneFailure,
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
  callState = { ...CTO_VOICE_INITIAL_STATE, isCallOwner: true };
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
  it("goes straight to connecting, and closes once the call is live", async () => {
    const { rerender } = render(<CtoVoiceStartSheet onClose={onClose} />);

    // No key step: the sheet asks for the call first and only falls back to a
    // key when the answer says there is none.
    await waitFor(() => expect(screen.getByTestId("cto-voice-sheet-connecting")).toBeTruthy());
    expect(start).toHaveBeenCalledTimes(1);
    // Still open: the call has not connected yet, and closing here is what left
    // the user with a header notice and no way forward.
    expect(onClose).not.toHaveBeenCalled();

    setLive();
    rerender(<CtoVoiceStartSheet onClose={onClose} />);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
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
      message: "This is a development build. macOS cannot ask it for the microphone."
        + " Start ADE from Terminal, or allow 'Electron' under Microphone in System Settings.",
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
      message: "No microphone is connected. Plug one in or pick an input under System Settings, Sound.",
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
