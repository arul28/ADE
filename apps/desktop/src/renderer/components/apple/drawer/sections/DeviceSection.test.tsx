/* @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  APPLE_DRAWER_TEXT_SIZES,
  APPLE_LOCATION_PRESETS,
  APPLE_STATUS_BAR_DEMO,
  DeviceSection,
} from "./DeviceSection";
import { SETTINGS, controlsIn, installAdeMock, makeActions, makeCtx } from "../drawerTestHarness";

afterEach(cleanup);

describe("DeviceSection", () => {
  it("holds everything §B1 puts in the Device group, and no heading of its own", () => {
    installAdeMock();
    const { container } = render(<DeviceSection ctx={makeCtx()} />);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByRole("group", { name: "Appearance" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Text size" })).toBeTruthy();
    for (const label of ["Reduce Motion", "Increase Contrast", "Reduce Transparency", "Show Borders", "VoiceOver"]) {
      expect(screen.getByRole("switch", { name: label })).toBeTruthy();
    }
    expect(screen.getByText("Location")).toBeTruthy();
    expect(screen.getByLabelText("Latitude")).toBeTruthy();
    expect(screen.getByText("Status bar")).toBeTruthy();
    expect(screen.getByRole("button", { name: "9:41" })).toBeTruthy();
    expect(container.textContent).toContain("Device's own");
  });

  it("writes the appearance the device does not already have, and never the one it does", async () => {
    const { iosSimulator } = installAdeMock();
    render(<DeviceSection ctx={makeCtx()} />);
    // The harness's device is light.
    expect(screen.getByRole("button", { name: "Light" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Light" }));
    expect(iosSimulator.setAppearance).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    await waitFor(() => expect(iosSimulator.setAppearance).toHaveBeenCalledWith(
      { laneId: "lane-1", deviceUdid: "UDID-1", chatSessionId: null, appearance: "dark" },
      null,
    ));
  });

  it("offers the four text sizes and writes the chosen one", async () => {
    const { iosSimulator } = installAdeMock();
    render(<DeviceSection ctx={makeCtx()} />);
    expect(APPLE_DRAWER_TEXT_SIZES.map((size) => size.value)).toEqual(["small", "medium", "large", "extra-large"]);
    expect(screen.getByRole("button", { name: "Text size" }).textContent).toContain("Default");
    // Radix opens its trigger on Enter; jsdom has no PointerEvent for a click.
    fireEvent.keyDown(screen.getByRole("button", { name: "Text size" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Large" }));
    await waitFor(() => expect(iosSimulator.setContentSize).toHaveBeenCalledWith(
      expect.objectContaining({ contentSize: "large" }),
      null,
    ));
  });

  it("writes an accessibility switch the device reported", async () => {
    const { iosSimulator } = installAdeMock();
    render(<DeviceSection ctx={makeCtx()} />);
    // Reported true by the harness, so the click turns it OFF.
    fireEvent.click(screen.getByRole("switch", { name: "Reduce Motion" }));
    await waitFor(() => expect(iosSimulator.setAccessibilityOption).toHaveBeenCalledWith(
      expect.objectContaining({ option: "reduce-motion", enabled: false }),
      null,
    ));
  });

  it("sets a location from the fields, from a preset, and clears it", async () => {
    const { iosSimulator } = installAdeMock();
    render(<DeviceSection ctx={makeCtx()} />);
    expect((screen.getByRole("button", { name: "Set" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "48.8" } });
    fireEvent.change(screen.getByLabelText("Longitude"), { target: { value: "2.35" } });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    await waitFor(() => expect(iosSimulator.setLocation).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 48.8, longitude: 2.35 }),
      null,
    ));

    fireEvent.keyDown(screen.getByRole("button", { name: "Preset" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Tokyo" }));
    const tokyo = APPLE_LOCATION_PRESETS.find((preset) => preset.label === "Tokyo")!;
    await waitFor(() => expect(iosSimulator.setLocation).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: tokyo.latitude, longitude: tokyo.longitude }),
      null,
    ));

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(iosSimulator.clearLocation).toHaveBeenCalled());
    expect((screen.getByLabelText("Latitude") as HTMLInputElement).value).toBe("");
  });

  it("refuses a location outside the world", () => {
    installAdeMock();
    render(<DeviceSection ctx={makeCtx()} />);
    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "120" } });
    fireEvent.change(screen.getByLabelText("Longitude"), { target: { value: "2" } });
    expect((screen.getByRole("button", { name: "Set" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("overrides the status bar with Apple's own screenshot values, and clears it only when it is overridden", async () => {
    const { iosSimulator } = installAdeMock();
    const view = render(<DeviceSection ctx={makeCtx()} />);
    // Nothing to clear while the device reports its own status bar.
    expect((screen.getByRole("button", { name: "Clear status bar" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "9:41" }));
    await waitFor(() => expect(iosSimulator.setStatusBar).toHaveBeenCalledWith(
      expect.objectContaining({ ...APPLE_STATUS_BAR_DEMO, laneId: "lane-1", deviceUdid: "UDID-1" }),
      null,
    ));
    view.unmount();

    render(<DeviceSection ctx={makeCtx({ actions: makeActions({ settings: { ...SETTINGS, statusBarOverridden: true } }) })} />);
    expect(screen.getByText("Overridden")).toBeTruthy();
    const clear = screen.getByRole("button", { name: "Clear status bar" }) as HTMLButtonElement;
    expect(clear.disabled).toBe(false);
    fireEvent.click(clear);
    await waitFor(() => expect(iosSimulator.clearStatusBar).toHaveBeenCalledWith(
      { laneId: "lane-1", deviceUdid: "UDID-1", chatSessionId: null },
      null,
    ));
  });

  it("disables every control while an action is pending, and hides none of them", () => {
    installAdeMock();
    const { container } = render(<DeviceSection ctx={makeCtx({ actions: makeActions({ disabled: true, pending: true }) })} />);
    const controls = controlsIn(container);
    expect(controls.length).toBeGreaterThan(10);
    for (const control of controls) expect((control as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables Appearance outright on a device that does not support it", () => {
    installAdeMock();
    render(<DeviceSection ctx={makeCtx({ actions: makeActions({ settings: { ...SETTINGS, appearance: "unsupported" } }) })} />);
    expect((screen.getByRole("button", { name: "Dark" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Light" }).getAttribute("aria-pressed")).toBe("false");
  });
});
