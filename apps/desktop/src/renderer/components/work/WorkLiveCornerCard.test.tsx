/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkLiveCornerCard } from "./WorkLiveCornerCard";
import { NativeToolFeedsProvider } from "../terminals/NativeToolFeedsContext";
import { useAppStore } from "../../state/appStore";
import type { BuiltInBrowserStatus, OpenProjectBinding } from "../../../shared/types";
import type { MacDesktopDisplay, MacDesktopEventPayload, MacDesktopStatus, MacDesktopStreamStatus } from "../../../shared/types/macDesktop";
import {
  makeBuiltInBrowserStatus,
  makeBuiltInBrowserTab,
} from "../chat/__fixtures__/builtInBrowserStatus";
import { resetMacDesktopFrames, setMacDesktopFrame } from "../chat/macDesktopFrameStore";
import {
  MAC_DESKTOP_LIVE_VIEW_STOP_GRACE_MS,
  resetMacDesktopLiveViewLeasesForTests,
} from "../chat/macDesktopLiveViewLease";
import { FIRST_FRAME_TIMEOUT_MS, RECOVER_MAX_TRIES } from "../chat/useMacDesktopLiveView";
import { resetWorkToolOnScreenForTests } from "../../lib/workToolOnScreen";
import { resetMacDesktopSupportCache } from "../terminals/useMacDesktopSupport";
import { grantMacDesktopCardForChat, resetMacDesktopCardGrantsForTests } from "./macDesktopCardGrants";
import { resetChatCompanionUiStateCacheForTests } from "../chat/chatCompanionUiState";

/**
 * The decoder, faked only when a test asks: it draws a canvas and says it is
 * playing, which jsdom's missing WebCodecs never would.
 */
const fakeDecoder = { playing: false };

vi.mock("../device/H264StreamView", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../device/H264StreamView")>();
  const { useEffect } = await import("react");
  function FakeH264StreamView(props: Parameters<typeof actual.H264StreamView>[0]) {
    useEffect(() => {
      props.onStatus?.("playing", null);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return (
      <canvas
        data-testid="fake-decoder-canvas"
        ref={(node) => {
          // jsdom cannot encode a canvas; the frame snapshot only needs a string.
          if (node) node.toDataURL = () => "data:image/jpeg;base64,ZnJhbWU=";
          props.onCanvas?.(node);
        }}
      />
    );
  }
  return {
    ...actual,
    H264StreamView: (props: Parameters<typeof actual.H264StreamView>[0]) => (
      fakeDecoder.playing ? <FakeH264StreamView {...props} /> : <actual.H264StreamView {...props} />
    ),
  };
});

type BrowserEventListener = (event: unknown) => void;

const browserListeners = new Set<BrowserEventListener>();
const appControlListeners = new Set<BrowserEventListener>();
const macDesktopListeners = new Set<(event: MacDesktopEventPayload) => void>();
const startPreviewStream = vi.fn(async () => ({ tabId: "tab-1", fps: 12, maxWidth: 480, subscribers: 1 }));
const stopPreviewStream = vi.fn(async () => ({ tabId: "tab-1", fps: 12, maxWidth: 480, subscribers: 0 }));

function makeStreamStatus(overrides: Partial<MacDesktopStreamStatus> = {}): MacDesktopStreamStatus {
  return {
    laneId: "lane-1",
    running: false,
    fps: 0,
    idle: false,
    bitrateKbps: null,
    transport: null,
    lastError: null,
    clients: 0,
    viewerChatSessionIds: [],
    ...overrides,
  };
}

const macDesktopStartStream = vi.fn(async () => makeStreamStatus({
  running: true,
  transport: {
    url: "http://127.0.0.1:9/mac-desktop-video?lane=lane-1&token=t",
    port: 9,
    token: "t",
    codec: "avc1.640032",
    width: 1920,
    height: 1080,
  },
}));
const macDesktopStopStream = vi.fn(async () => makeStreamStatus());
const macDesktopGetStreamStatus = vi.fn(async () => makeStreamStatus());
const macDesktopGetStatus = vi.fn(async (): Promise<Partial<MacDesktopStatus> & Pick<MacDesktopStatus, "platform" | "supported">> => ({
  supported: true,
  platform: "darwin",
  display: null,
  lease: null,
  windows: [],
  recording: null,
}));
const macDesktopOnEvent = vi.fn((
  cb: (event: MacDesktopEventPayload) => void,
  _pin?: OpenProjectBinding | null,
) => {
  macDesktopListeners.add(cb);
  return () => macDesktopListeners.delete(cb);
});

const BROWSER_STATUS: BuiltInBrowserStatus = makeBuiltInBrowserStatus({
  visible: false,
  activeTabId: "tab-1",
  tabs: [
    makeBuiltInBrowserTab({
      id: "tab-1",
      url: "https://example.test/login",
      title: "Sign in",
      ownerChatSessionId: "chat-1",
    }),
  ],
});

function emitBrowserEvent(event: unknown): void {
  act(() => {
    for (const listener of browserListeners) listener(event);
  });
}

beforeEach(() => {
  fakeDecoder.playing = false;
  browserListeners.clear();
  appControlListeners.clear();
  macDesktopListeners.clear();
  startPreviewStream.mockClear();
  stopPreviewStream.mockClear();
  macDesktopStartStream.mockClear();
  macDesktopStopStream.mockClear();
  macDesktopGetStreamStatus.mockReset();
  macDesktopGetStreamStatus.mockResolvedValue(makeStreamStatus());
  macDesktopGetStatus.mockClear();
  macDesktopOnEvent.mockClear();
  resetMacDesktopSupportCache();
  resetMacDesktopLiveViewLeasesForTests();
  resetMacDesktopFrames();
  window.localStorage.clear();
  resetChatCompanionUiStateCacheForTests();
  // jsdom has no ResizeObserver; the card sizes itself from one.
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(private readonly callback: (entries: unknown[], observer: unknown) => void) {}
    observe(target: Element): void {
      // motion's drag-constraint observer reads `entries`, so a callback with
      // no arguments blows up inside framer-motion rather than in our code.
      this.callback([{ target, contentRect: { width: 900, height: 600 } }], this);
    }
    unobserve(): void {}
    disconnect(): void {}
  };
  // A host big enough for the card to decide it fits.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 900 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: 600 });
  (window as unknown as { ade: unknown }).ade = {
    builtInBrowser: {
      getStatus: vi.fn(async () => BROWSER_STATUS),
      onEvent: (cb: BrowserEventListener) => {
        browserListeners.add(cb);
        return () => browserListeners.delete(cb);
      },
      startPreviewStream,
      stopPreviewStream,
    },
    appControl: {
      getStatus: vi.fn(async () => ({ activeSession: null })),
      onEvent: (cb: BrowserEventListener) => {
        appControlListeners.add(cb);
        return () => appControlListeners.delete(cb);
      },
      getTrace: vi.fn(async () => ({ entries: [] })),
    },
    iosSimulator: { getStatus: vi.fn(async () => ({ activeSession: null })), onEvent: () => () => {} },
    macDesktop: {
      getStatus: macDesktopGetStatus,
      getStreamStatus: macDesktopGetStreamStatus,
      startStream: macDesktopStartStream,
      stopStream: macDesktopStopStream,
      resolveStreamUrl: vi.fn(async (url: string) => ({ url, forwarded: false, error: null })),
      onEvent: macDesktopOnEvent,
    },
  };
  useAppStore.setState({ projectBinding: null });
});

afterEach(() => {
  cleanup();
  resetMacDesktopCardGrantsForTests();
  window.localStorage.clear();
  resetChatCompanionUiStateCacheForTests();
  resetMacDesktopLiveViewLeasesForTests();
  resetMacDesktopFrames();
  resetMacDesktopSupportCache();
  vi.restoreAllMocks();
});

function renderCard(overrides: Partial<Parameters<typeof WorkLiveCornerCard>[0]> = {}) {
  const onPick = vi.fn();
  const props = {
    active: true,
    laneId: "lane-1" as string | null,
    activeTool: "git" as Parameters<typeof WorkLiveCornerCard>[0]["activeTool"],
    chatSessionId: "chat-1" as string | null,
    runtimePin: null,
    onPick,
    ...overrides,
  };
  // The feeds come from the page's provider in production; the card opens no
  // subscriptions of its own, so the test has to supply the same owner.
  const view = render(
    <NativeToolFeedsProvider active={props.active} runtimePin={props.runtimePin}>
      <WorkLiveCornerCard {...props} />
    </NativeToolFeedsProvider>,
  );
  return { ...view, onPick };
}

describe("WorkLiveCornerCard", () => {
  it("does not show a tab owned by a different chat", async () => {
    renderCard({ chatSessionId: "chat-2" });
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    emitBrowserEvent({ type: "status", status: BROWSER_STATUS });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(screen.queryByLabelText("Browser live preview")).toBeNull();
    expect(startPreviewStream).not.toHaveBeenCalled();
  });

  it("never starts a browser feed for a pane with no tab", async () => {
    renderCard();
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    emitBrowserEvent({
      type: "status",
      status: { ...BROWSER_STATUS, activeTabId: null, tabs: [] },
    });

    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    expect(startPreviewStream).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Browser live preview")).toBeNull();
  });
});

/* ── D1/D2: activity seeding and the shared live-view lease ─────────────── */

function macDesktopFrame() {
  return {
    laneId: "lane-1",
    dataUrl: "data:image/jpeg;base64,ZnJhbWU=",
    width: 1920,
    height: 1080,
    at: Date.now(),
    caption: null,
  };
}

function macDesktopDisplay(overrides: Partial<MacDesktopDisplay> = {}): MacDesktopDisplay {
  return {
    laneId: "lane-1",
    displayId: 31,
    name: "ADE · mac-desktop",
    mode: "virtual",
    width: 2560,
    height: 1440,
    scale: 1,
    origin: { x: 0, y: 0 },
    createdAt: "2026-09-18T19:00:00.000Z",
    windowCount: 1,
    lastActivityAt: "2026-09-18T19:00:00.000Z",
    ...overrides,
  };
}

/** The floating Mac Desktop, found only while it is in view (`hidden` hides it from roles). */
function macPlayer(): HTMLElement | null {
  return screen.queryByRole("group", { name: "Mac Desktop, floating" });
}

function findMacPlayer(): Promise<HTMLElement> {
  return screen.findByRole("group", { name: "Mac Desktop, floating" }, { timeout: 3_000 });
}

describe("Mac Desktop floating player", () => {
  function watching() {
    macDesktopGetStreamStatus.mockResolvedValue(
      makeStreamStatus({ viewerChatSessionIds: ["chat-1"] }),
    );
    setMacDesktopFrame(macDesktopFrame());
  }

  it("reads the lane's desktop with the focused CHAT's machine pin", async () => {
    // A Studio chat selected from a MacBook-bound tab: every mac-desktop read
    // the player makes must address the Studio, because that is where the
    // display lives. `TerminalsPage` supplies the pin; the player must spend it.
    const studioPin: OpenProjectBinding = {
      kind: "remote",
      key: "remote:target-studio:project-a",
      targetId: "target-studio",
      runtimeName: "Mac Studio",
      transport: "paired",
      projectId: "project-a",
      rootPath: "/repo",
      displayName: "ADE",
    };
    watching();
    renderCard({ activeTool: "browser", runtimePin: studioPin });

    await waitFor(() => expect(macDesktopGetStreamStatus).toHaveBeenCalledWith(
      { laneId: "lane-1" },
      studioPin,
    ));
    expect(macDesktopGetStatus).toHaveBeenCalledWith(
      { laneId: "lane-1", chatSessionId: "chat-1" },
      studioPin,
    );
    expect(macDesktopOnEvent).toHaveBeenCalledWith(expect.any(Function), studioPin);
    expect(await findMacPlayer()).toBeTruthy();
  });
});

describe("Mac Desktop floated by the chat's agent", () => {
  /** No tab and no viewer entry: only the agent's activity can authorize. */
  function withLaneDisplay() {
    (window.ade.builtInBrowser.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeBuiltInBrowserStatus({ visible: false, activeTabId: null, tabs: [] }),
    );
    macDesktopGetStatus.mockResolvedValue({
      supported: true,
      platform: "darwin",
      display: macDesktopDisplay(),
      lease: null,
      windows: [],
      recording: null,
    });
  }

  it("decodes and floats for the chat its agent drove, with no lease and no viewer entry", async () => {
    withLaneDisplay();
    fakeDecoder.playing = true;
    grantMacDesktopCardForChat("lane-1", "chat-1");
    renderCard({ activeTool: "browser" });
    await waitFor(() => expect(macDesktopStartStream).toHaveBeenCalledWith(
      { laneId: "lane-1", chatSessionId: "chat-1" },
      null,
    ));
    // No frame in the store yet: the player's own decoder produces the first.
    const player = await findMacPlayer();
    expect(player.querySelector("[data-mac-mini-decoder] canvas")).toBeTruthy();
  });

  it("authorizes nothing for another chat, even on the same lane", async () => {
    withLaneDisplay();
    grantMacDesktopCardForChat("lane-1", "chat-other");
    setMacDesktopFrame(macDesktopFrame());
    renderCard({ activeTool: "browser" });
    await waitFor(() => expect(macDesktopGetStatus).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(macPlayer()).toBeNull();
    expect(macDesktopStartStream).not.toHaveBeenCalled();
  });
});

describe("Mac Desktop floating preview on by default", () => {
  function withLaneDisplay() {
    (window.ade.builtInBrowser.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeBuiltInBrowserStatus({ visible: false, activeTabId: null, tabs: [] }),
    );
    macDesktopGetStatus.mockResolvedValue({
      supported: true,
      platform: "darwin",
      display: macDesktopDisplay(),
      lease: null,
      windows: [],
      recording: null,
    });
  }

  afterEach(() => {
    resetWorkToolOnScreenForTests();
    macDesktopGetStatus.mockResolvedValue({ supported: true, platform: "darwin", display: null, lease: null, windows: [], recording: null });
  });

  it("does not float for a chat of another lane or a lane-less chat, or with no display", async () => {
    withLaneDisplay();
    setMacDesktopFrame(macDesktopFrame());
    const view = renderCard({ activeTool: "browser", sessionLaneId: null });
    await waitFor(() => expect(macDesktopGetStatus).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(macPlayer()).toBeNull();
    view.unmount();

    macDesktopGetStatus.mockResolvedValue({ supported: true, platform: "darwin", display: null, lease: null, windows: [], recording: null });
    renderCard({ activeTool: "browser", sessionLaneId: "lane-1" });
    await waitFor(() => expect(macDesktopGetStatus).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(macPlayer()).toBeNull();
    expect(macDesktopStartStream).not.toHaveBeenCalled();
  });

  it("regression: a stream that sends no picture is in view, says so, stops re-dialling, and lets go", async () => {
    // The owner's 2026-09-24 report: the default-on player asked for the
    // lane's stream, its reader got no frame, and the player stayed hidden
    // (it mounted hidden until a first frame) while it restarted the encoder
    // behind it. Now it is in view from the start, says "Connecting video",
    // and once the re-dials are spent it says so and offers Retry.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      withLaneDisplay();
      // The real decoder, reading a body that never carries a frame.
      (globalThis as unknown as { VideoDecoder: unknown }).VideoDecoder = class {
        state = "unconfigured";
        decodeQueueSize = 0;
        configure(): void {}
        decode(): void {}
        close(): void { this.state = "closed"; }
      };
      (globalThis as unknown as { EncodedVideoChunk: unknown }).EncodedVideoChunk = class {};
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
      const readers: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        readers.push(String(input));
        return { ok: true, status: 200, body: new ReadableStream({ start() {} }) } as unknown as Response;
      });

      renderCard({ activeTool: null, sessionLaneId: "lane-1" });
      await waitFor(() => expect(readers).toHaveLength(1));
      const player = await findMacPlayer();
      expect(within(player).getByText("Connecting video…")).toBeTruthy();

      // Every address that draws nothing is re-dialled a few times, no more.
      for (let step = 0; step < 12; step += 1) {
        await act(async () => { vi.advanceTimersByTime(FIRST_FRAME_TIMEOUT_MS); });
      }
      expect(macDesktopStartStream.mock.calls.length).toBeLessThanOrEqual(1 + RECOVER_MAX_TRIES);
      expect(within(player).getByText("No picture from the display")).toBeTruthy();
      // ...and holds no encoder while it says so: the viewer lets go.
      await act(async () => { vi.advanceTimersByTime(MAC_DESKTOP_LIVE_VIEW_STOP_GRACE_MS + 50); });
      expect(macDesktopStopStream).toHaveBeenCalledWith(
        { laneId: "lane-1", chatSessionId: "chat-1", localViewer: true },
        null,
      );
      expect(within(player).getByText("No picture from the display")).toBeTruthy();

      const calls = macDesktopStartStream.mock.calls.length;
      await act(async () => {
        fireEvent.click(within(player).getByRole("button", { name: "Retry" }));
      });
      await waitFor(() => expect(macDesktopStartStream).toHaveBeenCalledTimes(calls + 1));
      expect(macDesktopStartStream).toHaveBeenLastCalledWith(
        { laneId: "lane-1", chatSessionId: "chat-1", fresh: true },
        null,
      );
      await waitFor(() => expect(within(player).queryByText("No picture from the display")).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });
});
