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

  it("has no Inspect and no Recording section: both are rail controls now (§B1)", async () => {
    installAdeMock();
    render(<AppleToolsDrawer {...props()} />);
    const headings = screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(headings).not.toContain("Inspect");
    expect(headings).not.toContain("Recording");
    // And no way to start one from here, open or closed.
    fireEvent.click(header("Capture"));
    await waitFor(() => expect(screen.getByText("No recordings for this lane yet.")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Record" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Overlay element frames" })).toBeNull();
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

  it("is opaque: nothing behind the drawer or its cards can be read through it (rule zero)", async () => {
    installAdeMock();
    const { container } = render(<AppleToolsDrawer {...props()} />);
    const shell = screen.getByTestId("apple-tools-drawer");
    expect(shell.className).toContain("bg-surface");
    expect(shell.className).toContain("border-l");
    // No alpha fill and no blur anywhere in the column: those are exactly what
    // made the simulator legible through the Simulator section's switches.
    expect(container.querySelector("[class*='backdrop-blur']")).toBeNull();
    expect(container.querySelector("[class*='bg-bg/']")).toBeNull();
    await waitFor(() => expect(screen.queryByText("Reading device settings…")).toBeNull());
  });

  it("dresses every group as a solid tools-grid card (§B2)", () => {
    installAdeMock();
    render(<AppleToolsDrawer {...props()} />);
    for (const testId of ["apple-drawer-device", "apple-drawer-app", "apple-drawer-capture", "apple-drawer-preview-lab"]) {
      const card = screen.getByTestId(testId);
      // The picker's own card class, plus the modifier that takes the 82%
      // translucency and the hover lift back off it.
      expect(card.className).toContain("ade-tool-card");
      expect(card.className).toContain("ade-tool-card-solid");
    }
    expect(screen.getByTestId("apple-drawer-device").getAttribute("data-open")).toBe("true");
    expect(screen.getByTestId("apple-drawer-app").getAttribute("data-open")).toBe("false");
  });

  it("puts no outline on the controls: the card carries the edge (§B2)", async () => {
    installAdeMock();
    render(<AppleToolsDrawer {...props()} />);
    await waitFor(() => expect(screen.queryByText("Reading device settings…")).toBeNull());
    const card = screen.getByTestId("apple-drawer-device");
    const outlined = [...card.querySelectorAll<HTMLElement>("button, input")]
      .filter((node) => /(^|\s)border(-border)?(\s|$)/.test(node.className));
    expect(outlined.map((node) => node.textContent)).toEqual([]);
    // And exactly one accent control in the open group — its primary verb.
    const accent = [...card.querySelectorAll<HTMLElement>("button")]
      .filter((node) => node.className.includes("var(--color-accent)_22%"));
    expect(accent.map((node) => node.textContent)).toEqual(["Light", "Set"]);
  });

  it("never lets a row's label and its control fall onto two lines (§B4)", async () => {
    installAdeMock();
    render(<AppleToolsDrawer {...props()} />);
    await waitFor(() => expect(screen.queryByText("Reading device settings…")).toBeNull());
    // Every row that pairs a label with a control is `flex-nowrap`, and the
    // LABEL is the side that gives way — the control has no smaller size.
    const row = screen.getByText("Reduce Transparency").closest("div");
    expect(row?.className).toContain("flex-nowrap");
    const label = screen.getByText("Reduce Transparency");
    expect(label.className).toContain("truncate");
    expect(label.className).toContain("min-w-0");
    expect(label.getAttribute("title")).toBe("Reduce Transparency");
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
