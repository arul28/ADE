/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IosSimulatorDeviceSettings } from "../../../shared/types/iosSimulator";
import { AppleDeviceRail } from "./AppleDeviceRail";
import type { AppleDeviceControls } from "./useAppleDeviceControls";
import { expectNoHorizontalOverflow } from "./testLayout";

afterEach(cleanup);

function settings(overrides: Partial<IosSimulatorDeviceSettings> = {}): IosSimulatorDeviceSettings {
  return {
    deviceUdid: "udid",
    appearance: "light",
    contentSize: "medium",
    accessibility: {
      "increase-contrast": false,
      "reduce-motion": false,
      "reduce-transparency": false,
      "button-shapes": false,
      "bold-text": false,
      "invert-colors": false,
      grayscale: false,
      "voice-over": false,
    },
    location: null,
    statusBarOverridden: false,
    readAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function controls(overrides: Partial<AppleDeviceControls> = {}): AppleDeviceControls {
  return {
    settings: settings(),
    pending: false,
    error: null,
    clearError: vi.fn(),
    act: vi.fn(async () => {}),
    disabled: false,
    ...overrides,
  };
}

function renderRail(overrides: Partial<React.ComponentProps<typeof AppleDeviceRail>> = {}) {
  const props: React.ComponentProps<typeof AppleDeviceRail> = {
    containerWidth: 900,
    deviceName: "iPhone 17 Pro",
    deviceRuntime: "iOS 26.2",
    controls: controls(),
    inputConnected: true,
    mode: "flat",
    canUse3d: true,
    threeDisabledReason: null,
    toolsOpen: false,
    recording: false,
    screenshotPending: false,
    onHome: vi.fn(),
    onRotate: vi.fn(),
    onScreenshot: vi.fn(),
    onToggleTools: vi.fn(),
    onMode: vi.fn(),
    onResetView: vi.fn(),
    onToggleRecording: vi.fn(),
    onFloat: vi.fn(),
    onSwitchDevice: vi.fn(),
    onPowerOff: vi.fn(),
    ...overrides,
  };
  const view = render(<AppleDeviceRail {...props} />);
  return { ...props, ...view };
}

const railButtons = () =>
  within(screen.getByRole("complementary", { name: "Device controls" })).getAllByRole("button");

describe("AppleDeviceRail", () => {
  it("names every control — §12.5: no icon without a name", () => {
    renderRail();
    for (const button of railButtons()) {
      const label = button.getAttribute("aria-label");
      expect(label, button.outerHTML).toBeTruthy();
      expect(label?.trim().length).toBeGreaterThan(0);
    }
  });

  it("carries §5's groups in order, and no Shake anywhere", () => {
    renderRail();
    const labels = railButtons().map((button) => button.getAttribute("aria-label"));
    expect(labels).toEqual([
      "Home",
      "Rotate device",
      "Switch device to dark mode",
      "Device text size",
      "Device tools",
      "Save screenshot",
      "More device actions",
      "3D view",
      "Flat view",
    ]);
    // `pressButton({name:"shake"})` is refused with APPLE_BUTTON_UNSUPPORTED,
    // so the control does not exist (§6).
    expect(screen.queryByRole("button", { name: /shake/i })).toBeNull();
  });

  it("offers Reset view only in 3D", () => {
    renderRail({ mode: "3d" });
    expect(screen.getByRole("button", { name: "Reset view" })).toBeTruthy();
    cleanup();
    renderRail({ mode: "flat" });
    expect(screen.queryByRole("button", { name: "Reset view" })).toBeNull();
  });

  it("collapses to Home, Tools and More below 360px", () => {
    renderRail({ containerWidth: 320 });
    expect(railButtons().map((button) => button.getAttribute("aria-label"))).toEqual([
      "Home",
      "Device tools",
      "More device actions",
    ]);
  });

  it("names the appearance button for the mode it switches TO", () => {
    const props = renderRail({ controls: controls({ settings: settings({ appearance: "dark" }) }) });
    const button = screen.getByRole("button", { name: "Switch device to light mode" });
    fireEvent.click(button);
    expect(props.controls.act).toHaveBeenCalledWith({ type: "setAppearance", value: "light" });
  });

  it("refuses hardware buttons while the input socket is down", () => {
    renderRail({ inputConnected: false });
    expect(screen.getByRole("button", { name: "Home" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Rotate device" }).hasAttribute("disabled")).toBe(true);
    // The view toggles are the renderer's own and stay usable.
    expect(screen.getByRole("button", { name: "Flat view" }).hasAttribute("disabled")).toBe(false);
  });

  it("disables the settings controls while one write is in flight", () => {
    renderRail({ controls: controls({ pending: true, disabled: true }) });
    expect(screen.getByRole("button", { name: "Switch device to dark mode" })
      .hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Device text size" })
      .hasAttribute("disabled")).toBe(true);
  });

  it("marks the pressed state of Tools and the view pair", () => {
    renderRail({ toolsOpen: true, mode: "3d" });
    expect(screen.getByRole("button", { name: "Device tools" }).getAttribute("aria-pressed"))
      .toBe("true");
    expect(screen.getByRole("button", { name: "3D view" }).getAttribute("aria-pressed"))
      .toBe("true");
    expect(screen.getByRole("button", { name: "Flat view" }).getAttribute("aria-pressed"))
      .toBe("false");
  });

  it("puts the device in the More menu's header and Power off last", () => {
    renderRail();
    // Keyboard rather than pointer: jsdom has no PointerEvent, so Radix's
    // pointerdown path never fires here. Enter is the same open.
    fireEvent.keyDown(screen.getByRole("button", { name: "More device actions" }), { key: "Enter" });
    const items = screen.getAllByRole("menuitem").map((node) => node.textContent);
    expect(screen.getByText("iPhone 17 Pro · iOS 26.2")).toBeTruthy();
    expect(items).toEqual(["Record", "Float over chat", "Switch device…", "Power off"]);
  });

  it("swaps Record for Stop recording while a recording runs", () => {
    renderRail({ recording: true });
    // Keyboard rather than pointer: jsdom has no PointerEvent, so Radix's
    // pointerdown path never fires here. Enter is the same open.
    fireEvent.keyDown(screen.getByRole("button", { name: "More device actions" }), { key: "Enter" });
    expect(screen.getByRole("menuitem", { name: "Stop recording" })).toBeTruthy();
  });

  it("is an opaque pill, never a blur over the picture (rule zero / §B3)", () => {
    const { container } = renderRail();
    const pill = container.querySelector("[data-apple-rail] > div") as HTMLElement;
    expect(pill.className).toContain("bg-surface");
    expect(pill.className).not.toContain("backdrop-blur");
    expect(container.querySelector("[class*='backdrop-blur']")).toBeNull();
  });

  it("wraps every icon in its own tooltip (§B6)", () => {
    const { container } = renderRail();
    for (const button of container.querySelectorAll("button")) {
      // PaneTooltip wraps each control in its own positioned span.
      expect(button.parentElement?.getAttribute("style") ?? "").toContain("inline-flex");
    }
  });

  it.each([360, 900])("fits its container at %ipx", (width) => {
    const { container } = renderRail({ containerWidth: width });
    expectNoHorizontalOverflow(container, width);
  });
});
