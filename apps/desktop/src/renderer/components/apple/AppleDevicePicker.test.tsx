/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppleInstalledSimulator } from "../../../shared/types/iosSimulator";
import { AppleDevicePicker } from "./AppleDevicePicker";
import { expectNoHorizontalOverflow } from "./testLayout";

afterEach(cleanup);

// jsdom has no canvas: the backdrop's own `onRefused` path is what the picker
// renders under test, which is also what a machine without WebGL shows.
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

const T = "com.apple.CoreSimulator.SimDeviceType.";

function simulator(overrides: Partial<AppleInstalledSimulator>): AppleInstalledSimulator {
  return {
    udid: "udid",
    name: "iPhone 17 Pro",
    runtime: "iOS 26.2",
    state: "Shutdown",
    isAvailable: true,
    family: "iphone",
    deviceTypeIdentifier: `${T}iPhone-17-Pro`,
    ...overrides,
  };
}

const INSTALLED = [
  simulator({ udid: "pro", name: "iPhone 17 Pro", state: "Booted" }),
  simulator({ udid: "max", name: "iPhone 17 Pro Max", deviceTypeIdentifier: `${T}iPhone-17-Pro-Max` }),
  simulator({ udid: "repro", name: "ADE Repro" }),
  simulator({
    udid: "pad",
    name: "iPad Pro 13-inch M4",
    runtime: "iPadOS 26.2",
    family: "ipad",
    deviceTypeIdentifier: `${T}iPad-Pro-13-inch-M4-8GB`,
  }),
  simulator({
    udid: "watch",
    name: "Series 10",
    runtime: "watchOS 26.2",
    family: "watch",
    deviceTypeIdentifier: `${T}Apple-Watch-Series-10-46mm`,
  }),
  simulator({
    udid: "tv",
    name: "Apple TV 4K",
    runtime: "tvOS 26.2",
    family: "iphone",
    deviceTypeIdentifier: `${T}Apple-TV-4K-3rd-generation-1080p`,
  }),
  simulator({
    udid: "vision",
    name: "Apple Vision Pro",
    runtime: "visionOS 26.2",
    family: "iphone",
    deviceTypeIdentifier: `${T}Apple-Vision-Pro`,
  }),
];

function renderPicker(overrides: Partial<React.ComponentProps<typeof AppleDevicePicker>> = {}) {
  const props = {
    installed: INSTALLED,
    pending: null,
    lastUsedUdid: null,
    refreshing: false,
    onStart: vi.fn(),
    onCreate: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides,
  };
  const view = render(<AppleDevicePicker {...props} />);
  return { ...props, ...view };
}

describe("AppleDevicePicker", () => {
  it("never calls the page 'iOS Simulators' again", () => {
    renderPicker();
    expect(screen.queryByRole("heading", { name: "iOS Simulators" })).toBeNull();
    expect(screen.queryByText("iOS Simulators")).toBeNull();
  });

  it("groups by family, in §B2's order, from the device type identifier", () => {
    const { container } = renderPicker();
    const headings = [...container.querySelectorAll("section[data-apple-family] h3")]
      .map((node) => node.textContent);
    expect(headings).toEqual(["iPhone", "iPad", "Apple Watch", "Apple TV", "Apple Vision"]);
  });

  it("files a device by its identifier even when the service's family disagrees", () => {
    const { container } = renderPicker();
    // Both of these carry `family: "iphone"` from the service. The identifier wins.
    const tv = container.querySelector("section[data-apple-family='tv']");
    expect(within(tv as HTMLElement).getByRole("button", { name: "Start Apple TV 4K" })).toBeTruthy();
    const vision = container.querySelector("section[data-apple-family='vision']");
    expect(within(vision as HTMLElement).getByRole("button", { name: "Start Apple Vision Pro" })).toBeTruthy();
  });

  it("shows the model under a custom name, and never repeats a name that is the model", () => {
    const { container } = renderPicker();
    const repro = container.querySelector("[data-apple-device-card='repro']") as HTMLElement;
    expect(within(repro).getByText("ADE Repro")).toBeTruthy();
    expect(within(repro).getByText("iPhone 17 Pro")).toBeTruthy();
    expect(repro.querySelector("[data-apple-model-line]")?.textContent).toBe("iPhone 17 Pro");

    const max = container.querySelector("[data-apple-device-card='max']") as HTMLElement;
    expect(max.querySelector("[data-apple-model-line]")).toBeNull();
  });

  it("promotes one hero card and does not repeat it in its family", () => {
    const { container } = renderPicker({ lastUsedUdid: "repro" });
    const hero = container.querySelector("[data-apple-hero-card]") as HTMLElement;
    expect(within(hero).getByText("ADE Repro")).toBeTruthy();
    expect(within(hero).getByText("iPhone 17 Pro")).toBeTruthy();
    expect(container.querySelector("[data-apple-device-card='repro']")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Start ADE Repro" })).toHaveLength(1);
  });

  it("heroes the newest iPhone when the lane has no history", () => {
    const { container } = renderPicker({
      lastUsedUdid: null,
      installed: [
        simulator({ udid: "old", name: "iPhone 16", runtime: "iOS 18.4" }),
        simulator({ udid: "new", name: "iPhone Air", runtime: "iOS 26.2" }),
        simulator({ udid: "pad", name: "iPad Pro", runtime: "iPadOS 26.4", family: "ipad", deviceTypeIdentifier: `${T}iPad-Pro-13-inch-M4-8GB` }),
      ],
    });
    const hero = container.querySelector("[data-apple-hero-card]") as HTMLElement;
    expect(within(hero).getByText("iPhone Air")).toBeTruthy();
  });

  it("names the action for the device it acts on, and opens what is already booted", () => {
    renderPicker();
    expect(screen.getByRole("button", { name: "Open iPhone 17 Pro" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start iPhone 17 Pro Max" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start Series 10" })).toBeTruthy();
  });

  it("starts the device that was clicked", () => {
    const props = renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "Start ADE Repro" }));
    expect(props.onStart).toHaveBeenCalledWith("repro");
  });

  it("locks every card while one start is in flight", () => {
    renderPicker({ pending: "repro" });
    expect(screen.getByRole("button", { name: "Open iPhone 17 Pro" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Start ADE Repro" }).hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByRole("button", { name: "Create a new simulator for this lane" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("keeps §B2's create card and footer, verbatim", () => {
    renderPicker();
    expect(screen.getByText("New simulator for this lane")).toBeTruthy();
    expect(screen.getByText("Only simulators already installed appear here.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  it("defaults Create to the hero, and spells each option's model out", () => {
    const props = renderPicker({ lastUsedUdid: "repro" });
    const select = screen.getByLabelText("Device to copy") as HTMLSelectElement;
    expect(select.value).toBe("repro");
    expect(
      [...select.options].some((option) => option.textContent === "ADE Repro · iPhone 17 Pro · iOS 26.2"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Create a new simulator for this lane" }));
    expect(props.onCreate).toHaveBeenCalledWith("repro");
  });

  it("says where simulators come from when there are none", () => {
    renderPicker({ installed: [] });
    expect(screen.getByText("No Apple simulators are installed.")).toBeTruthy();
    expect(screen.getByText("Install one in Xcode → Settings → Components.")).toBeTruthy();
    expect(screen.queryByText("New simulator for this lane")).toBeNull();
  });

  it("wears the tools grid's card and backdrop, not a flat black list", () => {
    const { container } = renderPicker();
    expect(container.querySelector(".ade-tool-picker-backdrop")).toBeTruthy();
    expect(container.querySelectorAll(".ade-tool-card").length).toBeGreaterThan(1);
    // Rule zero: nothing in this feature is see-through over the device.
    expect(container.querySelector(".bg-bg\\/80, .bg-bg\\/90, .bg-bg\\/95")).toBeNull();
  });

  it("never truncates a device name with an ellipsis", () => {
    const { container } = renderPicker({
      installed: [simulator({ udid: "long", name: "iPhone 17 Pro Max (2nd generation)" })],
    });
    expect(container.querySelector(".truncate")).toBeNull();
    expect(container.querySelector(".text-ellipsis")).toBeNull();
  });

  it.each([360, 900])("fits its container at %ipx", (width) => {
    const { container } = renderPicker();
    expectNoHorizontalOverflow(container, width);
  });
});
