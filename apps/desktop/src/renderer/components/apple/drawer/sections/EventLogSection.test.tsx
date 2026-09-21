/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IosSimulatorLogRow } from "../../../../../shared/types/iosSimulator";
import { APPLE_EVENT_LOG_LIMIT, appendEventLogRows, EventLogSection, eventLogClock } from "./EventLogSection";
import { installAdeMock, makeCtx } from "../drawerTestHarness";

afterEach(cleanup);

function row(id: number, message = `event ${id}`): IosSimulatorLogRow {
  return { id, at: "2026-09-21T10:00:05.000Z", source: "device", level: "info", process: null, subsystem: null, category: null, message };
}

describe("EventLogSection", () => {
  it("renders the title collapsed and subscribes to nothing", () => {
    const { iosSimulator } = installAdeMock();
    render(<EventLogSection ctx={makeCtx()} />);
    const trigger = screen.getByRole("button", { name: "Event log" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list", { name: "Event log rows" })).toBeNull();
    expect(iosSimulator.startEventLog).not.toHaveBeenCalled();
  });

  it("starts the log for the foreground app on expand and stops it on collapse", async () => {
    const { iosSimulator } = installAdeMock();
    iosSimulator.startEventLog.mockResolvedValue({ deviceUdid: "UDID-1", running: true, rows: [row(1, "launched")], cursor: 1, dropped: 0, lastError: null });
    render(<EventLogSection ctx={makeCtx()} />);
    fireEvent.click(screen.getByRole("button", { name: "Event log" }));
    await waitFor(() => expect(iosSimulator.startEventLog).toHaveBeenCalledWith(
      { laneId: "lane-1", deviceUdid: "UDID-1", chatSessionId: null, bundleId: "com.acme.app" },
      null,
    ));
    const list = await screen.findByRole("list", { name: "Event log rows" });
    expect(list.className).toContain("font-mono");
    expect(list.className).toContain("text-[11px]");
    expect(list.textContent).toContain("launched");
    expect(list.textContent).toMatch(/\d\d:\d\d:\d\d/);
    fireEvent.click(screen.getByRole("button", { name: "Event log" }));
    await waitFor(() => expect(iosSimulator.stopEventLog).toHaveBeenCalled());
  });

  it("says to open an app first when there is none, and never starts the log", () => {
    const { iosSimulator } = installAdeMock();
    render(<EventLogSection ctx={makeCtx({ foregroundApp: null })} />);
    fireEvent.click(screen.getByRole("button", { name: "Event log" }));
    expect(screen.getByText("Open an app first.")).toBeTruthy();
    expect(iosSimulator.startEventLog).not.toHaveBeenCalled();
  });

  it("caps the ring at one hundred rows", () => {
    const rows = appendEventLogRows([], Array.from({ length: 150 }, (_, index) => row(index)));
    expect(rows).toHaveLength(APPLE_EVENT_LOG_LIMIT);
    expect(rows[0]!.id).toBe(50);
    expect(appendEventLogRows(rows, [])).toHaveLength(APPLE_EVENT_LOG_LIMIT);
  });

  it("formats the clock and falls back for a non-ISO stamp", () => {
    expect(eventLogClock("2026-09-21T10:00:05.000Z")).toMatch(/^\d\d:\d\d:\d\d$/);
    expect(eventLogClock("not a date")).toBe("not a date");
    vi.clearAllMocks();
  });
});
