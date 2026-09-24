/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToastStack } from "./ToastStack";
import { dismissToast, getToasts, showToast } from "./toastStore";
import { STALE_CLI_TOAST_ID, buildStaleCliToast } from "./useStaleCliToast";

afterEach(() => {
  cleanup();
  for (const toast of getToasts()) dismissToast(toast.id);
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
