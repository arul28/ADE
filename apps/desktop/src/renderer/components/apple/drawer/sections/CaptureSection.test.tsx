/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SimRecording } from "../../../../../main/services/ios/recording/simRecordingService";
import { CAPTURE_POLL_MS, CaptureSection, recordingName } from "./CaptureSection";
import { installAdeMock, makeCtx } from "../drawerTestHarness";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** The row's name in THIS machine's timezone, which is what the row renders. */
const CLOCK = new Date("2026-09-21T10:11:12.000Z").toLocaleTimeString([], { hour12: false });

function recording(over: Partial<SimRecording> = {}): SimRecording {
  return {
    id: "rec-1",
    laneId: "lane-1",
    udid: "UDID-1",
    chatSessionId: null,
    path: "/r/.ade/artifacts/apple-recordings/lane-1/rec-1.mp4",
    startedAt: "2026-09-21T10:11:12.000Z",
    endedAt: "2026-09-21T10:11:35.000Z",
    durationMs: 23_000,
    bytes: 8_500_000,
    mode: "manual",
    proof: true,
    label: null,
    overlays: true,
    proofArtifactId: "artifact-1",
    ...over,
  };
}

describe("CaptureSection", () => {
  it("says so plainly when the lane has recorded nothing", async () => {
    installAdeMock();
    render(<CaptureSection ctx={makeCtx()} />);
    await waitFor(() => expect(screen.getByText("No recordings for this lane yet.")).toBeTruthy());
  });

  it("cannot start or stop a recording: Record is a rail control now (§B1)", async () => {
    const { iosSimulator } = installAdeMock();
    iosSimulator.recordList.mockResolvedValue([recording()]);
    render(<CaptureSection ctx={makeCtx()} />);
    await waitFor(() => expect(screen.getByText(`Recording ${CLOCK}`)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Record" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.queryByText("Status")).toBeNull();
    expect(iosSimulator.recordStart).not.toHaveBeenCalled();
  });

  it("lists a finished recording with its duration, size and description", async () => {
    const { iosSimulator } = installAdeMock();
    iosSimulator.recordList.mockResolvedValue([recording({ label: "signup", chatSessionId: "chat-9", mode: "auto" })]);
    render(<CaptureSection ctx={makeCtx()} />);
    const row = await screen.findByText("signup");
    expect(row.parentElement?.textContent).toContain("00:23");
    expect(row.parentElement?.textContent).toContain("8.1 MB");
    expect(row.parentElement?.textContent).toContain("agent · auto · proof");
  });

  it("hides the one still running: the rail says that, not the library", async () => {
    const { iosSimulator } = installAdeMock();
    iosSimulator.recordList.mockResolvedValue([
      recording({ id: "live", endedAt: null, durationMs: null, bytes: null }),
      recording(),
    ]);
    render(<CaptureSection ctx={makeCtx()} />);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
  });

  it("opens a recording in proof through the host's navigator", async () => {
    const { iosSimulator } = installAdeMock();
    iosSimulator.recordList.mockResolvedValue([recording()]);
    const onOpenProof = vi.fn();
    render(<CaptureSection ctx={makeCtx()} onOpenProof={onOpenProof} />);
    const open = await screen.findByRole("button", { name: "Open in proof" });
    fireEvent.click(open);
    expect(onOpenProof).toHaveBeenCalledWith("artifact-1");
  });

  it("disables Open in proof rather than hiding it while a recording has no artifact", async () => {
    const { iosSimulator } = installAdeMock();
    iosSimulator.recordList.mockResolvedValue([recording({ proofArtifactId: null })]);
    render(<CaptureSection ctx={makeCtx()} onOpenProof={vi.fn()} />);
    const open = await screen.findByRole("button", { name: "Open in proof" });
    expect((open as HTMLButtonElement).disabled).toBe(true);
  });

  it("falls back to opening the file itself on a surface with no proof drawer", async () => {
    const { iosSimulator, app } = installAdeMock();
    iosSimulator.recordList.mockResolvedValue([recording()]);
    const openPath = vi.fn(async () => undefined);
    (app as unknown as Record<string, unknown>).openPath = openPath;
    render(<CaptureSection ctx={makeCtx()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open in proof" }));
    await waitFor(() => expect(openPath).toHaveBeenCalledWith(recording().path));
  });

  it("reveals and deletes through the ⋯, and delete allows a proof recording", async () => {
    const { iosSimulator, app } = installAdeMock();
    iosSimulator.recordList.mockResolvedValue([recording()]);
    render(<CaptureSection ctx={makeCtx()} />);
    const more = await screen.findByRole("button", { name: `More for Recording ${CLOCK}` });
    fireEvent.keyDown(more, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Reveal in Finder" }));
    await waitFor(() => expect(app.revealPath).toHaveBeenCalledWith(recording().path));

    fireEvent.keyDown(screen.getByRole("button", { name: `More for Recording ${CLOCK}` }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await waitFor(() => expect(iosSimulator.recordDelete).toHaveBeenCalledWith(
      { laneId: "lane-1", chatSessionId: null, id: "rec-1", allowProof: true },
      null,
    ));
  });

  it("re-reads the library the moment the rail's recording stops", async () => {
    const { iosSimulator } = installAdeMock();
    iosSimulator.recordList.mockResolvedValue([]);
    // One ctx for every render: a fresh one carries a fresh `pinRef`, which is
    // a dependency of the list read and would count as its own transition.
    const ctx = makeCtx();
    const view = render(<CaptureSection ctx={ctx} activeRecordingId={null} />);
    await waitFor(() => expect(iosSimulator.recordList).toHaveBeenCalledTimes(1));

    // Record, from the rail: a transition, but nothing finished yet.
    view.rerender(<CaptureSection ctx={ctx} activeRecordingId="rec-1" />);
    await waitFor(() => expect(iosSimulator.recordList).toHaveBeenCalledTimes(2));

    // Stop: the finished row has to be on screen at once, not on the next poll.
    iosSimulator.recordList.mockResolvedValue([recording()]);
    view.rerender(<CaptureSection ctx={ctx} activeRecordingId={null} />);
    await waitFor(() => expect(screen.getByText(`Recording ${CLOCK}`)).toBeTruthy());
    expect(iosSimulator.recordList).toHaveBeenCalledTimes(3);
  });

  it("does not re-read on mount: the hook has already read once", async () => {
    const { iosSimulator } = installAdeMock();
    iosSimulator.recordList.mockResolvedValue([]);
    render(<CaptureSection ctx={makeCtx()} activeRecordingId="rec-1" />);
    await waitFor(() => expect(iosSimulator.recordList).toHaveBeenCalledTimes(1));
    // A rerender with the same active recording is not a transition either.
    await waitFor(() => expect(iosSimulator.recordList).toHaveBeenCalledTimes(1));
  });

  it("re-reads the lane's recordings on a slow timer, so one nobody here started lands too", async () => {
    vi.useFakeTimers();
    const { iosSimulator } = installAdeMock();
    iosSimulator.recordList.mockResolvedValue([]);
    render(<CaptureSection ctx={makeCtx()} />);
    await vi.advanceTimersByTimeAsync(1);
    expect(iosSimulator.recordList).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CAPTURE_POLL_MS + 1);
    expect(iosSimulator.recordList).toHaveBeenCalledTimes(2);
  });

  it("reads nothing at all while the drawer is hidden", () => {
    const { iosSimulator } = installAdeMock();
    render(<CaptureSection ctx={makeCtx({ visible: false })} />);
    expect(iosSimulator.recordList).not.toHaveBeenCalled();
  });

  it("names a recording by its label, then by its clock, then by its id", () => {
    expect(recordingName(recording({ label: "  signup  " }))).toBe("signup");
    expect(recordingName(recording())).toBe(`Recording ${CLOCK}`);
    expect(recordingName(recording({ startedAt: "nonsense" }))).toBe("rec-1");
  });
});
