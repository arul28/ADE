/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SimRecording } from "../../../../../main/services/ios/recording/simRecordingService";
import { RecordingSection, recordingName } from "./RecordingSection";
import { installAdeMock, makeCtx } from "../drawerTestHarness";

afterEach(cleanup);

function recording(overrides: Partial<SimRecording> = {}): SimRecording {
  return {
    id: "rec-1",
    laneId: "lane-1",
    udid: "UDID-1",
    chatSessionId: null,
    path: "/r/.ade/artifacts/apple-recordings/lane-1/rec-1.mp4",
    startedAt: "2026-09-21T10:00:00.000Z",
    endedAt: "2026-09-21T10:00:42.000Z",
    durationMs: 42_000,
    bytes: 3 * 1024 * 1024,
    mode: "manual",
    proof: false,
    label: "signup",
    overlays: true,
    ...overrides,
  };
}

describe("RecordingSection", () => {
  it("renders the title and an Idle status row with Record", async () => {
    installAdeMock();
    render(<RecordingSection ctx={makeCtx()} active={null} start={vi.fn()} stop={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Recording" })).toBeTruthy();
    expect(screen.getByText("Status")).toBeTruthy();
    expect(screen.getByTestId("apple-drawer-recording-status").textContent).toBe("Idle");
    expect(screen.getByRole("button", { name: "Record" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("No recordings for this lane yet.")).toBeTruthy());
  });

  it("shows Recording m:ss and Stop while one is in flight", () => {
    installAdeMock();
    const stop = vi.fn();
    const active = recording({ endedAt: null, durationMs: null, startedAt: new Date(Date.now() - 42_000).toISOString() });
    render(<RecordingSection ctx={makeCtx()} active={active} start={vi.fn()} stop={stop} />);
    expect(screen.getByTestId("apple-drawer-recording-status").textContent).toMatch(/Recording 00:4[12]/);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(stop).toHaveBeenCalled();
  });

  it("lists finished recordings with name, duration · size, Pin to proof and a ⋯ menu", async () => {
    const { iosSimulator } = installAdeMock();
    iosSimulator.recordList.mockResolvedValue([recording(), recording({ id: "rec-2", label: null, proof: true, bytes: null })]);
    render(<RecordingSection ctx={makeCtx()} active={null} start={vi.fn()} stop={vi.fn()} />);
    const list = await screen.findByRole("list", { name: "Recordings" });
    const items = list.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("signup");
    expect(items[0]!.textContent).toContain("00:42 · 3 MB");
    expect(items[1]!.textContent).toContain("pinned");
    const pins = screen.getAllByRole("button", { name: "Pin to proof" }) as HTMLButtonElement[];
    expect(pins[0]!.disabled).toBe(false);
    // A pinned recording's button is present and inert, not gone.
    expect(pins[1]!.disabled).toBe(true);
    expect(screen.getByRole("button", { name: `More for ${recordingName(recording())}` })).toBeTruthy();
    fireEvent.click(pins[0]!);
    await waitFor(() => expect(iosSimulator.captureProofBundle).toHaveBeenCalledWith(
      expect.objectContaining({ laneId: "lane-1", caption: "signup" }),
      null,
    ));
  });

  it("names an unlabeled recording by its start time", () => {
    expect(recordingName(recording({ label: null }))).toMatch(/^Recording \d\d:\d\d:\d\d$/);
    expect(recordingName(recording({ label: "  demo " }))).toBe("demo");
  });

  it("does not read the list while hidden and disables the verbs", () => {
    const { iosSimulator } = installAdeMock();
    render(<RecordingSection ctx={makeCtx({ visible: false })} active={null} start={vi.fn()} stop={vi.fn()} />);
    expect(iosSimulator.recordList).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Record" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
