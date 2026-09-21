/* @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SimulatorSection } from "./SimulatorSection";
import { installAdeMock, makeActions, makeCtx, SETTINGS } from "../drawerTestHarness";

afterEach(cleanup);

const SWITCHES = ["Reduce Motion", "Increase Contrast", "Reduce Transparency", "Show Borders", "VoiceOver"];

describe("SimulatorSection", () => {
  it("renders the title, Appearance, Text size and the five switches in order", () => {
    installAdeMock();
    render(<SimulatorSection ctx={makeCtx()} />);
    expect(screen.getByRole("heading", { name: "Simulator" })).toBeTruthy();
    expect(screen.getByText("Appearance")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Light" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dark" })).toBeTruthy();
    expect(screen.getByText("Text size")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Text size" }).textContent).toContain("Default");
    const switches = screen.getAllByRole("switch").map((element) => element.getAttribute("aria-label"));
    expect(switches).toEqual(SWITCHES);
  });

  it("shows only device-confirmed values and disables unreported switches without hiding them", () => {
    installAdeMock();
    render(<SimulatorSection ctx={makeCtx()} />);
    expect(screen.getByRole("button", { name: "Light" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Dark" }).getAttribute("aria-pressed")).toBe("false");
    const reduceMotion = screen.getByRole("switch", { name: "Reduce Motion" }) as HTMLButtonElement;
    expect(reduceMotion.getAttribute("aria-checked")).toBe("true");
    expect(reduceMotion.disabled).toBe(false);
    // `voice-over` is null in the fixture and Show Borders has no simctl option: present, off, inert.
    for (const label of ["VoiceOver", "Show Borders"]) {
      const control = screen.getByRole("switch", { name: label }) as HTMLButtonElement;
      expect(control.disabled).toBe(true);
      expect(control.getAttribute("aria-checked")).toBe("false");
    }
  });

  it("disables everything with no settings snapshot", () => {
    installAdeMock();
    render(<SimulatorSection ctx={makeCtx({ actions: makeActions({ settings: null, disabled: true }) })} />);
    for (const control of screen.getAllByRole("switch")) expect((control as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Dark" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Text size" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Text size" }).textContent).toContain("Unknown");
  });

  it("writes appearance and accessibility through act, and ignores a re-click of the current value", async () => {
    const { iosSimulator } = installAdeMock();
    const ctx = makeCtx();
    render(<SimulatorSection ctx={ctx} />);
    fireEvent.click(screen.getByRole("button", { name: "Light" }));
    expect(ctx.actions.act).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    await waitFor(() => expect(iosSimulator.setAppearance).toHaveBeenCalledWith(
      { laneId: "lane-1", deviceUdid: "UDID-1", chatSessionId: null, appearance: "dark" },
      null,
    ));
    fireEvent.click(screen.getByRole("switch", { name: "Reduce Motion" }));
    await waitFor(() => expect(iosSimulator.setAccessibilityOption).toHaveBeenCalledWith(
      expect.objectContaining({ option: "reduce-motion", enabled: false }),
      null,
    ));
  });

  it("names an unknown content size on the trigger rather than pretending", () => {
    installAdeMock();
    const settings = { ...SETTINGS, contentSize: "accessibility-large" as const };
    render(<SimulatorSection ctx={makeCtx({ actions: makeActions({ settings }) })} />);
    expect(screen.getByRole("button", { name: "Text size" }).textContent).toContain("accessibility-large");
  });
});
