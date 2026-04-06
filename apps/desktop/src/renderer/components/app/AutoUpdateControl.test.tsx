/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoUpdateSnapshot } from "../../../shared/types";
import { AutoUpdateControl } from "./AutoUpdateControl";

const EMPTY_SNAPSHOT: AutoUpdateSnapshot = {
  status: "idle",
  version: null,
  progressPercent: null,
  bytesPerSecond: null,
  transferredBytes: null,
  totalBytes: null,
  releaseNotesUrl: null,
  error: null,
  recentlyInstalled: null,
};

describe("AutoUpdateControl", () => {
  const originalAde = globalThis.window.ade;
  const originalConfirm = globalThis.window.confirm;
  let onUpdateEvent: ((snapshot: AutoUpdateSnapshot) => void) | null = null;

  beforeEach(() => {
    onUpdateEvent = null;
    globalThis.window.confirm = vi.fn(() => true);
    globalThis.window.ade = {
      app: {
        openExternal: vi.fn(async () => undefined),
      },
      updateCheckForUpdates: vi.fn(async () => undefined),
      updateGetState: vi.fn(async () => EMPTY_SNAPSHOT),
      updateQuitAndInstall: vi.fn(async () => undefined),
      updateDismissInstalledNotice: vi.fn(async () => undefined),
      onUpdateEvent: vi.fn((callback: (snapshot: AutoUpdateSnapshot) => void) => {
        onUpdateEvent = callback;
        return () => {
          onUpdateEvent = null;
        };
      }),
    } as any;
  });

  afterEach(() => {
    cleanup();
    if (originalAde === undefined) {
      delete (globalThis.window as any).ade;
    } else {
      globalThis.window.ade = originalAde;
    }
    globalThis.window.confirm = originalConfirm;
  });

  it("shows the post-install modal and opens Mintlify release notes", async () => {
    const snapshot: AutoUpdateSnapshot = {
      ...EMPTY_SNAPSHOT,
      recentlyInstalled: {
        version: "1.2.3",
        installedAt: "2026-04-06T15:23:00.000Z",
        releaseNotesUrl: "https://www.ade-app.dev/changelog/v1.2.3",
      },
    };
    globalThis.window.ade.updateGetState = vi.fn(async () => snapshot);

    render(<AutoUpdateControl />);

    expect(await screen.findByText(/ADE updated/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /open release notes/i }));

    expect(globalThis.window.ade.app.openExternal).toHaveBeenCalledWith(
      "https://www.ade-app.dev/changelog/v1.2.3",
    );
    expect(globalThis.window.ade.updateDismissInstalledNotice).toHaveBeenCalledTimes(1);
  });

  it("switches to restart-to-install once the update is downloaded", async () => {
    render(<AutoUpdateControl />);

    await waitFor(() => {
      expect(globalThis.window.ade.onUpdateEvent).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      onUpdateEvent?.({
        ...EMPTY_SNAPSHOT,
        status: "ready",
        version: "1.2.3",
        releaseNotesUrl: "https://www.ade-app.dev/changelog/v1.2.3",
      });
    });

    fireEvent.click(await screen.findByRole("button", { name: /restart to install v1.2.3/i }));

    expect(globalThis.window.confirm).toHaveBeenCalledTimes(1);
    expect(globalThis.window.ade.updateQuitAndInstall).toHaveBeenCalledTimes(1);
  });
});
