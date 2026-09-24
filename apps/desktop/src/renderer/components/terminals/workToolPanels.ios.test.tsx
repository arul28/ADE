/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { WorkToolPanelProps } from "./workToolPanels";

/**
 * Round 4 §B4, from the panel's side: the pane's unmount has to photograph the
 * last frame, take a lease and open the floating player in ONE synchronous
 * pass, before anything it owns is released.
 *
 * The pane itself is stubbed with a canvas — this is a test about the handover,
 * not about the device.
 */
/** 300×150 is the HTML default: a decoder canvas that has never drawn a frame. */
const decoder = { width: 320, height: 640 };

vi.mock("../apple/AppleDevicePane", () => ({
  AppleDevicePane: () => <canvas data-testid="fake-decoder" width={decoder.width} height={decoder.height} />,
}));

const { WORK_TOOL_COMPONENTS } = await import("./workToolPanels");
const {
  appleStreamLeaseKey,
  acquireAppleStreamLease,
  appleStreamLeaseCount,
  resetAppleStreamLeases,
} = await import("../apple/appleStreamLease");
const {
  getAppleMiniPlayerLaneDevice,
  getAppleMiniPlayerTarget,
  openAppleMiniPlayer,
  resetAppleMiniPlayerForTests,
  takeAppleMiniPlayerPoster,
} = await import("../apple/appleMiniPlayerStore");
const { isWorkSurfaceMounted, resetWorkToolOnScreenForTests, workSurfaceKey } = await import("../../lib/workToolOnScreen");

const LANE = "lane-1";
const UDID = "UDID-1";
const KEY = appleStreamLeaseKey({ pin: null, bound: null, laneId: LANE, deviceUdid: UDID });

const LANE_DEVICE = {
  laneId: LANE,
  udid: UDID,
  name: "ADE Repro",
  origin: "attached",
  family: "iphone",
  runtime: "iOS 26.2",
  createdAt: new Date(0).toISOString(),
  templateUdid: null,
};

function props(): WorkToolPanelProps {
  return {
    laneId: LANE,
    laneRoot: "/repo/.ade/worktrees/lane-1",
    activeLane: null,
    activeSession: null,
    runtimePin: null,
    panelSessionId: "chat-1",
    terminalOwnerSessionId: null,
    toolContext: {} as WorkToolPanelProps["toolContext"],
    pinnedMachineOffline: false,
    pinnedMachineName: null,
    warningReason: null,
    canInsertContext: false,
    shouldPersistPanelAttachment: false,
    resumingSession: false,
    selectedPath: null,
    selectedMode: null,
    selectedCommit: null,
    onSelectFile: vi.fn(),
    onSelectCommit: vi.fn(),
    onClearDiffSelection: vi.fn(),
    onAddAttachment: undefined,
    onAddBuiltInBrowserContext: undefined,
    onAddAppControlContext: undefined,
    onAddIosContext: undefined,
    onInsertDraft: undefined,
    onResumeEndedSession: vi.fn(),
    onToolChange: vi.fn(),
    onClose: vi.fn(),
  };
}

let deviceList: ReturnType<typeof vi.fn>;
let onEvent: ReturnType<typeof vi.fn>;

beforeEach(() => {
  decoder.width = 320;
  decoder.height = 640;
  resetAppleStreamLeases();
  resetAppleMiniPlayerForTests();
  deviceList = vi.fn(async () => ({ lane: LANE_DEVICE, installed: [{ udid: UDID, state: "Booted" }] }));
  onEvent = vi.fn(() => () => {});
  (window as unknown as { ade: unknown }).ade = {
    iosSimulator: { deviceList, onEvent, stopStream: vi.fn(async () => undefined) },
  };
  // jsdom's canvas has no 2D backend, so `toDataURL` is stubbed rather than
  // drawn — the assertion is that the panel ASKS, and what it does with it.
  HTMLCanvasElement.prototype.toDataURL = vi.fn(() => "data:image/jpeg;base64,POSTER");
});

afterEach(() => {
  cleanup();
  resetAppleStreamLeases();
  resetAppleMiniPlayerForTests();
  vi.restoreAllMocks();
});

const WorkIosTool = WORK_TOOL_COMPONENTS.ios;

describe("the Apple tool panel's handover", () => {
  /*
   * `apple show` while the device floats: the pane takes the device back
   * through its own retake handover, and only the mounted tool counts as
   * "on screen" for the show's answer.
   */
  it("takes the device back from the floating player on mount, and says it is mounted", () => {
    resetWorkToolOnScreenForTests();
    openAppleMiniPlayer({
      laneId: LANE,
      chatSessionId: "chat-1",
      deviceUdid: UDID,
      deviceName: "ADE Repro",
      deviceRuntime: "iOS 26.2",
      family: "iphone",
      runtimePin: null,
    });
    expect(isWorkSurfaceMounted(workSurfaceKey("ios", "bound", LANE))).toBe(false);
    const view = render(<WorkIosTool {...props()} />);
    expect(getAppleMiniPlayerTarget()).toBeNull();
    expect(isWorkSurfaceMounted(workSurfaceKey("ios", "bound", LANE))).toBe(true);
    view.unmount();
    expect(isWorkSurfaceMounted(workSurfaceKey("ios", "bound", LANE))).toBe(false);
  });

  it("caches the lane's device while it is open, so the unmount needs no question", async () => {
    render(<WorkIosTool {...props()} />);
    await vi.waitFor(() => expect(getAppleMiniPlayerLaneDevice({ laneId: LANE, runtimePin: null })).toEqual({
      udid: UDID, name: "ADE Repro", runtime: "iOS 26.2", family: "iphone",
    }));
    expect(deviceList).toHaveBeenCalledWith({ laneId: LANE, installed: true }, null);
    // Event-driven, never a poll: a device booted from Xcode still lands here.
    expect(onEvent).toHaveBeenCalled();
  });

  it("photographs the last frame and floats the device in one pass on unmount", async () => {
    // The pane, streaming.
    acquireAppleStreamLease(KEY, { laneId: LANE, deviceUdid: UDID, pinKey: "bound" });
    const view = render(<WorkIosTool {...props()} />);
    await vi.waitFor(() => expect(getAppleMiniPlayerLaneDevice({ laneId: LANE, runtimePin: null })).not.toBeNull());

    view.unmount();

    // Synchronously, with no await between the pane going and the player:
    expect(getAppleMiniPlayerTarget()).toMatchObject({ deviceUdid: UDID, deviceName: "ADE Repro" });
    expect(takeAppleMiniPlayerPoster(UDID)).toBe("data:image/jpeg;base64,POSTER");
    // …and the capture is still held, by the handover's own lease.
    expect(appleStreamLeaseCount(KEY)).toBe(2);
  });

  it("holds no lease for a lane that was not streaming: there is no capture to keep alive", async () => {
    const view = render(<WorkIosTool {...props()} />);
    await vi.waitFor(() => expect(getAppleMiniPlayerLaneDevice({ laneId: LANE, runtimePin: null })).not.toBeNull());
    view.unmount();
    // The photograph is free either way — it comes off a canvas that is already
    // drawn — but with nothing streaming there is nothing to hold open, and the
    // cold path asks the runtime instead.
    expect(takeAppleMiniPlayerPoster(UDID)).toBe("data:image/jpeg;base64,POSTER");
    expect(appleStreamLeaseCount(KEY)).toBe(0);
  });

  it("takes no photograph of a decoder that has never drawn a frame", async () => {
    /*
     * `IosSimH264Video` only sizes its canvas on the first decode, so before
     * one it is the HTML default 300×150 — and, drawn with `alpha: false`,
     * solid black. The poster is painted full-bleed over the floating player,
     * so photographing that placeholder would stretch a black rectangle across
     * the picture: the exact failure the poster exists to prevent.
     */
    decoder.width = 300;
    decoder.height = 150;
    acquireAppleStreamLease(KEY, { laneId: LANE, deviceUdid: UDID, pinKey: "bound" });
    const view = render(<WorkIosTool {...props()} />);
    await vi.waitFor(() => expect(getAppleMiniPlayerLaneDevice({ laneId: LANE, runtimePin: null })).not.toBeNull());
    view.unmount();

    expect(takeAppleMiniPlayerPoster(UDID)).toBeNull();
    // The handover itself still happens — it just opens on the live stream
    // rather than on a photograph of nothing.
    expect(getAppleMiniPlayerTarget()).toMatchObject({ deviceUdid: UDID });
  });

  it("does nothing at all without a lane", () => {
    render(<WorkIosTool {...props()} laneId={null} />);
    expect(deviceList).not.toHaveBeenCalled();
    expect(getAppleMiniPlayerTarget()).toBeNull();
  });
});
