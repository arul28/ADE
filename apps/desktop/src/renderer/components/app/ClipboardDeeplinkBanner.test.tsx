// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClipboardDeeplinkBanner } from "./ClipboardDeeplinkBanner";
import { AppBannerHost } from "../ui/notice";
import { resetAppBannersForTests } from "../ui/notice/appBannerStore";

function renderBanner() {
  return render(
    <>
      <ClipboardDeeplinkBanner />
      <AppBannerHost />
    </>,
  );
}

const DEEPLINK =
  "https://ade-app.dev/open?type=lane&id=550e8400-e29b-41d4-a716-446655440000";

const clipboardReads: Promise<string>[] = [];
const readClipboardText = vi.fn(() => {
  const result = Promise.resolve(DEEPLINK);
  clipboardReads.push(result);
  return result;
});

beforeEach(() => {
  readClipboardText.mockClear();
  clipboardReads.length = 0;
  (globalThis.window as any).ade = {
    app: { readClipboardText, openExternal: vi.fn(async () => {}) },
  };
});

afterEach(() => {
  cleanup();
  resetAppBannersForTests();
  delete (globalThis.window as any).__adeWebClient;
  delete (globalThis.window as any).ade;
});

describe("ClipboardDeeplinkBanner", () => {
  it("reads the clipboard on focus in the desktop app", async () => {
    renderBanner();

    await waitFor(() => expect(readClipboardText).toHaveBeenCalled());
    expect(await screen.findByText(/Found ADE link in clipboard/)).toBeTruthy();

    const before = readClipboardText.mock.calls.length;
    fireEvent.focus(window);
    await waitFor(() => expect(readClipboardText.mock.calls.length).toBeGreaterThan(before));
  });

  it("floats as a top-center prompt and opens the link as an ade:// URL", async () => {
    renderBanner();

    await screen.findByText(/Found ADE link in clipboard/);
    const floating = screen.getByTestId("app-banner-floating");
    expect(floating.textContent).toContain("Found ADE link in clipboard");

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const openExternal = (globalThis.window as any).ade.app.openExternal as ReturnType<typeof vi.fn>;
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(String(openExternal.mock.calls[0]?.[0])).toMatch(/^ade:\/\//);
    await waitFor(() => expect(screen.queryByText(/Found ADE link in clipboard/)).toBeNull());

    // The same link is not offered again once acted on.
    const previousReads = clipboardReads.length;
    fireEvent.focus(window);
    await waitFor(() => expect(clipboardReads).toHaveLength(previousReads + 1));
    await expect(clipboardReads[previousReads]).resolves.toBe(DEEPLINK);
    expect(screen.queryByText(/Found ADE link in clipboard/)).toBeNull();
  });

  /**
   * The browser prices a speculative clipboard read at one "Paste" permission
   * callout, pinned to the pointer and swallowing the click under it. Since the
   * callout takes focus, a focus-driven read re-arms itself every time the user
   * dismisses one.
   */
  it("never touches the clipboard in the hosted web client", async () => {
    (globalThis.window as any).__adeWebClient = true;
    renderBanner();

    fireEvent.focus(window);
    fireEvent.focus(window);

    expect(readClipboardText).not.toHaveBeenCalled();
    expect(screen.queryByText(/Found ADE link in clipboard/)).toBeNull();
  });
});
