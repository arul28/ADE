/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkToolReadOnlyView } from "./WorkToolReadOnlyView";
import type { WorkToolsLaneState, WorkToolsMacDesktopState } from "../../../shared/types/workTools";

const DATA_URL = "data:image/png;base64,AAAA";

function macDesktopState(overrides: Partial<WorkToolsMacDesktopState> = {}): WorkToolsMacDesktopState {
  return {
    supported: true,
    display: {
      laneId: "lane-1",
      displayId: 7,
      name: "ADE · lane-1",
      mode: "virtual",
      width: 2560,
      height: 1440,
      scale: 2,
      origin: { x: 0, y: 0 },
      createdAt: "2026-09-18T10:00:00.000Z",
      windowCount: 0,
      lastActivityAt: "2026-09-18T10:00:30.000Z",
    },
    windows: [],
    lease: null,
    stream: { running: true, idle: false, fps: 30, bitrateKbps: 900, lastError: null },
    permissions: { screenRecording: "granted", accessibility: "granted" },
    lastObservation: {
      id: "obs-1",
      capturedAt: "2026-09-18T10:00:20.000Z",
      caption: "Sign in",
      screenshotPath: "/tmp/obs/obs-1.png",
    },
    hostIsLocal: false,
    ...overrides,
  };
}

/** The web `macDesktop` namespace subset the live view reads. */
function liveApi(overrides: Record<string, unknown> = {}) {
  return {
    supportsLiveStream: () => true,
    streamSubscribe: vi.fn(async (args: { laneId: string; subscriptionId: string }) => {
      void args;
      return { ok: true, width: 2560, height: 1440, codec: "avc1.640032" };
    }),
    streamUnsubscribe: vi.fn(async (args: { subscriptionId: string }) => {
      void args;
      return { ok: true };
    }),
    onStreamRecord: () => () => {},
    onStreamEnded: () => () => {},
    onConnectionChange: () => () => {},
    ...overrides,
  };
}

function installFakeWebCodecs(): void {
  class FakeVideoDecoder {
    state = "configured";
    configure = vi.fn();
    decode = vi.fn();
    close = vi.fn(() => {
      this.state = "closed";
    });
  }
  class FakeEncodedVideoChunk {
    constructor(readonly init: unknown) {}
  }
  (globalThis as unknown as { VideoDecoder?: unknown }).VideoDecoder = FakeVideoDecoder;
  (globalThis as unknown as { EncodedVideoChunk?: unknown }).EncodedVideoChunk = FakeEncodedVideoChunk;
}

function laneState(overrides: Partial<WorkToolsLaneState> = {}): WorkToolsLaneState {
  return {
    laneId: "lane-1",
    activeTool: "browser",
    openTools: ["browser"],
    activeToolUpdatedAt: "2026-01-01T00:00:00.000Z",
    browser: {
      activeTabId: "tab-1",
      tabs: [
        {
          id: "tab-1",
          title: "Sign in · Example",
          url: "https://example.test/login",
          ownerChatSessionId: "chat-9",
          recording: true,
          active: true,
          handoffReason: null,
        },
      ],
      latestObservation: {
        path: "/tmp/obs/obs-2.png",
        capturedAt: "2026-01-02T00:00:00.000Z",
        caption: "Sign in",
      },
    },
    browserUnavailable: null,
    agentBrowserPresence: [],
    macDesktop: null,
    appControl: {
      appName: "ADE Dev",
      status: "connected",
      driver: "cdp",
      latestObservation: null,
    },
    capturedAt: "2026-01-02T00:00:01.000Z",
    ...overrides,
  };
}

function installAde(
  workTools: Partial<Window["ade"]["workTools"]>,
  macDesktop?: Record<string, unknown>,
): void {
  (window as unknown as { ade: unknown }).ade = {
    workTools,
    ...(macDesktop ? { macDesktop } : {}),
  };
}

describe("WorkToolReadOnlyView", () => {
  beforeEach(() => {
    (window as unknown as { ade?: unknown }).ade = undefined;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete (globalThis as unknown as { VideoDecoder?: unknown }).VideoDecoder;
    delete (globalThis as unknown as { EncodedVideoChunk?: unknown }).EncodedVideoChunk;
  });

  it("shows the lane's tabs and the latest frame, and never offers a control", async () => {
    const readObservationPreview = vi.fn(async () => ({
      dataUrl: DATA_URL,
      mimeType: "image/png",
      byteLength: 4,
    }));
    installAde({
      getLaneState: vi.fn(async () => laneState()),
      readObservationPreview,
    });

    render(<WorkToolReadOnlyView tool="browser" laneId="lane-1" />);

    expect(await screen.findByText("Sign in · Example")).toBeTruthy();
    expect(screen.getByText("https://example.test/login")).toBeTruthy();
    expect(screen.getByText("Recording")).toBeTruthy();
    expect(screen.getByText("Control from the desktop")).toBeTruthy();
    // Read-only means read-only: no button, no input, anywhere in the subtree.
    expect(document.querySelectorAll("button, input, textarea, select")).toHaveLength(0);

    await waitFor(() => {
      expect(screen.getByRole("img")).toHaveProperty("src", DATA_URL);
    });
    // Bytes are fetched by path, never carried in the state payload.
    expect(readObservationPreview).toHaveBeenCalledWith("/tmp/obs/obs-2.png");
  });

  it("renders the App Control app and status when asked for that tool", async () => {
    installAde({
      getLaneState: vi.fn(async () => laneState()),
      readObservationPreview: vi.fn(async () => null),
    });

    render(<WorkToolReadOnlyView tool="app-control" laneId="lane-1" />);

    expect(await screen.findByText("ADE Dev")).toBeTruthy();
    expect(screen.getByText("connected · cdp")).toBeTruthy();
    // The browser's tabs belong to the browser card, not this one.
    expect(screen.queryByText("Sign in · Example")).toBeNull();
  });

  it("says where the tools actually run when no desktop is attached", async () => {
    installAde({ getLaneState: vi.fn(async () => null) });

    render(<WorkToolReadOnlyView tool="browser" laneId="lane-1" />);

    expect(
      await screen.findByText("Tools run on the desktop. Open ADE on your Mac to see them here."),
    ).toBeTruthy();
  });

  it("reports an empty browser rather than an error when the desktop has no tabs", async () => {
    installAde({
      getLaneState: vi.fn(async () => laneState({
        browser: { activeTabId: null, tabs: [], latestObservation: null },
      })),
    });

    render(<WorkToolReadOnlyView tool="browser" laneId="lane-1" />);

    expect(await screen.findByText("No browser tabs are open in this lane.")).toBeTruthy();
  });

  it("does not tell a user with ADE already open to open ADE", async () => {
    // The narrow reason: a desktop IS attached, it just has no window for this
    // project. "Open ADE on your Mac" would send them to look at an app that is
    // already in front of them — the exact failure the reason exists to avoid,
    // and the wording is shared with the iOS sheet so the two cannot drift.
    installAde({
      getLaneState: vi.fn(async () => laneState({
        browser: null,
        browserUnavailable: "desktop_not_attached_for_project",
      })),
    });

    render(<WorkToolReadOnlyView tool="browser" laneId="lane-1" />);

    expect(
      await screen.findByText(
        "ADE Desktop doesn't have this project open. Open it on your Mac to see its tabs.",
      ),
    ).toBeTruthy();
  });

  it("distinguishes an unsupported browser from a failed read", async () => {
    installAde({
      getLaneState: vi.fn(async () => laneState({ browser: null, browserUnavailable: "unsupported" })),
    });
    const { unmount } = render(<WorkToolReadOnlyView tool="browser" laneId="lane-1" />);
    expect(await screen.findByText("The browser isn't available on this machine.")).toBeTruthy();
    unmount();

    installAde({
      getLaneState: vi.fn(async () => laneState({ browser: null, browserUnavailable: "error" })),
    });
    render(<WorkToolReadOnlyView tool="browser" laneId="lane-1" />);
    expect(await screen.findByText("Couldn't read the browser's state.")).toBeTruthy();
  });

  it("asks for nothing without a lane", async () => {
    const getLaneState = vi.fn(async () => laneState());
    installAde({ getLaneState });

    render(<WorkToolReadOnlyView tool="browser" laneId={null} />);

    expect(await screen.findByText("Select a lane to see what its tools are doing.")).toBeTruthy();
    expect(getLaneState).not.toHaveBeenCalled();
  });

  it("subscribes to the lane's stream when the host advertises the live view", async () => {
    installFakeWebCodecs();
    const api = liveApi();
    installAde(
      {
        getLaneState: vi.fn(async () => laneState({ macDesktop: macDesktopState() })),
        readObservationPreview: vi.fn(async () => null),
      },
      api,
    );

    const { unmount } = render(<WorkToolReadOnlyView tool="mac-desktop" laneId="lane-1" />);

    expect(await screen.findByTestId("ios-h264-canvas")).toBeTruthy();
    await waitFor(() => expect(api.streamSubscribe).toHaveBeenCalledTimes(1));
    expect(api.streamSubscribe.mock.calls[0]?.[0]).toMatchObject({ laneId: "lane-1" });
    // The lease line is the desktop strip's sentence, not a second phrasing.
    expect(screen.getByText("Nobody has taken control.")).toBeTruthy();

    unmount();
    await waitFor(() => expect(api.streamUnsubscribe).toHaveBeenCalledTimes(1));
  });

  it("keeps the still frame and says so when the browser has no WebCodecs", async () => {
    // No fake VideoDecoder: this is the Safari-without-WebCodecs path. The
    // host still advertises the contract, so the pane owes one line of why.
    installAde(
      {
        getLaneState: vi.fn(async () => laneState({ macDesktop: macDesktopState() })),
        readObservationPreview: vi.fn(async () => ({
          dataUrl: DATA_URL,
          mimeType: "image/png",
          byteLength: 4,
        })),
      },
      { ...liveApi() },
    );

    render(<WorkToolReadOnlyView tool="mac-desktop" laneId="lane-1" />);

    expect(await screen.findByRole("img")).toHaveProperty("src", DATA_URL);
    expect(screen.queryByTestId("ios-h264-canvas")).toBeNull();
    expect(screen.getByText("This browser can't play the live view, so this is the latest frame.")).toBeTruthy();
  });

  it("keeps the still frame without a notice when the host cannot stream at all", async () => {
    installAde(
      {
        getLaneState: vi.fn(async () => laneState({ macDesktop: macDesktopState() })),
        readObservationPreview: vi.fn(async () => ({
          dataUrl: DATA_URL,
          mimeType: "image/png",
          byteLength: 4,
        })),
      },
      { supportsLiveStream: () => false },
    );

    render(<WorkToolReadOnlyView tool="mac-desktop" laneId="lane-1" />);

    expect(await screen.findByRole("img")).toHaveProperty("src", DATA_URL);
    expect(screen.queryByTestId("ios-h264-canvas")).toBeNull();
    expect(screen.queryByText(/can't play the live view/)).toBeNull();
  });

  it("offers Start desktop only when the lane has no display, and Stop only while running", async () => {
    const start = vi.fn(async () => null);
    const stop = vi.fn(async () => null);
    installAde(
      {
        getLaneState: vi.fn(async () => laneState({
          macDesktop: macDesktopState({ display: null, stream: null }),
        })),
        readObservationPreview: vi.fn(async () => null),
      },
      { ...liveApi({ start, stop }) },
    );

    render(<WorkToolReadOnlyView tool="mac-desktop" laneId="lane-1" />);

    const startButton = await screen.findByRole("button", { name: "Start desktop" });
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    fireEvent.click(startButton);
    await waitFor(() => expect(start).toHaveBeenCalledWith({ laneId: "lane-1" }));
  });

  it("does not offer Start once the display exists, and Stop carries the lane", async () => {
    const stop = vi.fn(async () => null);
    installAde(
      {
        getLaneState: vi.fn(async () => laneState({ macDesktop: macDesktopState() })),
        readObservationPreview: vi.fn(async () => null),
      },
      { ...liveApi({ stop }) },
    );

    render(<WorkToolReadOnlyView tool="mac-desktop" laneId="lane-1" />);

    expect(await screen.findByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start desktop" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(stop).toHaveBeenCalledWith({ laneId: "lane-1" }));
  });
});
