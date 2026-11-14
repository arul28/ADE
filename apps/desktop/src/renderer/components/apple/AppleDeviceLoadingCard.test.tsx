/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppleDeviceLoadingCard } from "./AppleDeviceLoadingCard";

afterEach(cleanup);

describe("AppleDeviceLoadingCard", () => {

  it("advances to the second segment for the video step", () => {
    render(
      <AppleDeviceLoadingCard
        name="iPhone 17 Pro"
        runtime="iOS 26.2"
        family="iphone"
        stage="streaming"
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("Connecting video")).toBeTruthy();
    expect(screen.getByLabelText("Step 2 of 2: connect video")).toBeTruthy();
  });

  it("replaces the spinner and the bar with a sentence and one button on failure", () => {
    const onRetry = vi.fn();
    render(
      <AppleDeviceLoadingCard
        name="iPhone 17 Pro"
        runtime="iOS 26.2"
        family="iphone"
        stage="streaming"
        error={new Error("Device not booted: simctl said no")}
        onRetry={onRetry}
      />,
    );
    // The mapped sentence, never the wire text.
    expect(screen.getByText("The device is off.")).toBeTruthy();
    expect(screen.queryByText(/simctl said no/)).toBeNull();
    expect(screen.queryByLabelText(/Step \d of 2/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("names the model when the device was renamed", () => {
    render(
      <AppleDeviceLoadingCard
        name="ADE Repro"
        runtime="iOS 26.2"
        model="iPhone 17 Pro"
        family="iphone"
        stage="starting"
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("Booting ADE Repro…")).toBeTruthy();
    // A custom name hides the model, so the subtitle carries it.
    expect(screen.getByText("Installed simulator · iPhone 17 Pro · iOS 26.2")).toBeTruthy();
  });

  it("starts counting after 5s and explains a wait past 60s", () => {
    vi.useFakeTimers();
    try {
      render(
        <AppleDeviceLoadingCard
          name="ADE Repro"
          runtime="iOS 26.2"
          family="iphone"
          stage="starting"
          onRetry={vi.fn()}
        />,
      );
      // A short wait is not worth a stopwatch.
      expect(document.querySelector("[data-apple-loading-elapsed]")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(6_000);
      });
      expect(document.querySelector("[data-apple-loading-elapsed]")?.textContent).toBe("6s");
      expect(document.querySelector("[data-apple-loading-slow]")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(55_000);
      });
      expect(document.querySelector("[data-apple-loading-slow]")?.textContent)
        .toBe("Still booting — the first boot of a simulator can take a minute.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failure shows the device name plainly, with no stopwatch", () => {
    vi.useFakeTimers();
    try {
      render(
        <AppleDeviceLoadingCard
          name="ADE Repro"
          runtime="iOS 26.2"
          family="iphone"
          stage="starting"
          error="boom"
          onRetry={vi.fn()}
        />,
      );
      act(() => {
        vi.advanceTimersByTime(90_000);
      });
      expect(screen.getByText("ADE Repro")).toBeTruthy();
      expect(document.querySelector("[data-apple-loading-elapsed]")).toBeNull();
      expect(document.querySelector("[data-apple-loading-slow]")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays a status while it is working and becomes an alert when it fails", () => {
    const { rerender, container } = render(
      <AppleDeviceLoadingCard
        name="A"
        runtime={null}
        family="ipad"
        stage="starting"
        onRetry={vi.fn()}
      />,
    );
    expect(container.querySelector("[role='status']")).toBeTruthy();
    rerender(
      <AppleDeviceLoadingCard
        name="A"
        runtime={null}
        family="ipad"
        stage="starting"
        error="boom"
        onRetry={vi.fn()}
      />,
    );
    expect(container.querySelector("[role='alert']")).toBeTruthy();
  });
});
