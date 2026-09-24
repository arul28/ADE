/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ctoVoiceMicrophoneMessage } from "../../../shared/types/ctoVoice";
import { CtoTalkNoticeLine } from "./CtoTalkNoticeLine";
import { ctoMicrophoneSettingsAction } from "./ctoMicrophoneFix";

/**
 * The microphone failure the owner actually hit: Talk pressed on a Mac with no
 * microphone. They read a sentence naming a macOS pane, with no button to open
 * it, and asked what a Windows user is supposed to do with it. These pin both
 * halves — the sentence names the OS it is on, and every surface that shows one
 * carries the button that opens the pane it names.
 */

function setPlatform(platform: string) {
  (globalThis.window as unknown as { ade: unknown }).ade = {
    app: {
      runtimeTarget: { platform, arch: "arm64" },
      openSystemSettingsPane: vi.fn(async () => ({ opened: true })),
    },
  };
}

function openPaneSpy() {
  return (globalThis.window as unknown as {
    ade: { app: { openSystemSettingsPane: ReturnType<typeof vi.fn> } };
  }).ade.app.openSystemSettingsPane;
}

beforeEach(() => setPlatform("darwin"));

afterEach(() => {
  cleanup();
  delete (globalThis.window as unknown as { ade?: unknown }).ade;
});

describe("ctoVoiceMicrophoneMessage", () => {
  it("names the operating system it is running on, not just 'System Settings'", () => {
    expect(ctoVoiceMicrophoneMessage("no-device", "darwin"))
      .toBe("No microphone is connected to this Mac."
        + " Plug one in, or choose an input under macOS System Settings › Sound › Input.");
    expect(ctoVoiceMicrophoneMessage("no-device", "win32"))
      .toBe("No microphone is connected to this PC."
        + " Plug one in, or choose an input under Windows Settings › System › Sound › Input.");
  });

  it("says what to look for on Linux, where there is no one pane to name", () => {
    const message = ctoVoiceMicrophoneMessage("no-device", "linux");
    expect(message).toContain("your desktop's sound settings");
    expect(message).not.toContain("macOS");
    expect(message).not.toContain("Windows");
  });

  it("sends a permission refusal to the privacy pane and a missing device to sound", () => {
    expect(ctoVoiceMicrophoneMessage("os-denied", "darwin"))
      .toContain("macOS System Settings › Privacy & Security › Microphone");
    expect(ctoVoiceMicrophoneMessage("os-denied", "win32"))
      .toContain("Windows Settings › Privacy & security › Microphone");
    expect(ctoVoiceMicrophoneMessage("unavailable", "win32"))
      .toContain("Windows Settings › System › Sound › Input");
  });

  it("keeps 'start it from Terminal' to the only platform it is true on", () => {
    expect(ctoVoiceMicrophoneMessage("dev-build", "darwin")).toContain("Terminal");
    // Windows policy is one global switch, so the settings sentence IS the fix.
    expect(ctoVoiceMicrophoneMessage("dev-build", "win32")).not.toContain("Terminal");
    expect(ctoVoiceMicrophoneMessage("dev-build", "linux")).not.toContain("Terminal");
  });

  it("says two sentences for every kind", () => {
    for (const kind of ["os-denied", "dev-build", "no-device", "in-use", "unavailable"] as const) {
      for (const platform of ["darwin", "win32", "linux"]) {
        const message = ctoVoiceMicrophoneMessage(kind, platform);
        expect(message.split(". ").length).toBeGreaterThanOrEqual(2);
        expect(message.endsWith(".")).toBe(true);
      }
    }
  });
});

describe("ctoMicrophoneSettingsAction", () => {
  it("offers the sound pane for a missing device on macOS and Windows", () => {
    expect(ctoMicrophoneSettingsAction("no-device", "darwin"))
      .toEqual({ label: "Open sound settings", paneId: "macos-sound-input" });
    expect(ctoMicrophoneSettingsAction("no-device", "win32"))
      .toEqual({ label: "Open sound settings", paneId: "windows-sound" });
  });

  it("offers the privacy pane for a refusal, which is a different problem", () => {
    expect(ctoMicrophoneSettingsAction("os-denied", "darwin")?.paneId).toBe("macos-microphone");
    expect(ctoMicrophoneSettingsAction("os-denied", "win32")?.paneId).toBe("windows-microphone");
  });

  it("offers nothing on Linux, and nothing for a device another app is holding", () => {
    expect(ctoMicrophoneSettingsAction("no-device", "linux")).toBeNull();
    expect(ctoMicrophoneSettingsAction("os-denied", "linux")).toBeNull();
    expect(ctoMicrophoneSettingsAction("in-use", "darwin")).toBeNull();
    expect(ctoMicrophoneSettingsAction(null, "darwin")).toBeNull();
  });
});

describe("CtoTalkNoticeLine", () => {
  it("carries the settings button on the surface the owner actually saw", async () => {
    render(
      <CtoTalkNoticeLine
        notice={{ message: ctoVoiceMicrophoneMessage("no-device", "darwin"), microphone: "no-device" }}
      />,
    );

    expect(screen.getByTestId("cto-talk-error").textContent)
      .toContain("macOS System Settings › Sound › Input");
    fireEvent.click(screen.getByRole("button", { name: /Open (sound|microphone) settings/ }));
    await waitFor(() => expect(openPaneSpy()).toHaveBeenCalledWith("macos-sound-input"));
  });

  it("sends a Windows owner to the Windows sound pane", async () => {
    setPlatform("win32");
    render(
      <CtoTalkNoticeLine
        notice={{ message: ctoVoiceMicrophoneMessage("no-device", "win32"), microphone: "no-device" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Open (sound|microphone) settings/ }));
    await waitFor(() => expect(openPaneSpy()).toHaveBeenCalledWith("windows-sound"));
  });

  it("shows no button on Linux, or for a failure with no pane behind it", () => {
    setPlatform("linux");
    render(
      <CtoTalkNoticeLine
        notice={{ message: ctoVoiceMicrophoneMessage("no-device", "linux"), microphone: "no-device" }}
      />,
    );
    expect(screen.queryByRole("button", { name: /Open (sound|microphone) settings/ })).toBeNull();

    cleanup();
    setPlatform("darwin");
    render(<CtoTalkNoticeLine notice={{ message: "The call ended.", microphone: null }} />);
    expect(screen.queryByRole("button", { name: /Open (sound|microphone) settings/ })).toBeNull();
    expect(screen.getByTestId("cto-talk-error").textContent).toBe("The call ended.");
  });
});
