/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppleInstalledSimulator } from "../../../shared/types/iosSimulator";
import { AppleDevicePicker } from "./AppleDevicePicker";

afterEach(cleanup);

function simulator(overrides: Partial<AppleInstalledSimulator>): AppleInstalledSimulator {
  return {
    udid: "udid",
    name: "iPhone 17 Pro",
    runtime: "iOS 26.2",
    state: "Shutdown",
    isAvailable: true,
    family: "iphone",
    deviceTypeIdentifier: null,
    ...overrides,
  };
}

const INSTALLED = [
  simulator({ udid: "pro", name: "iPhone 17 Pro", state: "Booted" }),
  simulator({ udid: "max", name: "iPhone 17 Pro Max" }),
  simulator({ udid: "unit", name: "ADE Unit C" }),
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
  render(<AppleDevicePicker {...props} />);
  return props;
}

describe("AppleDevicePicker", () => {
  it("renders §3.1's heading, rows and footer verbatim", () => {
    renderPicker();
    expect(screen.getByRole("heading", { name: "iOS Simulators" })).toBeTruthy();
    expect(screen.getByText("iOS 26.2 · Running")).toBeTruthy();
    expect(screen.getAllByText("iOS 26.2 · Stopped")).toHaveLength(2);
    expect(screen.getByText("New simulator for this lane")).toBeTruthy();
    expect(screen.getByText("Only simulators already installed appear here.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  it("names each row's action for the device it acts on", () => {
    renderPicker();
    // The booted one opens; the rest start. Both are one click, which is the
    // whole point: round 1 attached without booting and showed a black column.
    expect(screen.getByRole("button", { name: "Open iPhone 17 Pro" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start iPhone 17 Pro Max" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start ADE Unit C" })).toBeTruthy();
  });

  it("puts the booted device first and pre-selects no row", () => {
    renderPicker();
    const rows = screen.getAllByRole("button")
      .filter((node) => /^(Open|Start) /.test(node.getAttribute("aria-label") ?? ""));
    expect(rows.map((node) => node.getAttribute("aria-label"))).toEqual([
      "Open iPhone 17 Pro",
      "Start ADE Unit C",
      "Start iPhone 17 Pro Max",
    ]);
    expect(rows.some((node) => node.getAttribute("aria-current") === "true")).toBe(false);
  });

  it("starts the device that was clicked", () => {
    const props = renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "Start ADE Unit C" }));
    expect(props.onStart).toHaveBeenCalledWith("unit");
  });

  it("locks every row while one start is in flight", () => {
    renderPicker({ pending: "unit" });
    expect(screen.getByRole("button", { name: "Open iPhone 17 Pro" })
      .hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Create a new simulator for this lane" })
      .hasAttribute("disabled")).toBe(true);
  });

  it("defaults Create to the lane's last used template", () => {
    const props = renderPicker({ lastUsedUdid: "max" });
    const select = screen.getByLabelText("Device to copy") as HTMLSelectElement;
    expect(select.value).toBe("max");
    fireEvent.click(screen.getByRole("button", { name: "Create a new simulator for this lane" }));
    expect(props.onCreate).toHaveBeenCalledWith("max");
  });

  it("defaults Create to the newest iPhone when the lane has no history", () => {
    renderPicker({
      lastUsedUdid: null,
      installed: [
        simulator({ udid: "old", name: "iPhone 16", runtime: "iOS 18.4" }),
        simulator({ udid: "new", name: "iPhone Air", runtime: "iOS 26.2" }),
        simulator({ udid: "pad", name: "iPad Pro", runtime: "iPadOS 26.4", family: "ipad" }),
      ],
    });
    expect((screen.getByLabelText("Device to copy") as HTMLSelectElement).value).toBe("new");
  });

  it("says where simulators come from when there are none", () => {
    renderPicker({ installed: [] });
    expect(screen.getByText("No iOS simulators are installed.")).toBeTruthy();
    expect(screen.getByText("Install one in Xcode → Settings → Components.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "iOS Simulators" })).toBeNull();
  });

  it("never truncates a device name with an ellipsis", () => {
    const { container } = render(
      <AppleDevicePicker
        installed={[simulator({ udid: "long", name: "iPhone 17 Pro Max (2nd generation)" })]}
        pending={null}
        lastUsedUdid={null}
        refreshing={false}
        onStart={vi.fn()}
        onCreate={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(container.querySelector(".truncate")).toBeNull();
    expect(container.querySelector(".text-ellipsis")).toBeNull();
  });
});
