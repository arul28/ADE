/* @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LocationSection } from "./LocationSection";
import { controlsIn, installAdeMock, makeActions, makeCtx, SETTINGS } from "../drawerTestHarness";

afterEach(cleanup);

describe("LocationSection", () => {
  it("renders the title, both mono inputs, Preset, Set and Clear", () => {
    installAdeMock();
    render(<LocationSection ctx={makeCtx()} />);
    expect(screen.getByRole("heading", { name: "Location" })).toBeTruthy();
    expect(screen.getByLabelText("Latitude").className).toContain("font-mono");
    expect(screen.getByLabelText("Longitude").className).toContain("font-mono");
    expect(screen.getByRole("button", { name: "Preset" }).textContent).toContain("Preset…");
    expect(screen.getByRole("button", { name: "Set" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear" })).toBeTruthy();
  });

  it("keeps Set disabled until both coordinates are in range", () => {
    installAdeMock();
    render(<LocationSection ctx={makeCtx()} />);
    const set = screen.getByRole("button", { name: "Set" }) as HTMLButtonElement;
    expect(set.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "91" } });
    fireEvent.change(screen.getByLabelText("Longitude"), { target: { value: "10" } });
    expect(set.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "51.5" } });
    expect(set.disabled).toBe(false);
  });

  it("sets and clears through act", async () => {
    const { iosSimulator } = installAdeMock();
    render(<LocationSection ctx={makeCtx()} />);
    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "51.5" } });
    fireEvent.change(screen.getByLabelText("Longitude"), { target: { value: "-0.12" } });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    await waitFor(() => expect(iosSimulator.setLocation).toHaveBeenCalledWith(
      { laneId: "lane-1", deviceUdid: "UDID-1", chatSessionId: null, latitude: 51.5, longitude: -0.12 },
      null,
    ));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(iosSimulator.clearLocation).toHaveBeenCalled());
    expect((screen.getByLabelText("Latitude") as HTMLInputElement).value).toBe("");
  });

  it("shows the device's last fix and disables everything while pending", () => {
    installAdeMock();
    const settings = { ...SETTINGS, location: { latitude: 37.7749, longitude: -122.4194 } };
    render(<LocationSection ctx={makeCtx({ actions: makeActions({ settings, disabled: true }) })} />);
    expect(screen.getByTestId("apple-drawer-location-current").textContent).toBe("37.775, -122.419");
    for (const control of controlsIn(screen.getByTestId("apple-drawer-location"))) {
      expect((control as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
