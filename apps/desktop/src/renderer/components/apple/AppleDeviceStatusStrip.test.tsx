/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppleDeviceNoticeStrip,
  AppleDeviceStatusStrip,
  describeAppleError,
} from "./AppleDeviceStatusStrip";
import { expectNoHorizontalOverflow } from "./testLayout";

afterEach(cleanup);

describe("describeAppleError", () => {
  it("keeps every sentence to twelve words or fewer", () => {
    for (const error of [
      new Error("APPLE_HELPER_UNAVAILABLE: no helper"),
      new Error("cannot start the ADE brain directly"),
      new Error("APPLE_STREAM_NOT_RUNNING"),
      new Error("Device not booted"),
      new Error("EPIPE reading from the helper socket at 127.0.0.1:51231"),
      { code: "APPLE_NO_INSTALLED_SIMULATORS", message: "none" },
    ]) {
      const { sentence } = describeAppleError(error);
      expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(12);
    }
  });

  it("maps §6's table, and everything else to one honest fallback", () => {
    expect(describeAppleError(new Error("Device not booted")).sentence).toBe("The device is off.");
    expect(describeAppleError(new Error("APPLE_STREAM_NOT_RUNNING")).sentence)
      .toBe("Video stopped.");
    expect(describeAppleError(new Error("APPLE_HELPER_UNAVAILABLE")).sentence)
      .toBe("ADE's simulator helper is missing from this install.");
    expect(describeAppleError(new Error("you cannot start the ADE brain directly")).sentence)
      .toBe("Install ADE into Applications, then relaunch.");
    expect(describeAppleError(new Error("Error invoking remote method 'x': TypeError")).sentence)
      .toBe("Something went wrong with the simulator.");
  });
});

describe("AppleDeviceStatusStrip", () => {
  it("shows the sentence and hides the wire text behind Details", () => {
    render(
      <AppleDeviceStatusStrip
        error={new Error("Error invoking remote method 'apple.start': TypeError")}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Something went wrong with the simulator.")).toBeTruthy();
    // §12.8: no string starting with "Error invoking remote method" is
    // reachable without asking for it.
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull();
    const details = screen.getByRole("button", { name: "Details" });
    expect(details.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(details);
    expect(details.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/Error invoking remote method/)).toBeTruthy();
  });

  it("offers the action the mapping asked for, and dismisses", () => {
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    render(
      <AppleDeviceStatusStrip
        error={new Error("Device not booted")}
        onAction={onAction}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(onAction).toHaveBeenCalledWith("start");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss this message" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("has no Details button when the failure carried no text", () => {
    render(<AppleDeviceStatusStrip error={null} onDismiss={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
  });
});

describe("AppleDeviceNoticeStrip", () => {
  it("is §3's two state lines, with one button and no red", () => {
    const onAction = vi.fn();
    const { rerender } = render(
      <AppleDeviceNoticeStrip
        sentence="iPhone 17 Pro is off."
        actionLabel="Start"
        onAction={onAction}
      />,
    );
    expect(screen.getByText("iPhone 17 Pro is off.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(onAction).toHaveBeenCalledOnce();
    rerender(
      <AppleDeviceNoticeStrip
        sentence="Video stopped."
        actionLabel="Reconnect"
        onAction={onAction}
      />,
    );
    expect(screen.getByText("Video stopped.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
  });

  it("offers a second, separate choice only when one is given", () => {
    const onAction = vi.fn();
    const onSecondaryAction = vi.fn();
    render(
      <AppleDeviceNoticeStrip
        sentence="iPhone 17 Pro is off."
        actionLabel="Start"
        onAction={onAction}
        secondaryActionLabel="Choose another device"
        onSecondaryAction={onSecondaryAction}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose another device" }));
    expect(onSecondaryAction).toHaveBeenCalledOnce();
    expect(onAction).not.toHaveBeenCalled();
    cleanup();
    render(<AppleDeviceNoticeStrip sentence="Video stopped." actionLabel="Reconnect" onAction={vi.fn()} />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("has no dismiss X when the state cannot be dismissed", () => {
    render(
      <AppleDeviceNoticeStrip sentence="Video stopped." actionLabel="Reconnect" onAction={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: "Dismiss this message" })).toBeNull();
  });

  it("is an opaque bar, never a tint over the device (rule zero / §B3)", () => {
    const { container } = render(
      <AppleDeviceStatusStrip error={new Error("APPLE_HELPER_UNAVAILABLE")} onDismiss={vi.fn()} />,
    );
    const strip = container.querySelector("[data-apple-status-strip='error'] [role='alert']") as HTMLElement;
    // The shared inline banner: red lives in the icon tile and border, never a
    // flooded fill over the device.
    expect(strip.getAttribute("data-notice-tone")).toBe("error");
    expect(strip.style.background).not.toContain("var(--color-error)");
    expect(container.querySelector("[class*='backdrop-blur']")).toBeNull();
  });

  it.each([360, 900])("fits its container at %ipx", (width) => {
    const { container } = render(
      <AppleDeviceStatusStrip
        error={new Error("Error invoking remote method 'apple.start': TypeError")}
        onAction={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expectNoHorizontalOverflow(container, width);
  });
});
