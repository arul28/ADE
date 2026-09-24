/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NavigateFunction } from "react-router-dom";
import type { PrEventPayload } from "../../../../shared/types";

import { ToastStack } from "./ToastStack";
import { dismissToast, getToasts, showToast } from "./toastStore";
import {
  PR_TOAST_DURATION_MS,
  buildAutoLinkedPrToast,
  buildPrNotificationToast,
} from "./usePrEventToasts";
import { STALE_CLI_TOAST_ID, buildStaleCliToast } from "./useStaleCliToast";

type PrNotification = Extract<PrEventPayload, { type: "pr-notification" }>;
type PrAutoLinked = Extract<PrEventPayload, { type: "pr-auto-linked" }>;

function notification(patch: Partial<PrNotification> = {}): PrNotification {
  return {
    type: "pr-notification",
    kind: "checks_failing",
    laneId: "lane-1",
    prId: "pr-1",
    prNumber: 42,
    title: "Checks failing",
    prTitle: "Speed up the build",
    message: "2 checks failed.",
    repoOwner: "acme",
    repoName: "app",
    headBranch: "feature",
    baseBranch: "main",
    timestamp: "2026-09-23T00:00:00.000Z",
    ...patch,
  } as PrNotification;
}

function autoLinked(patch: Partial<PrAutoLinked> = {}): PrAutoLinked {
  return {
    type: "pr-auto-linked",
    timestamp: "2026-09-23T00:00:00.000Z",
    prId: "pr-9",
    laneId: "lane-1",
    laneName: "Lane One",
    prNumber: 9,
    prTitle: "Add the thing",
    repoOwner: "acme",
    repoName: "app",
    headBranch: "feature",
    githubUrl: "https://github.com/acme/app/pull/9",
    ...patch,
  };
}

const openInGitHub = vi.fn();
const deletePr = vi.fn();

beforeEach(() => {
  (window as unknown as { ade: unknown }).ade = { prs: { openInGitHub, delete: deletePr } };
});

afterEach(() => {
  cleanup();
  for (const toast of getToasts()) dismissToast(toast.id);
  openInGitHub.mockReset();
  deletePr.mockReset();
  vi.restoreAllMocks();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("PR notification toast", () => {
  it("maps the event onto the shared card: tone, badge, number, chips, 18s", () => {
    const toast = buildPrNotificationToast(
      notification(),
      { id: "lane-1", name: "Lane One", color: "var(--color-accent)" },
      vi.fn() as unknown as NavigateFunction,
    );
    expect(toast.tone).toBe("error");
    expect(toast.badge).toBe("Checks failing");
    expect(toast.eyebrow).toBe("#42");
    expect(toast.title).toBe("Speed up the build");
    expect(toast.message).toBe("2 checks failed.");
    expect(toast.chips?.map((chip) => chip.label)).toEqual(["Lane One", "feature -> main", "acme/app"]);
    expect(toast.chips?.[0]?.color).toBe("var(--color-accent)");
    expect(toast.actions?.map((action) => action.label)).toEqual(["Open in ADE", "Open on GitHub"]);
    expect(toast.durationMs).toBe(PR_TOAST_DURATION_MS);
    // The same PR + kind refreshes one card instead of stacking a twin.
    expect(buildPrNotificationToast(notification(), null, vi.fn() as unknown as NavigateFunction).id).toBe(toast.id);
  });

  it("Open in ADE navigates to the PR's checks and closes; Open on GitHub closes only on success", async () => {
    const navigateMock = vi.fn();
    const navigate = navigateMock as unknown as NavigateFunction;
    render(<ToastStack />);
    act(() => {
      showToast(buildPrNotificationToast(notification(), null, navigate));
    });

    let rejectOpen: (error: Error) => void = () => {};
    const failedOpen = new Promise<never>((_resolve, reject) => {
      rejectOpen = reject;
    });
    openInGitHub.mockReturnValueOnce(failedOpen);
    fireEvent.click(screen.getByRole("button", { name: "Open on GitHub" }));
    await waitFor(() => expect(openInGitHub).toHaveBeenCalledWith("pr-1"));
    await act(async () => {
      rejectOpen(new Error("offline"));
      await expect(failedOpen).rejects.toThrow("offline");
    });
    expect(getToasts()).toHaveLength(1);

    openInGitHub.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Open on GitHub" }));
    await waitFor(() => expect(getToasts()).toHaveLength(0));

    act(() => {
      showToast(buildPrNotificationToast(notification(), null, navigate));
    });
    fireEvent.click(screen.getByRole("button", { name: "Open in ADE" }));
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(String(navigateMock.mock.calls[0]?.[0])).toMatch(/^\/prs\?/);
    expect(getToasts()).toHaveLength(0);
  });
});

describe("auto-linked PR toast", () => {
  it("undo shows a spinner, then an error and Retry undo on failure, then closes on success", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<ToastStack />);
    act(() => {
      showToast(buildAutoLinkedPrToast(autoLinked(), null));
    });
    expect(screen.getByText("Auto-linked PR #9")).toBeTruthy();
    expect(screen.getByText("Lane One")).toBeTruthy();

    let reject: (error: Error) => void = () => {};
    deletePr.mockReturnValueOnce(new Promise((_resolve, rej) => { reject = rej; }));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(deletePr).toHaveBeenCalledWith({ prId: "pr-9", closeOnGitHub: false, archiveLane: false });
    expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      reject(new Error("nope"));
    });
    expect(screen.getByText("Couldn't undo the link. Try again.")).toBeTruthy();
    expect(getToasts()).toHaveLength(1);

    deletePr.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Retry undo" }));
    await waitFor(() => expect(getToasts()).toHaveLength(0));
  });
});

describe("idle CLI sessions toast", () => {
  it("is sticky, snoozes through ×, and folds lanes past four into +N more", () => {
    const onDismiss = vi.fn();
    const onView = vi.fn();
    const lanes = ["a", "b", "c", "d", "e", "f"].map((id, index) => ({
      laneId: id,
      laneName: `Lane ${id}`,
      count: index === 0 ? 3 : 1,
      color: null,
    }));
    const toast = buildStaleCliToast({ count: 8, ageHours: 26, lanes, onViewProcesses: onView, onDismiss });
    expect(toast.id).toBe(STALE_CLI_TOAST_ID);
    expect(toast.durationMs).toBe(0);
    expect(toast.chips?.map((chip) => chip.label)).toEqual(["Lane a ×3", "Lane b", "Lane c", "Lane d", "+2 more"]);

    render(<ToastStack />);
    act(() => {
      showToast(toast);
    });
    expect(screen.getByText("Idle sessions")).toBeTruthy();
    expect(screen.getByText("8 CLI or shell sessions sitting idle")).toBeTruthy();
    expect(
      screen.getByText("No activity for about 26 hours. Close anything you're done with to free up memory."),
    ).toBeTruthy();
    const close = screen.getByTitle("Dismiss for an hour");
    fireEvent.click(close);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onView).not.toHaveBeenCalled();
  });
});
