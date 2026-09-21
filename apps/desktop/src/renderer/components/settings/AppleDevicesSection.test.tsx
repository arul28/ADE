/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useAppStore } from "../../state/appStore";
import { DEFAULT_APPLE_DEVICE_PREFERENCES } from "../../../shared/appleDeviceSettings";
import { AppleDevicesSection } from "./AppleDevicesSection";

describe("AppleDevicesSection", () => {
  afterEach(() => {
    cleanup();
    useAppStore.getState().setAppleDevicePreferences(DEFAULT_APPLE_DEVICE_PREFERENCES);
  });

  it("renders the Apple devices rows with contract defaults", () => {
    render(<AppleDevicesSection />);
    expect(screen.getByText("Apple devices")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Realistic body" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "Tap rings" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "Typed-text badges" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText("Remote viewer bitrate cap") as HTMLInputElement).value).toBe("2500");
    expect((screen.getByLabelText("Recordings storage warning") as HTMLInputElement).value).toBe("5");
  });

  it("writes toggles and number fields into the synced store", () => {
    render(<AppleDevicesSection />);
    fireEvent.click(screen.getByRole("switch", { name: "Realistic body" }));
    fireEvent.change(screen.getByLabelText("Remote viewer bitrate cap"), { target: { value: "1000" } });
    expect(useAppStore.getState().appleDevice.realisticBody).toBe(false);
    expect(useAppStore.getState().appleDevice.remoteBitrateKbpsCap).toBe(1000);
  });
});
