/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AutoUpdateBanner, describeStalenessBanner } from "./AutoUpdateBanner";
import { ToastStack } from "./toast/ToastStack";
import { AppBannerHost } from "../ui/notice";
import { resetAppBannersForTests } from "../ui/notice/appBannerStore";
import { DialogHost, __resetDialogRequestsForTests } from "../ui/dialog/confirm";
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
      updateGetInstallImpact: vi.fn(async () => ({ connectedPhones: [] })),
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
    __resetDialogRequestsForTests();
    resetAppBannersForTests();
    for (const toast of getToasts()) dismissToast(toast.id);
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "ade");
  });

  it("stays hidden in steady state", async () => {
    render(<><AutoUpdateBanner /><AppBannerHost /></>);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /restart now/i })).toBeNull();
    });
  });

  it("shows a floating prompt for a normally ready update", async () => {
    installAdeMock(snapshot({ status: "ready", version: "1.2.35" }));
    render(<><AutoUpdateBanner /><AppBannerHost /></>);

    const title = await screen.findByText("Update v1.2.35 is ready to install");
    expect(title.closest('[data-banner-layout="floating"]')).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart and install" })).toBeTruthy();
    expect(screen.queryByTestId("app-banner-dock")).toBeNull();
  });

  it("reappears for a new ready version after the current prompt is dismissed", async () => {
    const mock = installAdeMock(snapshot({ status: "ready", version: "1.2.35" }));
    render(<><AutoUpdateBanner /><AppBannerHost /></>);

    await screen.findByText("Update v1.2.35 is ready to install");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss update prompt" }));
    await waitFor(() => {
      expect(screen.queryByText("Update v1.2.35 is ready to install")).toBeNull();
    });
    expect(mock.capture).toHaveBeenCalledWith(expect.objectContaining({
      properties: expect.objectContaining({ user_action: "dismissed" }),
    }));

    mock.emit(snapshot({ status: "ready", version: "1.2.36" }));
    expect(await screen.findByText("Update v1.2.36 is ready to install")).toBeTruthy();
  });

  it("uses the shared install confirmation and action from the floating prompt", async () => {
    const mock = installAdeMock(snapshot({ status: "ready", version: "1.2.35" }));
    render(<><AutoUpdateBanner /><AppBannerHost /><DialogHost /></>);

    fireEvent.click(await screen.findByRole("button", { name: "Restart and install" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "ADE will quit and reopen automatically to install v1.2.35.",
    });
    expect(dialog.textContent).toContain("Open ADE Code terminals and running agent sessions");
    expect(window.ade.updateGetInstallImpact).toHaveBeenCalledTimes(1);
    expect(mock.updateQuitAndInstall).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => {
      expect(mock.updateQuitAndInstall).toHaveBeenCalledTimes(1);
    });
    expect(mock.capture).toHaveBeenCalledWith(expect.objectContaining({
      event: "ade_update_prompted",
      properties: expect.objectContaining({ user_action: "accepted", to_version: "1.2.35" }),
    }));
    expect(screen.getByRole("button", { name: "Restarting…" })).toBeTruthy();
  });

  it("shows the parked retry copy", async () => {
    installAdeMock(
      snapshot({
        status: "ready",
        version: "1.2.35",
        parked: { reason: "handoff_failed", at: 5 },
      }),
    );
    render(<><AutoUpdateBanner /><AppBannerHost /></>);
    expect(await screen.findByText(/ADE update didn't finish — Restart to retry/)).toBeTruthy();
  });

  it("dismisses until the state changes", async () => {
    const mock = installAdeMock(snapshot({
      status: "ready",
      version: "1.2.35",
      parked: { reason: "handoff_failed", at: 5 },
    }));
    render(<><AutoUpdateBanner /><AppBannerHost /></>);

    await screen.findByText(/ADE update didn't finish/);
    fireEvent.click(screen.getByTitle("Dismiss until the next update"));
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
    // The card plays a short exit animation, so assert on the toast store:
    // cancelling takes the countdown out at once, and a tick must not put it back.
    const countdownShown = () => getToasts().some((toast) => /ADE will update/.test(toast.title));
    expect(countdownShown()).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(countdownShown()).toBe(false);

    mock.emit(snapshot({ status: "ready", version: "1.2.35" }));
    resolveCancel(true);
  });
});

describe("AutoUpdateBanner update transaction notice", () => {
  afterEach(() => {
    cleanup();
    resetAppBannersForTests();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "ade");
  });

  it("renders the failed step's plain line with a Repair affordance", async () => {
    const restartBackgroundService = vi.fn(async () => {});
    installAdeMock(snapshot({
      updateTransaction: {
        ok: false,
        version: "1.2.35",
        steps: [
          { id: "swap", status: "ok", detail: "Running 1.2.35." },
          { id: "service", status: "ok", detail: "" },
          { id: "restart", status: "failed", detail: "endpoint never rebound" },
          { id: "health", status: "skipped", detail: "Skipped after an earlier step failed." },
        ],
        failureMessage:
          "Updated the app, but the background service didn't restart — click Repair.",
      },
    }));
    (window as unknown as { ade: Record<string, unknown> }).ade.app = { restartBackgroundService };

    render(<><AutoUpdateBanner /><AppBannerHost /></>);

    await screen.findByText(
      "Updated the app, but the background service didn't restart — click Repair.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Repair" }));
    await waitFor(() => expect(restartBackgroundService).toHaveBeenCalledTimes(1));
  });

  it("stays quiet when the transaction succeeded", async () => {
    installAdeMock(snapshot({
      updateTransaction: {
        ok: true,
        version: "1.2.35",
        steps: [],
        failureMessage: null,
      },
    }));

    render(<><AutoUpdateBanner /><AppBannerHost /></>);

    await waitFor(() => {
      expect(screen.queryByText(/background service/)).toBeNull();
    });
  });
});
