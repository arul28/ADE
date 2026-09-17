/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { CTO_VOICE_INITIAL_STATE, type CtoVoiceState } from "../../../shared/types/ctoVoice";
import { CtoVoiceHud } from "./CtoVoiceHud";

/**
 * What the person on the call can see about what was heard.
 *
 * Two failures from the call of 2026-09-16, both of them the HUD's to answer: a
 * user who said three sentences and watched nothing appear until the finals
 * arrived at once, and an answer cut off by a barge-in whose caption claimed
 * the half sentence was the whole of it.
 */

function renderHud(patch: Partial<CtoVoiceState>) {
  const state: CtoVoiceState = { ...CTO_VOICE_INITIAL_STATE, phase: "listening", ...patch };
  render(
    <CtoVoiceHud
      state={state}
      onToggleMute={vi.fn()}
      onEnd={vi.fn()}
      onApproveConfirmation={vi.fn()}
      onDenyConfirmation={vi.fn()}
    />,
  );
}

afterEach(() => { cleanup(); });

describe("the call HUD's captions", () => {
  it("shows the words still being transcribed", () => {
    renderHud({ pendingUserText: "what merged yester" });
    expect(screen.getByTestId("cto-voice-pending-caption").textContent)
      .toContain("what merged yester");
  });

  it("shows nothing extra when nothing is part-heard", () => {
    renderHud({ captions: [{ role: "user", text: "hello", atMs: 10 }] });
    expect(screen.queryByTestId("cto-voice-pending-caption")).toBeNull();
    expect(screen.getByTestId("cto-voice-caption").textContent).toContain("hello");
  });

  it("marks a caption the user cut off", () => {
    renderHud({
      captions: [{ role: "assistant", text: "I'm the CTO", atMs: 10, interrupted: true }],
    });
    expect(screen.getByTestId("cto-voice-caption-cut")).toBeTruthy();
  });

  it("leaves a finished answer unmarked", () => {
    renderHud({ captions: [{ role: "assistant", text: "Three merged yesterday.", atMs: 10 }] });
    expect(screen.queryByTestId("cto-voice-caption-cut")).toBeNull();
  });
});

/**
 * A call is a surface where nothing is clicked and everything moves on its own.
 *
 * The captions are the only record of what was said and the phase label is the
 * only word for what the call is doing, so both have to be announced; and a
 * strip that can authorise a destructive action must arrive where the keyboard
 * already is rather than somewhere the user has to go and find — without the
 * destructive answer itself being one keypress away.
 */
describe("the call HUD's announcements", () => {
  it("announces the captions and the phase without interrupting", () => {
    renderHud({ captions: [{ role: "assistant", text: "Two checks are red.", atMs: 10 }] });
    expect(screen.getByTestId("cto-voice-captions").getAttribute("aria-live")).toBe("polite");
    expect(screen.getByTestId("cto-voice-phase-label").getAttribute("aria-live")).toBe("polite");
  });

  it("keeps the caption region in the accessibility tree before anything is said", () => {
    // `empty:hidden` is `display: none`, which takes a live region back OUT of
    // the tree — and a region that appears with its content already in it
    // announces nothing at all, which is the failure it was meant to avoid.
    renderHud({ captions: [] });
    const captions = screen.getByTestId("cto-voice-captions");
    expect(captions.className).not.toContain("empty:hidden");
  });

  it("raises the confirmation strip as an alert, and puts the keyboard on the strip", () => {
    renderHud({
      phase: "confirming",
      pendingConfirmation: {
        id: "confirm-1",
        prompt: "Force-push the sync lane?",
        toolName: "gitForcePush",
        destructive: true,
        utteranceId: null,
        expiresAtMs: 0,
      },
    });
    const strip = screen.getByTestId("cto-voice-confirm");
    expect(strip.getAttribute("role")).toBe("alert");
    // The STRIP, never the approve button: a focused "Yes, do it" turns one
    // stray Enter or Space into an authorised force-push.
    expect(document.activeElement).toBe(strip);
    expect(document.activeElement).not.toBe(screen.getByTestId("cto-voice-confirm-approve"));
  });
});
