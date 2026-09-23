/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkLiveCornerCard } from "./WorkLiveCornerCard";
import { NativeToolFeedsProvider } from "../terminals/NativeToolFeedsContext";
import { useAppStore } from "../../state/appStore";
import type { BuiltInBrowserStatus, BuiltInBrowserTab, OpenProjectBinding } from "../../../shared/types";
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
import { useMacDesktopLiveView } from "../chat/useMacDesktopLiveView";
import { resetMacDesktopSupportCache } from "../terminals/useMacDesktopSupport";
import {
  grantMacDesktopCardForChat,
  macDesktopCardGrantedAt,
  resetMacDesktopCardGrantsForTests,
} from "./macDesktopCardGrants";
import {
  floatWorkLiveCardForChat,
  markWorkLiveCardSeenForChat,
  readChatCompanionUiState,
  resetChatCompanionUiStateCacheForTests,
  setWorkLivePreviewEnabledForChat,
} from "../chat/chatCompanionUiState";

/**
 * The decoder, faked only when a test asks: it draws a canvas and says it is
 * playing, which jsdom's missing WebCodecs never would.
 */
const fakeDecoder = { playing: false };

vi.mock("../chat/H264VideoCanvas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chat/H264VideoCanvas")>();
  const { useEffect } = await import("react");
  function FakeH264VideoCanvas(props: Parameters<typeof actual.H264VideoCanvas>[0]) {
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
    H264VideoCanvas: (props: Parameters<typeof actual.H264VideoCanvas>[0]) => (
      fakeDecoder.playing ? <FakeH264VideoCanvas {...props} /> : <actual.H264VideoCanvas {...props} />
    ),
  };
});

/** The PiP window, faked: jsdom has none. Each entry is one session opened. */
const pipSessions: { video: HTMLVideoElement; stop: ReturnType<typeof vi.fn> }[] = [];
const pipSupport = { supported: false };

vi.mock("./workLiveIosPictureInPicture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workLiveIosPictureInPicture")>();
  return {
    ...actual,
    isWorkLivePictureInPictureSupported: () => pipSupport.supported,
    enterCanvasPictureInPicture: vi.fn(async (_canvas: HTMLCanvasElement) => {
      const session = { video: document.createElement("video"), stop: vi.fn() };
      pipSessions.push(session);
      return session;
    }),
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
const macDesktopGetStatus = vi.fn(async (): Promise<Partial<MacDesktopStatus>> => ({
  supported: true,
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

function emitMacDesktopEvent(event: MacDesktopEventPayload): void {
  act(() => {
    for (const listener of macDesktopListeners) listener(event);
  });
}

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

function emitAppControlEvent(event: unknown): void {
  act(() => {
    for (const listener of appControlListeners) listener(event);
  });
}

const APP_CONTROL_SESSION = { id: "app-1", status: "connected", label: "Playground", chatSessionId: "chat-1" };

/** One screencast frame, the 30fps feed that used to count as "activity". */
function appControlFrame() {
  return { type: "frame", frame: { mimeType: "image/jpeg", data: "AAAA", width: 288, height: 180 } };
}

/** jsdom does not decode images; report a natural size and fire `load`. */
function loadImage(image: HTMLImageElement, width: number, height: number): void {
  Object.defineProperty(image, "naturalWidth", { configurable: true, value: width });
  Object.defineProperty(image, "naturalHeight", { configurable: true, value: height });
  fireEvent.load(image);
}

beforeEach(() => {
  fakeDecoder.playing = false;
  pipSupport.supported = false;
  pipSessions.length = 0;
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
  it("shows nothing until a screen tool has actually done something", async () => {
    (window.ade.builtInBrowser.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeBuiltInBrowserStatus({ visible: false, activeTabId: null, tabs: [] }),
    );
    renderCard();
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    expect(screen.queryByLabelText("Browser live preview")).toBeNull();
    expect(startPreviewStream).not.toHaveBeenCalled();
  });

  it("shows the browser once it reports activity, and subscribes to its frames", async () => {
    renderCard();
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    emitBrowserEvent({ type: "status", status: BROWSER_STATUS });

    const card = await screen.findByLabelText("Browser live preview", {}, { timeout: 3_000 });
    expect(card).toBeTruthy();
    // The lease is held by a chat, so the title reads "Browser · agent".
    expect(screen.getByText("· agent")).toBeTruthy();
    await waitFor(() => expect(startPreviewStream).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: "tab-1", fps: 12 }),
    ));
  });

  it("does not show a tab owned by a different chat", async () => {
    renderCard({ chatSessionId: "chat-2" });
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    emitBrowserEvent({ type: "status", status: BROWSER_STATUS });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(screen.queryByLabelText("Browser live preview")).toBeNull();
    expect(startPreviewStream).not.toHaveBeenCalled();
  });

  it("paints a preview frame that arrives through the provider's fan-out", async () => {
    renderCard();
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    emitBrowserEvent({ type: "status", status: BROWSER_STATUS });
    const card = await screen.findByLabelText("Browser live preview", {}, { timeout: 3_000 });
    await waitFor(() => expect(startPreviewStream).toHaveBeenCalled());

    const frame = "data:image/jpeg;base64,ZnJhbWUtb25l";
    emitBrowserEvent({
      type: "preview-frame",
      tabId: "tab-1",
      dataUrl: frame,
      width: 480,
      height: 300,
      capturedAt: new Date().toISOString(),
    });

    await waitFor(() => {
      const live = card.querySelector("img");
      expect(live?.getAttribute("src")).toBe(frame);
    });
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

  it("hands the pane back to the tool when the thumbnail is clicked", async () => {
    const { onPick } = renderCard();
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    emitBrowserEvent({ type: "status", status: BROWSER_STATUS });
    await screen.findByLabelText("Browser live preview", {}, { timeout: 3_000 });

    fireEvent.click(screen.getByLabelText("Open Browser in the tools pane"));
    expect(onPick).toHaveBeenCalledWith("browser");
  });

  it("captions the last agent action and hides on dismiss", async () => {
    renderCard();
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    emitBrowserEvent({ type: "status", status: BROWSER_STATUS });
    await screen.findByLabelText("Browser live preview", {}, { timeout: 3_000 });

    emitBrowserEvent({
      type: "trace",
      tabId: "tab-1",
      entry: {
        id: "trace-1",
        tabId: "tab-1",
        action: "click",
        status: "ok",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: 20,
        target: { text: "Sign in" },
      },
    });
    expect(await screen.findByTitle(/Clicked 'Sign in'/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Hide the Browser preview"));
    await waitFor(() => expect(screen.queryByLabelText("Browser live preview")).toBeNull());
    await waitFor(() => expect(stopPreviewStream).toHaveBeenCalled());
  });

  it("stays hidden when the browser is the tool already filling the pane", async () => {
    renderCard({ activeTool: "browser" });
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    emitBrowserEvent({ type: "status", status: BROWSER_STATUS });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByLabelText("Browser live preview")).toBeNull();
    expect(startPreviewStream).not.toHaveBeenCalled();
  });
});

/* ── Placement, dismissal and scrubbing ──────────────────────────────────── */

const PROJECT_ROOT = "/p/live-card";

function seedProject(): void {
  useAppStore.setState({
    project: { rootPath: PROJECT_ROOT } as never,
    projectBinding: null,
    workViewByProject: {},
    laneWorkViewByScope: {},
  });
}

function traceEvent(id: string, action: string, text: string) {
  return {
    type: "trace",
    tabId: "tab-1",
    entry: {
      id,
      tabId: "tab-1",
      action,
      status: "ok",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 12,
      target: { text },
    },
  };
}

/**
 * jsdom has no PointerEvent constructor, so `fireEvent.pointerMove` drops
 * `clientX` — which is the only thing the scrubber reads. A MouseEvent named
 * `pointermove` carries it and React dispatches it to `onPointerMove` all the
 * same.
 */
function scrubTo(card: HTMLElement, clientX: number): void {
  fireEvent(card, new MouseEvent("pointermove", { bubbles: true, clientX, clientY: 10 }));
}

async function showCard(overrides: Partial<Parameters<typeof WorkLiveCornerCard>[0]> = {}) {
  const view = renderCard(overrides);
  await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
  emitBrowserEvent({ type: "status", status: BROWSER_STATUS });
  const card = await screen.findByLabelText("Browser live preview", {}, { timeout: 3_000 });
  return { ...view, card };
}

describe("WorkLiveCornerCard obstructions", () => {
  it("stops watching an obstruction once it leaves the DOM", async () => {
    const observed: Element[] = [];
    const unobserved: Element[] = [];
    const notifiers: (() => void)[] = [];
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      constructor(private readonly callback: (entries: unknown[], observer: unknown) => void) {
        notifiers.push(() => {
          this.callback([{ target: document.body, contentRect: { width: 900, height: 600 } }], this);
        });
      }
      observe(target: Element): void {
        observed.push(target);
        this.callback([{ target, contentRect: { width: 900, height: 600 } }], this);
      }
      unobserve(target: Element): void { unobserved.push(target); }
      disconnect(): void {}
    };

    const { container } = render(
      <NativeToolFeedsProvider active runtimePin={null}>
        <div data-testid="obstruction-slot"><div data-chat-composer-wrapper="" /></div>
        <WorkLiveCornerCard
          active
          laneId="lane-1"
          activeTool="git"
          chatSessionId="chat-1"
          runtimePin={null}
          onPick={vi.fn()}
        />
      </NativeToolFeedsProvider>,
    );

    const composer = container.querySelector("[data-chat-composer-wrapper]");
    expect(composer, "the composer the card measures against").toBeTruthy();
    await waitFor(() => expect(observed).toContain(composer));
    expect(unobserved).not.toContain(composer);

    act(() => { composer?.remove(); });
    act(() => { for (const notify of notifiers) notify(); });
    await waitFor(() => expect(unobserved).toContain(composer));
    expect(unobserved).toEqual([composer]);
  });
});

describe("WorkLiveCornerCard placement", () => {
  it("restores a persisted position instead of always parking bottom-right", async () => {
    seedProject();
    useAppStore.setState({
      workViewByProject: {
        [PROJECT_ROOT]: { workLiveCardPosition: { xPct: 0.5, yPct: 0.25 } } as never,
      },
    });
    const { card } = await showCard();
    expect(card.style.left).toBe("306px");
    expect(card.style.top).toBe(`${0.25 * (600 - 180)}px`);
    expect(card.style.width).toBe("288px");
    expect(card.style.height).toBe("180px");
  });

  it("contains a portrait frame rather than cropping it, and follows its aspect", async () => {
    seedProject();
    const { card } = await showCard();
    // Before any frame, the tool's default landscape aspect.
    expect(card.style.height).toBe("180px");

    const live = card.querySelector("img") as HTMLImageElement;
    expect(live.style.objectFit).toBe("contain");
    expect(live.style.objectPosition).toBe("");

    // A portrait page decodes: the card grows to the picture, uncropped.
    loadImage(live, 390, 844);
    await waitFor(() => expect(card.style.height).not.toBe("180px"));
    expect(Number.parseInt(card.style.height, 10)).toBeGreaterThan(180);
    expect(live.style.objectFit).toBe("contain");
    expect(live.style.objectPosition).toBe("");
  });

  it("clamps a stored position that would hang outside the column", async () => {
    seedProject();
    useAppStore.setState({
      workViewByProject: {
        [PROJECT_ROOT]: { workLiveCardPosition: { xPct: 0, yPct: 0 } } as never,
      },
    });
    const { card } = await showCard();
    expect(card.style.left).toBe("12px");
    expect(card.style.top).toBe("12px");
  });

  it("resizes by width, persists it, and keeps the aspect", async () => {
    seedProject();
    const { card } = await showCard();
    const handle = card.querySelector("[data-live-card-resize]") as HTMLElement;
    expect(handle).toBeTruthy();

    fireEvent(handle, new MouseEvent("pointerdown", { bubbles: true, clientX: 100, button: 0 }));
    fireEvent(handle, new MouseEvent("pointermove", { bubbles: true, clientX: 180, button: 0 }));
    fireEvent(handle, new MouseEvent("pointerup", { bubbles: true, clientX: 180, button: 0 }));

    await waitFor(() => expect(card.style.width).toBe("368px"));
    // Landscape aspect is locked: 288x180 -> 368x230.
    expect(card.style.height).toBe("230px");
    expect(useAppStore.getState().workViewByProject[PROJECT_ROOT]?.workLiveCardWidth).toBe(368);
  });

  it("draws a shrunk card in a column narrower than the full-size floor (M6)", async () => {
    seedProject();
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 360 });
    const { card } = await showCard();
    // The card clamps itself to the 200px minimum instead of disappearing.
    expect(card.style.width).toBe("200px");
  });

  it("pulls a right-edge card back inside when a resize widens it (M7)", async () => {
    seedProject();
    useAppStore.setState({
      workViewByProject: {
        [PROJECT_ROOT]: { workLiveCardPosition: { xPct: 1, yPct: 0.25 } } as never,
      },
    });
    const { card } = await showCard();
    expect(card.style.left).toBe(`${900 - 288 - 12}px`);

    const handle = card.querySelector("[data-live-card-resize]") as HTMLElement;
    fireEvent(handle, new MouseEvent("pointerdown", { bubbles: true, clientX: 100, button: 0 }));
    fireEvent(handle, new MouseEvent("pointermove", { bubbles: true, clientX: 300, button: 0 }));
    fireEvent(handle, new MouseEvent("pointerup", { bubbles: true, clientX: 300, button: 0 }));

    await waitFor(() => expect(card.style.width).toBe("450px"));
    const left = Number.parseInt(card.style.left, 10);
    const width = Number.parseInt(card.style.width, 10);
    expect(left + width).toBeLessThanOrEqual(900 - 12);
    // The clamp is persisted, not just drawn: xPct 1 would reopen off-column.
    const stored = useAppStore.getState().workViewByProject[PROJECT_ROOT]?.workLiveCardPosition;
    expect(stored?.xPct).toBeLessThan(1);
    expect(card.style.left).toBe(`${900 - 450 - 12}px`);
  });
});

describe("WorkLiveCornerCard dismissal", () => {
  it("remembers the close per chat and survives a remount", async () => {
    seedProject();
    const { unmount } = await showCard();

    fireEvent.click(screen.getByLabelText("Hide the Browser preview"));
    await waitFor(() => expect(screen.queryByLabelText("Browser live preview")).toBeNull());

    // Stored against the chat, keyed by the session that was showing.
    expect(readChatCompanionUiState("chat-1").workLiveCardClosedByTool.browser).toBe("tab-1");

    // Re-reading the same status after a remount is not a new session.
    unmount();
    renderCard();
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    emitBrowserEvent({ type: "status", status: BROWSER_STATUS });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(screen.queryByLabelText("Browser live preview")).toBeNull();
  });

  it("floats an unowned tab only in the chat whose pane showed it, and keeps the close there", async () => {
    seedProject();
    // A tab opened by hand belongs to no chat. It floats where the pane showed
    // it (chat-1), and it must NOT follow you into a chat that never did.
    const unowned = makeBuiltInBrowserStatus({
      visible: false,
      activeTabId: "tab-1",
      tabs: [
        makeBuiltInBrowserTab({
          id: "tab-1",
          url: "https://example.test/login",
          title: "Sign in",
          ownerChatSessionId: null,
        }),
      ],
    });
    // The pane is open on the browser in chat-1: the card records the tab as seen.
    const view = renderCard({ activeTool: "browser" });
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    emitBrowserEvent({ type: "status", status: unowned });
    await waitFor(() => expect(readChatCompanionUiState("chat-1").workLiveCardSeenByTool.browser).toBe("tab-1"));
    expect(screen.queryByLabelText("Browser live preview")).toBeNull();
    view.rerender(
      <NativeToolFeedsProvider active runtimePin={null}>
        <WorkLiveCornerCard active laneId="lane-1" activeTool="git" chatSessionId="chat-1" runtimePin={null} onPick={vi.fn()} />
      </NativeToolFeedsProvider>,
    );
    await screen.findByLabelText("Browser live preview", {}, { timeout: 3_000 });
    fireEvent.click(screen.getByLabelText("Hide the Browser preview"));
    await waitFor(() => expect(screen.queryByLabelText("Browser live preview")).toBeNull());
    view.unmount();

    // chat-2 never showed the tab: nothing floats there, closed or not.
    renderCard({ chatSessionId: "chat-2" });
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    emitBrowserEvent({ type: "status", status: unowned });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(screen.queryByLabelText("Browser live preview")).toBeNull();
    expect(readChatCompanionUiState("chat-2").workLiveCardSeenByTool).toEqual({});
  });

  it("drops a float when the session it was showing ends", async () => {
    seedProject();
    renderCard({ activeTool: "browser" });
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    emitBrowserEvent({ type: "status", status: BROWSER_STATUS });
    act(() => { floatWorkLiveCardForChat("chat-1", "browser"); });
    await screen.findByLabelText("Browser live preview", {}, { timeout: 3_000 });

    // The tab is closed: no tab, no session key, and the float goes with it.
    emitBrowserEvent({ type: "status", status: makeBuiltInBrowserStatus({ visible: false, activeTabId: null, tabs: [] }) });
    await waitFor(() => expect(screen.queryByLabelText("Browser live preview")).toBeNull());
    expect(readChatCompanionUiState("chat-1").workLiveCardFloating).toEqual([]);
  });

  it("a disabled preview never shows even when the tool is live", async () => {
    seedProject();
    const { card } = await showCard();
    fireEvent.click(screen.getByLabelText("Hide the Browser preview"));
    await waitFor(() => expect(screen.queryByLabelText("Browser live preview")).toBeNull());
    expect(card).toBeTruthy();

    // A frame is not a new session.
    emitBrowserEvent({
      type: "preview-frame",
      tabId: "tab-1",
      dataUrl: "data:image/jpeg;base64,bmV3",
      width: 480,
      height: 300,
      capturedAt: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(screen.queryByLabelText("Browser live preview")).toBeNull();

    // A NEW tab id is still not a way back on: the toggle is the only one.
    const nextStatus = makeBuiltInBrowserStatus({
      visible: false,
      activeTabId: "tab-2",
      tabs: [
        makeBuiltInBrowserTab({
          id: "tab-2",
          url: "https://example.test/next",
          title: "Next",
          ownerChatSessionId: "chat-1",
        }),
      ],
    });
    emitBrowserEvent({ type: "status", status: nextStatus });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(screen.queryByLabelText("Browser live preview")).toBeNull();
  });

  it("re-enabled preview shows when the pane is minimized", async () => {
    seedProject();
    // The pane is on Git, so the browser is minimized and the card may float.
    await showCard();
    fireEvent.click(screen.getByLabelText("Hide the Browser preview"));
    await waitFor(() => expect(screen.queryByLabelText("Browser live preview")).toBeNull());

    act(() => { setWorkLivePreviewEnabledForChat("chat-1", "browser", true); });
    expect(await screen.findByLabelText("Browser live preview", {}, { timeout: 3_000 })).toBeTruthy();
    expect(readChatCompanionUiState("chat-1").workLiveCardClosedByTool.browser).toBeUndefined();
  });

  it("reopens a closed card when the chat floats the tool", async () => {
    seedProject();
    await showCard();
    fireEvent.click(screen.getByLabelText("Hide the Browser preview"));
    await waitFor(() => expect(screen.queryByLabelText("Browser live preview")).toBeNull());

    act(() => { floatWorkLiveCardForChat("chat-1", "browser"); });
    expect(await screen.findByLabelText("Browser live preview", {}, { timeout: 3_000 })).toBeTruthy();
  });
});

describe("WorkLiveCornerCard App Control dismissal", () => {
  async function showAppControlCard() {
    seedProject();
    const view = renderCard({ activeTool: "browser" });
    await waitFor(() => expect(appControlListeners.size).toBeGreaterThan(0));
    emitAppControlEvent({ type: "session-started", session: APP_CONTROL_SESSION });
    const card = await screen.findByLabelText("App Control live preview", {}, { timeout: 3_000 });
    return { ...view, card };
  }

  it("stays dismissed while the screencast keeps painting", async () => {
    await showAppControlCard();
    fireEvent.click(screen.getByLabelText("Hide the App Control preview"));
    await waitFor(() => expect(screen.queryByLabelText("App Control live preview")).toBeNull());

    for (let i = 0; i < 20; i += 1) emitAppControlEvent(appControlFrame());
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(screen.queryByLabelText("App Control live preview")).toBeNull();
  });

  it("stays dismissed when the same session reports activity", async () => {
    await showAppControlCard();
    fireEvent.click(screen.getByLabelText("Hide the App Control preview"));
    await waitFor(() => expect(screen.queryByLabelText("App Control live preview")).toBeNull());

    // A status refresh — even with a new trace id — is not a new session.
    emitAppControlEvent({
      type: "session-updated",
      session: { ...APP_CONTROL_SESSION, lastTraceEntryId: "trace-9" },
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(screen.queryByLabelText("App Control live preview")).toBeNull();
  });

  it("stays off for a new App Control session id until the toggle is back on", async () => {
    await showAppControlCard();
    fireEvent.click(screen.getByLabelText("Hide the App Control preview"));
    await waitFor(() => expect(screen.queryByLabelText("App Control live preview")).toBeNull());

    emitAppControlEvent({
      type: "session-started",
      session: { ...APP_CONTROL_SESSION, id: "app-2", label: "Playground 2" },
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(screen.queryByLabelText("App Control live preview")).toBeNull();
  });

  it("shows an unowned session only in a chat whose pane has shown it", async () => {
    seedProject();
    const unowned = { ...APP_CONTROL_SESSION, id: "app-9", chatSessionId: null };
    renderCard({ activeTool: "browser" });
    await waitFor(() => expect(appControlListeners.size).toBeGreaterThan(0));
    emitAppControlEvent({ type: "session-started", session: unowned });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.queryByLabelText("App Control live preview")).toBeNull();

    act(() => { markWorkLiveCardSeenForChat("chat-1", "app-control", "app-9"); });
    expect(await screen.findByLabelText("App Control live preview", {}, { timeout: 3_000 })).toBeTruthy();
  });
});

describe("WorkLiveCornerCard scrubbing", () => {
  it("shows the hovered frame's caption and snaps back to live on leave", async () => {
    seedProject();
    const { card } = await showCard();
    emitBrowserEvent(traceEvent("trace-1", "click", "Sign in"));
    emitBrowserEvent(traceEvent("trace-2", "fill", "Email"));
    expect(await screen.findByTitle(/Typed 'Email'/)).toBeTruthy();

    card.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 288, bottom: 180, width: 288, height: 180,
      toJSON: () => ({}),
    });

    scrubTo(card, 0);
    expect(await screen.findByTitle(/Clicked 'Sign in'/)).toBeTruthy();

    scrubTo(card, 288);
    expect(await screen.findByTitle(/Typed 'Email'/)).toBeTruthy();

    fireEvent.pointerLeave(card);
    expect(await screen.findByTitle(/Typed 'Email'/)).toBeTruthy();
  });

  it("offers no scrubbing until there are two frames to scrub between", async () => {
    seedProject();
    const { card } = await showCard();
    emitBrowserEvent(traceEvent("trace-1", "click", "Sign in"));
    card.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 288, bottom: 180, width: 288, height: 180,
      toJSON: () => ({}),
    });
    scrubTo(card, 130);
    expect(await screen.findByText("Live")).toBeTruthy();
    expect(screen.getByTitle(/Clicked 'Sign in'/)).toBeTruthy();
  });

  it("activates the tool when the card's chrome is clicked, but not its ×", async () => {
    seedProject();
    const { card, onPick } = await showCard();
    fireEvent.click(card.querySelector("[data-live-card-pill]") as HTMLElement);
    expect(onPick).toHaveBeenCalledWith("browser");

    onPick.mockClear();
    fireEvent.click(screen.getByLabelText("Hide the Browser preview"));
    expect(onPick).not.toHaveBeenCalled();
  });

  it("keeps the scrub strip out of the layout until the pointer is on the card", async () => {
    seedProject();
    const { card } = await showCard();
    emitBrowserEvent(traceEvent("trace-1", "click", "Sign in"));
    emitBrowserEvent(traceEvent("trace-2", "fill", "Email"));
    await screen.findByTitle(/Typed 'Email'/);

    const strip = () => card.querySelector<HTMLElement>("[aria-hidden='true'].absolute.bottom-0");
    expect(strip()).toBeNull();

    card.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 288, bottom: 180, width: 288, height: 180,
      toJSON: () => ({}),
    });
    scrubTo(card, 144);
    await waitFor(() => expect(strip()).not.toBeNull());
    expect(strip()?.style.height).toBe("2px");

    fireEvent.pointerLeave(card);
    await waitFor(() => expect(strip()).toBeNull());
  });
});

describe("WorkLiveCornerCard chrome", () => {
  function restDot(card: HTMLElement): HTMLElement | null {
    return card.querySelector<HTMLElement>("[data-live-card-status]");
  }

  async function showTab(overrides: Partial<BuiltInBrowserTab>) {
    seedProject();
    const status = makeBuiltInBrowserStatus({
      visible: false,
      activeTabId: "tab-1",
      tabs: [
        makeBuiltInBrowserTab({
          id: "tab-1",
          url: "https://example.test/login",
          title: "Sign in",
          ownerChatSessionId: "chat-1",
          ...overrides,
        }),
      ],
    });
    renderCard();
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    emitBrowserEvent({ type: "status", status });
    return screen.findByLabelText("Browser live preview", {}, { timeout: 3_000 });
  }

  it("rests as a dot and keeps every control in the hover pill", async () => {
    seedProject();
    const { card } = await showCard();

    const dot = restDot(card);
    expect(dot?.dataset.liveCardStatus).toBe("idle");
    expect(dot?.className).toContain("group-hover:opacity-0");
    expect(dot?.className).toContain("h-2");

    const pill = card.querySelector("[data-live-card-pill]");
    expect(pill?.contains(screen.getByLabelText("Hide the Browser preview"))).toBe(true);
    expect(pill?.className).toContain("h-8");
    expect(pill?.className).toContain("group-hover:opacity-100");
    expect(pill?.className).toContain("cursor-grab");
    expect(pill?.textContent).toContain("Sign in");
    expect(pill?.textContent).not.toContain("Browser");
    expect(card.className).toContain("select-none");
  });

  it("leads the pill with the page and follows it with the last action", async () => {
    const card = await showTab({ title: null });
    const pill = card.querySelector("[data-live-card-pill]");
    expect(pill?.textContent).toContain("example.test");
    expect(pill?.textContent).not.toContain("https://");

    emitBrowserEvent(traceEvent("trace-1", "stopFindInPage", ""));
    await waitFor(() => expect(pill?.textContent).toContain("Closed find"));
    const text = pill?.textContent ?? "";
    expect(text.indexOf("example.test")).toBeLessThan(text.indexOf("Closed find"));
  });

  it("rests on a neutral dot rather than on the tool's own hue", async () => {
    const card = await showTab({});
    const dot = restDot(card);
    expect(dot?.dataset.liveCardStatus).toBe("idle");
    expect(dot?.getAttribute("style") ?? "").not.toContain("#22d3ee");
    expect(dot?.className).toContain("bg-fg/25");
  });

  it("turns the dot red while the tab is recording", async () => {
    const card = await showTab({ recording: { startedAt: new Date().toISOString(), fps: 30 } });
    const dot = restDot(card);
    expect(dot?.dataset.liveCardStatus).toBe("recording");
    expect(dot?.className).toContain("ade-status-pulse");
    expect(dot?.className).toContain("motion-reduce:animate-none");
  });

  it("turns the dot amber while a handoff waits, and names it in the pill", async () => {
    const card = await showTab({
      handoff: {
        reason: "Sign in to staging",
        startedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        requestedByChatSessionId: null,
        requestedByLaneId: null,
        startedAtOrigin: null,
        previousOwner: { laneId: null, chatSessionId: null },
      },
    });
    expect(restDot(card)?.dataset.liveCardStatus).toBe("handoff");
    expect(restDot(card)?.title).toBe("Sign in to staging");
    const chip = card.querySelector("[data-live-card-pill] [title='Sign in to staging']");
    expect(chip?.textContent).toBe("Needs you");
  });
});

describe("WorkLiveCornerCard tool switching", () => {
  it("keeps painting frames after the card has swapped source tools once", async () => {
    seedProject();
    renderCard({ activeTool: "git" });
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    await waitFor(() => expect(appControlListeners.size).toBeGreaterThan(0));

    emitBrowserEvent({ type: "status", status: BROWSER_STATUS });
    const first = await screen.findByLabelText("Browser live preview", {}, { timeout: 3_000 });
    const firstFrame = "data:image/jpeg;base64,Zmlyc3Q=";
    emitBrowserEvent({
      type: "preview-frame",
      tabId: "tab-1",
      dataUrl: firstFrame,
      width: 480,
      height: 300,
      capturedAt: new Date().toISOString(),
    });
    await waitFor(() => expect(first.querySelector("img")?.getAttribute("src")).toBe(firstFrame));

    emitAppControlEvent({ type: "session-started", session: APP_CONTROL_SESSION });
    await screen.findByLabelText("App Control live preview", {}, { timeout: 3_000 });

    emitBrowserEvent({
      type: "status",
      status: { ...BROWSER_STATUS, tabs: [{ ...BROWSER_STATUS.tabs[0]!, title: "Signed in" }] },
    });
    await screen.findByLabelText("Browser live preview", {}, { timeout: 3_000 });
    await waitFor(
      () => expect(screen.queryByLabelText("App Control live preview")).toBeNull(),
      { timeout: 3_000 },
    );

    const secondFrame = "data:image/jpeg;base64,c2Vjb25k";
    emitBrowserEvent({
      type: "preview-frame",
      tabId: "tab-1",
      dataUrl: secondFrame,
      width: 480,
      height: 300,
      capturedAt: new Date().toISOString(),
    });
    await waitFor(() => {
      const live = screen.getByLabelText("Browser live preview").querySelector("img");
      expect(live?.getAttribute("src")).toBe(secondFrame);
    });
  });
});

/* ── D1/D2: activity seeding and the shared live-view lease ─────────────── */

/** Stands in for `ChatMacDesktopPanel`'s decoder while a test drives the pane. */
function MacDesktopPaneProbe() {
  const live = useMacDesktopLiveView({
    laneId: "lane-1",
    runtimePin: null,
    enabled: true,
    chatSessionId: "chat-1",
  });
  return <span data-testid="pane-probe" data-url={live.url ?? ""} />;
}

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

describe("WorkLiveCornerCard live tools that predate the card", () => {
  it("shows a browser that was already open when the card mounted (D1)", async () => {
    // No `status` event ever arrives after mount; only the provider's settled
    // `getStatus` answer. Before the fix this tool had `lastActivityAt: 0` and
    // was skipped forever — the card could never show it again until a reload.
    renderCard({ activeTool: "mac-desktop" });
    expect(await screen.findByLabelText("Browser live preview", {}, { timeout: 3_000 })).toBeTruthy();
    await waitFor(() => expect(startPreviewStream).toHaveBeenCalled());
  });

  it("shows a floated tool even when it has never painted (D1)", async () => {
    (window.ade.builtInBrowser.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeBuiltInBrowserStatus({ visible: false, activeTabId: null, tabs: [] }),
    );
    renderCard({ activeTool: "browser" });
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    expect(screen.queryByLabelText("Browser live preview")).toBeNull();

    act(() => { floatWorkLiveCardForChat("chat-1", "browser"); });
    expect(await screen.findByLabelText("Browser live preview", {}, { timeout: 3_000 })).toBeTruthy();
  });

});

/** The floating Mac Desktop, found only while it is in view (`hidden` hides it from roles). */
function macPlayer(): HTMLElement | null {
  return screen.queryByRole("group", { name: "Mac Desktop, floating" });
}

function findMacPlayer(): Promise<HTMLElement> {
  return screen.findByRole("group", { name: "Mac Desktop, floating" }, { timeout: 3_000 });
}

/** Hover the player and press Close on its bar. */
function closeMacPlayer(player: HTMLElement): void {
  fireEvent.pointerEnter(player);
  fireEvent.click(within(player).getByRole("button", { name: "Close" }));
}

/** jsdom has no PointerEvent; React reads the type and the coordinates. */
function pointer(target: EventTarget, type: string, clientX: number, clientY: number): void {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY }));
  });
}

describe("Mac Desktop floating player", () => {
  function watching() {
    macDesktopGetStreamStatus.mockResolvedValue(
      makeStreamStatus({ viewerChatSessionIds: ["chat-1"] }),
    );
    setMacDesktopFrame(macDesktopFrame());
  }

  it("floats for a chat that watches the lane, in the shared player and not the corner card (D1)", async () => {
    watching();
    renderCard({ activeTool: "browser" });
    const player = await findMacPlayer();
    // The same shell as the floating Apple device: a dot at rest, eight
    // resize zones, and the picture from the lane's last frame.
    expect(player.querySelector("[data-mac-mini-dot='idle']")).toBeTruthy();
    expect(player.querySelectorAll("[data-mac-mini-resize]")).toHaveLength(8);
    expect(player.querySelector<HTMLImageElement>("[data-mac-mini-poster]")?.getAttribute("src"))
      .toBe("data:image/jpeg;base64,ZnJhbWU=");
    expect(screen.queryByLabelText("Mac Desktop live preview")).toBeNull();
    // The bar is hidden until the pointer arrives.
    expect(within(player).queryByRole("button", { name: "Open in pane" })).toBeNull();
  });

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

  it("never floats while the tools pane shows the Mac Desktop, even when floated", async () => {
    watching();
    floatWorkLiveCardForChat("chat-1", "mac-desktop");
    const view = renderCard({ activeTool: "mac-desktop" });
    await waitFor(() => expect(macDesktopGetStreamStatus).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(macPlayer()).toBeNull();
    // Mounted and hidden, so it comes back where it was.
    expect(document.querySelector("[data-mac-mini-player='lane-1']")?.hasAttribute("hidden")).toBe(true);

    // The pane moves to another tool: the desktop floats.
    view.rerender(
      <NativeToolFeedsProvider active runtimePin={null}>
        <WorkLiveCornerCard
          active
          laneId="lane-1"
          activeTool="git"
          chatSessionId="chat-1"
          runtimePin={null}
          onPick={view.onPick}
        />
      </NativeToolFeedsProvider>,
    );
    expect(await findMacPlayer()).toBeTruthy();
  });

  it("opens in the pane from the hover bar, and offers picture in picture there", async () => {
    watching();
    const { onPick } = renderCard({ activeTool: null });
    const player = await findMacPlayer();
    fireEvent.pointerEnter(player);
    expect(within(player).getByRole("button", { name: "Picture in picture" })).toBeTruthy();
    fireEvent.click(within(player).getByRole("button", { name: "Open in pane" }));
    expect(onPick).toHaveBeenCalledWith("mac-desktop");
  });

  it("drags from the picture and resizes from an edge, and remembers both", async () => {
    watching();
    renderCard({ activeTool: null });
    const player = await findMacPlayer();
    // The column is the stubbed 900×600; a 16:9 frame opens top right.
    expect(player.style.width).toBe("320px");
    expect(player.style.left).toBe(`${900 - 12 - 320}px`);
    expect(player.style.top).toBe("12px");

    const picture = player.querySelector("[data-mac-mini-picture]")!;
    pointer(picture, "pointerdown", 700, 50);
    pointer(window, "pointermove", 500, 250);
    pointer(window, "pointerup", 500, 250);
    expect(player.style.left).toBe(`${568 - 200}px`);
    expect(player.style.top).toBe("212px");

    const east = player.querySelector("[data-mac-mini-resize='east']")!;
    pointer(east, "pointerdown", 688, 300);
    pointer(window, "pointermove", 768, 300);
    pointer(window, "pointerup", 768, 300);
    expect(player.style.width).toBe("400px");
    expect(player.style.left).toBe("368px");

    expect(JSON.parse(window.localStorage.getItem("ade.macDesktop.floatingPlayer.v1") ?? "null"))
      .toEqual({ width: 400, position: { x: 368, y: 212 } });
  });

  it("opens where the user last left it", async () => {
    window.localStorage.setItem(
      "ade.macDesktop.floatingPlayer.v1",
      JSON.stringify({ width: 400, position: { x: 40, y: 60 } }),
    );
    watching();
    renderCard({ activeTool: null });
    const player = await findMacPlayer();
    expect(player.style.width).toBe("400px");
    expect(player.style.left).toBe("40px");
    expect(player.style.top).toBe("60px");
  });

  it("keeps a closed player closed through a recreated display, until the toggle (M2)", async () => {
    macDesktopGetStatus.mockResolvedValue({
      supported: true,
      display: macDesktopDisplay(),
      lease: null,
      windows: [],
      recording: null,
    });
    watching();
    renderCard({ activeTool: "browser" });
    const player = await findMacPlayer();
    // Wait for the display's key, which the close records.
    await waitFor(() => expect(macDesktopGetStatus).toHaveBeenCalled());
    await act(async () => {});

    closeMacPlayer(player);
    await waitFor(() => expect(macPlayer()).toBeNull());
    // The close still records the display it was showing, not the lane.
    expect(readChatCompanionUiState("chat-1").workLiveCardClosedByTool["mac-desktop"])
      .toBe("display:31:2026-09-18T19:00:00.000Z");

    // The display dies...
    emitMacDesktopEvent({ type: "display-destroyed", laneId: "lane-1", reason: "stopped" });
    await waitFor(() => expect(macPlayer()).toBeNull());
    // ...and a new one is a new session, but the toggle is what decides: a
    // dismissed preview stays dismissed.
    emitMacDesktopEvent({
      type: "display-created",
      display: macDesktopDisplay({ displayId: 57, createdAt: "2026-09-18T19:10:00.000Z" }),
    });
    act(() => { setMacDesktopFrame({ ...macDesktopFrame(), at: Date.now() + 1 }); });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(macPlayer()).toBeNull();

    // Turning the preview back on brings the player back for the new display.
    act(() => { setWorkLivePreviewEnabledForChat("chat-1", "mac-desktop", true); });
    expect(await findMacPlayer()).toBeTruthy();
  });

  it("keeps the stream alive, and decodes it in the player, when the pane goes away (D2)", async () => {
    watching();
    const onPick = vi.fn();
    /**
     * The card and the pane, with the pane mount toggleable without disturbing
     * the card's position in the tree — the same shape as the tools pane going
     * away inside a live Work page.
     */
    function Harness({ showPane }: { showPane: boolean }) {
      return (
        <NativeToolFeedsProvider active runtimePin={null}>
          {showPane ? <MacDesktopPaneProbe /> : null}
          <WorkLiveCornerCard
            active
            laneId="lane-1"
            activeTool="browser"
            chatSessionId="chat-1"
            runtimePin={null}
            onPick={onPick}
          />
        </NativeToolFeedsProvider>
      );
    }
    const view = render(<Harness showPane />);
    // The pane is the decoder owner: it starts the stream once.
    await waitFor(() => expect(macDesktopStartStream).toHaveBeenCalledTimes(1));
    const player = await findMacPlayer();
    expect(player.querySelector("[data-mac-mini-decoder]")).toBeNull();

    // Hiding the pane is an unmount: before the lease this stopped the encoder
    // (and with it the chat's viewer entry) under the player still showing it.
    view.rerender(<Harness showPane={false} />);
    await waitFor(() => expect(macDesktopStartStream).toHaveBeenCalledTimes(2));
    expect(macDesktopStopStream).not.toHaveBeenCalled();
    // The pane's release waits out its grace and then finds the player holding
    // the same chat, so it sends no stop at all.
    await new Promise((resolve) => setTimeout(resolve, MAC_DESKTOP_LIVE_VIEW_STOP_GRACE_MS + 150));
    expect(macDesktopStopStream).not.toHaveBeenCalled();
    // ...and the player owns the decoder now, drawn in its own box.
    await waitFor(() => expect(player.querySelector("[data-mac-mini-decoder] canvas")).toBeTruthy());

    // Closing the player is the last release: the stream stops.
    closeMacPlayer(player);
    await waitFor(() => expect(macDesktopStopStream).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    expect(macDesktopStopStream).toHaveBeenCalledWith({ laneId: "lane-1", chatSessionId: "chat-1", localViewer: true }, null);
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

  it("stays off with the chat's preview toggle off, and Close turns the agent's float off", async () => {
    withLaneDisplay();
    grantMacDesktopCardForChat("lane-1", "chat-1");
    setMacDesktopFrame(macDesktopFrame());
    setWorkLivePreviewEnabledForChat("chat-1", "mac-desktop", false);
    renderCard({ activeTool: "browser" });
    await waitFor(() => expect(macDesktopGetStatus).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(macPlayer()).toBeNull();

    act(() => { setWorkLivePreviewEnabledForChat("chat-1", "mac-desktop", true); });
    closeMacPlayer(await findMacPlayer());
    await waitFor(() => expect(macPlayer()).toBeNull());
    expect(macDesktopCardGrantedAt("lane-1", "chat-1")).toBeNull();
    expect(readChatCompanionUiState("chat-1").workLiveCardClosedByTool["mac-desktop"]).toBeTruthy();
  });

  it("says the display is off when it goes away, and Start starts it for this chat", async () => {
    withLaneDisplay();
    grantMacDesktopCardForChat("lane-1", "chat-1");
    setMacDesktopFrame(macDesktopFrame());
    const start = vi.fn(async () => ({ supported: true, display: macDesktopDisplay({ displayId: 57 }) }));
    (window.ade.macDesktop as unknown as { start: unknown }).start = start;
    renderCard({ activeTool: "browser" });
    const player = await findMacPlayer();
    expect(player.querySelector("[data-mac-mini-off]")).toBeNull();

    emitMacDesktopEvent({ type: "display-destroyed", laneId: "lane-1", reason: "stopped" });
    expect(await screen.findByText("Mac Desktop is off")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    expect(start).toHaveBeenCalledWith({ laneId: "lane-1", chatSessionId: "chat-1" }, null);
    await waitFor(() => expect(screen.queryByText("Mac Desktop is off")).toBeNull());
  });

  it("lets a player nobody floated leave with its display", async () => {
    withLaneDisplay();
    macDesktopGetStreamStatus.mockResolvedValue(makeStreamStatus({ viewerChatSessionIds: ["chat-1"] }));
    setMacDesktopFrame(macDesktopFrame());
    renderCard({ activeTool: "browser" });
    await findMacPlayer();
    emitMacDesktopEvent({ type: "display-destroyed", laneId: "lane-1", reason: "stopped" });
    await waitFor(() => expect(macPlayer()).toBeNull());
    expect(screen.queryByText("Mac Desktop is off")).toBeNull();
  });
});

describe("Mac Desktop floating player: who drives, recording, picture in picture", () => {
  const AGENT_LEASE = {
    laneId: "lane-1",
    holder: "agent" as const,
    holderId: "chat-7",
    holderLabel: "Fix login",
    grantedAt: "2026-09-18T19:00:00.000Z",
    expiresAt: "2026-09-18T19:01:00.000Z",
  };

  async function showMacDesktopPlayer(status: Partial<MacDesktopStatus> = {}) {
    (window.ade.builtInBrowser.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeBuiltInBrowserStatus({ visible: false, activeTabId: null, tabs: [] }),
    );
    macDesktopGetStatus.mockResolvedValue({
      supported: true,
      display: macDesktopDisplay(),
      lease: null,
      windows: [],
      recording: null,
      ...status,
    });
    macDesktopGetStreamStatus.mockResolvedValue(
      makeStreamStatus({ viewerChatSessionIds: ["chat-1"] }),
    );
    setMacDesktopFrame(macDesktopFrame());
    const { onPick } = renderCard({ activeTool: "browser" });
    const player = await findMacPlayer();
    return Object.assign(player, { onPick });
  }

  /** The owner tag on the hover bar, or null. */
  function ownerTag(player: HTMLElement): string | null {
    fireEvent.pointerEnter(player);
    return player.querySelector<HTMLElement>("[data-mac-mini-owner]")?.dataset.macMiniOwner ?? null;
  }

  function restDot(player: HTMLElement): string | undefined {
    fireEvent.pointerLeave(player);
    return player.querySelector<HTMLElement>("[data-mac-mini-dot]")?.dataset.macMiniDot;
  }

  it("names the agent holding the lease and pulses red while the desktop records", async () => {
    const player = await showMacDesktopPlayer({
      lease: AGENT_LEASE,
      recording: {
        laneId: "lane-1",
        running: true,
        startedAt: "2026-09-18T19:00:00.000Z",
        filePath: null,
        durationMs: null,
        caption: null,
      },
    });

    await waitFor(() => expect(ownerTag(player)).toBe("agent"));
    expect(restDot(player)).toBe("recording");
  });

  it("follows the lease and the recording as they change", async () => {
    const player = await showMacDesktopPlayer();
    await waitFor(() => expect(macDesktopGetStatus).toHaveBeenCalled());
    expect(ownerTag(player)).toBeNull();
    expect(restDot(player)).toBe("idle");

    emitMacDesktopEvent({ type: "lease-changed", laneId: "lane-1", lease: AGENT_LEASE });
    await waitFor(() => expect(ownerTag(player)).toBe("agent"));

    emitMacDesktopEvent({
      type: "lease-changed",
      laneId: "lane-1",
      lease: { ...AGENT_LEASE, holder: "user", holderId: "ade-window:1", holderLabel: "You" },
    });
    await waitFor(() => expect(ownerTag(player)).toBe("you"));

    emitMacDesktopEvent({
      type: "recording-changed",
      status: {
        laneId: "lane-1",
        running: true,
        startedAt: "2026-09-18T19:00:00.000Z",
        filePath: null,
        durationMs: null,
        caption: null,
      },
    });
    await waitFor(() => expect(restDot(player)).toBe("recording"));

    // Another lane's events say nothing about this one.
    emitMacDesktopEvent({ type: "lease-changed", laneId: "lane-2", lease: null });
    expect(ownerTag(player)).toBe("you");

    emitMacDesktopEvent({ type: "lease-changed", laneId: "lane-1", lease: null });
    emitMacDesktopEvent({
      type: "recording-changed",
      status: { laneId: "lane-1", running: false, startedAt: null, filePath: "/tmp/r.mp4", durationMs: 900, caption: null },
    });
    await waitFor(() => expect(restDot(player)).toBe("idle"));
    expect(ownerTag(player)).toBeNull();
  });

  it("keeps picture in picture off where the window cannot do it", async () => {
    const player = await showMacDesktopPlayer();
    fireEvent.pointerEnter(player);
    const button = within(player).getByRole<HTMLButtonElement>("button", { name: "Picture in picture" });
    expect(button.disabled).toBe(true);
  });

  it("offers no picture in picture on a browser card", async () => {
    renderCard({ activeTool: "mac-desktop" });
    const card = await screen.findByLabelText("Browser live preview", {}, { timeout: 3_000 });
    expect(card.querySelector("[aria-label='Picture in picture']")).toBeNull();
  });

  it("floats the player's decoder canvas into picture in picture, and comes back when it closes", async () => {
    fakeDecoder.playing = true;
    pipSupport.supported = true;
    const player = await showMacDesktopPlayer();
    const canvas = await screen.findByTestId("fake-decoder-canvas", {}, { timeout: 3_000 });
    fireEvent.pointerEnter(player);
    const button = () => within(player).getByRole<HTMLButtonElement>("button", { name: "Picture in picture" });
    await waitFor(() => expect(button().disabled).toBe(false));

    await act(async () => {
      fireEvent.click(button());
    });
    const { enterCanvasPictureInPicture } = await import("./workLiveIosPictureInPicture");
    expect(enterCanvasPictureInPicture).toHaveBeenCalledWith(canvas);
    await waitFor(() => expect(player.hasAttribute("data-mac-mini-pip")).toBe(true));
    expect(pipSessions).toHaveLength(1);
    // The button is the player's chrome, not a trip to the pane.
    expect(player.onPick).not.toHaveBeenCalled();

    act(() => {
      pipSessions[0]!.video.dispatchEvent(new Event("leavepictureinpicture"));
    });
    await waitFor(() => expect(player.hasAttribute("data-mac-mini-pip")).toBe(false));
    expect(pipSessions[0]!.stop).toHaveBeenCalled();
  });
});
