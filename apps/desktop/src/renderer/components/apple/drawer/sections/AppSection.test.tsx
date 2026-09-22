/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IosSimulatorLogRow } from "../../../../../shared/types/iosSimulator";
import { APPLE_EVENT_LOG_LIMIT, AppSection, appendEventLogRows, eventLogClock } from "./AppSection";
import { controlsIn, installAdeMock, makeActions, makeCtx } from "../drawerTestHarness";

afterEach(cleanup);

function row(id: number, over: Partial<IosSimulatorLogRow> = {}): IosSimulatorLogRow {
  return {
    id,
    at: "2026-09-21T10:11:12.000Z",
    level: "info",
    message: `line ${id}`,
    subsystem: null,
    category: null,
    ...over,
  } as IosSimulatorLogRow;
}

describe("AppSection", () => {
  it("renders the foreground row, both verbs, both submit rows, permissions, push and the log", () => {
    installAdeMock();
    render(<AppSection ctx={makeCtx()} />);
    // No heading of its own: the App GROUP card is the heading (§B1).
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText("Foreground")).toBeTruthy();
    expect(screen.getByTestId("apple-drawer-foreground").textContent).toBe("com.acme.app");
    expect(screen.getByRole("button", { name: "Relaunch" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Terminate" })).toBeTruthy();
    expect(screen.getByPlaceholderText("https://… or myapp://")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Bundle ID")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Launch" })).toBeTruthy();
    // The three sections that used to sit under this one, folded in.
    expect(screen.getByText("Permissions")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Grant" })).toBeTruthy();
    expect(screen.getByText("Push notification")).toBeTruthy();
    expect(screen.getByPlaceholderText("Alert text")).toBeTruthy();
    expect(screen.getByText("Event log")).toBeTruthy();
  });

  it("shows — and disables Relaunch/Terminate with no foreground app, never hiding them", () => {
    installAdeMock();
    render(<AppSection ctx={makeCtx({ foregroundApp: null })} />);
    expect(screen.getByTestId("apple-drawer-foreground").textContent).toBe("—");
    expect((screen.getByRole("button", { name: "Relaunch" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Terminate" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByPlaceholderText("https://… or myapp://") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByPlaceholderText("Alert text") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("Open an app first.")).toBeTruthy();
  });

  it("disables every control while an action is pending", () => {
    installAdeMock();
    const { container } = render(<AppSection ctx={makeCtx({ actions: makeActions({ disabled: true, pending: true }) })} />);
    for (const control of controlsIn(container)) {
      // The event-log switch answers `visible`, not `pending`: stopping a log
      // stream is not a device write and must not queue behind one.
      if (control.getAttribute("role") === "switch") continue;
      expect((control as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("opens a URL through act and clears the field on success", async () => {
    const { iosSimulator } = installAdeMock();
    const ctx = makeCtx();
    render(<AppSection ctx={ctx} />);
    const input = screen.getByPlaceholderText("https://… or myapp://") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "myapp://home" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(iosSimulator.openUrl).toHaveBeenCalledWith(
      { laneId: "lane-1", deviceUdid: "UDID-1", chatSessionId: null, url: "myapp://home" },
      null,
    ));
    await waitFor(() => expect(input.value).toBe(""));
    expect(ctx.actions.act).toHaveBeenCalledTimes(1);
  });

  it("launching a bundle id makes it the foreground app", async () => {
    const { iosSimulator } = installAdeMock();
    const ctx = makeCtx({ foregroundApp: null });
    render(<AppSection ctx={ctx} />);
    fireEvent.change(screen.getByPlaceholderText("Bundle ID"), { target: { value: "com.acme.two" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() => expect(iosSimulator.launch).toHaveBeenCalledWith(
      expect.objectContaining({ laneId: "lane-1", bundleId: "com.acme.two", build: false, openDrawer: false }),
      null,
    ));
    await waitFor(() => expect(ctx.setForegroundApp).toHaveBeenCalledWith("com.acme.two"));
  });

  it("relaunches and terminates the foreground app", async () => {
    const { iosSimulator } = installAdeMock();
    render(<AppSection ctx={makeCtx()} />);
    fireEvent.click(screen.getByRole("button", { name: "Relaunch" }));
    await waitFor(() => expect(iosSimulator.relaunchApp).toHaveBeenCalledWith(expect.objectContaining({ bundleId: "com.acme.app" }), null));
    fireEvent.click(screen.getByRole("button", { name: "Terminate" }));
    await waitFor(() => expect(iosSimulator.terminateApp).toHaveBeenCalledWith(expect.objectContaining({ bundleId: "com.acme.app" }), null));
    vi.clearAllMocks();
  });

  it("grants, revokes and resets a permission, defaulting the app id to the foreground app", async () => {
    const { iosSimulator } = installAdeMock();
    render(<AppSection ctx={makeCtx()} />);
    fireEvent.click(screen.getByRole("button", { name: "Grant" }));
    await waitFor(() => expect(iosSimulator.setPermission).toHaveBeenCalledWith(
      expect.objectContaining({ bundleId: "com.acme.app", service: "photos", action: "grant" }),
      null,
    ));
    fireEvent.change(screen.getByLabelText("App ID"), { target: { value: "com.other" } });
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(iosSimulator.setPermission).toHaveBeenCalledWith(
      expect.objectContaining({ bundleId: "com.other", action: "revoke" }),
      null,
    ));
  });

  it("sends a push to the foreground app", async () => {
    const { iosSimulator } = installAdeMock();
    render(<AppSection ctx={makeCtx()} />);
    fireEvent.change(screen.getByPlaceholderText("Alert text"), { target: { value: "Ping" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(iosSimulator.sendPushNotification).toHaveBeenCalledWith(
      expect.objectContaining({ bundleId: "com.acme.app", body: "Ping" }),
      null,
    ));
  });

  it("streams the log only while the switch is on, and stops it when it goes off", async () => {
    const { iosSimulator } = installAdeMock();
    iosSimulator.startEventLog.mockResolvedValue({
      deviceUdid: "UDID-1", running: true, cursor: 4, dropped: 0, lastError: null,
      rows: [row(1, { message: "hello" })],
    });
    render(<AppSection ctx={makeCtx()} />);
    expect(iosSimulator.startEventLog).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("switch", { name: "Stream log" }));
    await waitFor(() => expect(iosSimulator.startEventLog).toHaveBeenCalledWith(
      expect.objectContaining({ laneId: "lane-1", bundleId: "com.acme.app" }),
      null,
    ));
    await waitFor(() => expect(screen.getByText("hello")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "Streaming" }));
    });
    expect(iosSimulator.stopEventLog).toHaveBeenCalled();
    expect(screen.queryByText("hello")).toBeNull();
  });

  it("cannot stream a log with nothing in the foreground", () => {
    installAdeMock();
    render(<AppSection ctx={makeCtx({ foregroundApp: null })} />);
    expect((screen.getByRole("switch", { name: "Stream log" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("caps the log at the newest hundred rows", () => {
    const current = Array.from({ length: APPLE_EVENT_LOG_LIMIT }, (_, index) => row(index));
    const merged = appendEventLogRows(current, [row(1000), row(1001)]);
    expect(merged).toHaveLength(APPLE_EVENT_LOG_LIMIT);
    expect(merged.at(-1)?.id).toBe(1001);
    expect(merged[0]?.id).toBe(2);
    expect(appendEventLogRows(current, [])).toHaveLength(APPLE_EVENT_LOG_LIMIT);
  });

  it("reads a clock off an ISO timestamp and falls back to the raw text", () => {
    expect(eventLogClock("2026-09-21T10:11:12.000Z")).toMatch(/\d{2}:\d{2}:\d{2}/u);
    expect(eventLogClock("not a date")).toBe("not a date");
  });
});
