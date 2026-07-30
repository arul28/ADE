/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AutoUpdateBanner, describeStalenessBanner } from "./AutoUpdateBanner";
import { ToastStack } from "./toast/ToastStack";
import { getToasts, dismissToast } from "./toast/toastStore";
import { EMPTY_AUTO_UPDATE_SNAPSHOT } from "./useAutoUpdateSnapshot";
import type { AutoUpdateSnapshot } from "../../../shared/types";

function snapshot(overrides: Partial<AutoUpdateSnapshot>): AutoUpdateSnapshot {
  return { ...EMPTY_AUTO_UPDATE_SNAPSHOT, currentVersion: "1.2.34", ...overrides };
}

function installAdeMock(initial: AutoUpdateSnapshot = snapshot({})) {
  const updateQuitAndInstall = vi.fn(async () => true);
  const updateCancelAutoApply = vi.fn(async () => true);
  const capture = vi.fn(async () => ({ accepted: true, reason: "accepted" as const }));
  // Mutable so the initial (async) getState read can't clobber an already-emitted
  // state when its promise settles late.
  let current = initial;
  let listener: ((s: AutoUpdateSnapshot) => void) | null = null;
  Object.defineProperty(window, "ade", {
    configurable: true,
    value: {
      updateGetState: vi.fn(async () => current),
      updateQuitAndInstall,
      updateCancelAutoApply,
      analytics: { capture },
      onUpdateEvent: vi.fn((cb: (s: AutoUpdateSnapshot) => void) => {
        listener = cb;
        return () => {
          listener = null;
        };
      }),
    },
  });
  return {
    updateQuitAndInstall,
    updateCancelAutoApply,
    capture,
    emit(next: AutoUpdateSnapshot) {
      current = next;
      act(() => listener?.(next));
    },
  };
}

describe("describeStalenessBanner", () => {
  it("returns null in idle steady state", () => {
    expect(describeStalenessBanner(snapshot({ status: "idle" }))).toBeNull();
  });

  it("keeps a normally downloaded update in the top-right control only", () => {
    expect(describeStalenessBanner(
      snapshot({ status: "ready", version: "1.2.35" }),
    )).toBeNull();
  });

  it("flags a ready update after a failed install attempt", () => {
    const banner = describeStalenessBanner(snapshot({
      status: "ready",
      version: "1.2.35",
      lastInstallFailed: { targetVersion: "1.2.35", attempt: 1 },
    }));
    expect(banner?.kind).toBe("failed");
    expect(banner?.signature).toContain("1.2.35");
  });

  it("prefers the parked state over a ready status", () => {
    const banner = describeStalenessBanner(
      snapshot({
        status: "ready",
        version: "1.2.35",
        parked: { reason: "prepare_failed", at: 111 },
      }),
    );
    expect(banner?.kind).toBe("parked");
    expect(banner?.signature).toContain("prepare_failed");
  });

  it("does not flag a still-downloading update", () => {
    expect(describeStalenessBanner(snapshot({ status: "downloading", version: "1.2.35" }))).toBeNull();
  });
});

describe("AutoUpdateBanner", () => {
  beforeEach(() => {
    installAdeMock();
  });

  afterEach(() => {
    cleanup();
    for (const toast of getToasts()) dismissToast(toast.id);
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "ade");
  });

  it("stays hidden in steady state", async () => {
    render(<AutoUpdateBanner />);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /restart now/i })).toBeNull();
    });
  });

  it("does not show a wide banner for a normally ready update", async () => {
    const mock = installAdeMock(snapshot({ status: "ready", version: "1.2.35" }));
    render(<AutoUpdateBanner />);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /restart now/i })).toBeNull();
    });
    expect(mock.updateQuitAndInstall).not.toHaveBeenCalled();
  });

  it("shows the parked retry copy", async () => {
    installAdeMock(
      snapshot({
        status: "ready",
        version: "1.2.35",
        parked: { reason: "handoff_failed", at: 5 },
      }),
    );
    render(<AutoUpdateBanner />);
    expect(await screen.findByText(/ADE update didn't finish — Restart to retry/)).toBeTruthy();
  });

  it("dismisses until the state changes", async () => {
    const mock = installAdeMock(snapshot({
      status: "ready",
      version: "1.2.35",
      parked: { reason: "handoff_failed", at: 5 },
    }));
    render(<AutoUpdateBanner />);

    await screen.findByText(/ADE update didn't finish/);
    fireEvent.click(screen.getByRole("button", { name: /dismiss update banner/i }));
    await waitFor(() => {
      expect(screen.queryByText(/ADE update didn't finish/)).toBeNull();
    });
    expect(mock.capture).toHaveBeenCalledWith(expect.objectContaining({
      properties: expect.objectContaining({ user_action: "dismissed" }),
    }));

    // A fresh abort has a different signature, so the banner returns.
    mock.emit(snapshot({
      status: "ready",
      version: "1.2.35",
      parked: { reason: "handoff_failed", at: 6 },
    }));
    expect(await screen.findByText(/ADE update didn't finish/)).toBeTruthy();
  });

  it("shows a countdown toast and cancels the auto-apply", async () => {
    const mock = installAdeMock(
      snapshot({
        status: "ready",
        version: "1.2.35",
        autoApplyPending: { deadlineAt: Date.now() + 10_000 },
      }),
    );
    render(
      <>
        <AutoUpdateBanner />
        <ToastStack />
      </>,
    );

    expect(await screen.findByText(/ADE will update in \d+s/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => {
      expect(mock.updateCancelAutoApply).toHaveBeenCalledTimes(1);
    });
    expect(mock.capture).toHaveBeenCalledWith(expect.objectContaining({
      properties: expect.objectContaining({ user_action: "deferred" }),
    }));

    // Clearing the pending state removes the toast.
    mock.emit(snapshot({ status: "ready", version: "1.2.35" }));
    await waitFor(() => {
      expect(screen.queryByText(/ADE will update/)).toBeNull();
    });
  });

  it("does not let a countdown tick restore the toast while cancellation is in flight", async () => {
    vi.useFakeTimers();
    let resolveCancel!: (value: boolean) => void;
    const cancelPromise = new Promise<boolean>((resolve) => {
      resolveCancel = resolve;
    });
    const mock = installAdeMock(
      snapshot({
        status: "ready",
        version: "1.2.35",
        autoApplyPending: { deadlineAt: Date.now() + 10_000 },
      }),
    );
    mock.updateCancelAutoApply.mockImplementation(() => cancelPromise);
    render(
      <>
        <AutoUpdateBanner />
        <ToastStack />
      </>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText(/ADE will update in \d+s/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByText(/ADE will update/)).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.queryByText(/ADE will update/)).toBeNull();

    mock.emit(snapshot({ status: "ready", version: "1.2.35" }));
    resolveCancel(true);
  });
});
