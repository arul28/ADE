/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  AppleToolsDrawer,
  resetAppleDrawerGroupForTests,
  type AppleToolsDrawerProps,
} from "./AppleToolsDrawer";
import { DEVICE, installAdeMock } from "./drawerTestHarness";
import { expectNoHorizontalOverflow } from "../testLayout";

afterEach(cleanup);
beforeEach(() => {
  resetAppleDrawerGroupForTests();
  window.localStorage.clear();
});

/** §B1's four, in order. Nine flat sections are gone. */
const GROUPS = ["Device", "App", "Capture", "Preview Lab"];

function props(overrides: Partial<AppleToolsDrawerProps> = {}): AppleToolsDrawerProps {
  return {
    pin: null,
    laneId: "lane-1",
    device: DEVICE,
    visible: true,
    onClose: vi.fn(),
    onPreviewRendered: vi.fn(),
    ...overrides,
  };
}

function header(name: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^${name}$`) });
}

describe("AppleToolsDrawer", () => {
  it("renders the Tools header, the close control and exactly four groups in spec order", async () => {
    installAdeMock();
    const p = props();
    render(<AppleToolsDrawer {...p} />);
    expect(screen.getByText("Tools")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close tools" }));
    expect(p.onClose).toHaveBeenCalled();
    const headings = screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual(GROUPS);
    await waitFor(() => expect(screen.queryByText("Reading device settings…")).toBeNull());
  });

  it("passes the rail's recording through to Capture, so a stop lands in the library at once", async () => {
    const { iosSimulator } = installAdeMock();
    iosSimulator.recordList.mockResolvedValue([]);
    const view = render(<AppleToolsDrawer {...props({ activeRecordingId: "rec-1" })} />);
    fireEvent.click(header("Capture"));
    await waitFor(() => expect(iosSimulator.recordList).toHaveBeenCalledTimes(1));

    // The rail stopped: Record is not in this drawer any more, so this prop is
    // the only way the card can hear about it.
    view.rerender(<AppleToolsDrawer {...props({ activeRecordingId: null })} />);
    await waitFor(() => expect(iosSimulator.recordList).toHaveBeenCalledTimes(2));
  });

  it("opens Device by default and keeps exactly one group open", async () => {
    installAdeMock();
    render(<AppleToolsDrawer {...props()} />);
    expect(header("Device").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("switch", { name: "Reduce Motion" })).toBeTruthy();

    fireEvent.click(header("App"));
    expect(header("App").getAttribute("aria-expanded")).toBe("true");
    expect(header("Device").getAttribute("aria-expanded")).toBe("false");
    // A closed group is UNMOUNTED, not hidden: its polls have to stop with it.
    expect(screen.queryByRole("switch", { name: "Reduce Motion" })).toBeNull();
    await waitFor(() => expect(screen.getByTestId("apple-drawer-foreground")).toBeTruthy());
  });

  it("collapses the open group when its own header is clicked", () => {
    installAdeMock();
    render(<AppleToolsDrawer {...props()} />);
    fireEvent.click(header("Device"));
    expect(header("Device").getAttribute("aria-expanded")).toBe("false");
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(4);
    expect(screen.queryByRole("switch", { name: "Reduce Motion" })).toBeNull();
  });

  it("remembers the open group per chat", () => {
    installAdeMock();
    const first = render(<AppleToolsDrawer {...props({ chatSessionId: "chat-a" })} />);
    fireEvent.click(header("Preview Lab"));
    expect(header("Preview Lab").getAttribute("aria-expanded")).toBe("true");
    first.unmount();

    // Another chat opens on the default card, not on this one's choice.
    const other = render(<AppleToolsDrawer {...props({ chatSessionId: "chat-b" })} />);
    expect(header("Device").getAttribute("aria-expanded")).toBe("true");
    other.unmount();

    render(<AppleToolsDrawer {...props({ chatSessionId: "chat-a" })} />);
    expect(header("Preview Lab").getAttribute("aria-expanded")).toBe("true");
  });

  it("reads the foreground app only while the App group is open", async () => {
    const { iosSimulator } = installAdeMock();
    iosSimulator.getForegroundApp.mockResolvedValue({ bundleId: "com.other.fromxcode", pid: 77, checkedAt: "2026-09-21T00:00:00.000Z" });
    render(<AppleToolsDrawer {...props()} />);
    // Device is open: the App card's poll is not running at all.
    expect(iosSimulator.getForegroundApp).not.toHaveBeenCalled();
    fireEvent.click(header("App"));
    await waitFor(() => expect(screen.getByTestId("apple-drawer-foreground").textContent).toBe("com.other.fromxcode"));
    expect(iosSimulator.getForegroundApp).toHaveBeenCalledWith({ laneId: "lane-1", deviceUdid: "UDID-1" }, null);
    expect(iosSimulator.getStatus).not.toHaveBeenCalled();
  });

  it("falls back to the lane's active session for the foreground app, and ignores another lane's", async () => {
    const { iosSimulator } = installAdeMock();
    iosSimulator.getStatus.mockResolvedValue({
      platform: "darwin", supported: true, tools: [], activeDevice: null,
      activeSession: { bundleId: "com.acme.app", laneId: "lane-1", deviceUdid: "UDID-1" },
    });
    const view = render(<AppleToolsDrawer {...props()} />);
    fireEvent.click(header("App"));
    await waitFor(() => expect(screen.getByTestId("apple-drawer-foreground").textContent).toBe("com.acme.app"));
    view.unmount();

    resetAppleDrawerGroupForTests();
    iosSimulator.getStatus.mockResolvedValue({
      platform: "darwin", supported: true, tools: [], activeDevice: null,
      activeSession: { bundleId: "com.acme.app", laneId: "lane-9", deviceUdid: "UDID-1" },
    });
    render(<AppleToolsDrawer {...props()} />);
    fireEvent.click(header("App"));
    await waitFor(() => expect(iosSimulator.getStatus).toHaveBeenCalled());
    expect(screen.getByTestId("apple-drawer-foreground").textContent).toBe("—");
  });

  it("reads the device settings once visible", async () => {
    const { iosSimulator } = installAdeMock();
    render(<AppleToolsDrawer {...props()} />);
    await waitFor(() => expect(iosSimulator.getDeviceSettings).toHaveBeenCalledWith(
      { laneId: "lane-1", deviceUdid: "UDID-1", chatSessionId: null },
      null,
    ));
  });

  it("serializes actions: a second click during one in flight is dropped, and the value shown is the device's", async () => {
    const { iosSimulator } = installAdeMock();
    let release: (() => void) | null = null;
    iosSimulator.setAppearance.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ deviceUdid: "UDID-1", appearance: "dark", contentSize: "medium", accessibility: {}, location: null, statusBarOverridden: false, readAt: "" });
    }));
    render(<AppleToolsDrawer {...props()} />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Dark" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    await waitFor(() => expect(iosSimulator.setAppearance).toHaveBeenCalledTimes(1));
    // Not optimistic: Light is still the pressed value until the device confirms.
    expect(screen.getByRole("button", { name: "Light" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("Working")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Dark" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Reduce Motion" }));
    expect(iosSimulator.setAccessibilityOption).not.toHaveBeenCalled();
    iosSimulator.getDeviceSettings.mockResolvedValue({ deviceUdid: "UDID-1", appearance: "dark", contentSize: "medium", accessibility: {}, location: null, statusBarOverridden: false, readAt: "" });
    release!();
    await waitFor(() => expect(screen.getByRole("button", { name: "Dark" }).getAttribute("aria-pressed")).toBe("true"));
    expect(iosSimulator.getDeviceSettings).toHaveBeenCalledTimes(2);
  });

  it("shows a refused action as a plain sentence with Details, never the raw IPC text, and dismisses it", async () => {
    const { iosSimulator } = installAdeMock();
    iosSimulator.setAppearance.mockRejectedValue(new Error("Error invoking remote method 'ade.iosSimulator.setAppearance': Error: Device not booted (state: Shutdown)"));
    render(<AppleToolsDrawer {...props()} />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Dark" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("The device is off.");
    expect(banner.textContent).not.toContain("Error invoking remote method");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(banner.querySelector("pre")?.textContent).toContain("Error invoking remote method");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("reads nothing while hidden and disables the controls", () => {
    const { iosSimulator } = installAdeMock();
    render(<AppleToolsDrawer {...props({ visible: false })} />);
    expect(iosSimulator.getDeviceSettings).not.toHaveBeenCalled();
    expect(iosSimulator.getStatus).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Dark" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables an unreported control rather than hiding it (§B6)", async () => {
    const { iosSimulator } = installAdeMock();
    iosSimulator.getDeviceSettings.mockResolvedValue({
      deviceUdid: "UDID-1", appearance: "dark", contentSize: "medium",
      accessibility: { "reduce-motion": null }, location: null, statusBarOverridden: false, readAt: "",
    });
    render(<AppleToolsDrawer {...props()} />);
    const missing = await screen.findByRole("switch", { name: "Reduce Motion" });
    expect((missing as HTMLButtonElement).disabled).toBe(true);
    expect(missing.getAttribute("aria-checked")).toBe("false");
  });

  it.each([360, 900])("fits its container at %ipx", async (width) => {
    installAdeMock();
    const { container } = render(<AppleToolsDrawer {...props()} />);
    await waitFor(() => expect(screen.queryByText("Reading device settings…")).toBeNull());
    expectNoHorizontalOverflow(container, width);
  });
});
