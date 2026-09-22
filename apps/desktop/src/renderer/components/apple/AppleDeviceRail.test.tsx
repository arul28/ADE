/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppleDeviceRail } from "./AppleDeviceRail";
import { expectNoHorizontalOverflow } from "./testLayout";

afterEach(cleanup);

function renderRail(overrides: Partial<React.ComponentProps<typeof AppleDeviceRail>> = {}) {
  const props: React.ComponentProps<typeof AppleDeviceRail> = {
    containerWidth: 900,
    deviceName: "iPhone 17 Pro",
    deviceRuntime: "iOS 26.2",
    inputConnected: true,
    mode: "3d",
    canUse3d: true,
    threeDisabledReason: null,
    toolsOpen: false,
    inspecting: false,
    recording: false,
    screenshotPending: false,
    orientation: "portrait",
    onHome: vi.fn(),
    onOrientation: vi.fn(),
    onScreenshot: vi.fn(),
    onToggleTools: vi.fn(),
    onToggleInspect: vi.fn(),
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

const openMenu = (name: string) =>
  fireEvent.keyDown(screen.getByRole("button", { name }), { key: "Enter" });

const openMore = () =>
  // Keyboard rather than pointer: jsdom has no PointerEvent, so Radix's
  // pointerdown path never fires here. Enter is the same open.
  fireEvent.keyDown(screen.getByRole("button", { name: "More device actions" }), { key: "Enter" });

describe("AppleDeviceRail", () => {
  it("names every control — §12.5: no icon without a name", () => {
    renderRail();
    for (const button of railButtons()) {
      const label = button.getAttribute("aria-label");
      expect(label, button.outerHTML).toBeTruthy();
      expect(label?.trim().length).toBeGreaterThan(0);
    }
  });

  it("carries §A5's order, with no Appearance, Text size or Shake", () => {
    renderRail();
    const labels = railButtons().map((button) => button.getAttribute("aria-label"));
    expect(labels).toEqual([
      "Home",
      "Orientation: Portrait",
      "Inspect elements",
      "Save screenshot",
      "Record",
      "View: 3D",
      "Device tools",
      "More device actions",
    ]);
    // §A5: device settings live in the drawer, and only there.
    expect(screen.queryByRole("button", { name: /mode$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /text size/i })).toBeNull();
    // `pressButton({name:"shake"})` is refused with APPLE_BUTTON_UNSUPPORTED,
    // so the control does not exist (§6).
    expect(screen.queryByRole("button", { name: /shake/i })).toBeNull();
  });

  it("§A2: ONE view button, which switches and shows which view is on", () => {
    const props = renderRail({ mode: "3d" });
    const toggle = screen.getByRole("button", { name: "View: 3D" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(props.onMode).toHaveBeenCalledWith("flat");
    cleanup();

    const flat = renderRail({ mode: "flat" });
    const flatToggle = screen.getByRole("button", { name: "View: Flat" });
    expect(flatToggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(flatToggle);
    expect(flat.onMode).toHaveBeenCalledWith("3d");
    // The round-3 pair is gone.
    expect(screen.queryByRole("button", { name: "3D view" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Flat view" })).toBeNull();
  });

  it("refuses the 3D half of the toggle when 3D is impossible", () => {
    const props = renderRail({
      mode: "flat",
      canUse3d: false,
      threeDisabledReason: "3D view needs WebCodecs.",
    });
    const toggle = screen.getByRole("button", { name: "View: Flat" });
    expect(toggle.hasAttribute("disabled")).toBe(true);
    fireEvent.click(toggle);
    expect(props.onMode).not.toHaveBeenCalled();
    // The REASON is said in the pane's status strip, which is the only place
    // a disabled control can be read from (a disabled button takes no focus,
    // so its tooltip never opens).
  });

  it("§A4: Inspect is a rail toggle that reports its pressed state", () => {
    const props = renderRail({ inspecting: true });
    const inspect = screen.getByRole("button", { name: "Inspect elements" });
    expect(inspect.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(inspect);
    expect(props.onToggleInspect).toHaveBeenCalled();
  });

  it("§A5: Record is a rail toggle with a red active state, not a menu item", () => {
    const props = renderRail();
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(props.onToggleRecording).toHaveBeenCalled();
    openMore();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent))
      .not.toContain("Record");
    cleanup();

    renderRail({ recording: true });
    const stop = screen.getByRole("button", { name: "Stop recording" });
    expect(stop.getAttribute("aria-pressed")).toBe("true");
    expect(stop.className).toContain("var(--color-error)");
  });

  it("keeps Reset view, in the More menu, and only in 3D", () => {
    const props = renderRail({ mode: "3d" });
    openMore();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset view" }));
    expect(props.onResetView).toHaveBeenCalled();
    cleanup();
    renderRail({ mode: "flat" });
    openMore();
    expect(screen.queryByRole("menuitem", { name: "Reset view" })).toBeNull();
  });

  it("collapses to Home, Orientation, Tools and More below 360px", () => {
    // §V2: Orientation survives the collapse. The owner could not find the
    // control it replaces, and a control that vanishes in a narrow pane is one
    // more way not to find it.
    renderRail({ containerWidth: 320 });
    expect(railButtons().map((button) => button.getAttribute("aria-label"))).toEqual([
      "Home",
      "Orientation: Portrait",
      "Device tools",
      "More device actions",
    ]);
  });

  it("§V2: the orientation control NAMES the current orientation", () => {
    renderRail({ orientation: "landscape-left" });
    const control = screen.getByRole("button", { name: "Orientation: Landscape left" });
    // The glyph turns with the device, so the pill reads as the pose even
    // before the name is read out.
    expect(control.querySelector("svg")?.getAttribute("style") ?? "").toContain("rotate(90deg)");
    expect(screen.queryByRole("button", { name: "Rotate device" })).toBeNull();
  });

  it("§V2: offers all four orientations and checks the current one", () => {
    const props = renderRail({ orientation: "landscape-left" });
    openMenu("Orientation: Landscape left");
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(items).toEqual([
      "Portrait",
      "Portrait upside down",
      "Landscape left",
      "Landscape right",
    ]);
    expect(
      screen.getByRole("menuitem", { name: "Landscape left" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByRole("menuitem", { name: "Portrait" }).getAttribute("aria-checked"),
    ).toBe("false");
    fireEvent.click(screen.getByRole("menuitem", { name: "Landscape right" }));
    expect(props.onOrientation).toHaveBeenCalledWith("landscape-right");
  });

  it("refuses hardware buttons while the input socket is down", () => {
    renderRail({ inputConnected: false });
    expect(screen.getByRole("button", { name: "Home" }).hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByRole("button", { name: "Orientation: Portrait" }).hasAttribute("disabled"),
    ).toBe(true);
    // The view toggle is the renderer's own and stays usable.
    expect(screen.getByRole("button", { name: "View: 3D" }).hasAttribute("disabled")).toBe(false);
  });

  it("marks the pressed state of Tools", () => {
    renderRail({ toolsOpen: true });
    expect(screen.getByRole("button", { name: "Device tools" }).getAttribute("aria-pressed"))
      .toBe("true");
  });

  it("puts the device in the More menu's header and Power off last", () => {
    renderRail({ mode: "flat" });
    openMore();
    const items = screen.getAllByRole("menuitem").map((node) => node.textContent);
    expect(screen.getByText("iPhone 17 Pro · iOS 26.2")).toBeTruthy();
    expect(items).toEqual(["Float over chat", "Switch device…", "Power off"]);
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
