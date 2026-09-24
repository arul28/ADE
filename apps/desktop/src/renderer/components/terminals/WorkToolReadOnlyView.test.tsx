/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORK_TOOL_READ_ONLY_POLL_MS, WorkToolReadOnlyView, WORK_TOOL_READ_ONLY_LIVE_POLL_MS, createMacDesktopStreamSource } from "./WorkToolReadOnlyView";
import type { WorkToolsLaneState, WorkToolsMacDesktopState } from "../../../shared/types/workTools";
import type { SyncMacDesktopStreamRecordPayload } from "../../../shared/types/sync";

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
    vi.useRealTimers();
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

  /* ── Web takeover ─────────────────────────────────────────────────────── */

  const USER_LEASE = {
    laneId: "lane-1",
    holder: "user" as const,
    holderId: "web:conn-1:tab-token-1",
    holderLabel: "ADE Web",
    grantedAt: "2026-09-18T10:00:00.000Z",
    expiresAt: "2026-09-18T10:01:00.000Z",
  };

  function controlApi(overrides: Record<string, unknown> = {}) {
    return {
      ...liveApi({ supportsLiveStream: () => false }),
      supportsMacDesktopControl: () => true,
      takeControl: vi.fn(async (_args: { laneId: string; controllerId: string; controllerLabel?: string }) => USER_LEASE),
      returnControl: vi.fn(async (_args: { laneId: string; controllerId: string }) => null),
      renewLease: vi.fn(async (_args: { laneId: string; controllerId: string }) => USER_LEASE),
      input: vi.fn(async (_args: { laneId: string; call: unknown }) => ({
        ok: true,
        action: "click",
        mode: "real",
        silent: true,
        resolved: null,
        observation: null,
        trace: null,
      })),
      ...overrides,
    };
  }

  // jsdom has no PointerEvent, so testing-library would fall back to a plain
  // Event and drop clientX/clientY. A MouseEvent subclass restores them.
  beforeEach(() => {
    (window as unknown as { PointerEvent?: unknown }).PointerEvent = class PointerEvent extends MouseEvent {};
  });

  afterEach(() => {
    delete (window as unknown as { PointerEvent?: unknown }).PointerEvent;
  });

  it("keeps the watch-only wording and no control when the host has not advertised takeover", async () => {
    installAde(
      {
        getLaneState: vi.fn(async () => laneState({ macDesktop: macDesktopState() })),
        readObservationPreview: vi.fn(async () => null),
      },
      {
        ...liveApi({ supportsLiveStream: () => false }),
        supportsMacDesktopControl: () => false,
        takeControl: vi.fn(async () => USER_LEASE),
      },
    );

    render(<WorkToolReadOnlyView tool="mac-desktop" laneId="lane-1" />);

    expect(await screen.findByText("Control from the desktop")).toBeTruthy();
    expect(screen.queryByTestId("mac-desktop-web-takeover")).toBeNull();
  });

  it("takes control, shows the strip state, and heartbeats the lease", async () => {
    const api = controlApi();
    installAde(
      {
        getLaneState: vi.fn(async () => laneState({ macDesktop: macDesktopState() })),
        readObservationPreview: vi.fn(async () => null),
      },
      api,
    );

    render(<WorkToolReadOnlyView tool="mac-desktop" laneId="lane-1" />);

    // The affordance and the hint change together: the host advertised both
    // halves, so the pane must not still claim control is elsewhere.
    const takeButton = await screen.findByTestId("mac-desktop-web-takeover");
    expect(screen.getByText("Take control here, or watch from the desktop")).toBeTruthy();

    // Fake timers only after the initial load: `findBy` drives its own clock.
    vi.useFakeTimers();
    fireEvent.click(takeButton);
    await act(async () => {});

    expect(api.takeControl).toHaveBeenCalledWith({
      laneId: "lane-1",
      controllerId: expect.any(String),
      controllerLabel: "ADE Web",
    });
    expect(screen.getByTestId("mac-desktop-web-takeover-banner").textContent).toContain("You have control");
    expect(screen.getByTestId("mac-desktop-web-owner").textContent).toBe("You have control");
    expect(screen.getByText("Return to agent")).toBeTruthy();
    expect(screen.getByText("You have control.")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(api.renewLease).toHaveBeenCalledTimes(1);
    expect(api.renewLease).toHaveBeenCalledWith({
      laneId: "lane-1",
      controllerId: api.takeControl.mock.calls[0]?.[0]?.controllerId,
    });
  });

  it("badges who drives the lane and whether it is recording", async () => {
    const getLaneState = vi.fn(async () => laneState({
      macDesktop: macDesktopState({
        lease: { ...USER_LEASE, holder: "agent", holderId: "chat-7", holderLabel: "Fix login" },
        recording: { running: true, startedAt: "2026-09-18T10:00:00.000Z" },
      }),
    }));
    installAde({ getLaneState, readObservationPreview: vi.fn(async () => null) }, controlApi());

    render(<WorkToolReadOnlyView tool="mac-desktop" laneId="lane-1" />);

    expect((await screen.findByTestId("mac-desktop-web-owner")).textContent).toBe("Agent driving");
    expect(screen.getByTestId("mac-desktop-web-recording").textContent).toBe("Recording");
  });

  it("shows no owner or recording badge on an idle lane, or from a host that sends no recording", async () => {
    installAde(
      {
        getLaneState: vi.fn(async () => laneState({ macDesktop: macDesktopState() })),
        readObservationPreview: vi.fn(async () => null),
      },
      controlApi(),
    );

    render(<WorkToolReadOnlyView tool="mac-desktop" laneId="lane-1" />);

    expect(await screen.findByTestId("mac-desktop-web-takeover")).toBeTruthy();
    expect(screen.queryByTestId("mac-desktop-web-owner")).toBeNull();
    expect(screen.queryByTestId("mac-desktop-web-recording")).toBeNull();
  });

  it("returns control when the tab goes hidden", async () => {
    const api = controlApi();
    installAde(
      {
        getLaneState: vi.fn(async () => laneState({ macDesktop: macDesktopState() })),
        readObservationPreview: vi.fn(async () => null),
      },
      api,
    );

    render(<WorkToolReadOnlyView tool="mac-desktop" laneId="lane-1" />);
    fireEvent.click(await screen.findByTestId("mac-desktop-web-takeover"));
    await act(async () => {});

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    try {
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await waitFor(() => expect(api.returnControl).toHaveBeenCalledTimes(1));
      expect(api.returnControl).toHaveBeenCalledWith({
        laneId: "lane-1",
        controllerId: api.takeControl.mock.calls[0]?.[0]?.controllerId,
      });
      expect(screen.queryByTestId("mac-desktop-web-takeover-banner")).toBeNull();
    } finally {
      delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    }
  });

  it("shows a Control ended line when the polled lease changes holder", async () => {
    // Fake timers from the start, so the pane's poll interval is a fake one
    // this test can advance instead of waiting four real seconds.
    vi.useFakeTimers();
    const api = controlApi();
    const getLaneState = vi.fn(async () => laneState({
      capturedAt: new Date().toISOString(),
      macDesktop: macDesktopState({
        lease: { ...USER_LEASE, holderId: "web:conn-2:someone-else" },
      }),
    }));
    installAde({ getLaneState, readObservationPreview: vi.fn(async () => null) }, api);

    render(<WorkToolReadOnlyView tool="mac-desktop" laneId="lane-1" />);
    await act(async () => {});
    const takeButton = screen.getByTestId("mac-desktop-web-takeover");
    fireEvent.click(takeButton);
    await act(async () => {});
    // The state on the screen was read before this tab took control, so it is
    // not evidence that control ended. The next poll is.
    expect(screen.queryByTestId("mac-desktop-web-control-notice")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(WORK_TOOL_READ_ONLY_POLL_MS);
    });
    expect(screen.getByTestId("mac-desktop-web-control-notice").textContent).toContain("Control ended");
    expect(screen.queryByTestId("mac-desktop-web-takeover-banner")).toBeNull();
  });

  it("maps pointer coordinates through the picture's letterbox", async () => {
    const api = controlApi();
    installAde(
      {
        getLaneState: vi.fn(async () => laneState({ macDesktop: macDesktopState() })),
        readObservationPreview: vi.fn(async () => null),
      },
      api,
    );
    // jsdom has no layout: give the pane a 1000x1000 box and let the shared
    // geometry place the 2560x1440 picture inside it (562.5px tall, centered).
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 1000,
      right: 1000,
      bottom: 1000,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    (Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = vi.fn();
    (Element.prototype as unknown as { releasePointerCapture: () => void }).releasePointerCapture = vi.fn();

    render(<WorkToolReadOnlyView tool="mac-desktop" laneId="lane-1" />);
    fireEvent.click(await screen.findByTestId("mac-desktop-web-takeover"));
    await act(async () => {});

    const surface = screen.getByTestId("mac-desktop-web-surface");
    fireEvent.pointerDown(surface, { clientX: 500, clientY: 500, pointerId: 7, button: 0 });
    fireEvent.pointerUp(surface, { clientX: 500, clientY: 500, pointerId: 7, button: 0, detail: 1 });

    await waitFor(() => expect(api.input).toHaveBeenCalledTimes(1));
    expect(api.input).toHaveBeenCalledWith({
      laneId: "lane-1",
      call: {
        kind: "click",
        args: expect.objectContaining({
          laneId: "lane-1",
          x: 1280,
          y: 720,
          silent: true,
        }),
      },
    });
  });

  it("returns control on Escape and does not type that key into the lane", async () => {
    const api = controlApi();
    installAde(
      {
        getLaneState: vi.fn(async () => laneState({ macDesktop: macDesktopState() })),
        readObservationPreview: vi.fn(async () => null),
      },
      api,
    );

    render(<WorkToolReadOnlyView tool="mac-desktop" laneId="lane-1" />);
    fireEvent.click(await screen.findByTestId("mac-desktop-web-takeover"));
    await act(async () => {});
    expect(screen.getByText("Esc")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(api.returnControl).toHaveBeenCalledWith({
      laneId: "lane-1",
      controllerId: api.takeControl.mock.calls[0]?.[0]?.controllerId,
    }));
    const calls = api.input.mock.calls.map((entry) => (entry[0] as { call?: { kind?: string } })?.call);
    expect(calls.some((call) => call?.kind === "releaseInput")).toBe(true);
    expect(calls.some((call) => call?.kind === "press")).toBe(false);
    expect(screen.queryByTestId("mac-desktop-web-takeover-banner")).toBeNull();
  });
});

describe("WorkToolReadOnlyView live Mac Desktop stream", () => {
  /**
   * The live-picture half of the Mac Desktop read-only pane: the pushed-record
   * gate and the poll/still bookkeeping that follows the canvas's `playing`
   * status. C's file covers the control affordance, so this one stays additive.
   */

  const DATA_URL = "data:image/png;base64,AAAA";

  type RecordHandler = (record: SyncMacDesktopStreamRecordPayload) => void;

  class FakeVideoDecoder {
    static instances: FakeVideoDecoder[] = [];
    state = "unconfigured";
    configure = vi.fn(() => {
      this.state = "configured";
    });
    close = vi.fn(() => {
      this.state = "closed";
    });
    decode = vi.fn(() => {
      // The real decoder answers with the drawn frame; a chunk accepted and then
      // never drawn is what the playing-status test is about.
      if (this.drawOnDecode) this.init.output({ displayWidth: 16, displayHeight: 9, close: () => {} });
    });
    private readonly init: {
      output: (frame: { displayWidth: number; displayHeight: number; close: () => void }) => void;
      error: (error: Error) => void;
    };

    constructor(init: FakeVideoDecoder["init"]) {
      this.init = init;
      FakeVideoDecoder.instances.push(this);
    }

    drawOnDecode = false;
  }

  class FakeEncodedVideoChunk {
    constructor(readonly init: unknown) {}
  }

  function installFakeWebCodecs(options: { drawOnDecode: boolean }): void {
    FakeVideoDecoder.instances = [];
    class ConfiguredFakeVideoDecoder extends FakeVideoDecoder {
      constructor(init: FakeVideoDecoder["init"]) {
        super(init);
        this.drawOnDecode = options.drawOnDecode;
      }
    }
    (globalThis as unknown as { VideoDecoder?: unknown }).VideoDecoder = ConfiguredFakeVideoDecoder;
    (globalThis as unknown as { EncodedVideoChunk?: unknown }).EncodedVideoChunk = FakeEncodedVideoChunk;
  }

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

  function laneState(overrides: Partial<WorkToolsLaneState> = {}): WorkToolsLaneState {
    return {
      laneId: "lane-1",
      activeTool: "mac-desktop",
      openTools: ["mac-desktop"],
      activeToolUpdatedAt: "2026-01-01T00:00:00.000Z",
      browser: null,
      browserUnavailable: null,
      agentBrowserPresence: [],
      macDesktop: macDesktopState(),
      appControl: null,
      capturedAt: "2026-01-02T00:00:01.000Z",
      ...overrides,
    };
  }

  function configRecord(subscriptionId: string, seq: number): SyncMacDesktopStreamRecordPayload {
    const json = JSON.stringify({ codec: "avc1.640032", width: 2560, height: 1440, annexB: true });
    return {
      subscriptionId,
      seq,
      kind: "config",
      keyframe: false,
      timestampUs: 0,
      data: btoa(json),
    };
  }

  function frameRecord(
    subscriptionId: string,
    seq: number,
    keyframe: boolean,
  ): SyncMacDesktopStreamRecordPayload {
    return {
      subscriptionId,
      seq,
      kind: "frame",
      keyframe,
      timestampUs: seq * 33_333,
      data: btoa(String.fromCharCode(0x65, 0x88)),
    };
  }

  /** A web `macDesktop` namespace whose record pushes the test drives. */
  function controlledApi() {
    const recordHandlers: RecordHandler[] = [];
    const streamSubscribe = vi.fn(async (args: { laneId: string; subscriptionId: string }) => {
      void args;
      return { ok: true, width: 2560, height: 1440, codec: "avc1.640032" };
    });
    const api = {
      supportsLiveStream: () => true,
      streamSubscribe,
      streamUnsubscribe: vi.fn(async () => ({ ok: true })),
      onStreamRecord: (handler: RecordHandler) => {
        recordHandlers.push(handler);
        return () => {
          const index = recordHandlers.indexOf(handler);
          if (index >= 0) recordHandlers.splice(index, 1);
        };
      },
      onStreamEnded: () => () => {},
      onConnectionChange: () => () => {},
    };
    return {
      api,
      streamSubscribe,
      push: (record: SyncMacDesktopStreamRecordPayload) => {
        for (const handler of [...recordHandlers]) handler(record);
      },
    };
  }

  describe("createMacDesktopStreamSource", () => {
    it("withholds P-frames after a sequence gap until the next keyframe", () => {
      const { api, push } = controlledApi();
      const received: Array<{ keyframe: boolean; seq?: number }> = [];
      const source = createMacDesktopStreamSource({
        api: api as never,
        laneId: "lane-1",
        subscriptionId: "sub-1",
        viewerLabel: "ADE Web",
      });
      const unsubscribe = source.subscribe({
        onRecord: (record) => {
          if (record.kind === "access-unit") received.push({ keyframe: record.keyframe, seq: record.seq });
        },
        onError: vi.fn(),
        onEnd: vi.fn(),
      });

      push(configRecord("sub-1", 0));
      push(frameRecord("sub-1", 1, true));
      push(frameRecord("sub-1", 2, false));
      expect(received).toHaveLength(2);

      // The host skipped 3 and 4 under backpressure.
      push(frameRecord("sub-1", 5, false));
      push(frameRecord("sub-1", 6, false));
      expect(received).toHaveLength(2);

      push(frameRecord("sub-1", 7, true));
      expect(received).toHaveLength(3);
      expect(received[2]).toEqual({ keyframe: true, seq: 7 });

      // Another subscription's records never reach this source.
      push(frameRecord("sub-other", 8, true));
      expect(received).toHaveLength(3);
      unsubscribe();
    });
  });

  describe("WorkToolReadOnlyView live poll", () => {
    beforeEach(() => {
      (window as unknown as { ade?: unknown }).ade = undefined;
      HTMLCanvasElement.prototype.getContext = (() => ({ drawImage: vi.fn() })) as never;
    });

    afterEach(() => {
      cleanup();
      vi.restoreAllMocks();
      delete (globalThis as unknown as { VideoDecoder?: unknown }).VideoDecoder;
      delete (globalThis as unknown as { EncodedVideoChunk?: unknown }).EncodedVideoChunk;
    });

    it("skips the still fetch and lengthens the poll while the live picture plays", async () => {
      installFakeWebCodecs({ drawOnDecode: true });
      const { api, streamSubscribe, push } = controlledApi();
      const readObservationPreview = vi.fn(async () => ({
        dataUrl: DATA_URL,
        mimeType: "image/png",
        byteLength: 4,
      }));
      const getLaneState = vi.fn(async () => laneState());
      (window as unknown as { ade: unknown }).ade = {
        workTools: { getLaneState, readObservationPreview },
        macDesktop: api,
      };

      const intervals: Array<{ callback: TimerHandler; delay?: number }> = [];
      const setIntervalSpy = vi.spyOn(window, "setInterval");
      setIntervalSpy.mockImplementation(((callback: TimerHandler, delay?: number) => {
        intervals.push({ callback, delay });
        return 0;
      }) as unknown as typeof window.setInterval);
      // testing-library's waitFor polls on its own 50ms interval; only the
      // component's two poll cadences are this test's business.
      const pollIntervals = () => intervals.filter((entry) =>
        entry.delay === WORK_TOOL_READ_ONLY_POLL_MS || entry.delay === WORK_TOOL_READ_ONLY_LIVE_POLL_MS);

      const { unmount } = render(<WorkToolReadOnlyView tool="mac-desktop" laneId="lane-1" />);

      // Before the picture: one still fetch and the four-second poll.
      await waitFor(() => expect(readObservationPreview).toHaveBeenCalledTimes(1));
      expect(pollIntervals().at(-1)?.delay).toBe(WORK_TOOL_READ_ONLY_POLL_MS);

      await waitFor(() => expect(streamSubscribe).toHaveBeenCalledTimes(1));
      const subscriptionId = streamSubscribe.mock.calls[0]![0].subscriptionId;
      push(configRecord(subscriptionId, 0));
      push(frameRecord(subscriptionId, 1, true));
      await waitFor(() =>
        expect(document.querySelector("canvas")?.getAttribute("data-status")).toBe("playing"));
      await waitFor(() => expect(pollIntervals().at(-1)?.delay).toBe(WORK_TOOL_READ_ONLY_LIVE_POLL_MS));

      // A later poll notices a new observation path. The live picture replaces
      // the still, so it must not be fetched.
      getLaneState.mockResolvedValue(laneState({
        macDesktop: macDesktopState({
          lastObservation: {
            id: "obs-2",
            capturedAt: "2026-01-02T00:00:05.000Z",
            caption: "Newer frame",
            screenshotPath: "/tmp/obs/obs-2.png",
          },
        }),
      }));
      const poll = pollIntervals().at(-1)?.callback;
      expect(typeof poll).toBe("function");
      (poll as () => void)();
      await waitFor(() => expect(getLaneState.mock.calls.length).toBeGreaterThan(1));
      expect(readObservationPreview).toHaveBeenCalledTimes(1);

      unmount();
    });
  });
});
