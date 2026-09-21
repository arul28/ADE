/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppleToolsDrawer, type AppleToolsDrawerProps } from "./AppleToolsDrawer";
import { DEVICE, installAdeMock } from "./drawerTestHarness";

afterEach(cleanup);

const SECTION_ORDER = ["App", "Simulator", "Inspect", "Recording", "Location", "Permissions", "Push notification", "Preview Lab", "Event log"];

function props(overrides: Partial<AppleToolsDrawerProps> = {}): AppleToolsDrawerProps {
  return {
    pin: null,
    laneId: "lane-1",
    device: DEVICE,
    visible: true,
    onClose: vi.fn(),
    inspect: { enabled: false, setEnabled: vi.fn(), selected: null },
    recording: { active: null, start: vi.fn(), stop: vi.fn() },
    onPreviewRendered: vi.fn(),
    ...overrides,
  };
}

describe("AppleToolsDrawer", () => {
  it("renders the Tools header, the close control and the nine sections in spec order", async () => {
    installAdeMock();
    const p = props();
    render(<AppleToolsDrawer {...p} />);
    expect(screen.getByText("Tools")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close tools" }));
    expect(p.onClose).toHaveBeenCalled();
    const headings = screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual(SECTION_ORDER);
    await waitFor(() => expect(screen.queryByText("Reading device settings…")).toBeNull());
  });

  it("shows the app the device reports in front, even when ADE launched nothing", async () => {
    const { iosSimulator } = installAdeMock();
    iosSimulator.getForegroundApp.mockResolvedValue({ bundleId: "com.other.fromxcode", pid: 77, checkedAt: "2026-09-21T00:00:00.000Z" });
    render(<AppleToolsDrawer {...props()} />);
    await waitFor(() => expect(screen.getByTestId("apple-drawer-foreground").textContent).toBe("com.other.fromxcode"));
    expect(iosSimulator.getForegroundApp).toHaveBeenCalledWith({ laneId: "lane-1", deviceUdid: "UDID-1" }, null);
    expect(iosSimulator.getStatus).not.toHaveBeenCalled();
  });

  it("reads the device settings once visible and derives the foreground app from the lane's session", async () => {
    const { iosSimulator } = installAdeMock();
    iosSimulator.getStatus.mockResolvedValue({
      platform: "darwin", supported: true, tools: [], activeDevice: null,
      activeSession: { bundleId: "com.acme.app", laneId: "lane-1", deviceUdid: "UDID-1" },
    });
    render(<AppleToolsDrawer {...props()} />);
    await waitFor(() => expect(iosSimulator.getDeviceSettings).toHaveBeenCalledWith(
      { laneId: "lane-1", deviceUdid: "UDID-1", chatSessionId: null },
      null,
    ));
    await waitFor(() => expect(screen.getByTestId("apple-drawer-foreground").textContent).toBe("com.acme.app"));
  });

  it("ignores another lane's session for the foreground app", async () => {
    const { iosSimulator } = installAdeMock();
    iosSimulator.getStatus.mockResolvedValue({
      platform: "darwin", supported: true, tools: [], activeDevice: null,
      activeSession: { bundleId: "com.acme.app", laneId: "lane-9", deviceUdid: "UDID-1" },
    });
    render(<AppleToolsDrawer {...props()} />);
    await waitFor(() => expect(iosSimulator.getStatus).toHaveBeenCalled());
    expect(screen.getByTestId("apple-drawer-foreground").textContent).toBe("—");
  });

  it("serializes actions: a second click during one in flight is dropped, and the value shown is the device's", async () => {
    const { iosSimulator } = installAdeMock();
    let release: (() => void) | null = null;
    iosSimulator.setAppearance.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ ...(iosSimulator.getDeviceSettings.getMockImplementation() ? {} : {}), deviceUdid: "UDID-1", appearance: "dark", contentSize: "medium", accessibility: {}, location: null, statusBarOverridden: false, readAt: "" });
    }));
    render(<AppleToolsDrawer {...props()} />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Dark" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    await waitFor(() => expect(iosSimulator.setAppearance).toHaveBeenCalledTimes(1));
    // Not optimistic: Light is still the pressed value until the device confirms.
    expect(screen.getByRole("button", { name: "Light" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("Working")).toBeTruthy();
    // Every control is disabled while pending, so the second click cannot land.
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
});
