/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppleDeviceLoadingCard } from "./AppleDeviceLoadingCard";

afterEach(cleanup);

describe("AppleDeviceLoadingCard", () => {
  it("names the device, the runtime and the step, in §3.2's words", () => {
    render(
      <AppleDeviceLoadingCard
        name="iPhone 17 Pro"
        runtime="iOS 26.2"
        family="iphone"
        stage="starting"
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("iPhone 17 Pro")).toBeTruthy();
    expect(screen.getByText("iOS 26.2")).toBeTruthy();
    expect(screen.getByText("Starting device…")).toBeTruthy();
    expect(screen.getByLabelText("Step 1 of 2: start device")).toBeTruthy();
  });

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
    expect(screen.getByText("Connecting video…")).toBeTruthy();
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
