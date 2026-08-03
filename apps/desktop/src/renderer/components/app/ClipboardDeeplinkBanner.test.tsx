// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClipboardDeeplinkBanner } from "./ClipboardDeeplinkBanner";

const DEEPLINK =
  "https://ade-app.dev/open?type=lane&id=550e8400-e29b-41d4-a716-446655440000";

const readClipboardText = vi.fn(async () => DEEPLINK);

beforeEach(() => {
  readClipboardText.mockClear();
  (globalThis.window as any).ade = {
    app: { readClipboardText, openExternal: vi.fn(async () => {}) },
  };
});

afterEach(() => {
  cleanup();
  delete (globalThis.window as any).__adeWebClient;
  delete (globalThis.window as any).ade;
});

describe("ClipboardDeeplinkBanner", () => {
  it("reads the clipboard on focus in the desktop app", async () => {
    render(<ClipboardDeeplinkBanner />);

    await waitFor(() => expect(readClipboardText).toHaveBeenCalled());
    expect(await screen.findByText(/Found ADE link in clipboard/)).toBeTruthy();

    const before = readClipboardText.mock.calls.length;
    fireEvent.focus(window);
    await waitFor(() => expect(readClipboardText.mock.calls.length).toBeGreaterThan(before));
  });

  /**
   * The browser prices a speculative clipboard read at one "Paste" permission
   * callout, pinned to the pointer and swallowing the click under it. Since the
   * callout takes focus, a focus-driven read re-arms itself every time the user
   * dismisses one.
   */
  it("never touches the clipboard in the hosted web client", async () => {
    (globalThis.window as any).__adeWebClient = true;
    render(<ClipboardDeeplinkBanner />);

    fireEvent.focus(window);
    fireEvent.focus(window);
    await Promise.resolve();

    expect(readClipboardText).not.toHaveBeenCalled();
    expect(screen.queryByText(/Found ADE link in clipboard/)).toBeNull();
  });
});
